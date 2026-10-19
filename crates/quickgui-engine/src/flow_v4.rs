//! v4 data nodes and resumable execution. Device/network waits never hold Engine.
#[cfg(test)]
#[path = "flow_v4_tests.rs"]
mod tests;
use crate::serial::{self, SerialError, SerialFilter, SerialService, SerialSettings};
use crate::{
    now_ms, read_path, replace_path, validate_json, validate_path, CancellationToken, Engine,
    FlowNode, Project, RuntimeSnapshot, ScriptHost, ScriptRequest,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

pub fn manual_entry_id<'a>(flow: &'a crate::Flow, entry: Option<&str>) -> Result<&'a str, String> {
    let mut entries = flow.nodes.iter().filter(|node| {
        node.kind == "event"
            && node
                .config
                .get("trigger")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                == "manual"
    });
    if let Some(id) = entry {
        return entries
            .find(|node| node.id == id)
            .map(|node| node.id.as_str())
            .ok_or_else(|| "Unknown manual event entry".into());
    }
    let first = entries
        .next()
        .ok_or("This flow has no manual event entry")?;
    if entries.next().is_some() {
        return Err("Choose a manual event entry for this flow".into());
    }
    Ok(first.id.as_str())
}

pub fn execution_key(project: &Project) -> String {
    use sha2::{Digest, Sha256};
    let flows:Vec<_>=project.flows.iter().map(|flow|json!({"id":flow.id,"enabled":flow.enabled,"nodes":flow.nodes.iter().map(|n|json!({"id":n.id,"kind":n.kind,"config":n.config,"block":n.block})).collect::<Vec<_>>(),"edges":flow.edges})).collect();
    let connections: Vec<_> = project
        .connections
        .iter()
        .map(|c| json!({"id":c["id"],"protocol":c["protocol"],"config":c["config"]}))
        .collect();
    format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"id":project.id,"schema":project.schema_version,"variables":project.variables,"flows":flows,"scripts":project.scripts,"connections":connections,"windows":project.windows.as_deref().unwrap_or_default().iter().map(|w|&w.id).collect::<Vec<_>>() })).unwrap()))
}

pub fn resolve_ref(engine: &Engine, input: &Value, reference: &Value) -> Result<Value, String> {
    let object = reference.as_object().ok_or("ValueRef must be an object")?;
    let source = object
        .get("source")
        .and_then(Value::as_str)
        .ok_or("Missing ValueRef source")?;
    let allowed: &[&str] = match source {
        "literal" => &["source", "value"],
        "input" => &["source", "path"],
        "variable" => &["source", "variable", "path"],
        _ => return Err("Unknown ValueRef source".into()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unknown ValueRef field".into());
    }
    let root = match source {
        "literal" => object.get("value").ok_or("Literal ValueRef needs value")?,
        "input" => input,
        "variable" => {
            let id = object
                .get("variable")
                .and_then(Value::as_str)
                .ok_or("Variable ValueRef needs stable ID")?;
            if !engine.project.variables.iter().any(|v| v.id == id) {
                return Err(format!("Unknown variable ID: {id}"));
            }
            &engine
                .snapshot
                .values
                .get(id)
                .ok_or("Runtime variable missing")?
                .value
        }
        _ => unreachable!(),
    };
    let value = if let Some(path) = object.get("path") {
        read_path(
            root,
            path.as_array().ok_or("ValueRef path must be an array")?,
        )?
    } else {
        root
    };
    validate_json(value)?;
    Ok(value.clone())
}
fn reference_default(node: &FlowNode, key: &str, default: Value) -> Value {
    node.config.get(key).cloned().unwrap_or(default)
}
fn literal(value: Value) -> Value {
    json!({"source":"literal","value":value})
}
pub fn map_value(engine: &Engine, node: &FlowNode, input: &Value) -> Result<Value, String> {
    let fields = |input: &Value| -> Result<Value, String> {
        let fields = node
            .config
            .get("fields")
            .and_then(Value::as_object)
            .ok_or("Map fields must be an object")?;
        let mut out = serde_json::Map::new();
        for (key, value) in fields {
            out.insert(key.clone(), resolve_ref(engine, input, value)?);
        }
        Ok(Value::Object(out))
    };
    let output = match node.config.get("operation").and_then(Value::as_str) {
        Some("value") => resolve_ref(
            engine,
            input,
            node.config.get("value").ok_or("Map value missing")?,
        )?,
        Some("object") => fields(input)?,
        Some("array") => {
            let items = resolve_ref(
                engine,
                input,
                node.config.get("items").ok_or("Map items missing")?,
            )?;
            Value::Array(
                items
                    .as_array()
                    .ok_or("Map items must resolve to an array")?
                    .iter()
                    .map(fields)
                    .collect::<Result<_, _>>()?,
            )
        }
        _ => return Err("Unknown map operation".into()),
    };
    validate_json(&output)?;
    Ok(output)
}
pub fn append_value(engine: &mut Engine, node: &FlowNode, input: &Value) -> Result<Value, String> {
    let id = node
        .config
        .get("variable")
        .and_then(Value::as_str)
        .ok_or("Append variable ID missing")?;
    let variable = engine
        .project
        .variables
        .iter()
        .find(|v| v.id == id)
        .ok_or("Append requires a stable variable ID")?;
    if variable.value_type != "json" || variable.read_only {
        return Err("Append requires a writable JSON variable".into());
    }
    let root = &engine.snapshot.values[id].value;
    let path = node
        .config
        .get("path")
        .map(|v| v.as_array().ok_or("Append path must be an array"))
        .transpose()?
        .map(Vec::as_slice)
        .unwrap_or_default();
    validate_path(path)?;
    let mut items = read_path(root, path)?
        .as_array()
        .ok_or("Append target must be an array")?
        .clone();
    let item = resolve_ref(
        engine,
        input,
        node.config.get("item").ok_or("Append item missing")?,
    )?;
    let max_items = integer(node, "maxItems", 500, 1, 100000)? as usize;
    let max_bytes = integer(node, "maxBytes", 524288, 2, 1048576)? as usize;
    if serde_json::to_vec(&vec![item.clone()])
        .map_err(|e| e.to_string())?
        .len()
        > max_bytes
    {
        return Err("Append item exceeds the display history byte limit".into());
    }
    let newest = match node
        .config
        .get("order")
        .and_then(Value::as_str)
        .unwrap_or("oldestFirst")
    {
        "latestFirst" => true,
        "oldestFirst" => false,
        _ => return Err("Unknown append order".into()),
    };
    if newest {
        items.insert(0, item);
    } else {
        items.push(item);
    }
    let mut dropped = 0u64;
    while items.len() > max_items
        || serde_json::to_vec(&items).map_err(|e| e.to_string())?.len() > max_bytes
    {
        if newest {
            items.pop();
        } else {
            items.remove(0);
        }
        dropped += 1;
    }
    let mut total = dropped;
    let mut next = replace_path(root, path, json!(items))?;
    if let Some(count_path) = node.config.get("droppedPath") {
        let count_path = count_path
            .as_array()
            .ok_or("Dropped path must be an array")?;
        validate_path(count_path)?;
        if path.starts_with(count_path) || count_path.starts_with(path) {
            return Err("Array and dropped count paths cannot overlap".into());
        }
        let old = read_path(root, count_path)?
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Dropped count must be a nonnegative safe integer")?;
        total = old
            .checked_add(dropped)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Dropped count overflow")?;
        next = replace_path(&next, count_path, json!(total))?;
    }
    let output = json!({"items":items,"droppedItems":dropped,"droppedTotal":total});
    validate_json(&next)?;
    validate_json(&output)?;
    engine.set_variable(id, next)?;
    Ok(output)
}
fn integer(node: &FlowNode, key: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    let value = node
        .config
        .get(key)
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| format!("{key} must be an integer"))
        })
        .transpose()?
        .unwrap_or(default);
    if !(min..=max).contains(&value) {
        Err(format!("{key} outside allowed range"))
    } else {
        Ok(value)
    }
}
pub fn filter_id(value: &Value) -> Result<Option<u16>, String> {
    match value {
        Value::String(s) => {
            let s = s.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
            if s.is_empty() {
                return Ok(None);
            }
            let s = s
                .strip_prefix("0x")
                .or_else(|| s.strip_prefix("0X"))
                .unwrap_or(s);
            if s.is_empty() || s.len() > 4 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("USB ID must be 1..4 hexadecimal digits".into());
            }
            Ok(Some(u16::from_str_radix(s, 16).map_err(|e| e.to_string())?))
        }
        Value::Number(n) => n
            .as_u64()
            .filter(|v| *v <= 65535)
            .map(|v| Some(v as u16))
            .ok_or("USB ID must be an integer 0..65535".into()),
        _ => Err("USB ID must be empty, a hex string, or an integer".into()),
    }
}

pub enum SerialAction {
    Scan,
    Filter {
        ports: Value,
        filter: SerialFilter,
    },
    Open {
        id: String,
        settings: SerialSettings,
    },
    Close(String),
    Listen(String, bool),
    Reconnect(String, bool),
    Reset(String),
    Send {
        id: String,
        bytes: Vec<u8>,
        timeout: u64,
    },
}
pub fn prepare_serial(
    engine: &Engine,
    node: &FlowNode,
    input: &Value,
) -> Result<SerialAction, String> {
    let action = node
        .config
        .get("action")
        .and_then(Value::as_str)
        .ok_or("Serial action missing")?;
    let resolve = |key: &str, default: Value| {
        resolve_ref(engine, input, &reference_default(node, key, default))
    };
    let required = |key: &str| {
        resolve_ref(
            engine,
            input,
            node.config
                .get(key)
                .ok_or_else(|| format!("{key} ValueRef is required"))?,
        )
    };
    if action == "scan" {
        return Ok(SerialAction::Scan);
    }
    if action == "filter" {
        return Ok(SerialAction::Filter {
            ports: resolve("ports", json!({"source":"input","path":["ports"]}))?,
            filter: SerialFilter {
                vid: filter_id(&resolve("vid", literal(json!("")))?)?,
                pid: filter_id(&resolve("pid", literal(json!("")))?)?,
            },
        });
    }
    let id = node
        .config
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or("Serial connection ID missing")?
        .to_owned();
    let connection = engine
        .project
        .connections
        .iter()
        .find(|c| c["id"] == id && c["protocol"] == "serial")
        .ok_or("Missing declared serial connection")?;
    Ok(match action {
        "open" => {
            let mut config = serde_json::Map::new();
            for key in [
                "portName",
                "baudRate",
                "dataBits",
                "stopBits",
                "parity",
                "flowControl",
                "framing",
                "autoReconnect",
            ] {
                if let Some(value) = connection["config"].get(key) {
                    config.insert(key.into(), value.clone());
                }
            }
            if !config.contains_key("portName") {
                if let Some(address) = connection["config"].get("address") {
                    config.insert("portName".into(), address.clone());
                }
            }
            let settings = required("settings")?;
            config.extend(
                settings
                    .as_object()
                    .ok_or("Serial settings must resolve to an object")?
                    .clone(),
            );
            let settings: SerialSettings =
                serde_json::from_value(Value::Object(config)).map_err(|e| e.to_string())?;
            settings.validate().map_err(|e| e.to_string())?;
            SerialAction::Open { id, settings }
        }
        "close" => SerialAction::Close(id),
        "listenStart" => SerialAction::Listen(id, true),
        "listenStop" => SerialAction::Listen(id, false),
        "resetCounters" => SerialAction::Reset(id),
        "setReconnect" => SerialAction::Reconnect(
            id,
            required("enabled")?
                .as_bool()
                .ok_or("Reconnect enabled must be boolean")?,
        ),
        "send" => {
            let data = required("data")?;
            let encoding = required("encoding")?;
            let ending = required("lineEnding")?;
            let timeout = resolve("timeoutMs", literal(json!(5000)))?
                .as_u64()
                .filter(|n| (1..=15000).contains(n))
                .ok_or("timeoutMs must be an integer 1..15000")?;
            let bytes = serial::encode_serial(
                data.as_str().ok_or("Serial data must be a string")?,
                encoding.as_str().ok_or("Encoding must be a string")?,
                ending.as_str().ok_or("Line ending must be a string")?,
            )
            .map_err(|e| e.to_string())?;
            SerialAction::Send { id, bytes, timeout }
        }
        _ => return Err("Unknown serial action".into()),
    })
}
pub async fn serial_action(
    service: &SerialService,
    action: SerialAction,
    cancel: CancellationToken,
) -> Result<Value, SerialError> {
    match action {
        SerialAction::Scan => {
            let ports = serial::scan_ports(SerialFilter::default()).await?;
            let time = now_ms();
            Ok(
                json!({"kind":"snapshot","ports":ports,"added":[],"removed":[],"changed":[],"sequence":time,"timestamp":time,"timestampIso":serial::timestamp_iso(time)}),
            )
        }
        SerialAction::Filter { ports, filter } => {
            let ports = ports.as_array().ok_or_else(|| {
                SerialError::new("INVALID_FILTER", "Serial ports must be an array")
            })?;
            let mut matches = Vec::new();
            for port in ports {
                if port.get("portName").and_then(Value::as_str).is_none() {
                    return Err(SerialError::new(
                        "INVALID_FILTER",
                        "Invalid serial port entry",
                    ));
                }
                let id = |key| -> Result<Option<u16>, SerialError> {
                    match port.get(key) {
                        None | Some(Value::Null) => Ok(None),
                        Some(value) => value
                            .as_u64()
                            .filter(|id| *id <= 65535)
                            .map(|id| Some(id as u16))
                            .ok_or_else(|| {
                                SerialError::new(
                                    "INVALID_FILTER",
                                    "USB IDs must be integers 0..65535 or null",
                                )
                            }),
                    }
                };
                let vid = id("vid")?;
                let pid = id("pid")?;
                if filter.vid.is_none_or(|expected| vid == Some(expected))
                    && filter.pid.is_none_or(|expected| pid == Some(expected))
                {
                    matches.push(port.clone());
                }
            }
            Ok(json!(matches))
        }
        SerialAction::Open { id, settings } => service.open(&id, settings, cancel).await,
        SerialAction::Close(id) => service.close(&id).await,
        SerialAction::Listen(id, value) => service.listen(&id, value),
        SerialAction::Reconnect(id, value) => service.set_reconnect(&id, value),
        SerialAction::Reset(id) => service.reset_counters(&id),
        SerialAction::Send { id, bytes, timeout } => {
            service.send(&id, bytes, timeout, cancel).await
        }
    }
}

pub fn validate_project(project: &Project) -> Result<(), String> {
    for flow in &project.flows {
        for node in &flow.nodes {
            let trigger = node
                .config
                .get("trigger")
                .and_then(Value::as_str)
                .unwrap_or("");
            let modern = ["serial", "usb", "map", "append"].contains(&node.kind.as_str())
                || ["serial", "controlledInterval"].contains(&trigger);
            if !modern {
                continue;
            }
            let action = node
                .config
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("");
            let allowed: &[&str] = match node.kind.as_str() {
                "usb" => match action {
                    "discover" => &["action", "filter"],
                    "communicate" => &[
                        "action",
                        "sessionId",
                        "device",
                        "options",
                        "data",
                        "encoding",
                        "reportId",
                        "length",
                    ],
                    _ => return Err("Unknown USB FB".into()),
                },
                "serial" => match action {
                    "discover" => &["action", "ports", "vid", "pid"],
                    "communicate" => &[
                        "action",
                        "connectionId",
                        "settings",
                        "data",
                        "encoding",
                        "lineEnding",
                        "timeoutMs",
                        "enabled",
                    ],
                    "scan" => &["action"],
                    "filter" => &["action", "ports", "vid", "pid"],
                    "open" => &["action", "connectionId", "settings"],
                    "setReconnect" => &["action", "connectionId", "enabled"],
                    "send" => &[
                        "action",
                        "connectionId",
                        "data",
                        "encoding",
                        "lineEnding",
                        "timeoutMs",
                    ],
                    _ => &["action", "connectionId"],
                },
                "map" => match node.config.get("operation").and_then(Value::as_str) {
                    Some("value") => &["operation", "value"],
                    Some("array") => &["operation", "items", "fields"],
                    _ => &["operation", "fields"],
                },
                "append" => &[
                    "variable",
                    "path",
                    "item",
                    "maxItems",
                    "maxBytes",
                    "order",
                    "droppedPath",
                ],
                "event" if trigger == "controlledInterval" => &["trigger", "interval", "enabled"],
                "event" if trigger == "serial" => {
                    match node.config.get("event").and_then(Value::as_str) {
                        Some("devices") => &["trigger", "event", "connectionId"],
                        Some("data") => &["trigger", "event", "connectionId", "direction"],
                        _ => &["trigger", "event", "connectionId"],
                    }
                }
                _ => return Err("Serial triggers require event nodes".into()),
            };
            if node
                .config
                .keys()
                .any(|key| !allowed.contains(&key.as_str()))
            {
                return Err(format!("Unknown config field in node {}", node.id));
            }
            let check_ref = |value: &Value| -> Result<(), String> {
                fn visit(value: &Value, project: &Project) -> Result<(), String> {
                    let o = value.as_object().ok_or("ValueRef must be an object")?;
                    match o.get("source").and_then(Value::as_str) {
                        Some("literal") => {
                            if o.keys().any(|k| !["source", "value"].contains(&k.as_str())) {
                                return Err("Unknown literal reference field".into());
                            }
                            validate_json(o.get("value").ok_or("Literal missing value")?)?;
                        }
                        Some("input") | Some("variable") => {
                            if o["source"] == "input" && o.contains_key("variable") {
                                return Err("Input reference cannot specify a variable".into());
                            }
                            if o.keys()
                                .any(|k| !["source", "variable", "path"].contains(&k.as_str()))
                            {
                                return Err("Unknown value reference field".into());
                            }
                            if o["source"] == "variable"
                                && !project.variables.iter().any(|v| {
                                    o.get("variable").and_then(Value::as_str) == Some(v.id.as_str())
                                })
                            {
                                return Err("Missing stable variable reference".into());
                            }
                            if let Some(p) = o.get("path") {
                                validate_path(p.as_array().ok_or("Path must be an array")?)?;
                                if o["source"] == "variable"
                                    && !p.as_array().unwrap().is_empty()
                                    && project.variables.iter().any(|v| {
                                        Some(v.id.as_str())
                                            == o.get("variable").and_then(Value::as_str)
                                            && v.value_type != "json"
                                    })
                                {
                                    return Err(
                                        "Nonempty reference paths require JSON variables".into()
                                    );
                                }
                            }
                        }
                        _ => return Err("Unknown ValueRef source".into()),
                    }
                    Ok(())
                }
                visit(value, project)
            };
            let literal_value = |key: &str| {
                node.config
                    .get(key)
                    .filter(|reference| {
                        reference.get("source").and_then(Value::as_str) == Some("literal")
                    })
                    .and_then(|reference| reference.get("value"))
            };
            if node.kind == "usb"
                || (node.kind == "serial" && ["discover", "communicate"].contains(&action))
            {
                let keys: &[&str] = match (node.kind.as_str(), action) {
                    ("usb", "discover") => &["filter"],
                    ("usb", "communicate") => &[
                        "device", "options", "data", "encoding", "reportId", "length",
                    ],
                    ("serial", "discover") => &["ports", "vid", "pid"],
                    _ => &[
                        "settings",
                        "data",
                        "encoding",
                        "lineEnding",
                        "timeoutMs",
                        "enabled",
                    ],
                };
                for key in keys {
                    check_ref(
                        node.config
                            .get(*key)
                            .ok_or_else(|| format!("Missing FB parameter {key}"))?,
                    )?;
                }
                if node.kind == "usb" {
                    if action == "communicate"
                        && !node
                            .config
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.trim().is_empty() && v.len() <= 128)
                    {
                        return Err("Invalid USB session ID".into());
                    }
                    if let Some(v) = literal_value("filter") {
                        serde_json::from_value::<crate::usb::Filter>(v.clone())
                            .map_err(|e| e.to_string())?
                            .native()?;
                    }
                    if let Some(v) = literal_value("options") {
                        serde_json::from_value::<crate::usb::Options>(v.clone())
                            .map_err(|e| e.to_string())?
                            .validate()?;
                    }
                    if literal_value("reportId")
                        .is_some_and(|v| !v.as_u64().is_some_and(|n| n <= 255))
                        || literal_value("length")
                            .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=65535).contains(&n)))
                    {
                        return Err("Invalid HID report ID or feature length".into());
                    }
                    if literal_value("device").is_some_and(|v| {
                        !v.is_null() && !v.is_string() && !v.get("id").is_some_and(Value::is_string)
                    }) {
                        return Err("USB device must be an exact discovered identity".into());
                    }
                } else {
                    if action == "communicate"
                        && !project.connections.iter().any(|c| {
                            c["protocol"] == "serial"
                                && c.get("id") == node.config.get("connectionId")
                        })
                    {
                        return Err("Missing serial connection reference".into());
                    }
                    for key in ["vid", "pid"] {
                        if let Some(v) = literal_value(key) {
                            filter_id(v)?;
                        }
                    }
                    if let Some(v) = literal_value("settings") {
                        let mut c = json!({"portName":"validation-only"});
                        c.as_object_mut().unwrap().extend(
                            v.as_object()
                                .ok_or("Serial settings must be an object")?
                                .clone(),
                        );
                        serde_json::from_value::<SerialSettings>(c)
                            .map_err(|e| e.to_string())?
                            .validate()
                            .map_err(|e| e.to_string())?;
                    }
                    if literal_value("enabled").is_some_and(|v| !v.is_boolean())
                        || literal_value("lineEnding").is_some_and(|v| {
                            ![Some("none"), Some("lf"), Some("crlf")].contains(&v.as_str())
                        })
                        || literal_value("timeoutMs")
                            .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=15000).contains(&n)))
                    {
                        return Err("Invalid serial communication parameters".into());
                    }
                }
                if literal_value("data").is_some_and(|v| !v.is_string())
                    || literal_value("encoding")
                        .is_some_and(|v| ![Some("utf8"), Some("hex")].contains(&v.as_str()))
                {
                    return Err("Invalid communication data or encoding".into());
                }
                continue;
            }
            match node.kind.as_str() {
                "serial" => {
                    let action = node
                        .config
                        .get("action")
                        .and_then(Value::as_str)
                        .ok_or("Serial action missing")?;
                    let required_fields: &[&str] = match action {
                        "open" => &["settings"],
                        "setReconnect" => &["enabled"],
                        "send" => &["data", "encoding", "lineEnding"],
                        _ => &[],
                    };
                    for key in required_fields {
                        check_ref(
                            node.config
                                .get(*key)
                                .ok_or_else(|| format!("{key} ValueRef is required"))?,
                        )?;
                    }
                    if ![
                        "scan",
                        "filter",
                        "open",
                        "close",
                        "listenStart",
                        "listenStop",
                        "setReconnect",
                        "resetCounters",
                        "send",
                    ]
                    .contains(&action)
                    {
                        return Err("Unknown serial action".into());
                    }
                    if !["scan", "filter"].contains(&action)
                        && !project.connections.iter().any(|c| {
                            c["protocol"] == "serial"
                                && c.get("id") == node.config.get("connectionId")
                        })
                    {
                        return Err("Missing serial connection reference".into());
                    }
                    for key in [
                        "ports",
                        "vid",
                        "pid",
                        "settings",
                        "enabled",
                        "data",
                        "encoding",
                        "lineEnding",
                        "timeoutMs",
                    ] {
                        if let Some(v) = node.config.get(key) {
                            check_ref(v)?;
                        }
                    }
                    if action == "filter" {
                        for key in ["vid", "pid"] {
                            if let Some(value) = literal_value(key) {
                                filter_id(value)?;
                            }
                        }
                    }
                    if action == "setReconnect"
                        && literal_value("enabled").is_some_and(|value| !value.is_boolean())
                    {
                        return Err("Reconnect enabled must be boolean".into());
                    }
                    if action == "send" {
                        if literal_value("data").is_some_and(|value| !value.is_string()) {
                            return Err("Send data must be a string".into());
                        }
                        if literal_value("encoding").is_some_and(|value| {
                            ![Some("utf8"), Some("hex")].contains(&value.as_str())
                        }) {
                            return Err("Invalid send encoding".into());
                        }
                        if literal_value("lineEnding").is_some_and(|value| {
                            ![Some("none"), Some("lf"), Some("crlf")].contains(&value.as_str())
                        }) {
                            return Err("Invalid line ending".into());
                        }
                        if literal_value("timeoutMs").is_some_and(|value| {
                            !value
                                .as_u64()
                                .is_some_and(|value| (1..=15000).contains(&value))
                        }) {
                            return Err("Send timeout must be an integer 1..15000".into());
                        }
                    }
                    if action == "open" {
                        if let Some(settings) = literal_value("settings") {
                            let mut candidate = json!({"portName":"validation-only"});
                            candidate.as_object_mut().unwrap().extend(
                                settings
                                    .as_object()
                                    .ok_or("Serial settings must be an object")?
                                    .clone(),
                            );
                            serde_json::from_value::<SerialSettings>(candidate)
                                .map_err(|e| e.to_string())?
                                .validate()
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                "map" => match node.config.get("operation").and_then(Value::as_str) {
                    Some("value") => {
                        check_ref(node.config.get("value").ok_or("Map value missing")?)?
                    }
                    Some("object") | Some("array") => {
                        if node.config["operation"] == "array" {
                            check_ref(node.config.get("items").ok_or("Map items missing")?)?;
                        }
                        for value in node
                            .config
                            .get("fields")
                            .and_then(Value::as_object)
                            .ok_or("Map fields missing")?
                            .values()
                        {
                            check_ref(value)?;
                        }
                    }
                    _ => return Err("Unknown map operation".into()),
                },
                "append" => {
                    let variable = project
                        .variables
                        .iter()
                        .find(|v| {
                            node.config.get("variable").and_then(Value::as_str)
                                == Some(v.id.as_str())
                        })
                        .ok_or("Append variable missing")?;
                    if variable.value_type != "json" || variable.read_only {
                        return Err("Append requires writable JSON variable".into());
                    }
                    check_ref(node.config.get("item").ok_or("Append item missing")?)?;
                    integer(node, "maxItems", 500, 1, 100000)?;
                    integer(node, "maxBytes", 524288, 2, 1048576)?;
                    if node.config.get("order").is_some_and(|order| {
                        ![Some("latestFirst"), Some("oldestFirst")].contains(&order.as_str())
                    }) {
                        return Err("Unknown append order".into());
                    }
                    for key in ["path", "droppedPath"] {
                        if let Some(path) = node.config.get(key) {
                            validate_path(path.as_array().ok_or("Append path must be array")?)?;
                        }
                    }
                    if let Some(dropped) = node.config.get("droppedPath").and_then(Value::as_array)
                    {
                        let path = node
                            .config
                            .get("path")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or_default();
                        if path.starts_with(dropped) || dropped.starts_with(path) {
                            return Err("Array and dropped count paths cannot overlap".into());
                        }
                    }
                }
                "event" if trigger == "serial" => {
                    let event = node
                        .config
                        .get("event")
                        .and_then(Value::as_str)
                        .ok_or("Serial event missing")?;
                    if !["devices", "data", "state", "error"].contains(&event) {
                        return Err("Unknown serial event".into());
                    }
                    if event != "devices"
                        && !project.connections.iter().any(|c| {
                            c["protocol"] == "serial"
                                && c.get("id") == node.config.get("connectionId")
                        })
                    {
                        return Err("Serial event connection missing".into());
                    }
                    if let Some(direction) = node.config.get("direction") {
                        if !["rx", "tx", "both"].contains(&direction.as_str().unwrap_or("")) {
                            return Err("Invalid serial event direction".into());
                        }
                    }
                }
                "event" if trigger == "controlledInterval" => {
                    if literal_value("enabled").is_some_and(|value| !value.is_boolean()) {
                        return Err("Controlled interval enabled must be boolean".into());
                    }
                    if literal_value("interval").is_some_and(|value| {
                        !value
                            .as_u64()
                            .is_some_and(|value| (100..=86400000).contains(&value))
                    }) {
                        return Err("Controlled interval must be an integer 100..86400000".into());
                    }
                    for key in ["interval", "enabled"] {
                        if let Some(v) = node.config.get(key) {
                            check_ref(v)?;
                        }
                    }
                }
                _ => {}
            }
            if ["serial", "map", "append"].contains(&node.kind.as_str())
                && flow
                    .edges
                    .iter()
                    .filter(|edge| edge.source == node.id && !crate::function_blocks::is_data(edge))
                    .any(|edge| {
                        edge.source_handle
                            .as_deref()
                            .is_some_and(|p| p != "success" && p != "error")
                    })
            {
                return Err("Action node handle must be success or error".into());
            }
        }
    }
    Ok(())
}

pub async fn run_shared(
    engine: Arc<Mutex<Engine>>,
    serial: Option<SerialService>,
    flow_id: &str,
    entry: Option<&str>,
    input: Value,
    cancel: CancellationToken,
    host: Option<&ScriptHost>,
) -> Result<RuntimeSnapshot, String> {
    run_activation_shared(engine, serial, flow_id, entry, input, cancel, host, None).await
}
pub async fn run_output_shared(
    engine: Arc<Mutex<Engine>>,
    serial: Option<SerialService>,
    flow_id: &str,
    node: &str,
    port: &str,
    input: Value,
    cancel: CancellationToken,
    host: Option<&ScriptHost>,
) -> Result<RuntimeSnapshot, String> {
    run_activation_shared(
        engine,
        serial,
        flow_id,
        Some(node),
        input,
        cancel,
        host,
        Some(port),
    )
    .await
}
async fn run_activation_shared(
    engine: Arc<Mutex<Engine>>,
    serial: Option<SerialService>,
    flow_id: &str,
    entry: Option<&str>,
    input: Value,
    cancel: CancellationToken,
    host: Option<&ScriptHost>,
    output: Option<&str>,
) -> Result<RuntimeSnapshot, String> {
    let cancel = cancel.child_token();
    let _cancel_on_return = cancel.clone().drop_guard();
    let (flow, epoch, order, run_id) = {
        let mut e = engine.lock().await;
        if !e.snapshot.running {
            return Err("Runtime stopped".into());
        }
        let (flow, order) = e.flow_plans.get(flow_id).cloned().ok_or("Unknown flow")?;
        if entry.is_some_and(|id| {
            !flow.nodes.iter().any(|n| {
                n.id == id
                    && (n.kind == "event"
                        || output.is_some_and(|p| {
                            crate::function_blocks::execution_outputs(n).contains(&p)
                        }))
            })
        }) {
            return Err("Unknown event entry".into());
        }
        if !flow.enabled {
            return Err("Flow disabled".into());
        }
        e.v4_next_run += 1;
        let run_id = e.v4_next_run;
        e.v4_runs.insert(run_id, String::new());
        e.snapshot.running = true;
        e.notify();
        (flow, e.execution_epoch, order, run_id)
    };
    let operation = async {
        let pending: BTreeMap<String, VecDeque<crate::function_blocks::Activation>> = flow
            .nodes
            .iter()
            .filter(|n| {
                (n.kind == "event" || output.is_some())
                    && match entry {
                        Some(id) => n.id == id,
                        None => {
                            n.config
                                .get("trigger")
                                .and_then(Value::as_str)
                                .unwrap_or("manual")
                                == "manual"
                        }
                    }
            })
            .map(|n| {
                (
                    n.id.clone(),
                    VecDeque::from([crate::function_blocks::Activation {
                        value: input.clone(),
                        port: "input".into(),
                        output: output.map(str::to_owned),
                    }]),
                )
            })
            .collect();
        if pending.is_empty() {
            return Err("This flow has no manual event entry; external events require their real runtime source".into());
        }
        crate::function_blocks::run_graph(
            engine.clone(),
            serial.as_ref(),
            &flow,
            &order,
            pending,
            epoch,
            run_id,
            &cancel,
            host,
        )
        .await
    };
    let result = tokio::select! {_=cancel.cancelled()=>Err("Flow cancelled".into()),result=tokio::time::timeout(Duration::from_secs(60),operation)=>result.map_err(|_|"Flow exceeded deadline".to_owned()).and_then(|r|r)};
    let mut e = engine.lock().await;
    if e.execution_epoch == epoch {
        e.v4_runs.remove(&run_id);
        e.snapshot.active_nodes = e
            .v4_runs
            .values()
            .filter(|id| !id.is_empty())
            .cloned()
            .collect();
        e.notify();
        if let Err(error) = &result {
            e.log("error", error.clone(), Some(flow_id), None);
        }
    }
    result?;
    Ok(e.snapshot())
}

pub(crate) async fn execute_shared_node(
    engine: &Arc<Mutex<Engine>>,
    serial: Option<&SerialService>,
    flow: &crate::Flow,
    node: &FlowNode,
    port: &str,
    input: Value,
    epoch: u64,
    cancel: &CancellationToken,
    host: Option<&ScriptHost>,
) -> Result<(Value, Option<String>), String> {
    let result: Result<Value, Value> = match node.kind.as_str() {
        "usb" => {
            let action = node
                .config
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("");
            let command = if port == "input" {
                if action == "discover" {
                    "scan"
                } else {
                    "send"
                }
            } else {
                port
            };
            let keys: &[&str] = match (action, command) {
                ("discover", "unwatch") => &[],
                ("discover", _) => &["filter"],
                (_, "open") => &["device", "options"],
                (_, "send" | "featureSend") => &["data", "encoding", "reportId"],
                (_, "featureGet") => &["reportId", "length"],
                _ => &[],
            };
            let resolved = {
                let e = engine.lock().await;
                node.config
                    .iter()
                    .filter(|(k, _)| keys.contains(&k.as_str()))
                    .map(|(k, v)| resolve_ref(&e, &input, v).map(|v| (k.clone(), v)))
                    .collect::<Result<BTreeMap<_, _>, _>>()
            };
            match (serial, resolved) {
                (Some(service), Ok(c)) => {
                    let action = node
                        .config
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if action == "discover" {
                        let filter = serde_json::from_value::<crate::usb::Filter>(
                            c.get("filter").cloned().unwrap_or(json!({})),
                        )
                        .map_err(crate::usb::diagnostic);
                        match filter {
                            Ok(filter) => service
                                .usb()
                                .discover(
                                    &flow.id,
                                    &node.id,
                                    if port == "input" { "scan" } else { port },
                                    filter,
                                )
                                .await
                                .map(|v| crate::usb::envelope(v, "success")),
                            Err(e) => Err(e),
                        }
                    } else {
                        let command = if port == "input" { "send" } else { port };
                        let id = node
                            .config
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let prepared = (|| -> Result<_, String> {
                            let options = serde_json::from_value::<crate::usb::Options>(
                                c.get("options").cloned().unwrap_or(json!({})),
                            )
                            .map_err(|e| e.to_string())?;
                            let bytes = if ["send", "featureSend"].contains(&command) {
                                serial::encode_serial(
                                    c.get("data")
                                        .and_then(Value::as_str)
                                        .ok_or("USB send data must be a string")?,
                                    c.get("encoding").and_then(Value::as_str).unwrap_or("hex"),
                                    "none",
                                )
                                .map_err(|e| e.to_string())?
                            } else {
                                Vec::new()
                            };
                            let report_id = c
                                .get("reportId")
                                .unwrap_or(&json!(0))
                                .as_u64()
                                .filter(|v| *v <= 255)
                                .ok_or("Report ID must be 0..255")?
                                as u8;
                            let length = c
                                .get("length")
                                .unwrap_or(&json!(64))
                                .as_u64()
                                .filter(|v| (1..=65535).contains(v))
                                .ok_or("Feature length must be 1..65535")?
                                as usize;
                            Ok((options, bytes, report_id, length))
                        })();
                        match prepared {
                            Ok((options, bytes, report_id, length)) => service
                                .usb()
                                .command(
                                    id,
                                    command,
                                    c.get("device").cloned().unwrap_or(Value::Null),
                                    options,
                                    bytes,
                                    report_id,
                                    length,
                                    cancel.child_token(),
                                )
                                .await
                                .map(|(v, _)| crate::usb::envelope(v, "success")),
                            Err(e) => Err(crate::usb::diagnostic(e)),
                        }
                    }
                }
                (None, _) => Err(
                    json!({"code":"NATIVE_USB_REQUIRED","message":"USB requires the desktop runtime"}),
                ),
                (_, Err(e)) => Err(crate::usb::diagnostic(e)),
            }
        }
        "serial" => {
            let action = node
                .config
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut operation = node.clone();
            if action == "communicate" {
                let command = if port == "input" { "send" } else { port };
                operation.config.insert("action".into(), json!(command));
            }
            if action == "discover" {
                operation.config.insert(
                    "action".into(),
                    json!(if port == "filter" { "filter" } else { "scan" }),
                );
            }
            let (prepared, discovery_filter) = {
                let e = engine.lock().await;
                let filter = (|| -> Result<SerialFilter, String> {
                    if action != "discover" || ["filter", "unwatch"].contains(&port) {
                        return Ok(SerialFilter::default());
                    }
                    Ok(SerialFilter {
                        vid: filter_id(&resolve_ref(&e, &input, &node.config["vid"])?)?,
                        pid: filter_id(&resolve_ref(&e, &input, &node.config["pid"])?)?,
                    })
                })();
                (prepare_serial(&e, &operation, &input), filter)
            };
            match prepared {
                Ok(operation) => match serial {
                    Some(service) => {
                        if action == "discover" && ["watch", "unwatch"].contains(&port) {
                            service.watch_discovery(&flow.id, &node.id, port == "watch");
                        }
                        if action == "discover" && port == "unwatch" {
                            Ok(crate::usb::envelope(
                                json!({"kind":"stopped","ports":[]}),
                                "success",
                            ))
                        } else {
                            serial_action(service, operation, cancel.child_token())
                                .await
                                .map_err(|e| json!(e))
                                .and_then(|mut value| {
                                    if action == "discover" && port != "filter" {
                                        let filter =
                                            discovery_filter.map_err(crate::usb::diagnostic)?;
                                        let ports =
                                            serde_json::from_value::<Vec<serial::SerialPortInfo>>(
                                                value["ports"].clone(),
                                            )
                                            .map_err(crate::usb::diagnostic)?;
                                        value["ports"] = json!(ports
                                            .into_iter()
                                            .filter(|p| filter.matches(p))
                                            .collect::<Vec<_>>());
                                    }
                                    Ok(if ["discover", "communicate"].contains(&action) {
                                        crate::usb::envelope(value, "success")
                                    } else {
                                        value
                                    })
                                })
                        }
                    }
                    None => Err(
                        json!({"code":"NATIVE_REQUIRED","message":"Serial requires the desktop runtime"}),
                    ),
                },
                Err(error) => Err(json!({"code":"INVALID_CONFIG","message":error})),
            }
        }
        "map" => {
            let e = engine.lock().await;
            map_value(&e, node, &input).map_err(|e| json!({"code":"MAP_ERROR","message":e}))
        }
        "append" => {
            let mut e = engine.lock().await;
            if !(!cancel.is_cancelled() && e.snapshot.running && e.execution_epoch == epoch) {
                return Err("Stale append".into());
            }
            append_value(&mut e, node, &input)
                .map_err(|e| json!({"code":"APPEND_ERROR","message":e}))
        }
        "delay" => {
            let ms = node
                .config
                .get("ms")
                .and_then(Value::as_u64)
                .ok_or("Invalid delay")?
                .min(60000);
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(input.clone())
        }
        "script" => {
            let id = node
                .config
                .get("scriptId")
                .and_then(Value::as_str)
                .ok_or("Missing script")?;
            let response = script_shared_context(
                engine.clone(),
                id,
                input.clone(),
                cancel.child_token(),
                host.ok_or("Native C worker required")?,
                Some((&flow.id, &node.id)),
            )
            .await?;
            Ok(response.output)
        }
        "http" | "connection" => {
            let connections = { engine.lock().await.project.connections.clone() };
            crate::external_request(&connections, node)
                .await
                .map_err(|e| json!({"code":"IO_ERROR","message":e}))
        }
        _ => {
            let mut e = engine.lock().await;
            if !(!cancel.is_cancelled() && e.snapshot.running && e.execution_epoch == epoch) {
                return Err("Stale node".into());
            }
            e.execute_node(&flow, node, input.clone(), cancel.child_token(), host)
                .await
                .map_err(|e| json!({"code":"NODE_ERROR","message":e}))
        }
    };
    {
        let e = engine.lock().await;
        if !(!cancel.is_cancelled() && e.snapshot.running && e.execution_epoch == epoch) {
            return Err("Stale IO continuation".into());
        }
    }

    let action = ["serial", "usb", "map", "append"].contains(&node.kind.as_str());
    match result {
        Ok(value) if node.kind == "condition" => Ok((
            input,
            Some(
                if value.as_bool().unwrap_or(false) {
                    "true"
                } else {
                    "false"
                }
                .into(),
            ),
        )),
        Ok(value) => Ok((value, action.then(|| "success".into()))),
        Err(mut error) => {
            error["operation"] = json!(node
                .config
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or(node.kind.as_str()));
            if let Some(id) = node.config.get("connectionId") {
                error["connectionId"] = id.clone();
            }
            if action {
                Ok((error, Some("error".into())))
            } else {
                Err(error.to_string())
            }
        }
    }
}

pub async fn script_shared(
    engine: Arc<Mutex<Engine>>,
    script_id: &str,
    input: Value,
    cancel: CancellationToken,
    host: &ScriptHost,
) -> Result<crate::ScriptResponse, String> {
    script_shared_context(engine, script_id, input, cancel, host, None).await
}

async fn script_shared_context(
    engine: Arc<Mutex<Engine>>,
    script_id: &str,
    input: Value,
    cancel: CancellationToken,
    host: &ScriptHost,
    context: Option<(&str, &str)>,
) -> Result<crate::ScriptResponse, String> {
    let (gate, epoch) = {
        let e = engine.lock().await;
        let gate = e
            .script_locks
            .lock()
            .unwrap()
            .entry(script_id.into())
            .or_default()
            .clone();
        (gate, e.execution_epoch)
    };
    let _guard = tokio::select! {_=cancel.cancelled()=>return Err("Script cancelled".into()),guard=gate.lock()=>guard};
    let request = {
        let e = engine.lock().await;
        if cancel.is_cancelled() || e.execution_epoch != epoch || !e.snapshot.running {
            return Err("Stale script request".into());
        }
        let script = e
            .project
            .scripts
            .iter()
            .find(|s| s.id == script_id)
            .ok_or("Missing script")?;
        ScriptRequest {
            source: script.source.clone(),
            input,
            variables: e.script_variables(),
            state: e
                .script_state
                .get(&e.script_state_key(script_id, context.map(|c| c.0), context.map(|c| c.1)))
                .cloned()
                .unwrap_or_default(),
            timeout_ms: script.timeout_ms,
            variable_aliases: script.variable_aliases.clone(),
        }
    };
    let response = host.execute(request, cancel.clone()).await?;
    let mut e = engine.lock().await;
    if cancel.is_cancelled() || e.execution_epoch != epoch || !e.snapshot.running {
        return Err("Stale script result".into());
    }
    e.apply_script_response_context(
        script_id,
        &response,
        context.map(|c| c.0),
        context.map(|c| c.1),
    )?;
    Ok(response)
}
