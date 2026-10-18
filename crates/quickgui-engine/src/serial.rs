//! Persistent native serial sessions. Actors never acquire an Engine lock.
use crate::{now_ms, CancellationToken};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot, Notify},
};
use tokio_serial::SerialPortBuilderExt;

pub const RX_BATCH_LIMIT: usize = 256;
pub const RX_BYTE_LIMIT: usize = 1024 * 1024;
const TX_BATCH_LIMIT: usize = 64;
const TX_BYTE_LIMIT: usize = 1024 * 1024;
const MAX_MESSAGE: usize = 65535;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsbLocation {
    pub bus_id: String,
    pub port_chain: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub serial_number: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub usb_location: Option<UsbLocation>,
    pub display_name: String,
}
impl SerialPortInfo {
    pub fn can_reconnect(&self) -> bool {
        !self.port_name.is_empty()
            && self.vid.is_some()
            && self.pid.is_some()
            && self.usb_location.as_ref().is_some_and(|location| {
                !location.bus_id.is_empty() && !location.port_chain.is_empty()
            })
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        self.can_reconnect()
            && other.can_reconnect()
            && self.vid == other.vid
            && self.pid == other.pid
            && canonical_port(&self.port_name) == canonical_port(&other.port_name)
            && self.usb_location == other.usb_location
    }
}
fn canonical_port(name: &str) -> String {
    #[cfg(windows)]
    {
        return name.trim_start_matches(r"\\.\").to_ascii_uppercase();
    }
    #[cfg(not(windows))]
    {
        name.to_owned()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialFilter {
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}
impl SerialFilter {
    pub fn matches(&self, p: &SerialPortInfo) -> bool {
        self.vid.is_none_or(|v| p.vid == Some(v)) && self.pid.is_none_or(|v| p.pid == Some(v))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialSettings {
    pub port_name: String,
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    #[serde(default = "default_bits")]
    pub data_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_stop")]
    pub stop_bits: u8,
    #[serde(default = "default_flow")]
    pub flow_control: String,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default = "default_framing")]
    pub framing: String,
}
fn default_framing() -> String {
    "raw".into()
}
fn default_baud() -> u32 {
    115200
}
fn default_bits() -> u8 {
    8
}
fn default_parity() -> String {
    "none".into()
}
fn default_stop() -> u8 {
    1
}
fn default_flow() -> String {
    "none".into()
}
impl SerialSettings {
    pub fn validate(&self) -> Result<(), SerialError> {
        if !["raw", "line", "length16"].contains(&self.framing.as_str())
            || self.port_name.is_empty()
            || self.port_name.len() > 1024
            || self.port_name.contains('\0')
            || !(1..=4_000_000).contains(&self.baud_rate)
            || !(5..=8).contains(&self.data_bits)
            || ![1, 2].contains(&self.stop_bits)
            || !["none", "odd", "even"].contains(&self.parity.as_str())
            || !["none", "software", "hardware"].contains(&self.flow_control.as_str())
        {
            return Err(SerialError::new(
                "INVALID_CONFIG",
                "Invalid serial settings",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialError {
    pub code: String,
    pub message: String,
    #[serde(default = "serial_operation")]
    pub operation: String,
    #[serde(default)]
    pub bytes_accepted: usize,
}
impl SerialError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            operation: serial_operation(),
            bytes_accepted: 0,
        }
    }
}
fn serial_operation() -> String {
    "serial".into()
}
impl std::fmt::Display for SerialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
#[derive(Clone, Debug)]
pub struct SerialState {
    pub connection_id: String,
    pub session_id: u64,
    pub status: String,
    pub port: Option<SerialPortInfo>,
    pub auto_reconnect: bool,
    pub reconnect_paused: bool,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_batches: u64,
    pub tx_messages: u64,
    pub error: Option<SerialError>,
    pub listening: bool,
    pub listen_epoch: u64,
}
pub fn timestamp_iso(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms / 3600000 % 24,
        ms / 60000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}
impl SerialState {
    pub fn value(&self) -> Value {
        let timestamp = now_ms();
        let is_open = self.status == "open";
        let reconnecting =
            self.status == "disconnected" && self.auto_reconnect && !self.reconnect_paused;
        json!({"connectionId":self.connection_id,"sessionId":if self.session_id==0{Value::Null}else{json!(self.session_id)},"status":match self.status.as_str(){"closing"=>"closed","disconnected" if reconnecting=>"reconnecting","disconnected"|"faulted"=>"needsManualOpen",other=>other},"port":self.port,"autoReconnect":self.auto_reconnect,"listening":self.listening&&is_open,"isOpen":is_open,"canOpen":!reconnecting&&!matches!(self.status.as_str(),"open"|"opening"|"closing"),"canClose":matches!(self.status.as_str(),"open"|"opening"|"closing"|"disconnected"),"counters":self.counters(),"error":self.error,"timestamp":timestamp,"timestampIso":timestamp_iso(timestamp)})
    }
    fn counters(&self) -> Value {
        json!({"txBytes":self.tx_bytes,"rxBytes":self.rx_bytes,"txPackets":self.tx_messages,"rxPackets":self.rx_batches})
    }
}
impl Serialize for SerialState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value().serialize(serializer)
    }
}
impl SerialState {
    fn closed(id: &str) -> Self {
        Self {
            connection_id: id.into(),
            session_id: 0,
            status: "closed".into(),
            port: None,
            auto_reconnect: false,
            reconnect_paused: false,
            rx_bytes: 0,
            tx_bytes: 0,
            rx_batches: 0,
            tx_messages: 0,
            error: None,
            listening: false,
            listen_epoch: 0,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialEvent {
    pub connection_id: Option<String>,
    pub session_id: u64,
    pub revision: u64,
    pub sequence: u64,
    pub timestamp: u64,
    pub kind: String,
    pub payload: Value,
    pub listen_epoch: u64,
}

pub async fn scan_ports(filter: SerialFilter) -> Result<Vec<SerialPortInfo>, SerialError> {
    static SCAN: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = SCAN
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| SerialError::new("SCAN_FAILED", e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let ports = tokio_serial::available_ports()
            .map_err(|e| SerialError::new("SCAN_FAILED", e.to_string()))?;
        let mut result: Vec<_> = ports
            .into_iter()
            .map(|p| {
                let mut info = SerialPortInfo {
                    port_name: p.port_name.clone(),
                    port_type: "unknown".into(),
                    vid: None,
                    pid: None,
                    serial_number: None,
                    manufacturer: None,
                    product: None,
                    usb_location: None,
                    display_name: p.port_name.clone(),
                };
                match p.port_type {
                    tokio_serial::SerialPortType::UsbPort(usb) => {
                        info.port_type = "usb".into();
                        info.vid = Some(usb.vid);
                        info.pid = Some(usb.pid);
                        info.serial_number = usb.serial_number;
                        info.manufacturer = usb.manufacturer;
                        info.product = usb.product;
                        info.usb_location = usb.location.map(|l| UsbLocation {
                            bus_id: l.bus_id().into(),
                            port_chain: l.port_chain().to_vec(),
                        });
                    }
                    tokio_serial::SerialPortType::BluetoothPort => {
                        info.port_type = "bluetooth".into()
                    }
                    tokio_serial::SerialPortType::PciPort => info.port_type = "pci".into(),
                    _ => {}
                }
                info
            })
            .filter(|p| filter.matches(p))
            .collect();
        #[cfg(test)]
        result.extend(
            demo_test::registered_pty_ports()
                .into_iter()
                .filter(|port| filter.matches(port)),
        );
        result.sort_by(|a, b| a.port_name.cmp(&b.port_name));
        Ok(result)
    })
    .await
    .map_err(|e| SerialError::new("SCAN_FAILED", e.to_string()))?
}

// Process-wide ownership also prevents designer and preview from sharing a port.
static PORT_LEASES: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
static NEXT_LEASE: AtomicU64 = AtomicU64::new(1);
pub(crate) struct PortLease {
    key: String,
    id: u64,
}
impl PortLease {
    pub(crate) fn acquire(port: &str) -> Result<Self, SerialError> {
        let key = canonical_port(port);
        let mut leases = PORT_LEASES.get_or_init(Default::default).lock().unwrap();
        if leases.contains_key(&key) {
            return Err(SerialError::new(
                "PORT_IN_USE",
                "Port is already owned by a runtime",
            ));
        }
        let id = NEXT_LEASE.fetch_add(1, Ordering::Relaxed);
        leases.insert(key.clone(), id);
        Ok(Self { key, id })
    }
}
impl Drop for PortLease {
    fn drop(&mut self) {
        if let Ok(mut leases) = PORT_LEASES.get_or_init(Default::default).lock() {
            if leases.get(&self.key) == Some(&self.id) {
                leases.remove(&self.key);
            }
        }
    }
}
struct Budget {
    batches: AtomicUsize,
    bytes: AtomicUsize,
}
impl Budget {
    fn acquire(self: &Arc<Self>, n: usize, batches: usize, bytes: usize) -> Option<Credit> {
        let count = self.batches.fetch_add(1, Ordering::AcqRel);
        let used = self.bytes.fetch_add(n, Ordering::AcqRel);
        if count >= batches || used.saturating_add(n) > bytes {
            self.batches.fetch_sub(1, Ordering::AcqRel);
            self.bytes.fetch_sub(n, Ordering::AcqRel);
            None
        } else {
            Some(Credit {
                budget: self.clone(),
                bytes: n,
                batches: 1,
            })
        }
    }
}
struct Credit {
    budget: Arc<Budget>,
    bytes: usize,
    batches: usize,
}
impl Drop for Credit {
    fn drop(&mut self) {
        self.budget
            .batches
            .fetch_sub(self.batches, Ordering::AcqRel);
        self.budget.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
pub struct SerialDelivery {
    pub event: SerialEvent,
    _credit: Option<Credit>,
}
struct Ingress {
    control: VecDeque<SerialEvent>,
    data: VecDeque<SerialDelivery>,
    prefer_data: bool,
}
struct Entry {
    state: SerialState,
    settings: SerialSettings,
    cancel: CancellationToken,
    sender: mpsc::Sender<Tx>,
    task: Option<tokio::task::JoinHandle<()>>,
}
struct Tx {
    bytes: Vec<u8>,
    revision: u64,
    cancel: CancellationToken,
    deadline: tokio::time::Instant,
    reply: oneshot::Sender<Result<Value, SerialError>>,
    _credit: Credit,
}
struct Inner {
    entries: Mutex<BTreeMap<String, Entry>>,
    ingress: Mutex<Ingress>,
    wake: Notify,
    revision: AtomicU64,
    sequence: AtomicU64,
    next_session: AtomicU64,
    lifetime: CancellationToken,
    rx: Arc<Budget>,
    tx: Arc<Budget>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    reconnect_tasks: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    connections: Mutex<BTreeMap<String, Value>>,
    gates: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    periodic_pause: AtomicU64,
    periodic_runs: Mutex<PeriodicRuns>,
    execution_key: Mutex<String>,
    state_wake: Notify,
    scan_needed: std::sync::atomic::AtomicBool,
}
#[derive(Clone)]
pub struct SerialService {
    inner: Arc<Inner>,
}
#[derive(Default)]
struct PeriodicRuns {
    next_id: u64,
    active: BTreeMap<u64, CancellationToken>,
}
pub struct PeriodicRun {
    inner: std::sync::Weak<Inner>,
    id: u64,
    pub cancellation: CancellationToken,
}
impl Drop for PeriodicRun {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner.periodic_runs.lock().unwrap().active.remove(&self.id);
        }
    }
}
// A cancelled caller must not leave an OS open finishing in the background with
// an indefinitely "opening" state. The actor keeps ownership until cleanup ends.
struct OpeningCleanup {
    service: SerialService,
    id: String,
    session: u64,
}
impl Drop for OpeningCleanup {
    fn drop(&mut self) {
        if let Some(entry) = self.service.inner.entries.lock().unwrap().get_mut(&self.id) {
            if entry.state.session_id == self.session
                && matches!(entry.state.status.as_str(), "opening" | "closing")
            {
                entry.state.status = "closed".into();
                entry.state.listening = false;
            }
        }
        self.service.state_event(&self.id);
    }
}
impl SerialService {
    pub fn new(lifetime: CancellationToken) -> Self {
        Self {
            inner: Arc::new(Inner {
                entries: Mutex::new(BTreeMap::new()),
                ingress: Mutex::new(Ingress {
                    control: VecDeque::new(),
                    data: VecDeque::new(),
                    prefer_data: false,
                }),
                wake: Notify::new(),
                revision: AtomicU64::new(0),
                sequence: AtomicU64::new(0),
                next_session: AtomicU64::new(1),
                lifetime,
                rx: Arc::new(Budget {
                    batches: AtomicUsize::new(0),
                    bytes: AtomicUsize::new(0),
                }),
                tx: Arc::new(Budget {
                    batches: AtomicUsize::new(0),
                    bytes: AtomicUsize::new(0),
                }),
                monitor: Mutex::new(None),
                reconnect_tasks: Mutex::new(BTreeMap::new()),
                connections: Mutex::new(BTreeMap::new()),
                gates: Mutex::new(BTreeMap::new()),
                periodic_pause: AtomicU64::new(0),
                periodic_runs: Mutex::new(PeriodicRuns::default()),
                execution_key: Mutex::new(String::new()),
                state_wake: Notify::new(),
                scan_needed: std::sync::atomic::AtomicBool::new(false),
            }),
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.inner.lifetime.is_cancelled()
    }
    pub fn cancel(&self) {
        self.inner.lifetime.cancel();
        self.pause_periodic();
        for entry in self.inner.entries.lock().unwrap().values() {
            entry.cancel.cancel();
        }
        self.inner.wake.notify_waiters();
    }
    pub async fn shutdown(&self) {
        self.cancel();
        loop {
            let done = self.inner.entries.lock().unwrap().values().all(|entry| {
                entry
                    .task
                    .as_ref()
                    .map_or(entry.state.status != "opening", |t| t.is_finished())
            });
            let monitor_done = self
                .inner
                .monitor
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|task| task.is_finished());
            let reconnect_done = self
                .inner
                .reconnect_tasks
                .lock()
                .unwrap()
                .values()
                .all(|task| task.is_finished());
            if done && monitor_done && reconnect_done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let tasks: Vec<_> = {
            self.inner
                .entries
                .lock()
                .unwrap()
                .values_mut()
                .filter_map(|entry| {
                    entry.state.status = "closed".into();
                    entry.state.listening = false;
                    entry.task.take()
                })
                .collect()
        };
        for task in tasks {
            let _ = task.await;
        }
        let monitor = self.inner.monitor.lock().unwrap().take();
        if let Some(task) = monitor {
            let _ = task.await;
        }
        let reconnect_tasks = std::mem::take(&mut *self.inner.reconnect_tasks.lock().unwrap());
        for (_, task) in reconnect_tasks {
            let _ = task.await;
        }
        let mut queue = self.inner.ingress.lock().unwrap();
        queue.data.clear();
        queue.control.clear();
    }
    pub fn periodic_epoch(&self) -> u64 {
        self.inner.periodic_pause.load(Ordering::Acquire)
    }
    pub fn periodic_run(
        &self,
        expected_epoch: u64,
        parent: &CancellationToken,
    ) -> Option<PeriodicRun> {
        let mut runs = self.inner.periodic_runs.lock().unwrap();
        if expected_epoch != self.periodic_epoch() || self.is_cancelled() || parent.is_cancelled() {
            return None;
        }
        runs.next_id = runs.next_id.checked_add(1)?;
        let id = runs.next_id;
        let cancellation = parent.child_token();
        runs.active.insert(id, cancellation.clone());
        Some(PeriodicRun {
            inner: Arc::downgrade(&self.inner),
            id,
            cancellation,
        })
    }
    fn pause_periodic(&self) {
        let mut runs = self.inner.periodic_runs.lock().unwrap();
        for token in runs.active.values() {
            token.cancel();
        }
        runs.active.clear();
        self.inner.periodic_pause.fetch_add(1, Ordering::AcqRel);
    }
    pub fn snapshot_map(&self) -> BTreeMap<String, Value> {
        self.snapshot()
            .into_iter()
            .map(|s| (s.connection_id.clone(), s.value()))
            .collect()
    }
    pub fn current_event(&self, event: &SerialEvent) -> bool {
        if event.revision != self.inner.revision.load(Ordering::Acquire) {
            return false;
        }
        if event.connection_id.is_none() {
            return true;
        }
        let entries = self.inner.entries.lock().unwrap();
        event
            .connection_id
            .as_ref()
            .and_then(|id| entries.get(id))
            .is_some_and(|e| {
                e.state.session_id == event.session_id
                    && (event.kind != "data"
                        || event.payload["direction"] == "tx"
                        || (e.state.listening && e.state.listen_epoch == event.listen_epoch))
            })
    }
    /// Coalesced state represents the latest session state. Data events always
    /// retain their original snapshot, including their recorded counters.
    pub fn refresh_state_event(&self, event: &mut SerialEvent) -> bool {
        if !self.current_event(event) {
            return false;
        }
        if event.kind == "state" {
            if let Some(connection) = event.connection_id.as_deref() {
                if let Some(entry) = self
                    .inner
                    .entries
                    .lock()
                    .unwrap()
                    .get(connection)
                    .filter(|entry| entry.state.session_id == event.session_id)
                {
                    event.payload = entry.state.value();
                    event.payload["kind"] = json!("state");
                    event.payload["sequence"] = json!(event.sequence);
                } else {
                    return false;
                }
            }
        }
        true
    }
    fn gate(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .gates
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone()
    }
    pub fn snapshot(&self) -> Vec<SerialState> {
        self.inner
            .entries
            .lock()
            .unwrap()
            .values()
            .map(|e| e.state.clone())
            .collect()
    }
    fn event(&self, id: Option<&str>, instance: u64, kind: &str, payload: Value) -> SerialEvent {
        SerialEvent {
            connection_id: id.map(str::to_owned),
            session_id: instance,
            revision: self.inner.revision.load(Ordering::Acquire),
            sequence: self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1,
            timestamp: now_ms(),
            kind: kind.into(),
            payload,
            listen_epoch: 0,
        }
    }
    fn control(&self, mut event: SerialEvent) {
        if event.payload.is_object() {
            event.payload["sequence"] = json!(event.sequence);
            event.payload["timestamp"] = json!(event.timestamp);
            event.payload["timestampIso"] = json!(timestamp_iso(event.timestamp));
        }
        let mut q = self.inner.ingress.lock().unwrap();
        q.control
            .retain(|e| e.kind != event.kind || e.connection_id != event.connection_id);
        // At most one control event per kind/connection, independent of the RX
        // budget. Never evict an undelivered fault because data filled its queue.
        q.control.push_back(event);
        drop(q);
        self.inner.wake.notify_one();
    }
    fn state_event(&self, id: &str) {
        self.publish_state(id, true);
    }
    fn counter_state_event(&self, id: &str) {
        self.publish_state(id, false);
    }
    fn publish_state(&self, id: &str, include_error: bool) {
        self.inner.state_wake.notify_one();
        let state = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.state.clone());
        if let Some(state) = state {
            let mut value = state.value();
            value["kind"] = json!("state");
            self.control(self.event(Some(id), state.session_id, "state", value));
            if let Some(error) = state.error.filter(|_| include_error) {
                let mut value = json!(error);
                value["kind"] = json!("error");
                value["connectionId"] = json!(id);
                value["sessionId"] = json!(state.session_id);
                value["timestamp"] = json!(now_ms());
                value["timestampIso"] = json!(timestamp_iso(now_ms()));
                self.control(self.event(Some(id), state.session_id, "error", value));
            }
        }
    }
    fn fault(&self, id: &str, error: SerialError, pause: bool) {
        self.pause_periodic();
        if let Some(e) = self.inner.entries.lock().unwrap().get_mut(id) {
            e.state.status = if pause { "faulted" } else { "disconnected" }.into();
            e.state.error = Some(error);
            e.state.reconnect_paused |= pause;
            if pause {
                e.state.listening = false;
                e.state.listen_epoch += 1;
            }
            e.cancel.cancel();
        }
        if pause {
            self.inner
                .ingress
                .lock()
                .unwrap()
                .data
                .retain(|delivery| delivery.event.connection_id.as_deref() != Some(id));
        }
        self.state_event(id);
    }
    pub async fn next_event(&self, cancel: &CancellationToken) -> Option<SerialDelivery> {
        loop {
            if cancel.is_cancelled() || self.is_cancelled() {
                return None;
            }
            let notified = self.inner.wake.notified();
            let queued = {
                let mut q = self.inner.ingress.lock().unwrap();
                let urgent = q.control.iter().position(|event| {
                    event.kind == "error"
                        || (event.kind == "state"
                            && (matches!(
                                event.payload["status"].as_str(),
                                Some("reconnecting" | "needsManualOpen" | "error")
                            ) || (event.payload["status"] == "closed"
                                && !event.payload["error"].is_null())))
                });
                if let Some(index) = urgent {
                    Some(SerialDelivery {
                        event: q.control.remove(index).unwrap(),
                        _credit: None,
                    })
                } else if q.prefer_data && !q.data.is_empty() {
                    q.prefer_data = false;
                    q.data.pop_front()
                } else if let Some(event) = q.control.pop_front() {
                    q.prefer_data = true;
                    Some(SerialDelivery {
                        event,
                        _credit: None,
                    })
                } else {
                    q.prefer_data = false;
                    q.data.pop_front()
                }
            };
            if let Some(mut delivery) = queued {
                if self.refresh_state_event(&mut delivery.event) {
                    return Some(delivery);
                }
                continue;
            }
            tokio::select! {_=cancel.cancelled()=>return None,_=self.inner.lifetime.cancelled()=>return None,_=notified=>{}}
        }
    }
    pub async fn next_state(&self, cancel: &CancellationToken) -> Option<BTreeMap<String, Value>> {
        tokio::select! {_=cancel.cancelled()=>None,_=self.inner.lifetime.cancelled()=>None,_=self.inner.state_wake.notified()=>Some(self.snapshot_map())}
    }
    pub async fn reconcile(&self, project: &crate::Project) {
        self.inner.scan_needed.store(
            project.flows.iter().any(|flow| {
                flow.enabled
                    && flow.nodes.iter().any(|node| {
                        node.kind == "event"
                            && node.config.get("trigger").and_then(Value::as_str) == Some("serial")
                    })
            }),
            Ordering::Release,
        );
        let key = crate::flow_v4::execution_key(project);
        {
            let mut previous = self.inner.execution_key.lock().unwrap();
            if *previous == key {
                return;
            }
            *previous = key;
        }
        self.inner.revision.fetch_add(1, Ordering::AcqRel);
        {
            let mut q = self.inner.ingress.lock().unwrap();
            q.data.clear();
            q.control.clear();
        }
        let next: BTreeMap<_, _> = project
            .connections
            .iter()
            .filter(|c| c["protocol"] == "serial")
            .filter_map(|c| {
                c["id"].as_str().map(|id| {
                    (
                        id.to_owned(),
                        json!({"id":c["id"],"protocol":c["protocol"],"config":c["config"]}),
                    )
                })
            })
            .collect();
        let changed: Vec<_> = {
            let mut old = self.inner.connections.lock().unwrap();
            let keys = old
                .iter()
                .filter(|(id, v)| next.get(*id) != Some(*v))
                .map(|(id, _)| id.clone())
                .collect();
            *old = next;
            keys
        };
        for id in changed {
            let _ = self.close(&id).await;
            if !self.inner.connections.lock().unwrap().contains_key(&id) {
                self.inner.entries.lock().unwrap().remove(&id);
            }
        }
        self.start_monitor();
    }
    fn start_monitor(&self) {
        let mut monitor = self.inner.monitor.lock().unwrap();
        if monitor.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let service = self.clone();
        *monitor = Some(tokio::spawn(async move {
            let mut previous: Option<Vec<SerialPortInfo>> = None;
            let mut previous_revision = u64::MAX;
            let mut ticks = tokio::time::interval(Duration::from_secs(1));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {_=service.inner.lifetime.cancelled()=>break,_=ticks.tick()=>{}}
                if !service.inner.scan_needed.load(Ordering::Acquire)
                    && !service.inner.entries.lock().unwrap().values().any(|entry| {
                        matches!(
                            entry.state.status.as_str(),
                            "open" | "opening" | "disconnected"
                        )
                    })
                {
                    continue;
                }
                let ports = tokio::select! {_=service.inner.lifetime.cancelled()=>break,result=scan_ports(SerialFilter::default())=>result};
                match ports {
                    Ok(ports) => {
                        let revision = service.inner.revision.load(Ordering::Acquire);
                        if previous_revision != revision {
                            previous = None;
                            previous_revision = revision;
                        }
                        if previous.as_ref() != Some(&ports) {
                            let added: Vec<_> = ports
                                .iter()
                                .filter(|p| {
                                    previous.as_ref().is_some_and(|old| {
                                        !old.iter().any(|q| q.port_name == p.port_name)
                                    })
                                })
                                .cloned()
                                .collect();
                            let removed: Vec<_> = previous
                                .as_ref()
                                .into_iter()
                                .flatten()
                                .filter(|p| !ports.iter().any(|q| q.port_name == p.port_name))
                                .cloned()
                                .collect();
                            service.control(service.event(None,0,"devices",json!({"kind":if previous.is_none(){"snapshot"}else{"changed"},"ports":ports,"added":added,"removed":removed,"changed":ports.iter().filter(|p|previous.as_ref().is_some_and(|old|old.iter().any(|q|q.port_name==p.port_name&&q!=*p))).collect::<Vec<_>>(),"sequence":service.inner.sequence.load(Ordering::Acquire)+1,"timestamp":now_ms(),"timestampIso":timestamp_iso(now_ms())})));
                            previous = Some(ports.clone());
                        }
                        service.reconnect(&ports);
                    }
                    Err(e) => {
                        let mut value = json!(e);
                        value["kind"] = json!("error");
                        value["operation"] = json!("scan");
                        service.control(service.event(None, 0, "error", value));
                    }
                }
            }
        }));
    }
    fn reconnect(&self, ports: &[SerialPortInfo]) {
        let retry: Vec<_> = {
            let entries = self.inner.entries.lock().unwrap();
            entries
                .iter()
                .filter(|(_, e)| {
                    e.state.status == "disconnected"
                        && e.state.auto_reconnect
                        && !e.state.reconnect_paused
                        && e.task.as_ref().is_none_or(|t| t.is_finished())
                })
                .map(|(id, e)| (id.clone(), e.settings.clone(), e.state.port.clone()))
                .collect()
        };
        for (id, settings, expected) in retry {
            if self.is_cancelled() {
                return;
            }
            let mut attempts = self.inner.reconnect_tasks.lock().unwrap();
            if attempts.get(&id).is_some_and(|task| !task.is_finished()) {
                continue;
            }
            let Some(expected) = expected else { continue };
            if let Some(current) = ports
                .iter()
                .find(|p| canonical_port(&p.port_name) == canonical_port(&expected.port_name))
            {
                if !expected.same_identity(current) {
                    self.fault(
                        &id,
                        SerialError::new(
                            "IDENTITY_CHANGED",
                            "Serial identity changed; open manually",
                        ),
                        true,
                    );
                    continue;
                }
                let service = self.clone();
                let connection = id.clone();
                attempts.insert(
                    id,
                    tokio::spawn(async move {
                        let _ = service
                            .open_inner(
                                &connection,
                                settings,
                                false,
                                service.inner.lifetime.child_token(),
                            )
                            .await;
                    }),
                );
            }
        }
    }
    pub async fn open(
        &self,
        id: &str,
        settings: SerialSettings,
        cancel: CancellationToken,
    ) -> Result<Value, SerialError> {
        let cancel = cancel.child_token();
        let _cancel_on_return = cancel.clone().drop_guard();
        self.open_inner(id, settings, true, cancel).await
    }
    async fn open_inner(
        &self,
        id: &str,
        mut settings: SerialSettings,
        manual: bool,
        cancel: CancellationToken,
    ) -> Result<Value, SerialError> {
        let gate = self.gate(id);
        let _guard = gate.lock().await;
        settings.validate()?;
        if self.is_cancelled() || cancel.is_cancelled() {
            return Err(SerialError::new("CANCELLED", "Runtime closed"));
        }
        if !manual
            && !self
                .inner
                .entries
                .lock()
                .unwrap()
                .get(id)
                .is_some_and(|entry| {
                    entry.state.status == "disconnected"
                        && entry.state.auto_reconnect
                        && !entry.state.reconnect_paused
                })
        {
            return Err(SerialError::new(
                "RECONNECT_CANCELLED",
                "Automatic reconnect was disabled or superseded by manual control",
            ));
        }
        if let Some(existing) = self.inner.entries.lock().unwrap().get(id) {
            let mut normalized = settings.clone();
            normalized.port_name = existing.settings.port_name.clone();
            if normalized.auto_reconnect
                && existing
                    .state
                    .port
                    .as_ref()
                    .is_some_and(|port| !port.can_reconnect())
            {
                normalized.auto_reconnect = false;
            }
            if existing.state.status == "open"
                && canonical_port(&existing.settings.port_name)
                    == canonical_port(&settings.port_name)
                && existing.settings == normalized
            {
                return Ok(existing.state.value());
            }
        }
        if self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|e| matches!(e.state.status.as_str(), "open" | "opening" | "closing"))
        {
            return Err(SerialError::new(
                "ALREADY_OPEN",
                "Close the existing session before opening again",
            ));
        }
        loop {
            let done = self
                .inner
                .entries
                .lock()
                .unwrap()
                .get(id)
                .is_none_or(|entry| entry.task.as_ref().is_none_or(|task| task.is_finished()));
            if done {
                break;
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(SerialError::new("CANCELLED", "Open cancelled during cleanup")),
                _ = self.inner.lifetime.cancelled() => return Err(SerialError::new("CANCELLED", "Runtime closed")),
                _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
        let ports = scan_ports(SerialFilter::default()).await?;
        if self.is_cancelled() || cancel.is_cancelled() {
            return Err(SerialError::new("CANCELLED", "Open cancelled"));
        }
        let info = ports
            .into_iter()
            .find(|p| canonical_port(&p.port_name) == canonical_port(&settings.port_name))
            .ok_or_else(|| SerialError::new("PORT_NOT_FOUND", "Port is no longer enumerated"))?;
        let old_identity = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|e| e.state.port.clone());
        if !manual
            && !old_identity
                .as_ref()
                .is_some_and(|old| old.same_identity(&info))
        {
            return Err(SerialError::new(
                "IDENTITY_CHANGED",
                "Automatic reconnect requires the same VID/PID, port and USB topology",
            ));
        }
        let unavailable = settings.auto_reconnect && !info.can_reconnect();
        if unavailable {
            settings.auto_reconnect = false;
        }
        let lease = PortLease::acquire(&settings.port_name)?;
        let instance = self
            .inner
            .next_session
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |id| {
                (id < 9_007_199_254_740_991).then_some(id + 1)
            })
            .map_err(|_| {
                SerialError::new(
                    "SESSION_ID_EXHAUSTED",
                    "Restart the runtime to allocate a new safe session ID",
                )
            })?;
        let (sender, receiver) = mpsc::channel(TX_BATCH_LIMIT);
        let port_cancel = self.inner.lifetime.child_token();
        let mut state = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.state.clone())
            .unwrap_or_else(|| SerialState::closed(id));
        state.status = "opening".into();
        state.session_id = instance;
        state.auto_reconnect = settings.auto_reconnect;
        state.error = if unavailable {
            Some(SerialError::new(
                "IDENTITY_UNAVAILABLE",
                "Auto reconnect disabled: VID/PID or USB topology unavailable",
            ))
        } else {
            None
        };
        if manual {
            state.reconnect_paused = false;
        }
        state.port = Some(info.clone());
        self.inner.entries.lock().unwrap().insert(
            id.to_owned(),
            Entry {
                state,
                settings: settings.clone(),
                cancel: port_cancel.clone(),
                sender,
                task: None,
            },
        );
        self.state_event(id);
        let service = self.clone();
        let connection = id.to_owned();
        let (opened, result) = oneshot::channel();
        let (accepted, acceptance) = oneshot::channel::<()>();
        let opening_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let _opening_cleanup = OpeningCleanup {
                service: service.clone(),
                id: connection.clone(),
                session: instance,
            };
            let handle = tokio::runtime::Handle::current();
            let config = settings.clone();
            let opening = tokio::task::spawn_blocking(move || {
                let _enter = handle.enter();
                let builder = tokio_serial::new(&config.port_name, config.baud_rate)
                    .data_bits(match config.data_bits {
                        5 => tokio_serial::DataBits::Five,
                        6 => tokio_serial::DataBits::Six,
                        7 => tokio_serial::DataBits::Seven,
                        _ => tokio_serial::DataBits::Eight,
                    })
                    .parity(match config.parity.as_str() {
                        "even" => tokio_serial::Parity::Even,
                        "odd" => tokio_serial::Parity::Odd,
                        _ => tokio_serial::Parity::None,
                    })
                    .stop_bits(if config.stop_bits == 2 {
                        tokio_serial::StopBits::Two
                    } else {
                        tokio_serial::StopBits::One
                    })
                    .flow_control(match config.flow_control.as_str() {
                        "hardware" => tokio_serial::FlowControl::Hardware,
                        "software" => tokio_serial::FlowControl::Software,
                        _ => tokio_serial::FlowControl::None,
                    });
                #[cfg(test)]
                let result = demo_test::take_registered_pty(&config.port_name)
                    .map(Ok)
                    .unwrap_or_else(|| builder.open_native_async());
                #[cfg(not(test))]
                let result = builder.open_native_async();
                (result, lease)
            });
            let (port, _lease) = match opening.await {
                Ok(result) => result,
                Err(e) => {
                    let error = SerialError::new("OPEN_FAILED", e.to_string());
                    let _ = opened.send(Err(error.clone()));
                    service.fault(&connection, error, false);
                    return;
                }
            };
            let mut port = match port {
                Ok(port) => port,
                Err(error) => {
                    let error = SerialError::new("OPEN_FAILED", error.to_string());
                    if let Some(e) = service.inner.entries.lock().unwrap().get_mut(&connection) {
                        e.state.status = if manual { "closed" } else { "disconnected" }.into();
                        e.state.error = Some(error.clone());
                    }
                    service.state_event(&connection);
                    let _ = opened.send(Err(error));
                    return;
                }
            };
            if port_cancel.is_cancelled() || cancel.is_cancelled() {
                let _ = opened.send(Err(SerialError::new("CANCELLED", "Open cancelled")));
                return;
            }
            #[cfg(unix)]
            if let Err(e) = port.set_exclusive(true) {
                let error = SerialError::new("OPEN_FAILED", e.to_string());
                let _ = opened.send(Err(error.clone()));
                service.fault(&connection, error, false);
                return;
            }
            let fresh = tokio::select! {_=port_cancel.cancelled()=>{let _=opened.send(Err(SerialError::new("CANCELLED","Open cancelled")));return;},_=cancel.cancelled()=>{let _=opened.send(Err(SerialError::new("CANCELLED","Open cancelled")));return;},result=scan_ports(SerialFilter::default())=>result};
            let matches = fresh
                .as_ref()
                .ok()
                .and_then(|ports| ports.iter().find(|p| p.port_name == info.port_name))
                .is_some_and(|p| {
                    p.vid == info.vid && p.pid == info.pid && p.usb_location == info.usb_location
                });
            if !matches || port_cancel.is_cancelled() || cancel.is_cancelled() {
                let error = SerialError::new(
                    "IDENTITY_CHANGED",
                    "Port changed or open cancelled before activation",
                );
                let _ = opened.send(Err(error.clone()));
                service.fault(&connection, error, true);
                return;
            }
            if let Some(e) = service.inner.entries.lock().unwrap().get_mut(&connection) {
                e.state.status = "open".into();
                e.state.listening = if manual { true } else { e.state.listening };
                e.state.listen_epoch += 1;
            }
            service.state_event(&connection);
            let state = service
                .inner
                .entries
                .lock()
                .unwrap()
                .get(&connection)
                .map(|e| e.state.clone());
            let delivered = opened.send(Ok(json!(state))).is_ok();
            // Open becomes persistent only when the caller accepted the result.
            // Cancelling or dropping that caller closes a late OS handle.
            let accepted = delivered
                && tokio::select! {
                    biased;
                    result = acceptance => result.is_ok(),
                    _ = port_cancel.cancelled() => false,
                    _ = cancel.cancelled() => false,
                };
            if !accepted || port_cancel.is_cancelled() {
                if let Some(entry) = service.inner.entries.lock().unwrap().get_mut(&connection) {
                    if entry.state.session_id == instance {
                        entry.state.status = "closing".into();
                    }
                }
                return;
            }
            service
                .run_port(
                    connection.clone(),
                    instance,
                    port,
                    receiver,
                    port_cancel.clone(),
                )
                .await;
            if let Some(e) = service.inner.entries.lock().unwrap().get_mut(&connection) {
                if e.state.session_id == instance && e.state.status == "open" {
                    e.state.status = "disconnected".into();
                    e.state.error =
                        Some(SerialError::new("DISCONNECTED", "Serial connection ended"));
                }
            }
            service.state_event(&connection);
        });
        if let Some(entry) = self.inner.entries.lock().unwrap().get_mut(id) {
            entry.task = Some(task);
        }
        let state = tokio::time::timeout(Duration::from_secs(5), result)
            .await
            .map_err(|_| {
                let error = SerialError::new(
                    "OPEN_TIMEOUT",
                    "Open is still being cleaned up; no retry was started",
                );
                if let Some(entry) = self.inner.entries.lock().unwrap().get_mut(id) {
                    entry.cancel.cancel();
                    entry.state.status = "closing".into();
                    entry.state.error = Some(error.clone());
                }
                self.state_event(id);
                error
            })?
            .map_err(|_| SerialError::new("CANCELLED", "Open cancelled"))??;
        // The actor still owns the original cancellation token. Its acceptance
        // branch wins over cancellation caused by returning a successful open.
        if self.is_cancelled() || opening_cancel.is_cancelled() {
            return Err(SerialError::new("CANCELLED", "Runtime closed"));
        }
        accepted
            .send(())
            .map_err(|_| SerialError::new("CANCELLED", "Open was cancelled before activation"))?;
        Ok(state)
    }
    pub async fn close(&self, id: &str) -> Result<Value, SerialError> {
        self.pause_periodic();
        if let Some(e) = self.inner.entries.lock().unwrap().get(id) {
            e.cancel.cancel();
        }
        let gate = self.gate(id);
        let _guard = gate.lock().await;
        {
            let mut entries = self.inner.entries.lock().unwrap();
            if let Some(e) = entries.get_mut(id) {
                e.state.status = "closing".into();
                e.state.reconnect_paused = true;
                e.cancel.cancel();
            } else {
                return Ok(json!(SerialState::closed(id)));
            }
        }
        loop {
            let done = self
                .inner
                .entries
                .lock()
                .unwrap()
                .get(id)
                .is_none_or(|e| e.task.as_ref().is_none_or(|t| t.is_finished()));
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let task = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get_mut(id)
            .and_then(|e| e.task.take());
        if let Some(task) = task {
            task.await
                .map_err(|e| SerialError::new("CLOSE_FAILED", e.to_string()))?;
        }
        if let Some(e) = self.inner.entries.lock().unwrap().get_mut(id) {
            e.state.status = "closed".into();
            e.state.error = None;
            e.state.listening = false;
            e.state.listen_epoch += 1;
        }
        self.inner
            .ingress
            .lock()
            .unwrap()
            .data
            .retain(|delivery| delivery.event.connection_id.as_deref() != Some(id));
        self.state_event(id);
        Ok(json!(self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.state.clone())))
    }
    pub fn listen(&self, id: &str, enabled: bool) -> Result<Value, SerialError> {
        let state = {
            let mut entries = self.inner.entries.lock().unwrap();
            let e = entries
                .get_mut(id)
                .filter(|e| e.state.status == "open")
                .ok_or_else(|| SerialError::new("NOT_OPEN", "Serial port is not open"))?;
            e.state.listening = enabled;
            e.state.listen_epoch += 1;
            e.state.clone()
        };
        if !enabled {
            self.inner.ingress.lock().unwrap().data.retain(|item| {
                item.event.connection_id.as_deref() != Some(id)
                    || item.event.payload["direction"] == "tx"
            });
        }
        self.state_event(id);
        Ok(state.value())
    }
    pub fn reset_counters(&self, id: &str) -> Result<Value, SerialError> {
        let state = {
            let mut entries = self.inner.entries.lock().unwrap();
            let e = entries
                .get_mut(id)
                .ok_or_else(|| SerialError::new("NOT_OPEN", "No serial session"))?;
            e.state.rx_bytes = 0;
            e.state.tx_bytes = 0;
            e.state.rx_batches = 0;
            e.state.tx_messages = 0;
            e.state.clone()
        };
        self.state_event(id);
        Ok(state.value())
    }
    pub fn set_reconnect(&self, id: &str, enabled: bool) -> Result<Value, SerialError> {
        let state = {
            let mut entries = self.inner.entries.lock().unwrap();
            let e = entries.get_mut(id).ok_or_else(|| {
                SerialError::new("NOT_OPEN", "Open manually before configuring reconnect")
            })?;
            if enabled && e.state.reconnect_paused {
                return Err(SerialError::new(
                    "MANUAL_OPEN_REQUIRED",
                    "Open manually before enabling automatic reconnect",
                ));
            }
            if enabled
                && !e
                    .state
                    .port
                    .as_ref()
                    .is_some_and(SerialPortInfo::can_reconnect)
            {
                return Err(SerialError::new(
                    "IDENTITY_UNAVAILABLE",
                    "USB identity is incomplete",
                ));
            }
            e.state.auto_reconnect = enabled;
            e.settings.auto_reconnect = enabled;
            e.state.clone()
        };
        self.state_event(id);
        Ok(json!(state))
    }
    pub async fn send(
        &self,
        id: &str,
        bytes: Vec<u8>,
        timeout_ms: u64,
        cancel: CancellationToken,
    ) -> Result<Value, SerialError> {
        let cancel = cancel.child_token();
        let _cancel_on_return = cancel.clone().drop_guard();
        if cancel.is_cancelled() || self.is_cancelled() {
            return Err(SerialError::new("CANCELLED", "Write cancelled"));
        }
        if bytes.len() > MAX_MESSAGE {
            return Err(SerialError::new(
                "MESSAGE_TOO_LARGE",
                "Send exceeds 65535 bytes",
            ));
        }
        let credit = self
            .inner
            .tx
            .acquire(bytes.len(), TX_BATCH_LIMIT, TX_BYTE_LIMIT)
            .ok_or_else(|| SerialError::new("TX_QUEUE_FULL", "Transmit queue is full"))?;
        let sender = {
            let entries = self.inner.entries.lock().unwrap();
            let e = entries
                .get(id)
                .filter(|e| e.state.status == "open")
                .ok_or_else(|| SerialError::new("NOT_OPEN", "Serial port is not open"))?;
            e.sender.clone()
        };
        let (reply, result) = oneshot::channel();
        sender
            .try_send(Tx {
                bytes,
                revision: self.inner.revision.load(Ordering::Acquire),
                cancel,
                deadline: tokio::time::Instant::now()
                    + Duration::from_millis(timeout_ms.clamp(1, 15000)),
                reply,
                _credit: credit,
            })
            .map_err(|_| SerialError::new("TX_QUEUE_FULL", "Transmit queue unavailable"))?;
        result.await.map_err(|_| {
            SerialError::new(
                "CANCELLED",
                "Transmit stopped; queued messages are not replayed",
            )
        })?
    }
    async fn run_port(
        &self,
        id: String,
        instance: u64,
        port: tokio_serial::SerialStream,
        mut commands: mpsc::Receiver<Tx>,
        cancel: CancellationToken,
    ) {
        let (mut reader, mut writer) = tokio::io::split(port);
        let rx = self.clone();
        let rx_id = id.clone();
        let rx_cancel = cancel.clone();
        let framing = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .settings
            .framing
            .clone();
        let receive = async move {
            let mut buffer = [0u8; 4096];
            let mut pending = Vec::<u8>::new();
            let mut parser_credit = Credit {
                budget: rx.inner.rx.clone(),
                bytes: 0,
                batches: 0,
            };
            let mut utf8 = Utf8Stream::default();
            let mut listen_epoch = 0;
            let mut execution_epoch = rx.inner.revision.load(Ordering::Acquire);
            loop {
                let result = tokio::select! {biased;_=rx_cancel.cancelled()=>return,result=reader.read(&mut buffer)=>result};
                let size = match result {
                    Ok(0) => {
                        rx.fault(
                            &rx_id,
                            SerialError::new("DISCONNECTED", "Serial peer closed"),
                            false,
                        );
                        return;
                    }
                    Ok(n) => n,
                    Err(e) => {
                        rx.fault(&rx_id, SerialError::new("IO_ERROR", e.to_string()), false);
                        return;
                    }
                };
                let state = {
                    let mut entries = rx.inner.entries.lock().unwrap();
                    let Some(entry) = entries.get_mut(&rx_id) else {
                        return;
                    };
                    entry.state.rx_bytes += size as u64;
                    entry.state.clone()
                };
                rx.inner.state_wake.notify_one();
                let read_epoch = rx.inner.revision.load(Ordering::Acquire);
                if listen_epoch != state.listen_epoch || execution_epoch != read_epoch {
                    pending.clear();
                    utf8 = Utf8Stream::default();
                    rx.inner
                        .rx
                        .bytes
                        .fetch_sub(parser_credit.bytes, Ordering::AcqRel);
                    parser_credit.bytes = 0;
                    listen_epoch = state.listen_epoch;
                    execution_epoch = read_epoch;
                }
                if !state.listening {
                    rx.counter_state_event(&rx_id);
                    continue;
                }
                let before = rx.inner.rx.bytes.fetch_add(size, Ordering::AcqRel);
                if before.saturating_add(size) > RX_BYTE_LIMIT {
                    rx.inner.rx.bytes.fetch_sub(size, Ordering::AcqRel);
                    rx.fault(
                        &rx_id,
                        SerialError::new(
                            "RX_OVERFLOW",
                            "RX exceeded 256 batches or 1 MiB; reopen manually",
                        ),
                        true,
                    );
                    return;
                }
                parser_credit.bytes += size;
                pending.extend_from_slice(&buffer[..size]);
                loop {
                    let frame = match framing.as_str() {
                        "raw" => Some((pending.len(), 0, pending.len())),
                        "line" => pending.iter().position(|b| *b == b'\n').map(|end| {
                            (
                                end + 1,
                                0,
                                if end > 0 && pending[end - 1] == b'\r' {
                                    end - 1
                                } else {
                                    end
                                },
                            )
                        }),
                        "length16" if pending.len() >= 2 => {
                            let n = u16::from_be_bytes([pending[0], pending[1]]) as usize;
                            if pending.len() >= n + 2 {
                                Some((n + 2, 2, n + 2))
                            } else {
                                None
                            }
                        }
                        _ => None,
                    };
                    let Some((wire, start, end)) = frame else {
                        break;
                    };
                    if wire == 0 {
                        break;
                    }
                    let batches = rx.inner.rx.batches.fetch_add(1, Ordering::AcqRel);
                    if batches >= RX_BATCH_LIMIT {
                        rx.inner.rx.batches.fetch_sub(1, Ordering::AcqRel);
                        rx.fault(
                            &rx_id,
                            SerialError::new(
                                "RX_OVERFLOW",
                                "RX exceeded 256 batches or 1 MiB; reopen manually",
                            ),
                            true,
                        );
                        return;
                    }
                    let credit = Credit {
                        budget: rx.inner.rx.clone(),
                        bytes: wire,
                        batches: 1,
                    };
                    parser_credit.bytes -= wire;
                    let payload = pending[start..end].to_vec();
                    pending.drain(..wire);
                    let state = {
                        let mut entries = rx.inner.entries.lock().unwrap();
                        let entry = entries.get_mut(&rx_id).unwrap();
                        entry.state.rx_batches += 1;
                        entry.state.clone()
                    };
                    let mut event=rx.event(Some(&rx_id),instance,"data",json!({"kind":"data","direction":"rx","connectionId":rx_id,"sessionId":instance,"hex":hex(&payload),"text":utf8.push(&payload),"byteLength":wire,"counters":state.value()["counters"]}));
                    event.listen_epoch = listen_epoch;
                    event.revision = read_epoch;
                    event.payload["sequence"] = json!(event.sequence);
                    event.payload["timestamp"] = json!(event.timestamp);
                    event.payload["timestampIso"] = json!(timestamp_iso(event.timestamp));
                    rx.inner
                        .ingress
                        .lock()
                        .unwrap()
                        .data
                        .push_back(SerialDelivery {
                            event,
                            _credit: Some(credit),
                        });
                    rx.inner.wake.notify_one();
                    if pending.is_empty() {
                        break;
                    }
                }
                rx.counter_state_event(&rx_id);
            }
        };
        let tx_service = self.clone();
        let tx_id = id.clone();
        let tx_cancel = cancel.clone();
        let transmit = async move {
            loop {
                let request = tokio::select! {biased;_=tx_cancel.cancelled()=>return,request=commands.recv()=>match request{Some(r)=>r,None=>return}};
                let mut accepted = 0;
                let mut failure = if request.cancel.is_cancelled() {
                    Some(SerialError::new("CANCELLED", "Write cancelled"))
                } else if tokio::time::Instant::now() >= request.deadline {
                    Some(SerialError::new("WRITE_TIMEOUT", "Write deadline exceeded"))
                } else {
                    None
                };
                while failure.is_none() && accepted < request.bytes.len() {
                    let result = tokio::select! {biased;_=tx_cancel.cancelled()=>Err(SerialError::new("DISCONNECTED","Connection stopped")),_=request.cancel.cancelled()=>Err(SerialError::new("CANCELLED","Write cancelled")),_=tokio::time::sleep_until(request.deadline)=>Err(SerialError::new("WRITE_TIMEOUT","Write deadline exceeded")),result=writer.write(&request.bytes[accepted..])=>result.map_err(|e|SerialError::new("IO_ERROR",e.to_string()))};
                    match result {
                        Ok(0) => {
                            failure =
                                Some(SerialError::new("IO_ERROR", "Write returned zero bytes"));
                            break;
                        }
                        Ok(n) => {
                            accepted += n;
                            if let Some(e) =
                                tx_service.inner.entries.lock().unwrap().get_mut(&tx_id)
                            {
                                e.state.tx_bytes += n as u64;
                            }
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
                if let Some(mut error) = failure {
                    error.bytes_accepted = accepted;
                    error.operation = "send".into();
                    let fatal = error.code == "IO_ERROR";
                    let _ = request.reply.send(Err(error.clone()));
                    let mut payload = json!(error);
                    payload["kind"] = json!("error");
                    payload["connectionId"] = json!(tx_id);
                    payload["sessionId"] = json!(instance);
                    let mut event = tx_service.event(Some(&tx_id), instance, "error", payload);
                    event.revision = request.revision;
                    tx_service.control(event);
                    tx_service.counter_state_event(&tx_id);
                    if fatal {
                        tx_service.fault(&tx_id, error, false);
                        return;
                    }
                } else {
                    let state = {
                        let mut entries = tx_service.inner.entries.lock().unwrap();
                        let e = entries.get_mut(&tx_id).unwrap();
                        e.state.tx_messages += 1;
                        e.state.clone()
                    };
                    let mut event=tx_service.event(Some(&tx_id),instance,"data",json!({"kind":"data","direction":"tx","connectionId":tx_id,"sessionId":instance,"byteLength":accepted,"text":String::from_utf8_lossy(&request.bytes),"hex":hex(&request.bytes),"counters":state.value()["counters"]}));
                    event.payload["sequence"] = json!(event.sequence);
                    event.payload["timestamp"] = json!(event.timestamp);
                    event.payload["timestampIso"] = json!(timestamp_iso(event.timestamp));
                    let response = json!({"bytesAccepted":accepted,"counters":state.value()["counters"],"timestamp":event.timestamp,"timestampIso":timestamp_iso(event.timestamp)});
                    event.revision = request.revision;
                    tx_service
                        .inner
                        .ingress
                        .lock()
                        .unwrap()
                        .data
                        .push_back(SerialDelivery {
                            event,
                            _credit: Some(request._credit),
                        });
                    tx_service.inner.wake.notify_one();
                    let _ = request.reply.send(Ok(response));
                    tx_service.counter_state_event(&tx_id);
                }
            }
        };
        let receive_done = async {
            receive.await;
            cancel.cancel();
        };
        let transmit_done = async {
            transmit.await;
            cancel.cancel();
        };
        tokio::join!(receive_done, transmit_done);
    }
}

pub fn encode_serial(
    data: &str,
    encoding: &str,
    line_ending: &str,
) -> Result<Vec<u8>, SerialError> {
    let mut bytes = match encoding {
        "utf8" => data.as_bytes().to_vec(),
        "hex" => {
            let text: String = data
                .chars()
                .filter(|c| !matches!(c, '\t'..='\r' | ' '))
                .collect();
            if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(SerialError::new(
                    "INVALID_HEX",
                    "HEX requires complete hexadecimal byte pairs",
                ));
            }
            (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
                .collect()
        }
        _ => {
            return Err(SerialError::new(
                "INVALID_ENCODING",
                "Encoding must be utf8 or hex",
            ))
        }
    };
    bytes.extend_from_slice(match line_ending {
        "none" => b"",
        "lf" => b"\n",
        "crlf" => b"\r\n",
        _ => return Err(SerialError::new("INVALID_CONFIG", "Unknown line ending")),
    });
    if bytes.len() > MAX_MESSAGE {
        return Err(SerialError::new(
            "MESSAGE_TOO_LARGE",
            "Send exceeds 65535 bytes",
        ));
    }
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

#[cfg(test)]
#[path = "serial_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "serial_demo_test.rs"]
mod demo_test;
impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let good = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..good]).unwrap());
                    match error.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..good + n);
                        }
                        None => {
                            self.pending.drain(..good);
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}
