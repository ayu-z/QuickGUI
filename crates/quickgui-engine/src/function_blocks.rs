//! Versioned FB data interfaces. Execution wires trigger; data wires supply named values.
use crate::serial::SerialService;
use crate::{
    read_path, validate_json, validate_path, CancellationToken, Engine, Flow, FlowNode, Project,
    ScriptHost,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::Arc,
};
use tokio::sync::Mutex;
#[cfg(test)]
#[path = "function_blocks_tests.rs"]
mod tests;

fn present_json<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataInput {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: String,
    pub binding: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_value: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataOutput {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: String,
    pub path: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockInterface {
    pub version: u32,
    pub inputs: Vec<DataInput>,
    pub outputs: Vec<DataOutput>,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphabetic()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_key(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && (id.as_bytes()[0].is_ascii_alphabetic() || id.starts_with('_'))
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !["__proto__", "constructor", "prototype"].contains(&id)
}
fn config_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "math" => &["operand"],
        "condition" => &["value"],
        "delay" => &["ms"],
        "log" => &["message"],
        "emit" => &["event"],
        "http" => &["url", "method", "body"],
        "usb" => &[
            "filter", "device", "options", "data", "encoding", "reportId", "length",
        ],
        "serial" => &[
            "ports",
            "vid",
            "pid",
            "settings",
            "data",
            "encoding",
            "lineEnding",
            "timeoutMs",
            "enabled",
        ],
        _ => &[],
    }
}
fn check_type(kind: &str, value: &Value, name: &str) -> Result<(), String> {
    let valid = match kind {
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "json" => true,
        _ => false,
    };
    if !valid {
        return Err(format!("Data port {name} requires {kind}"));
    }
    validate_json(value)?;
    Ok(())
}
pub fn default_output(node: &FlowNode) -> &'static str {
    match node.kind.as_str() {
        "serial" | "usb" | "map" | "append" => "success",
        "condition" => "true",
        _ => "output",
    }
}
pub fn is_data(edge: &crate::FlowEdge) -> bool {
    edge.kind.as_deref() == Some("data")
}

pub fn validate_project(project: &Project) -> Result<(), String> {
    for flow in &project.flows {
        for node in &flow.nodes {
            let Some(block) = &node.block else {
                continue;
            };
            if block.version != 1 || block.inputs.len() > 16 || block.outputs.len() > 16 {
                return Err("Unsupported FB interface version or port limit".into());
            }
            for ports in [
                block
                    .inputs
                    .iter()
                    .map(|p| (&p.id, &p.name, &p.value_type))
                    .collect::<Vec<_>>(),
                block
                    .outputs
                    .iter()
                    .map(|p| (&p.id, &p.name, &p.value_type))
                    .collect(),
            ] {
                let (mut ids, mut names) = (BTreeSet::new(), BTreeSet::new());
                for (id, name, kind) in ports {
                    if !valid_id(id)
                        || name.trim().is_empty()
                        || name.chars().count() > 64
                        || !ids.insert(id)
                        || !names.insert(name)
                        || !["number", "boolean", "string", "json"].contains(&kind.as_str())
                    {
                        return Err(format!("Invalid or duplicate data port on {}", node.id));
                    }
                }
            }
            let mut bindings = BTreeSet::new();
            for input in &block.inputs {
                let key = input.key.as_deref().unwrap_or("");
                if node.kind == "event" || !bindings.insert((&input.binding, key)) {
                    return Err("Invalid or duplicate data input binding".into());
                }
                match input.binding.as_str() {
                    "input" if input.key.is_none() => {}
                    "config"
                        if valid_key(key)
                            && config_keys(&node.kind).contains(&key)
                            && node.config.contains_key(key) => {}
                    "field"
                        if valid_key(key) && ["script", "map"].contains(&node.kind.as_str()) => {}
                    _ => return Err(format!("Invalid data input binding: {}", input.name)),
                }
                if let Some(value) = &input.default_value {
                    check_type(&input.value_type, value, &input.name)?;
                }
            }
            if block.inputs.iter().any(|p| p.binding == "input")
                && block.inputs.iter().any(|p| p.binding == "field")
            {
                return Err("Cannot mix a whole input with named object inputs".into());
            }
            for output in &block.outputs {
                validate_path(&output.path)?;
            }
        }
        let mut targets = BTreeSet::new();
        for edge in &flow.edges {
            if edge.kind.is_some() && !is_data(edge) {
                return Err("Data edges require kind=data".into());
            }
            let source = flow
                .nodes
                .iter()
                .find(|n| n.id == edge.source)
                .ok_or("Missing source node")?;
            let target = flow
                .nodes
                .iter()
                .find(|n| n.id == edge.target)
                .ok_or("Missing target node")?;
            if !is_data(edge) {
                {
                    let port = edge
                        .source_handle
                        .as_deref()
                        .unwrap_or(default_output(source));
                    let valid = execution_outputs(source).contains(&port);
                    if !valid
                        || !execution_inputs(target)
                            .contains(&edge.target_handle.as_deref().unwrap_or("input"))
                    {
                        return Err("Invalid execution port".into());
                    }
                }
                continue;
            }
            let output = source
                .block
                .as_ref()
                .and_then(|b| {
                    b.outputs.iter().find(|p| {
                        Some(format!("data-out:{}", p.id)).as_deref()
                            == edge.source_handle.as_deref()
                    })
                })
                .ok_or("Missing source data port")?;
            let input = target
                .block
                .as_ref()
                .and_then(|b| {
                    b.inputs.iter().find(|p| {
                        Some(format!("data-in:{}", p.id)).as_deref()
                            == edge.target_handle.as_deref()
                    })
                })
                .ok_or("Missing target data port")?;
            if input.value_type != "json" && input.value_type != output.value_type {
                return Err("Incompatible data port types".into());
            }
            if !targets.insert((&edge.target, &edge.target_handle)) {
                return Err("Data input already has a source".into());
            }
        }
    }
    Ok(())
}

fn prepare(
    node: &FlowNode,
    message: Value,
    values: &BTreeMap<String, Value>,
) -> Result<(FlowNode, Value), String> {
    let mut prepared = node.clone();
    let Some(block) = &node.block else {
        return Ok((prepared, message));
    };
    let mut input = message.clone();
    let mut fields = serde_json::Map::new();
    for port in &block.inputs {
        let value = if let Some(value) = values.get(&port.id) {
            value.clone()
        } else if let Some(value) = &port.default_value {
            value.clone()
        } else if port.binding == "input" {
            message.clone()
        } else if port.binding == "config" {
            if ["serial", "usb"].contains(&node.kind.as_str()) {
                continue;
            }
            node.config
                .get(port.key.as_deref().unwrap_or(""))
                .cloned()
                .ok_or("Missing config data input")?
        } else {
            return Err(format!("Missing value for data input {}", port.name));
        };
        check_type(&port.value_type, &value, &port.name)?;
        match port.binding.as_str() {
            "input" => {
                input = value;
                if node.kind == "write" {
                    prepared.config.remove("value");
                }
            }
            "field" => {
                fields.insert(port.key.clone().unwrap(), value);
            }
            _ => {
                prepared.config.insert(
                    port.key.clone().unwrap(),
                    if ["serial", "usb"].contains(&node.kind.as_str()) {
                        json!({"source":"literal","value":value})
                    } else {
                        value
                    },
                );
            }
        }
    }
    if !fields.is_empty() {
        input = Value::Object(fields);
    }
    Ok((prepared, input))
}

#[derive(Clone)]
pub(crate) struct Activation {
    pub value: Value,
    pub port: String,
    pub output: Option<String>,
}
impl Activation {
    pub fn input(value: Value) -> Self {
        Self {
            value,
            port: "input".into(),
            output: None,
        }
    }
}
pub fn execution_inputs(node: &FlowNode) -> Vec<&'static str> {
    match (
        node.kind.as_str(),
        node.config.get("action").and_then(Value::as_str),
    ) {
        ("serial", Some("discover")) => vec!["input", "scan", "filter", "watch", "unwatch"],
        ("usb", Some("discover")) => vec!["input", "scan", "watch", "unwatch"],
        ("serial", Some("communicate")) => vec![
            "input",
            "open",
            "close",
            "send",
            "listenStart",
            "listenStop",
            "setReconnect",
            "resetCounters",
        ],
        ("usb", Some("communicate")) => vec![
            "input",
            "open",
            "close",
            "send",
            "featureSend",
            "featureGet",
            "descriptor",
        ],
        ("event", _) => vec![],
        _ => vec!["input"],
    }
}
pub fn execution_outputs(node: &FlowNode) -> Vec<&'static str> {
    match (
        node.kind.as_str(),
        node.config.get("action").and_then(Value::as_str),
    ) {
        ("serial" | "usb", Some("discover")) => vec!["success", "changed", "error"],
        ("serial", Some("communicate")) => vec!["success", "rx", "tx", "state", "error"],
        ("usb", Some("communicate")) => vec![
            "success",
            "rx",
            "tx",
            "state",
            "feature",
            "descriptor",
            "error",
        ],
        ("serial" | "usb" | "map" | "append", _) => vec!["success", "error"],
        ("condition", _) => vec!["true", "false", "error"],
        ("event", _) => vec!["output"],
        _ if node.block.is_some() => vec!["output", "error"],
        _ => vec!["output"],
    }
}
struct GraphRun<'a> {
    engine: Arc<Mutex<Engine>>,
    serial: Option<&'a SerialService>,
    flow: &'a Flow,
    pending: BTreeMap<String, VecDeque<Activation>>,
    data: BTreeMap<String, BTreeMap<String, Value>>,
    epoch: u64,
    run_id: u64,
    cancel: &'a CancellationToken,
    host: Option<&'a ScriptHost>,
    activations: usize,
    evaluating: BTreeSet<String>,
    failed: BTreeSet<String>,
}
impl GraphRun<'_> {
    fn evaluate<'a>(
        &'a mut self,
        id: String,
        activation: Activation,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            self.activations += 1;
            if self.activations > 10000 || !self.evaluating.insert(id.clone()) {
                return Err("Flow activation limit or cyclic data dependency".into());
            }
            let node = self
                .flow
                .nodes
                .iter()
                .find(|n| n.id == id)
                .ok_or("Missing FB node")?
                .clone();
            let message = activation.value.clone();
            let mut values = BTreeMap::new();
            for input in node
                .block
                .as_ref()
                .map(|b| &b.inputs)
                .into_iter()
                .flatten()
                .filter(|_| activation.output.is_none())
            {
                let Some(wire) = self
                    .flow
                    .edges
                    .iter()
                    .find(|e| {
                        is_data(e)
                            && e.target == id
                            && e.target_handle.as_deref() == Some(&format!("data-in:{}", input.id))
                    })
                    .cloned()
                else {
                    continue;
                };
                let source = self
                    .flow
                    .nodes
                    .iter()
                    .find(|n| n.id == wire.source)
                    .ok_or("Missing data source")?
                    .clone();
                if !self.data.contains_key(&source.id) {
                    if source.block.is_none()
                        || source.kind == "event"
                        || ["serial", "usb"].contains(&source.kind.as_str())
                        || self
                            .flow
                            .edges
                            .iter()
                            .any(|e| !is_data(e) && e.target == source.id)
                    {
                        return Err(format!(
                            "Data input {}.{}: upstream block has not executed in this run",
                            node.label, input.name
                        ));
                    }
                    self.evaluate(source.id.clone(), Activation::input(Value::Null))
                        .await?;
                }
                if self.failed.contains(&source.id) {
                    self.failed.insert(id.clone());
                    self.data.insert(id.clone(), BTreeMap::new());
                    self.evaluating.remove(&id);
                    return Ok(());
                }
                let port = source
                    .block
                    .as_ref()
                    .unwrap()
                    .outputs
                    .iter()
                    .find(|p| wire.source_handle.as_deref() == Some(&format!("data-out:{}", p.id)))
                    .ok_or("Missing data output")?;
                let value = self
                    .data
                    .get(&source.id)
                    .and_then(|data| data.get(&port.id))
                    .ok_or_else(|| {
                        format!("Data output {}.{} unavailable", source.label, port.name)
                    })?;
                values.insert(input.id.clone(), value.clone());
            }
            let (prepared, input) = if activation.output.is_some() {
                (node.clone(), message.clone())
            } else {
                prepare(&node, message.clone(), &values)?
            };
            {
                let mut engine = self.engine.lock().await;
                if self.cancel.is_cancelled()
                    || !engine.snapshot.running
                    || engine.execution_epoch != self.epoch
                {
                    return Err("Execution cancelled by project revision".into());
                }
                engine.v4_runs.insert(self.run_id, node.id.clone());
                engine.snapshot.active_nodes = engine
                    .v4_runs
                    .values()
                    .filter(|id| !id.is_empty())
                    .cloned()
                    .collect();
                engine.notify_activity(
                    activation.output.is_none()
                        && matches!(
                            node.kind.as_str(),
                            "delay" | "serial" | "usb" | "script" | "http" | "connection"
                        ),
                );
            }
            let result = if let Some(port) = activation.output {
                Ok((message.clone(), Some(port)))
            } else {
                crate::flow_v4::execute_shared_node(
                    &self.engine,
                    self.serial,
                    self.flow,
                    &prepared,
                    &activation.port,
                    input.clone(),
                    self.epoch,
                    self.cancel,
                    self.host,
                )
                .await
            };
            {
                let engine = self.engine.lock().await;
                if self.cancel.is_cancelled()
                    || !engine.snapshot.running
                    || engine.execution_epoch != self.epoch
                {
                    return Err("Stale FB continuation".into());
                }
            }
            let (value, port) = match result {
                Ok(result) => result,
                Err(error) if node.block.is_some() => (
                    json!({"code":"BLOCK_ERROR","message":error,"operation":node.kind}),
                    Some("error".into()),
                ),
                Err(error) => return Err(error),
            };
            let port = port.as_deref().unwrap_or(default_output(&node));
            let edges: Vec<_> = self
                .flow
                .edges
                .iter()
                .filter(|e| {
                    !is_data(e)
                        && e.source == id
                        && e.source_handle.as_deref().unwrap_or(default_output(&node)) == port
                })
                .collect();
            if port == "error" && edges.is_empty() {
                return Err(format!("Unhandled block error: {value}"));
            }
            if port == "error" {
                self.failed.insert(id.clone());
            } else {
                self.failed.remove(&id);
            }
            let output = if node.kind == "condition" {
                json!({"Q":port == "true","IN":input})
            } else {
                value.clone()
            };
            let mut data = BTreeMap::new();
            if port != "error" {
                for port in node
                    .block
                    .as_ref()
                    .map(|b| &b.outputs)
                    .into_iter()
                    .flatten()
                {
                    let value = read_path(&output, &port.path)?;
                    check_type(&port.value_type, value, &port.name)?;
                    data.insert(port.id.clone(), value.clone());
                }
            }
            self.data.insert(id.clone(), data);
            for edge in edges {
                let queue = self.pending.entry(edge.target.clone()).or_default();
                if queue.len() >= 256 {
                    return Err("Node input queue limit exceeded".into());
                }
                queue.push_back(Activation {
                    value: if ["serial", "usb"].contains(&node.kind.as_str())
                        && [Some("discover"), Some("communicate")]
                            .contains(&node.config.get("action").and_then(Value::as_str))
                        && port != "error"
                    {
                        value["result"].clone()
                    } else {
                        value.clone()
                    },
                    port: edge.target_handle.clone().unwrap_or_else(|| "input".into()),
                    output: None,
                });
            }
            self.evaluating.remove(&id);
            Ok(())
        })
    }
}
pub(crate) async fn run_graph(
    engine: Arc<Mutex<Engine>>,
    serial: Option<&SerialService>,
    flow: &Flow,
    order: &[usize],
    pending: BTreeMap<String, VecDeque<Activation>>,
    epoch: u64,
    run_id: u64,
    cancel: &CancellationToken,
    host: Option<&ScriptHost>,
) -> Result<(), String> {
    let mut run = GraphRun {
        engine,
        serial,
        flow,
        pending,
        data: BTreeMap::new(),
        epoch,
        run_id,
        cancel,
        host,
        activations: 0,
        evaluating: BTreeSet::new(),
        failed: BTreeSet::new(),
    };
    loop {
        let Some(id) = order
            .iter()
            .map(|i| &flow.nodes[*i].id)
            .find(|id| run.pending.get(*id).is_some_and(|p| !p.is_empty()))
            .cloned()
        else {
            break;
        };
        let message = run.pending.get_mut(&id).unwrap().pop_front().unwrap();
        run.evaluate(id, message).await?;
    }
    Ok(())
}
