use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type JsonMap = BTreeMap<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub locale: String,
    pub theme: Value,
    pub window: WindowConfig,
    #[serde(
        default,
        deserialize_with = "deserialize_windows",
        skip_serializing_if = "Option::is_none"
    )]
    pub windows: Option<Vec<ProjectWindow>>,
    pub publish: Value,
    #[serde(default)]
    pub widgets: Vec<Value>,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub flows: Vec<Flow>,
    #[serde(default)]
    pub scripts: Vec<CScript>,
    #[serde(default)]
    pub modules: Vec<Value>,
    #[serde(default)]
    pub assets: Vec<Value>,
    #[serde(default)]
    pub connections: Vec<Value>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
    pub always_on_top: bool,
    pub fullscreen: bool,
    pub maximized: bool,
    pub center: bool,
    pub remember_position: bool,
    pub background: String,
    pub content_radius: f64,
    pub corner_preference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWindow {
    pub id: String,
    pub name: String,
    pub config: WindowConfig,
    pub widgets: Vec<Value>,
    pub open_on_start: bool,
}

fn deserialize_windows<'de, D>(deserializer: D) -> Result<Option<Vec<ProjectWindow>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Missing is legacy v1; an explicitly present field must be an array, never null.
    Vec::<ProjectWindow>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWindowState {
    pub open: Vec<String>,
    pub focused: String,
    pub revision: u64,
}

impl Default for RuntimeWindowState {
    fn default() -> Self {
        Self {
            open: vec!["main".into()],
            focused: "main".into(),
            revision: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: String,
    pub initial: Value,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub persistent: bool,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub position: Value,
    #[serde(default)]
    pub config: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CScript {
    pub id: String,
    pub name: String,
    pub source: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeValue {
    pub value: Value,
    pub quality: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLog {
    pub id: String,
    pub time: u64,
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    #[serde(default)]
    pub window_state: RuntimeWindowState,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub sequence: u64,
    pub values: BTreeMap<String, RuntimeValue>,
    pub logs: Vec<RuntimeLog>,
    pub running: bool,
    pub active_nodes: Vec<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    pub source: String,
    pub input: Value,
    #[serde(default)]
    pub variables: BTreeMap<String, f64>,
    #[serde(default)]
    pub state: BTreeMap<String, f64>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponse {
    pub output: Value,
    pub writes: BTreeMap<String, f64>,
    pub state: BTreeMap<String, f64>,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub event: String,
    pub payload: Value,
    pub time: u64,
    pub flow_id: String,
    pub node_id: String,
}
