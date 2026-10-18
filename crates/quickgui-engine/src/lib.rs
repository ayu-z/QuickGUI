//! Portable QuickGUI graph execution. UI documents remain in the project model.
mod connections;
mod history;
mod types;
mod worker;
pub use connections::{test_connection, Connection, ConnectionTestResult};
pub use history::{AlarmRecord, HistorySample, HistoryStore, RetentionPolicy};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub use tokio_util::sync::CancellationToken;
pub use types::*;
pub use worker::ScriptHost;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Returns a deterministic topological order, rejecting dangling edges and cycles.
pub fn validate_flow(flow: &Flow) -> Result<Vec<usize>, String> {
    if flow.nodes.len() > 10_000 || flow.edges.len() > 50_000 {
        return Err("Flow exceeds node/edge limits".into());
    }
    let mut ids = BTreeMap::new();
    let known = [
        "event",
        "read",
        "write",
        "condition",
        "math",
        "delay",
        "log",
        "script",
        "http",
        "emit",
        "connection",
    ];
    for (i, node) in flow.nodes.iter().enumerate() {
        if node.id.is_empty() || ids.insert(node.id.as_str(), i).is_some() {
            return Err(format!("Duplicate or empty node ID: {}", node.id));
        }
        if !known.contains(&node.kind.as_str()) {
            return Err(format!("Unsupported node kind: {}", node.kind));
        }
    }
    let mut indegree = vec![0usize; flow.nodes.len()];
    let mut next = vec![Vec::new(); flow.nodes.len()];
    let mut edge_ids = BTreeSet::new();
    for edge in &flow.edges {
        if !edge_ids.insert(&edge.id) {
            return Err(format!("Duplicate edge ID: {}", edge.id));
        }
        let source = *ids
            .get(edge.source.as_str())
            .ok_or_else(|| format!("Missing source node: {}", edge.source))?;
        let target = *ids
            .get(edge.target.as_str())
            .ok_or_else(|| format!("Missing target node: {}", edge.target))?;
        if flow.nodes[target].kind == "event" {
            return Err("Event nodes cannot have incoming edges".into());
        }
        next[source].push(target);
        indegree[target] += 1;
    }
    let mut queue: VecDeque<usize> = indegree
        .iter()
        .enumerate()
        .filter(|(_, n)| **n == 0)
        .map(|(i, _)| i)
        .collect();
    let mut order = Vec::new();
    while let Some(i) = queue.pop_front() {
        order.push(i);
        for &target in &next[i] {
            indegree[target] -= 1;
            if indegree[target] == 0 {
                queue.push_back(target);
            }
        }
    }
    if order.len() != flow.nodes.len() {
        return Err("Flow contains a cycle; use explicit events for repeated work".into());
    }
    if !flow.nodes.iter().any(|n| n.kind == "event") {
        return Err("Flow needs an event entry node".into());
    }
    Ok(order)
}

pub struct Engine {
    project: Project,
    snapshot: RuntimeSnapshot,
    script_state: BTreeMap<String, BTreeMap<String, f64>>,
    sequence: u64,
    snapshot_sequence: std::sync::atomic::AtomicU64,
    observer: Option<std::sync::Arc<dyn Fn(RuntimeSnapshot) + Send + Sync>>,
    event_observer: Option<std::sync::Arc<dyn Fn(RuntimeEvent) + Send + Sync>>,
}

impl Engine {
    pub fn new(project: Project) -> Result<Self, String> {
        if project.schema_version != 1 {
            return Err(format!(
                "Unsupported project schema {}",
                project.schema_version
            ));
        }
        let mut snapshot = RuntimeSnapshot {
            revision: project.revision,
            ..Default::default()
        };
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for variable in &project.variables {
            if !ids.insert(&variable.id) || !names.insert(&variable.name) {
                return Err("Duplicate variable ID or name".into());
            }
            validate_value(variable, &variable.initial)?;
            snapshot.values.insert(
                variable.id.clone(),
                RuntimeValue {
                    value: variable.initial.clone(),
                    quality: "good".into(),
                    timestamp: now_ms(),
                },
            );
        }
        let mut flow_ids = BTreeSet::new();
        for flow in &project.flows {
            if !flow_ids.insert(&flow.id) {
                return Err("Duplicate flow ID".into());
            }
            validate_flow(flow)?;
        }
        let mut script_ids = BTreeSet::new();
        for script in &project.scripts {
            if !script_ids.insert(&script.id) {
                return Err("Duplicate script ID".into());
            }
        }
        Ok(Self {
            project,
            snapshot,
            script_state: BTreeMap::new(),
            sequence: 0,
            snapshot_sequence: std::sync::atomic::AtomicU64::new(0),
            observer: None,
            event_observer: None,
        })
    }
    pub fn snapshot(&self) -> RuntimeSnapshot {
        let mut snapshot = self.snapshot.clone();
        snapshot.project_id = self.project.id.clone();
        snapshot.sequence = self
            .snapshot_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        snapshot
    }
    pub fn set_observer(
        &mut self,
        observer: std::sync::Arc<dyn Fn(RuntimeSnapshot) + Send + Sync>,
    ) {
        self.observer = Some(observer);
    }
    pub fn set_event_observer(
        &mut self,
        observer: std::sync::Arc<dyn Fn(RuntimeEvent) + Send + Sync>,
    ) {
        self.event_observer = Some(observer);
    }
    fn notify(&self) {
        if let Some(observer) = &self.observer {
            observer(self.snapshot());
        }
    }
    pub fn project(&self) -> &Project {
        &self.project
    }
    pub fn apply_project(&mut self, project: Project) -> Result<(), String> {
        let mut next = Self::new(project)?;
        next.observer = self.observer.clone();
        next.event_observer = self.event_observer.clone();
        if next.project.id == self.project.id {
            for variable in &next.project.variables {
                if let Some(previous) = self
                    .project
                    .variables
                    .iter()
                    .find(|old| old.id == variable.id && old.value_type == variable.value_type)
                {
                    if let Some(value) = self.snapshot.values.get(&previous.id) {
                        next.snapshot
                            .values
                            .insert(variable.id.clone(), value.clone());
                    }
                }
            }
            next.script_state = self
                .script_state
                .iter()
                .filter(|(id, _)| next.project.scripts.iter().any(|s| s.id == **id))
                .map(|(id, state)| (id.clone(), state.clone()))
                .collect();
            next.snapshot.logs = self.snapshot.logs.clone();
            next.sequence = self.sequence;
            next.snapshot_sequence.store(
                self.snapshot_sequence
                    .load(std::sync::atomic::Ordering::Relaxed),
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        *self = next;
        self.notify();
        Ok(())
    }
    pub fn stop(&mut self) {
        self.snapshot.running = false;
        self.snapshot.active_nodes.clear();
        self.notify();
    }
    pub fn set_variable(&mut self, name: &str, value: Value) -> Result<(), String> {
        let variable = self
            .resolve_variable(name)
            .ok_or_else(|| format!("Unknown variable: {name}"))?;
        if variable.read_only {
            return Err(format!("Variable {} is read-only", variable.name));
        }
        validate_value(variable, &value)?;
        self.snapshot.values.insert(
            variable.id.clone(),
            RuntimeValue {
                value,
                quality: "good".into(),
                timestamp: now_ms(),
            },
        );
        self.notify();
        Ok(())
    }
    /// Startup-only persisted state restore. Read-only UI values may be restored,
    /// but unknown/nonpersistent variables and incompatible types are rejected.
    pub fn restore_persistent_values(
        &mut self,
        values: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        for (id, value) in values {
            let variable = self
                .project
                .variables
                .iter()
                .find(|v| v.id == *id)
                .ok_or_else(|| format!("Unknown persistent variable: {id}"))?;
            if !variable.persistent {
                return Err(format!("Variable is not persistent: {id}"));
            }
            validate_value(variable, value)?;
        }
        for (id, value) in values {
            self.snapshot.values.insert(
                id.clone(),
                RuntimeValue {
                    value: value.clone(),
                    quality: "good".into(),
                    timestamp: now_ms(),
                },
            );
        }
        self.notify();
        Ok(())
    }
    fn resolve_variable(&self, key: &str) -> Option<&Variable> {
        self.project
            .variables
            .iter()
            .find(|v| v.id == key)
            .or_else(|| self.project.variables.iter().find(|v| v.name == key))
    }
    fn script_variables(&self) -> BTreeMap<String, f64> {
        let mut values = BTreeMap::new();
        for variable in &self.project.variables {
            if let Some(number) = self
                .snapshot
                .values
                .get(&variable.id)
                .and_then(|v| v.value.as_f64())
            {
                values.insert(variable.name.clone(), number);
            }
        }
        // Stable IDs win if an author gives a variable another variable's ID as its name.
        for (id, value) in &self.snapshot.values {
            if let Some(number) = value.value.as_f64() {
                values.insert(id.clone(), number);
            }
        }
        values
    }
    fn log(&mut self, level: &str, message: String, flow: Option<&str>, node: Option<&str>) {
        self.sequence += 1;
        self.snapshot.logs.push(RuntimeLog {
            id: format!("log-{}", self.sequence),
            time: now_ms(),
            level: level.into(),
            message,
            node_id: node.map(str::to_owned),
            flow_id: flow.map(str::to_owned),
        });
        if self.snapshot.logs.len() > 1000 {
            self.snapshot.logs.drain(..self.snapshot.logs.len() - 1000);
        }
        self.notify();
    }
    pub async fn run_flow(
        &mut self,
        flow_id: &str,
        input: Value,
        cancel: CancellationToken,
        host: Option<&ScriptHost>,
    ) -> Result<RuntimeSnapshot, String> {
        self.run_entry(flow_id, None, input, cancel, host).await
    }
    pub async fn run_event(
        &mut self,
        flow_id: &str,
        node_id: &str,
        input: Value,
        cancel: CancellationToken,
        host: Option<&ScriptHost>,
    ) -> Result<RuntimeSnapshot, String> {
        self.run_entry(flow_id, Some(node_id), input, cancel, host)
            .await
    }
    async fn run_entry(
        &mut self,
        flow_id: &str,
        entry: Option<&str>,
        input: Value,
        cancel: CancellationToken,
        host: Option<&ScriptHost>,
    ) -> Result<RuntimeSnapshot, String> {
        let flow = self
            .project
            .flows
            .iter()
            .find(|f| f.id == flow_id)
            .cloned()
            .ok_or_else(|| format!("Unknown flow: {flow_id}"))?;
        if !flow.enabled {
            return Err(format!("Flow {} is disabled", flow.name));
        }
        let order = validate_flow(&flow)?;
        if let Some(entry) = entry {
            if !flow
                .nodes
                .iter()
                .any(|n| n.id == entry && n.kind == "event")
            {
                return Err(format!("Event entry node does not exist: {entry}"));
            }
        }
        self.snapshot.running = true;
        self.notify();
        let result = tokio::select! {
            _=cancel.cancelled()=>Err("Flow cancelled".to_owned()),
            result=tokio::time::timeout(Duration::from_secs(60),self.execute_nodes(&flow,order,entry,input,cancel.clone(),host))=>result.map_err(|_|"Flow exceeded 60 second deadline".to_owned()).and_then(|r|r),
        };
        self.stop();
        if let Err(error) = result {
            self.log("error", error.clone(), Some(flow_id), None);
            return Err(error);
        }
        Ok(self.snapshot())
    }
    async fn execute_nodes(
        &mut self,
        flow: &Flow,
        order: Vec<usize>,
        entry: Option<&str>,
        input: Value,
        cancel: CancellationToken,
        host: Option<&ScriptHost>,
    ) -> Result<(), String> {
        let mut pending: BTreeMap<String, Vec<Value>> = flow
            .nodes
            .iter()
            .filter(|n| n.kind == "event" && entry.map_or(true, |id| n.id == id))
            .map(|n| (n.id.clone(), vec![input.clone()]))
            .collect();
        let mut scheduled = pending.len();
        for i in order {
            if cancel.is_cancelled() {
                return Err("Flow cancelled".into());
            }
            let node = &flow.nodes[i];
            let Some(inputs) = pending.remove(&node.id) else {
                continue;
            };
            for input in inputs {
                if cancel.is_cancelled() {
                    return Err("Flow cancelled".into());
                }
                self.snapshot.active_nodes = vec![node.id.clone()];
                self.notify();
                let result = self
                    .execute_node(flow, node, input, cancel.clone(), host)
                    .await
                    .map_err(|e| format!("{} ({}): {e}", node.label, node.id))?;
                for edge in flow.edges.iter().filter(|e| e.source == node.id) {
                    if node.kind == "condition" {
                        let branch = if result.as_bool().unwrap_or(false) {
                            "true"
                        } else {
                            "false"
                        };
                        if edge.source_handle.as_deref().unwrap_or("true") != branch {
                            continue;
                        }
                    }
                    scheduled += 1;
                    if scheduled > 10_000 {
                        return Err("Flow exceeded 10000 node activations".into());
                    }
                    pending
                        .entry(edge.target.clone())
                        .or_default()
                        .push(result.clone());
                }
            }
        }
        Ok(())
    }
    async fn execute_node(
        &mut self,
        flow: &Flow,
        node: &FlowNode,
        input: Value,
        cancel: CancellationToken,
        host: Option<&ScriptHost>,
    ) -> Result<Value, String> {
        let text = |key: &str| node.config.get(key).and_then(Value::as_str).unwrap_or("");
        match node.kind.as_str() {
            "event" => Ok(input),
            "read" => self
                .resolve_variable(text("variable"))
                .and_then(|v| self.snapshot.values.get(&v.id))
                .map(|v| v.value.clone())
                .ok_or_else(|| format!("Unknown variable: {}", text("variable"))),
            "write" => {
                let value = node.config.get("value").cloned().unwrap_or(input);
                self.set_variable(text("variable"), value.clone())?;
                Ok(value)
            }
            "math" => {
                let x = input.as_f64().ok_or("Math input must be a number")?;
                let y = node
                    .config
                    .get("operand")
                    .and_then(Value::as_f64)
                    .ok_or("Math operand must be a number")?;
                let result = match text("operation") {
                    "add" => x + y,
                    "subtract" => x - y,
                    "multiply" => x * y,
                    "divide" if y != 0.0 => x / y,
                    "divide" => return Err("Division by zero".into()),
                    x => return Err(format!("Unknown operation: {x}")),
                };
                if !result.is_finite() {
                    return Err("Math result is non-finite".into());
                }
                Ok(json!(result))
            }
            "condition" => {
                let rhs = node.config.get("value").unwrap_or(&Value::Null);
                let result = match text("operator") {
                    "eq" => equal_values(&input, rhs),
                    "neq" => !equal_values(&input, rhs),
                    op => {
                        let (a, b) = (
                            input.as_f64().ok_or("Comparison input must be numeric")?,
                            rhs.as_f64().ok_or("Comparison value must be numeric")?,
                        );
                        match op {
                            "gt" => a > b,
                            "gte" => a >= b,
                            "lt" => a < b,
                            "lte" => a <= b,
                            _ => return Err(format!("Unknown comparison: {op}")),
                        }
                    }
                };
                Ok(json!(result))
            }
            "delay" => {
                let ms = node
                    .config
                    .get("ms")
                    .and_then(Value::as_u64)
                    .ok_or("Delay ms must be a nonnegative integer")?
                    .min(60_000);
                tokio::select! {_=cancel.cancelled()=>Err("Flow cancelled".into()),_=tokio::time::sleep(Duration::from_millis(ms))=>Ok(input)}
            }
            "log" => {
                let message = if text("message").is_empty() {
                    input.to_string()
                } else {
                    text("message").to_owned()
                };
                self.log("info", message, Some(&flow.id), Some(&node.id));
                Ok(input)
            }
            "emit" => {
                if let Some(observer) = &self.event_observer {
                    observer(RuntimeEvent {
                        event: text("event").to_owned(),
                        payload: input.clone(),
                        time: now_ms(),
                        flow_id: flow.id.clone(),
                        node_id: node.id.clone(),
                    });
                }
                self.log(
                    "info",
                    format!("event {}: {}", text("event"), input),
                    Some(&flow.id),
                    Some(&node.id),
                );
                Ok(input)
            }
            "script" => {
                let script = self
                    .project
                    .scripts
                    .iter()
                    .find(|s| s.id == text("scriptId"))
                    .cloned()
                    .ok_or("Script reference is missing")?;
                let host=host.ok_or("C scripts require the native QuickGUI worker; no simulated result is available")?;
                let response = host
                    .execute(
                        ScriptRequest {
                            source: script.source,
                            input,
                            variables: self.script_variables(),
                            state: self
                                .script_state
                                .get(&script.id)
                                .cloned()
                                .unwrap_or_default(),
                            timeout_ms: script.timeout_ms,
                        },
                        cancel,
                    )
                    .await?;
                // Validate the complete write set before applying any script side effect.
                for (name, value) in &response.writes {
                    let variable = self
                        .resolve_variable(name)
                        .ok_or_else(|| format!("Script wrote unknown variable: {name}"))?;
                    if variable.read_only {
                        return Err(format!("Script wrote read-only variable: {name}"));
                    }
                    validate_value(variable, &json!(value))?;
                }
                for (name, value) in response.writes {
                    let id = self
                        .resolve_variable(&name)
                        .expect("write set validated above")
                        .id
                        .clone();
                    self.snapshot.values.insert(
                        id,
                        RuntimeValue {
                            value: json!(value),
                            quality: "good".into(),
                            timestamp: now_ms(),
                        },
                    );
                }
                self.script_state.insert(script.id, response.state);
                self.notify();
                for message in response.logs {
                    self.log("info", message, Some(&flow.id), Some(&node.id));
                }
                Ok(response.output)
            }
            "connection" => {
                let definition = self
                    .project
                    .connections
                    .iter()
                    .find(|c| c.get("id").and_then(Value::as_str) == Some(text("connectionId")))
                    .cloned()
                    .ok_or("Connection reference is missing")?;
                let connection: Connection = serde_json::from_value(definition)
                    .map_err(|e| format!("Invalid connection: {e}"))?;
                serde_json::to_value(test_connection(connection).await?).map_err(|e| e.to_string())
            }
            "http" => {
                let url = text("url");
                if !url.starts_with("https://") && !url.starts_with("http://") {
                    return Err("HTTP node requires an http(s) URL".into());
                }
                let method = if text("method").is_empty() {
                    reqwest::Method::GET
                } else {
                    reqwest::Method::from_bytes(text("method").as_bytes())
                        .map_err(|e| e.to_string())?
                };
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(15))
                    .build()
                    .map_err(|e| e.to_string())?;
                let mut request = client.request(method, url);
                if let Some(body) = node.config.get("body") {
                    request = request.json(body);
                }
                let mut response = request
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .error_for_status()
                    .map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                    if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                        return Err("HTTP response exceeds 2 MiB".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
            }
            _ => Err(format!("Unsupported node: {}", node.kind)),
        }
    }
}

fn equal_values(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}
fn validate_value(variable: &Variable, value: &Value) -> Result<(), String> {
    let valid = match variable.value_type.as_str() {
        "number" => value.is_number(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Variable {} expects {}",
            variable.name, variable.value_type
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Project {
        serde_json::from_value(json!({"schemaVersion":1,"id":"p","name":"P","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"v","name":"count","type":"number","initial":2}],"flows":[{"id":"f","name":"F","enabled":true,"nodes":[{"id":"a","kind":"event","label":"Start","config":{}},{"id":"b","kind":"math","label":"Multiply","config":{"operation":"multiply","operand":3}},{"id":"c","kind":"write","label":"Store","config":{"variable":"count"}}],"edges":[{"id":"ab","source":"a","target":"b"},{"id":"bc","source":"b","target":"c"}]}]})).unwrap()
    }
    #[tokio::test]
    async fn graph_executes_and_types_are_checked() {
        let mut e = Engine::new(fixture()).unwrap();
        let s = e
            .run_flow("f", json!(4), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(s.values["v"].value, json!(12.0));
        assert!(!s.running);
        assert!(e.set_variable("count", json!(true)).is_err());
    }
    #[test]
    fn cycles_and_dangling_edges_are_rejected() {
        let mut p = fixture();
        p.flows[0].edges.push(FlowEdge {
            id: "cb".into(),
            source: "c".into(),
            target: "b".into(),
            source_handle: None,
            target_handle: None,
        });
        assert!(Engine::new(p.clone()).err().unwrap().contains("cycle"));
        p.flows[0].edges[0].source = "missing".into();
        assert!(Engine::new(p).is_err());
    }
    #[tokio::test]
    async fn cancelled_delay_preserves_state_and_clears_running() {
        let mut p = fixture();
        p.flows[0].nodes[1].kind = "delay".into();
        p.flows[0].nodes[1].config = BTreeMap::from([("ms".into(), json!(10_000))]);
        let mut e = Engine::new(p).unwrap();
        let token = CancellationToken::new();
        let t = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            t.cancel();
        });
        assert!(e
            .run_flow("f", json!(9), token, None)
            .await
            .unwrap_err()
            .contains("cancelled"));
        assert!(!e.snapshot.running);
        assert!(e.snapshot.active_nodes.is_empty());
        assert_eq!(e.snapshot.values["v"].value, json!(2));
    }
    #[test]
    fn unknown_schema_and_readonly_writes_fail() {
        let mut p = fixture();
        p.schema_version = 2;
        assert!(Engine::new(p).is_err());
        let mut p = fixture();
        p.variables[0].read_only = true;
        assert!(Engine::new(p)
            .unwrap()
            .set_variable("count", json!(3))
            .is_err());
    }
    #[test]
    fn script_contract_is_camel_case() {
        let r:ScriptRequest=serde_json::from_value(json!({"source":"void qg_process(void) {}","input":0,"variables":{},"state":{},"timeoutMs":50})).unwrap();
        assert_eq!(r.timeout_ms, 50);
        assert!(serde_json::to_value(r).unwrap().get("timeoutMs").is_some());
    }
    #[test]
    fn hot_reload_preserves_compatible_values_and_rejects_invalid_project_atomically() {
        let mut e = Engine::new(fixture()).unwrap();
        e.set_variable("count", json!(21)).unwrap();
        let mut p = fixture();
        p.revision = 1;
        p.variables[0].name = "renamed".into();
        p.variables[0].read_only = true;
        e.apply_project(p.clone()).unwrap();
        assert_eq!(e.snapshot.values["v"].value, json!(21));
        assert!(!e.snapshot.values.contains_key("renamed"));
        p.schema_version = 42;
        assert!(e.apply_project(p).is_err());
        assert_eq!(e.project.schema_version, 1);
        assert_eq!(e.snapshot.values["v"].value, json!(21));
        let mut p = fixture();
        p.id = "another".into();
        e.apply_project(p).unwrap();
        assert_eq!(e.snapshot.values["v"].value, json!(2));
    }
    #[tokio::test]
    async fn division_by_zero_does_not_commit_downstream_write() {
        let mut p = fixture();
        p.flows[0].nodes[1].config = BTreeMap::from([
            ("operation".into(), json!("divide")),
            ("operand".into(), json!(0)),
        ]);
        let mut e = Engine::new(p).unwrap();
        assert!(e
            .run_flow("f", json!(4), CancellationToken::new(), None)
            .await
            .unwrap_err()
            .contains("zero"));
        assert_eq!(e.snapshot.values["v"].value, json!(2));
        assert!(!e.snapshot.running);
    }
    #[tokio::test]
    async fn joins_process_each_incoming_and_emit_observable_events() {
        let mut p = fixture();
        p.flows[0].nodes[2].kind = "emit".into();
        p.flows[0].nodes[2].config = BTreeMap::from([("event".into(), json!("sample"))]);
        let mut other = p.flows[0].nodes[1].clone();
        other.id = "d".into();
        other.config.insert("operand".into(), json!(2));
        p.flows[0].nodes.push(other);
        p.flows[0].edges.extend([
            FlowEdge {
                id: "ad".into(),
                source: "a".into(),
                target: "d".into(),
                source_handle: None,
                target_handle: None,
            },
            FlowEdge {
                id: "dc".into(),
                source: "d".into(),
                target: "c".into(),
                source_handle: None,
                target_handle: None,
            },
        ]);
        let mut e = Engine::new(p).unwrap();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = events.clone();
        e.set_event_observer(std::sync::Arc::new(move |event| {
            out.lock().unwrap().push(event)
        }));
        let snapshots = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = snapshots.clone();
        e.set_observer(std::sync::Arc::new(move |snapshot| {
            out.lock().unwrap().push(snapshot)
        }));
        e.run_flow("f", json!(4), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.payload.clone())
                .collect::<Vec<_>>(),
            vec![json!(12.0), json!(8.0)]
        );
        assert!(snapshots
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.running && s.active_nodes == vec!["b"]));
        assert!(!snapshots.lock().unwrap().last().unwrap().running);
    }
    #[test]
    fn numeric_comparison_matches_javascript_numbers() {
        assert!(equal_values(&json!(2), &json!(2.0)));
        assert!(!equal_values(&json!(2), &json!("2")));
    }
    #[test]
    fn snapshots_identify_project_and_increase_across_hot_reload() {
        let mut e = Engine::new(fixture()).unwrap();
        let first = e.snapshot();
        let second = e.snapshot();
        assert_eq!(first.project_id, "p");
        assert!(second.sequence > first.sequence);
        let mut p = fixture();
        p.revision = 1;
        e.apply_project(p).unwrap();
        let third = e.snapshot();
        assert_eq!(third.project_id, "p");
        assert_eq!(third.revision, 1);
        assert!(third.sequence > second.sequence);
        let mut p = fixture();
        p.id = "new-project".into();
        e.apply_project(p).unwrap();
        assert_eq!(e.snapshot().project_id, "new-project");
    }
    #[test]
    fn persistent_restore_allows_readonly_and_rejects_incompatible_sets_atomically() {
        let mut p = fixture();
        p.variables[0].persistent = true;
        p.variables[0].read_only = true;
        let mut e = Engine::new(p).unwrap();
        e.restore_persistent_values(&BTreeMap::from([("v".into(), json!(37))]))
            .unwrap();
        assert_eq!(e.snapshot.values["v"].value, json!(37));
        assert!(e.set_variable("v", json!(38)).is_err());
        assert!(e
            .restore_persistent_values(&BTreeMap::from([("v".into(), json!(false))]))
            .is_err());
        assert_eq!(e.snapshot.values["v"].value, json!(37));
    }
    #[tokio::test]
    async fn run_event_activates_only_the_requested_entry() {
        let mut p = fixture();
        p.flows[0].nodes.extend([
            FlowNode {
                id: "other".into(),
                kind: "event".into(),
                label: "Other".into(),
                position: Value::Null,
                config: Default::default(),
            },
            FlowNode {
                id: "other-log".into(),
                kind: "log".into(),
                label: "Other log".into(),
                position: Value::Null,
                config: BTreeMap::from([("message".into(), json!("other branch"))]),
            },
        ]);
        p.flows[0].edges.push(FlowEdge {
            id: "other-edge".into(),
            source: "other".into(),
            target: "other-log".into(),
            source_handle: None,
            target_handle: None,
        });
        let mut e = Engine::new(p).unwrap();
        let snapshot = e
            .run_event("f", "a", json!(3), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(snapshot.values["v"].value, json!(9.0));
        assert!(snapshot.logs.is_empty());
        let snapshot = e
            .run_event("f", "other", json!(0), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(snapshot.values["v"].value, json!(9.0));
        assert_eq!(snapshot.logs.len(), 1);
        assert!(e
            .run_event("f", "b", json!(0), CancellationToken::new(), None)
            .await
            .is_err());
    }
}
