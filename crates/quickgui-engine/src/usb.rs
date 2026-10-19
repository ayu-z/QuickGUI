//! USB FB host. The upstream manager owns discovery identities and native I/O.
use crate::{now_ms, CancellationToken};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{mpsc, Mutex, OnceCell};
use usb_comm::{
    Bus, DeviceFilter, DeviceInfo, DeviceManager, DevicePath, HidSession, Transport,
    UsbPrintSession,
};
#[cfg(test)]
#[path = "usb_tests.rs"]
mod tests;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    pub transport: Option<String>,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub serial_number: Option<String>,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
}
impl Filter {
    pub fn native(&self) -> Result<usb_comm::DeviceFilterSet, String> {
        let transports = match self.transport.as_deref().unwrap_or("any") {
            "any" => vec![Transport::Hid, Transport::UsbPrint],
            "hid" => vec![Transport::Hid],
            "usbPrint" => vec![Transport::UsbPrint],
            _ => return Err("USB transport must be any, hid or usbPrint".into()),
        };
        Ok(DeviceFilter::any_of(transports.into_iter().map(
            |transport| DeviceFilter {
                transport: Some(transport),
                bus: Some(Bus::Usb),
                vendor_id: self.vendor_id,
                product_id: self.product_id,
                serial_number: self.serial_number.clone(),
                usage_page: self.usage_page,
                usage: self.usage,
                ..Default::default()
            },
        )))
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub numbered_input_reports: Option<bool>,
    pub bulk_max_packet_size: Option<usize>,
    pub send_zero_length_packet: Option<bool>,
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .bulk_max_packet_size
            .is_some_and(|v| ![8, 16, 32, 64, 512, 1024].contains(&v))
        {
            return Err("Invalid USB bulk packet size".into());
        }
        Ok(())
    }
}
pub fn envelope(result: Value, port: &str) -> Value {
    json!({"data":if ["rx","tx","feature","descriptor"].contains(&port) {result.clone()}else{Value::Null},
        "state":if port=="state" {result.clone()}else{Value::Null},
        "devices":if result.is_array(){result.clone()}else{result.get("devices").or_else(||result.get("ports")).cloned().unwrap_or(json!([]))},
        "result":result})
}
pub fn diagnostic(error: impl std::fmt::Display) -> Value {
    json!({"code":"USB_ERROR","message":error.to_string(),"operation":"usb"})
}
fn identity(device: &DeviceInfo) -> String {
    let (prefix, bytes) = match &device.id.endpoint {
        DevicePath::Hid(path) => ("hid", path.clone()),
        DevicePath::UsbPrint(path) => ("usbPrint", path.as_bytes().to_vec()),
        DevicePath::Serial(path) => ("serial", path.as_bytes().to_vec()),
    };
    format!(
        "{prefix}:{}:{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        device.id.generation
    )
}
pub fn device_json(d: &DeviceInfo) -> Value {
    let path = match &d.id.endpoint {
        DevicePath::Hid(bytes) => json!({"bytes":bytes}),
        DevicePath::UsbPrint(path) | DevicePath::Serial(path) => json!({"text":path}),
    };
    json!({"id":identity(d),"generation":d.id.generation,"path":path,
        "transport":match d.transport {Transport::Hid=>"hid",Transport::UsbPrint=>"usbPrint",Transport::Serial=>"serial"},
        "bus":format!("{:?}",d.bus),"vendorId":d.vendor_id,"productId":d.product_id,
        "serialNumber":d.serial_number,"manufacturer":d.manufacturer,"product":d.product,
        "hid":d.hid.as_ref().map(|h|json!({"interfaceNumber":h.interface_number,"usagePage":h.usage_page,"usage":h.usage})),
        "usbPrint":d.usb_print.as_ref().map(|p|json!({"location":p.location,"deviceInstanceId":p.device_instance_id}))})
}
#[derive(Clone)]
enum Session {
    Hid(HidSession),
    Print(UsbPrintSession),
}
impl Session {
    async fn close(&self) {
        let _ = match self {
            Self::Hid(s) => s.close().await,
            Self::Print(s) => s.close().await,
        };
    }
    async fn recv(&self) -> usb_comm::Result<(u8, Vec<u8>)> {
        match self {
            Self::Hid(s) => s.recv(None).await.map(|r| (r.report_id, r.payload)),
            Self::Print(s) => s.recv(None).await.map(|v| (0, v)),
        }
    }
}
struct Task {
    cancel: CancellationToken,
    join: tokio::task::JoinHandle<()>,
}
struct Entry {
    session: Session,
    task: Task,
}
pub struct Event {
    pub validity: CancellationToken,
    pub revision: u64,
    pub session_id: Option<String>,
    pub target: Option<(String, String)>,
    pub port: String,
    pub value: Value,
}
struct Inner {
    lifetime: CancellationToken,
    revision: AtomicU64,
    manager: OnceCell<DeviceManager>,
    gate: Mutex<()>,
    devices: Mutex<BTreeMap<String, DeviceInfo>>,
    sessions: Mutex<BTreeMap<String, Entry>>,
    watchers: Mutex<BTreeMap<(String, String), Task>>,
    controls: Mutex<BTreeMap<String, CancellationToken>>,
    sender: mpsc::Sender<Event>,
    receiver: Mutex<mpsc::Receiver<Event>>,
}
#[derive(Clone)]
pub struct UsbService {
    inner: Arc<Inner>,
}
impl UsbService {
    pub fn new(lifetime: CancellationToken) -> Self {
        let (sender, receiver) = mpsc::channel(64);
        Self {
            inner: Arc::new(Inner {
                lifetime,
                revision: AtomicU64::new(0),
                manager: OnceCell::new(),
                gate: Mutex::new(()),
                devices: Mutex::new(BTreeMap::new()),
                sessions: Mutex::new(BTreeMap::new()),
                watchers: Mutex::new(BTreeMap::new()),
                controls: Mutex::new(BTreeMap::new()),
                sender,
                receiver: Mutex::new(receiver),
            }),
        }
    }
    async fn manager(&self) -> Result<&DeviceManager, Value> {
        self.inner
            .manager
            .get_or_try_init(|| async { DeviceManager::new(Default::default()) })
            .await
            .map_err(diagnostic)
    }
    pub fn current(&self, event: &Event) -> bool {
        !event.validity.is_cancelled()
            && event.revision == self.inner.revision.load(Ordering::Acquire)
            && !self.inner.lifetime.is_cancelled()
    }
    pub async fn next_event(&self, cancel: &CancellationToken) -> Option<Event> {
        tokio::select! {_=cancel.cancelled()=>None,_=self.inner.lifetime.cancelled()=>None,v=async {self.inner.receiver.lock().await.recv().await}=>v}
    }
    async fn emit(&self, event: Event, cancel: &CancellationToken) {
        tokio::select! {_=cancel.cancelled()=>{},_=self.inner.lifetime.cancelled()=>{},_=self.inner.sender.send(event)=>{}}
    }
    async fn stop(task: Task) {
        task.cancel.cancel();
        let _ = task.join.await;
    }
    pub async fn reset(&self) {
        let _gate = self.inner.gate.lock().await;
        self.inner.revision.fetch_add(1, Ordering::AcqRel);
        for (_, token) in std::mem::take(&mut *self.inner.controls.lock().await) {
            token.cancel();
        }
        let watchers = std::mem::take(&mut *self.inner.watchers.lock().await);
        for (_, task) in watchers {
            Self::stop(task).await;
        }
        let sessions = std::mem::take(&mut *self.inner.sessions.lock().await);
        for (_, entry) in sessions {
            Self::stop(entry.task).await;
            entry.session.close().await;
        }
        self.inner.devices.lock().await.clear();
        // A scheduler may be blocked in recv while holding the receiver lock.
        // Revision and validity checks discard old queued events on delivery.
    }
    async fn snapshot(&self, filter: &Filter) -> Result<Value, Value> {
        let devices = self
            .manager()
            .await?
            .discover(filter.native().map_err(diagnostic)?)
            .await
            .map_err(diagnostic)?;
        // Cache exact opaque identities; upstream rechecks the generation before opening.
        let mut cache = self.inner.devices.lock().await;
        cache.retain(|_, device| !filter.native().unwrap().matches(device));
        for device in &devices {
            cache.insert(identity(device), device.clone());
        }
        Ok(
            json!({"kind":"snapshot","devices":devices.iter().map(device_json).collect::<Vec<_>>(),"timestamp":now_ms()}),
        )
    }
    pub async fn discover(
        &self,
        flow: &str,
        node: &str,
        command: &str,
        filter: Filter,
    ) -> Result<Value, Value> {
        let _gate = self.inner.gate.lock().await;
        let target = (flow.to_owned(), node.to_owned());
        if command == "unwatch" {
            if let Some(task) = self.inner.watchers.lock().await.remove(&target) {
                Self::stop(task).await;
            }
            return Ok(json!({"devices":[],"kind":"stopped","timestamp":now_ms()}));
        }
        let result = self.snapshot(&filter).await?;
        if command == "watch" {
            if let Some(task) = self.inner.watchers.lock().await.remove(&target) {
                Self::stop(task).await;
            }
            let manager = self.manager().await?.clone();
            let native = filter.native().map_err(diagnostic)?;
            let mut watcher = manager.watch(native.clone());
            let cancel = self.inner.lifetime.child_token();
            let stop = cancel.clone();
            let owner = self.clone();
            let destination = target.clone();
            let revision = self.inner.revision.load(Ordering::Acquire);
            let cleanup = cancel.clone().drop_guard();
            let join = tokio::spawn(async move {
                loop {
                    let event =
                        tokio::select! {_=stop.cancelled()=>break,event=watcher.recv()=>event};
                    let event = match event {
                        Ok(e) => e,
                        Err(error) => {
                            owner
                                .emit(
                                    Event {
                                        validity: stop.clone(),
                                        revision,
                                        session_id: None,
                                        target: Some(destination.clone()),
                                        port: "error".into(),
                                        value: diagnostic(error),
                                    },
                                    &stop,
                                )
                                .await;
                            break;
                        }
                    };
                    let kind = match event {
                        usb_comm::DeviceEvent::Snapshot { .. } => "snapshot",
                        usb_comm::DeviceEvent::Added { .. } => "added",
                        usb_comm::DeviceEvent::Removed { .. } => "removed",
                        usb_comm::DeviceEvent::Changed { .. } => "changed",
                        usb_comm::DeviceEvent::ResyncRequired { .. } => {
                            watcher = manager.watch(native.clone());
                            "resync"
                        }
                        usb_comm::DeviceEvent::BackendError(error) => {
                            owner
                                .emit(
                                    Event {
                                        validity: stop.clone(),
                                        revision,
                                        session_id: None,
                                        target: Some(destination.clone()),
                                        port: "error".into(),
                                        value: diagnostic(error),
                                    },
                                    &stop,
                                )
                                .await;
                            continue;
                        }
                        _ => continue,
                    };
                    let result = tokio::select! {_=stop.cancelled()=>break,result=owner.snapshot(&filter)=>result};
                    let (value, port) = match result {
                        Ok(mut v) => {
                            v["kind"] = json!(kind);
                            (envelope(v, "changed"), "changed")
                        }
                        Err(e) => (e, "error"),
                    };
                    owner
                        .emit(
                            Event {
                                validity: stop.clone(),
                                revision,
                                session_id: None,
                                target: Some(destination.clone()),
                                port: port.into(),
                                value,
                            },
                            &stop,
                        )
                        .await;
                }
            });
            self.inner
                .watchers
                .lock()
                .await
                .insert(target, Task { cancel, join });
            cleanup.disarm();
        }
        Ok(result)
    }
    pub async fn command(
        &self,
        id: &str,
        command: &str,
        device: Value,
        options: Options,
        bytes: Vec<u8>,
        report_id: u8,
        length: usize,
        invocation: CancellationToken,
    ) -> Result<(Value, String), Value> {
        let owner = self.clone();
        let id = id.to_owned();
        let command = command.to_owned();
        let revision = self.inner.revision.load(Ordering::Acquire);
        tokio::spawn(async move {
            let result = owner
                .command_owned(
                    &id,
                    &command,
                    device,
                    options,
                    bytes,
                    report_id,
                    length,
                    revision,
                    &invocation,
                )
                .await;
            if invocation.is_cancelled() && command == "open" {
                let _ = owner
                    .command_owned(
                        &id,
                        "close",
                        Value::Null,
                        Options::default(),
                        vec![],
                        0,
                        1,
                        revision,
                        &CancellationToken::new(),
                    )
                    .await;
                return Err(diagnostic("USB invocation cancelled"));
            }
            if let Ok((value, port)) = &result {
                let validity = owner
                    .inner
                    .sessions
                    .lock()
                    .await
                    .get(&id)
                    .map(|e| e.task.cancel.clone())
                    .unwrap_or_else(|| owner.inner.lifetime.child_token());
                if port == "state" {
                    if let Some(previous) = owner
                        .inner
                        .controls
                        .lock()
                        .await
                        .insert(id.clone(), validity.clone())
                    {
                        previous.cancel();
                    }
                }
                owner
                    .emit(
                        Event {
                            validity,
                            revision,
                            session_id: Some(id.clone()),
                            target: None,
                            port: port.clone(),
                            value: envelope(value.clone(), port),
                        },
                        &invocation,
                    )
                    .await;
            }
            result
        })
        .await
        .map_err(diagnostic)?
    }
    async fn command_owned(
        &self,
        id: &str,
        command: &str,
        device: Value,
        options: Options,
        bytes: Vec<u8>,
        report_id: u8,
        length: usize,
        revision: u64,
        invocation: &CancellationToken,
    ) -> Result<(Value, String), Value> {
        let _gate = self.inner.gate.lock().await;
        if invocation.is_cancelled()
            || self.inner.lifetime.is_cancelled()
            || revision != self.inner.revision.load(Ordering::Acquire)
        {
            return Err(diagnostic("Stale USB command"));
        }
        if command == "close" {
            if let Some(entry) = self.inner.sessions.lock().await.remove(id) {
                Self::stop(entry.task).await;
                entry.session.close().await;
            }
            return Ok((
                json!({"sessionId":id,"status":"closed","timestamp":now_ms()}),
                "state".into(),
            ));
        }
        if command == "open" {
            options.validate().map_err(diagnostic)?;
            if self.inner.sessions.lock().await.contains_key(id) {
                return Err(diagnostic(
                    "USB session already open; close it before changing device",
                ));
            }
            let key = device
                .as_str()
                .or_else(|| device.get("id").and_then(Value::as_str))
                .ok_or_else(|| diagnostic("Select an exact device returned by USB discovery"))?;
            let info = self
                .inner
                .devices
                .lock()
                .await
                .get(key)
                .cloned()
                .ok_or_else(|| {
                    diagnostic("Device identity is stale or was not discovered in this runtime")
                })?;
            let manager = self.manager().await?;
            let session = match info.transport {
                Transport::Hid => Session::Hid(
                    manager
                        .open_hid(
                            &info,
                            usb_comm::HidOptions {
                                numbered_input_reports: options
                                    .numbered_input_reports
                                    .unwrap_or(false),
                                ..Default::default()
                            },
                        )
                        .await
                        .map_err(diagnostic)?,
                ),
                Transport::UsbPrint => Session::Print(
                    manager
                        .open_usb_print(
                            &info,
                            usb_comm::UsbPrintOptions {
                                bulk_max_packet_size: options.bulk_max_packet_size.unwrap_or(64),
                                send_zero_length_packet: options
                                    .send_zero_length_packet
                                    .unwrap_or(true),
                                ..Default::default()
                            },
                        )
                        .await
                        .map_err(diagnostic)?,
                ),
                _ => {
                    return Err(diagnostic(
                        "Use the serial communication FB for serial endpoints",
                    ))
                }
            };
            let cancel = self.inner.lifetime.child_token();
            let stop = cancel.clone();
            let receiver = session.clone();
            let owner = self.clone();
            let session_id = id.to_owned();
            let revision = self.inner.revision.load(Ordering::Acquire);
            let cleanup = cancel.clone().drop_guard();
            let join = tokio::spawn(async move {
                loop {
                    let result =
                        tokio::select! {_=stop.cancelled()=>break,result=receiver.recv()=>result};
                    match result {
                        Ok((report_id, bytes)) => {
                            owner
                                .emit(
                                    Event {
                                        validity: stop.clone(),
                                        revision,
                                        session_id: Some(session_id.clone()),
                                        target: None,
                                        port: "rx".into(),
                                        value: envelope(
                                            packet(&session_id, report_id, &bytes, "rx"),
                                            "rx",
                                        ),
                                    },
                                    &stop,
                                )
                                .await
                        }
                        Err(error) => {
                            owner
                                .emit(
                                    Event {
                                        validity: stop.clone(),
                                        revision,
                                        session_id: Some(session_id.clone()),
                                        target: None,
                                        port: "error".into(),
                                        value: diagnostic(error),
                                    },
                                    &stop,
                                )
                                .await;
                            owner.emit(Event{validity:stop.clone(),revision,session_id:Some(session_id.clone()),target:None,port:"state".into(),value:envelope(json!({"sessionId":session_id,"status":"disconnected","timestamp":now_ms()}),"state")},&stop).await;
                            break;
                        }
                    }
                }
                receiver.close().await;
            });
            self.inner.sessions.lock().await.insert(
                id.to_owned(),
                Entry {
                    session,
                    task: Task { cancel, join },
                },
            );
            cleanup.disarm();
            return Ok((
                json!({"sessionId":id,"status":"open","device":device_json(&info),"timestamp":now_ms()}),
                "state".into(),
            ));
        }
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(id)
            .map(|e| e.session.clone())
            .ok_or_else(|| diagnostic("USB session is closed"))?;
        match (command, session) {
            ("send", Session::Hid(s)) => {
                s.send_report(report_id, &bytes).await.map_err(diagnostic)?;
            }
            ("send", Session::Print(s)) => {
                s.write_all(&bytes).await.map_err(diagnostic)?;
            }
            ("featureSend", Session::Hid(s)) => {
                s.send_feature_report(report_id, &bytes)
                    .await
                    .map_err(diagnostic)?;
            }
            ("featureGet", Session::Hid(s)) => {
                let report = s
                    .get_feature_report(report_id, length)
                    .await
                    .map_err(diagnostic)?;
                return Ok((
                    packet(id, report.report_id, &report.payload, "feature"),
                    "feature".into(),
                ));
            }
            ("descriptor", Session::Hid(s)) => {
                let bytes = s.report_descriptor().await.map_err(diagnostic)?;
                return Ok((packet(id, 0, &bytes, "descriptor"), "descriptor".into()));
            }
            _ => return Err(diagnostic("Command is unsupported by this USB transport")),
        }
        Ok((packet(id, report_id, &bytes, "tx"), "tx".into()))
    }
}
fn packet(id: &str, report_id: u8, bytes: &[u8], direction: &str) -> Value {
    json!({"sessionId":id,"reportId":report_id,"bytes":bytes,"hex":bytes.iter().map(|v|format!("{v:02X}")).collect::<Vec<_>>().join(" "),"text":String::from_utf8_lossy(bytes),"direction":direction,"timestamp":now_ms()})
}
