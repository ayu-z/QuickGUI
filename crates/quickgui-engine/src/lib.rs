//! Portable QuickGUI graph execution. UI documents remain in the project model.
mod connections;
pub mod flow_v4;
pub mod function_blocks;
mod history;
mod json_value;
pub mod serial;
pub mod usb;
pub use json_value::{read_path, replace_path, validate_json, validate_path};
mod types;
mod windows;
mod worker;
pub use connections::{test_connection, Connection, ConnectionTestResult};
pub use history::{
    AlarmRecord, HistoryRangeQuery, HistoryRangeResult, HistorySample, HistoryStore,
    RetentionPolicy,
};
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
        "serial",
        "usb",
        "map",
        "append",
        "window",
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
    if !flow.nodes.iter().any(|n| {
        n.kind == "event"
            || ["serial", "usb"].contains(&n.kind.as_str())
                && n.config.get("action").and_then(Value::as_str) == Some("communicate")
    }) {
        return Err("Flow needs an event entry node".into());
    }
    Ok(order)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ScriptStateKey {
    Script(String),
    Block {
        flow: String,
        node: String,
        script: String,
    },
}
pub struct Engine {
    project: Project,
    flow_plans: BTreeMap<String, (std::sync::Arc<Flow>, std::sync::Arc<Vec<usize>>)>,
    snapshot: RuntimeSnapshot,
    script_state: BTreeMap<ScriptStateKey, BTreeMap<String, f64>>,
    script_locks:
        std::sync::Arc<std::sync::Mutex<BTreeMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>>,
    v4_runs: BTreeMap<u64, String>,
    v4_next_run: u64,
    execution_epoch: u64,
    sequence: u64,
    snapshot_sequence: std::sync::atomic::AtomicU64,
    observer: Option<std::sync::Arc<dyn Fn(RuntimeSnapshot) + Send + Sync>>,
    event_observer: Option<std::sync::Arc<dyn Fn(RuntimeEvent) + Send + Sync>>,
    activity_notified_at: Option<std::time::Instant>,
}

impl Engine {
    pub fn new(mut project: Project) -> Result<Self, String> {
        if !(1..=5).contains(&project.schema_version) {
            return Err(format!(
                "Unsupported project schemaVersion {}",
                project.schema_version
            ));
        }
        if project.schema_version < 5 {
            project.windows.get_or_insert_with(Vec::new);
        }
        project.schema_version = 5;
        windows::validate(&project)?;
        function_blocks::validate_project(&project)?;
        flow_v4::validate_project(&project)?;
        let mut snapshot = RuntimeSnapshot {
            revision: project.revision,
            running: true,
            window_state: windows::initial(&project),
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
        let mut flow_plans = BTreeMap::new();
        for flow in &project.flows {
            if !flow_ids.insert(&flow.id) {
                return Err("Duplicate flow ID".into());
            }
            let order = validate_flow(flow)?;
            flow_plans.insert(
                flow.id.clone(),
                (
                    std::sync::Arc::new(flow.clone()),
                    std::sync::Arc::new(order),
                ),
            );
            for node in &flow.nodes {
                if let Some(path) = node.config.get("path") {
                    validate_path(path.as_array().ok_or("JSON path must be an array")?)?;
                }
            }
        }
        let mut script_ids = BTreeSet::new();
        for script in &project.scripts {
            if let Some(aliases) = &script.variable_aliases {
                for target in aliases.values() {
                    if !project
                        .variables
                        .iter()
                        .any(|v| v.id == *target && v.value_type == "number")
                    {
                        return Err(format!(
                            "C alias target must be a declared numeric variable ID: {target}"
                        ));
                    }
                }
            }
            if !script_ids.insert(&script.id) {
                return Err("Duplicate script ID".into());
            }
        }
        Ok(Self {
            project,
            flow_plans,
            snapshot,
            script_state: BTreeMap::new(),
            script_locks: Default::default(),
            v4_runs: Default::default(),
            v4_next_run: 0,
            execution_epoch: 0,
            sequence: 0,
            snapshot_sequence: std::sync::atomic::AtomicU64::new(0),
            observer: None,
            event_observer: None,
            activity_notified_at: None,
        })
    }
    pub fn update_serial_state(&mut self, states: BTreeMap<String, Value>) {
        self.snapshot.serial = Some(states);
        self.notify();
    }
    pub fn external_event(&mut self, event: &str, payload: Value) {
        if let Some(observer) = &self.event_observer {
            observer(RuntimeEvent {
                event: event.into(),
                payload,
                time: now_ms(),
                flow_id: String::new(),
                node_id: String::new(),
            });
        }
    }
    pub fn external_error(&mut self, message: String) {
        self.log("error", message, None, None);
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
    fn notify_activity(&mut self, waiting: bool) {
        // Node highlights are visual samples. Values, logs, errors and final
        // snapshots still notify immediately and must never be coalesced here.
        let now = std::time::Instant::now();
        if waiting
            || self
                .activity_notified_at
                .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(16))
        {
            self.notify();
            // A slow UI callback must not make the very next node broadcast
            // again just because the callback itself consumed the sample window.
            self.activity_notified_at = Some(std::time::Instant::now());
        }
    }
    pub fn project(&self) -> &Project {
        &self.project
    }
    pub fn apply_project(&mut self, project: Project) -> Result<(), String> {
        let mut next = Self::new(project)?;
        next.v4_next_run = self.v4_next_run;
        next.execution_epoch = self.execution_epoch
            + u64::from(
                flow_v4::execution_key(&self.project) != flow_v4::execution_key(&next.project),
            );
        next.observer = self.observer.clone();
        next.event_observer = self.event_observer.clone();
        if next.project.id == self.project.id {
            next.script_locks = self.script_locks.clone();
            if flow_v4::execution_key(&self.project) == flow_v4::execution_key(&next.project) {
                next.v4_runs = self.v4_runs.clone();
                next.v4_next_run = self.v4_next_run;
                next.snapshot.running = self.snapshot.running;
                next.snapshot.active_nodes = self.snapshot.active_nodes.clone();
            }
            next.snapshot.window_state =
                windows::reconcile(&self.project, &next.project, &self.snapshot.window_state);
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
                .filter(|(key, _)| match key {
                    ScriptStateKey::Script(id) => next.project.scripts.iter().any(|s| s.id == *id),
                    ScriptStateKey::Block { flow, node, script } => {
                        next.project.scripts.iter().any(|s| s.id == *script)
                            && next.project.flows.iter().any(|f| {
                                f.id == *flow
                                    && f.nodes.iter().any(|n| {
                                        n.id == *node
                                            && n.block.is_some()
                                            && n.kind == "script"
                                            && n.config.get("scriptId").and_then(Value::as_str)
                                                == Some(script)
                                    })
                            })
                    }
                })
                .map(|(id, state)| (id.clone(), state.clone()))
                .collect();
            next.snapshot.logs = self.snapshot.logs.clone();
            next.snapshot.serial = self.snapshot.serial.clone();
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
        self.execution_epoch += 1;
        self.v4_runs.clear();
        self.snapshot.running = false;
        self.snapshot.active_nodes.clear();
        self.notify();
    }
    pub fn start_domain(&mut self) {
        self.snapshot.running = true;
        self.notify();
    }
    pub fn window_action(&mut self, action: &str, window_id: &str) -> Result<(), String> {
        windows::validate_action(&self.project, action, window_id)?;
        let state = &mut self.snapshot.window_state;
        if action == "close" {
            state.open.retain(|id| id != window_id);
            if state.focused == window_id {
                state.focused = "main".into();
            }
        } else {
            if !state.open.iter().any(|id| id == window_id) {
                state.open.push(window_id.to_owned());
            }
            state.focused = window_id.to_owned();
        }
        state.revision = state.revision.saturating_add(1);
        self.notify();
        Ok(())
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
    pub fn set_variable_path(
        &mut self,
        name: &str,
        value: Value,
        path: Option<&[Value]>,
    ) -> Result<(), String> {
        let Some(path) = path else {
            return self.set_variable(name, value);
        };
        if path.is_empty() {
            return self.set_variable(name, value);
        }
        let variable = self
            .resolve_variable(name)
            .ok_or_else(|| format!("Unknown variable: {name}"))?;
        if variable.value_type != "json" {
            return Err("JSON paths require a json variable".into());
        }
        let current = &self.snapshot.values[&variable.id].value;
        let next = replace_path(current, path, value)?;
        self.set_variable(name, next)
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
        for variable in self
            .project
            .variables
            .iter()
            .filter(|v| v.value_type == "number")
        {
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
        for variable in self
            .project
            .variables
            .iter()
            .filter(|v| v.value_type == "number")
        {
            if let Some(number) = self.snapshot.values[&variable.id].value.as_f64() {
                values.insert(variable.id.clone(), number);
            }
        }
        values
    }
    pub async fn execute_script(
        &mut self,
        script_id: &str,
        input: Value,
        cancel: CancellationToken,
        host: &ScriptHost,
    ) -> Result<ScriptResponse, String> {
        self.execute_script_context(script_id, input, cancel, host, None, None)
            .await
    }
    fn script_state_key(
        &self,
        script_id: &str,
        flow_id: Option<&str>,
        node_id: Option<&str>,
    ) -> ScriptStateKey {
        if let (Some(flow), Some(node)) = (flow_id, node_id) {
            if self.project.flows.iter().any(|f| {
                f.id == flow
                    && f.nodes
                        .iter()
                        .any(|n| n.id == node && n.block.is_some() && n.kind == "script")
            }) {
                return ScriptStateKey::Block {
                    flow: flow.into(),
                    node: node.into(),
                    script: script_id.into(),
                };
            }
        }
        ScriptStateKey::Script(script_id.into())
    }
    async fn execute_script_context(
        &mut self,
        script_id: &str,
        input: Value,
        cancel: CancellationToken,
        host: &ScriptHost,
        flow_id: Option<&str>,
        node_id: Option<&str>,
    ) -> Result<ScriptResponse, String> {
        let script = self
            .project
            .scripts
            .iter()
            .find(|s| s.id == script_id)
            .cloned()
            .ok_or("Script reference is missing")?;
        let response = host
            .execute(
                ScriptRequest {
                    source: script.source,
                    input,
                    variables: self.script_variables(),
                    state: self
                        .script_state
                        .get(&self.script_state_key(script_id, flow_id, node_id))
                        .cloned()
                        .unwrap_or_default(),
                    timeout_ms: script.timeout_ms,
                    variable_aliases: script.variable_aliases.clone(),
                },
                cancel,
            )
            .await?;
        self.apply_script_response_context(script_id, &response, flow_id, node_id)?;
        Ok(response)
    }
    /// All writes and state are validated before publishing a single committed snapshot.
    pub fn apply_script_response(
        &mut self,
        script_id: &str,
        response: &ScriptResponse,
    ) -> Result<(), String> {
        self.apply_script_response_context(script_id, response, None, None)
    }
    fn apply_script_response_context(
        &mut self,
        script_id: &str,
        response: &ScriptResponse,
        flow_id: Option<&str>,
        node_id: Option<&str>,
    ) -> Result<(), String> {
        let script = self
            .project
            .scripts
            .iter()
            .find(|s| s.id == script_id)
            .ok_or("Script reference is missing")?;
        validate_json(&response.output)?;
        if response.state.values().any(|value| !value.is_finite()) {
            return Err("Invalid C state".into());
        }
        let mut writes = BTreeMap::new();
        for (name, value) in &response.writes {
            let variable = if let Some(aliases) = &script.variable_aliases {
                if !aliases.values().any(|target| target == name) {
                    return Err(format!("C wrote outside alias scope: {name}"));
                }
                self.project.variables.iter().find(|v| v.id == *name)
            } else {
                self.resolve_variable(name)
            }
            .ok_or_else(|| format!("Script wrote unknown variable: {name}"))?;
            if variable.read_only || variable.value_type != "number" || !value.is_finite() {
                return Err(format!("Invalid C write: {name}"));
            }
            writes.insert(variable.id.clone(), *value);
        }
        for (id, value) in writes {
            self.snapshot.values.insert(
                id,
                RuntimeValue {
                    value: json!(value),
                    quality: "good".into(),
                    timestamp: now_ms(),
                },
            );
        }
        self.script_state.insert(
            self.script_state_key(script_id, flow_id, node_id),
            response.state.clone(),
        );
        self.notify();
        for message in &response.logs {
            self.log("info", message.clone(), flow_id, node_id);
        }
        Ok(())
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
        let placeholder = Self::new(self.project.clone())?;
        let owned = std::mem::replace(self, placeholder);
        let shared = std::sync::Arc::new(tokio::sync::Mutex::new(owned));
        let result =
            flow_v4::run_shared(shared.clone(), None, flow_id, entry, input, cancel, host).await;
        std::mem::swap(self, &mut *shared.lock().await);
        result
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
            "window" => {
                self.window_action(text("action"), text("windowId"))?;
                Ok(input)
            }
            "read" => {
                let variable = self
                    .resolve_variable(text("variable"))
                    .ok_or_else(|| format!("Unknown variable: {}", text("variable")))?;
                let value = &self.snapshot.values[&variable.id].value;
                if let Some(path) = node.config.get("path") {
                    let path = path.as_array().ok_or("JSON path must be an array")?;
                    if !path.is_empty() && variable.value_type != "json" {
                        return Err("JSON paths require a json variable".into());
                    }
                    return read_path(value, path).cloned();
                }
                Ok(value.clone())
            }
            "write" => {
                let value = node.config.get("value").cloned().unwrap_or(input);
                let path = node
                    .config
                    .get("path")
                    .map(|v| v.as_array().ok_or("JSON path must be an array"))
                    .transpose()?;
                self.set_variable_path(text("variable"), value.clone(), path.map(Vec::as_slice))?;
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
                    "eq" => equal_json(&input, rhs),
                    "neq" => !equal_json(&input, rhs),
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
                let host = host.ok_or("C scripts require the native QuickGUI worker")?;
                let response = self
                    .execute_script_context(
                        text("scriptId"),
                        input,
                        cancel,
                        host,
                        Some(&flow.id),
                        Some(&node.id),
                    )
                    .await?;
                Ok(response.output)
            }
            "connection" | "http" => external_request(&self.project.connections, node).await,
            _ => Err(format!("Unsupported node: {}", node.kind)),
        }
    }
}

pub(crate) async fn external_request(
    connections: &[Value],
    node: &FlowNode,
) -> Result<Value, String> {
    let text = |key: &str| node.config.get(key).and_then(Value::as_str).unwrap_or("");
    match node.kind.as_str() {
        "connection" => {
            let definition = connections
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
                reqwest::Method::from_bytes(text("method").as_bytes()).map_err(|e| e.to_string())?
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
        _ => Err("Unsupported external operation".into()),
    }
}

fn equal_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equal_json(a, b)))
        }
        _ => equal_values(a, b),
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
        "json" => {
            validate_json(value)?;
            true
        }
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
        assert!(s.running);
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
            kind: None,
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
        assert!(e.snapshot.running);
        assert!(e.snapshot.active_nodes.is_empty());
        assert_eq!(e.snapshot.values["v"].value, json!(2));
    }
    #[test]
    fn unknown_schema_and_readonly_writes_fail() {
        let mut p = fixture();
        p.schema_version = 6;
        assert!(Engine::new(p).is_err());
        let mut p = fixture();
        p.variables[0].read_only = true;
        assert!(Engine::new(p)
            .unwrap()
            .set_variable("count", json!(3))
            .is_err());
    }
    fn multi_window_fixture() -> Project {
        let mut project = fixture();
        project.schema_version = 2;
        project.windows = Some(vec![ProjectWindow {
            id: "details".into(),
            name: "Details".into(),
            config: project.window.clone(),
            widgets: Vec::new(),
            open_on_start: false,
        }]);
        project
    }
    #[tokio::test]
    async fn windows_share_flow_values_and_close_without_stopping_the_engine() {
        let mut project = multi_window_fixture();
        project.flows[0].nodes[1].kind = "window".into();
        project.flows[0].nodes[1].config = BTreeMap::from([
            ("action".into(), json!("open")),
            ("windowId".into(), json!("details")),
        ]);
        let mut engine = Engine::new(project).unwrap();
        assert_eq!(engine.snapshot().window_state.open, ["main"]);
        let result = engine
            .run_flow("f", json!(42), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(result.window_state.open, ["main", "details"]);
        assert_eq!(result.values["v"].value, json!(42));
        engine.window_action("open", "details").unwrap();
        assert_eq!(engine.snapshot().window_state.open, ["main", "details"]);
        engine.window_action("close", "details").unwrap();
        assert_eq!(engine.snapshot().window_state.open, ["main"]);
        engine.window_action("focus", "details").unwrap();
        assert_eq!(engine.snapshot().window_state.focused, "details");
        assert_eq!(engine.snapshot().values["v"].value, json!(42));
        assert!(engine.window_action("close", "main").is_err());
        assert!(engine.window_action("open", "unknown").is_err());
    }
    #[test]
    fn window_hot_updates_preserve_visibility_and_only_initialize_new_windows() {
        let mut project = multi_window_fixture();
        project.windows.as_mut().unwrap()[0].open_on_start = true;
        let mut engine = Engine::new(project.clone()).unwrap();
        engine.window_action("close", "details").unwrap();
        engine.set_variable("count", json!(7)).unwrap();
        let state = engine.snapshot().window_state;
        project.revision += 1;
        project.windows.as_mut().unwrap()[0].config.title = "Changed".into();
        engine.apply_project(project.clone()).unwrap();
        assert_eq!(engine.snapshot().window_state, state);
        assert_eq!(engine.snapshot().values["v"].value, json!(7));
        engine.window_action("focus", "details").unwrap();
        project.windows.as_mut().unwrap()[0].id = "alarms".into();
        project.revision += 1;
        engine.apply_project(project).unwrap();
        assert_eq!(engine.snapshot().window_state.open, ["main", "alarms"]);
        assert_eq!(engine.snapshot().window_state.focused, "main");
        assert_eq!(engine.snapshot().values["v"].value, json!(7));
    }
    #[test]
    fn window_schema_and_invalid_actions_cannot_replace_an_active_engine() {
        let project = multi_window_fixture();
        let mut engine = Engine::new(project.clone()).unwrap();
        let mut invalid = project.clone();
        invalid.schema_version = 6;
        assert!(engine.apply_project(invalid).is_err());
        let mut invalid = project.clone();
        invalid.schema_version = 5;
        invalid.windows = None;
        assert!(engine.apply_project(invalid).is_err());
        let mut invalid = project.clone();
        invalid.windows.as_mut().unwrap()[0].id = "main".into();
        assert!(engine.apply_project(invalid).is_err());
        let mut invalid = project;
        invalid.flows[0].nodes[1].kind = "window".into();
        invalid.flows[0].nodes[1].config = BTreeMap::from([
            ("action".into(), json!("close")),
            ("windowId".into(), json!("main")),
        ]);
        assert!(engine.apply_project(invalid).is_err());
        assert_eq!(engine.project().schema_version, 5);
        assert_eq!(engine.snapshot().window_state.open, ["main"]);
    }
    #[test]
    fn empty_path_is_a_typed_root_write_even_for_legacy_scalars() {
        let mut e = Engine::new(fixture()).unwrap();
        e.set_variable_path("v", json!(17), Some(&[])).unwrap();
        assert_eq!(e.snapshot().values["v"].value, json!(17));
        assert!(e.set_variable_path("v", json!("wrong"), Some(&[])).is_err());
        assert_eq!(e.snapshot().values["v"].value, json!(17));
    }
    #[test]
    fn v3_json_paths_are_atomic_bounded_and_preserve_siblings() {
        let mut p = fixture();
        p.schema_version = 3;
        p.windows = Some(vec![]);
        p.variables[0].value_type = "json".into();
        p.variables[0].initial = json!({"a":[null,1],"b":2});
        let mut e = Engine::new(p.clone()).unwrap();
        e.set_variable_path("v", json!(3), Some(&[json!("a"), json!(0)]))
            .unwrap();
        e.set_variable_path("v", json!(4), Some(&[json!("b")]))
            .unwrap();
        let expected = json!({"a":[3,1],"b":4});
        assert_eq!(e.snapshot().values["v"].value, expected);
        for path in [
            vec![json!("a"), json!(2)],
            vec![json!("missing")],
            vec![json!("a"), json!("0")],
        ] {
            assert!(e.set_variable_path("v", json!(9), Some(&path)).is_err());
            assert_eq!(e.snapshot().values["v"].value, expected);
        }
        assert!(e.set_variable("v", json!("x".repeat(1024 * 1024))).is_err());
        let mut deep = json!(0);
        for _ in 0..33 {
            deep = json!([deep]);
        }
        assert!(e.set_variable("v", deep).is_err());
        p.revision += 1;
        e.apply_project(p).unwrap();
        assert_eq!(e.snapshot().values["v"].value, expected);
    }
    #[tokio::test]
    async fn v3_conditions_use_structural_json_equality_and_forward_original_payload() {
        let mut p = fixture();
        p.schema_version = 3;
        p.windows = Some(vec![]);
        p.variables[0].value_type = "json".into();
        p.variables[0].initial = Value::Null;
        p.flows[0].nodes[1].kind = "condition".into();
        p.flows[0].nodes[1].config = BTreeMap::from([
            ("operator".into(), json!("eq")),
            ("value".into(), json!({"x":[2.0,null]})),
        ]);
        let mut e = Engine::new(p).unwrap();
        e.run_flow("f", json!({"x":[2,null]}), CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(e.snapshot().values["v"].value, json!({"x":[2,null]}));
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
        assert_eq!(e.project.schema_version, 5);
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
        assert!(e.snapshot.running);
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
                kind: None,
            },
            FlowEdge {
                id: "dc".into(),
                source: "d".into(),
                target: "c".into(),
                source_handle: None,
                target_handle: None,
                kind: None,
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
            .any(|s| s.running && !s.active_nodes.is_empty()));
        assert!(snapshots.lock().unwrap().last().unwrap().running);
        assert!(snapshots
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .active_nodes
            .is_empty());
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
                block: None,
            },
            FlowNode {
                id: "other-log".into(),
                kind: "log".into(),
                label: "Other log".into(),
                position: Value::Null,
                config: BTreeMap::from([("message".into(), json!("other branch"))]),
                block: None,
            },
        ]);
        p.flows[0].edges.push(FlowEdge {
            id: "other-edge".into(),
            source: "other".into(),
            target: "other-log".into(),
            source_handle: None,
            target_handle: None,
            kind: None,
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
