use crate::Session;
use quickgui_engine::{flow_v4, Project, ScriptHost};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

pub struct EventSource {
    flow: String,
    node: String,
    pub interval: Option<Duration>,
    controlled: Option<(Value, Value)>,
    serial: Option<(String, Option<String>, String)>,
    sends_serial: bool,
}
pub fn sources(project: &Project) -> Result<Vec<EventSource>, String> {
    let mut result = Vec::new();
    for flow in project.flows.iter().filter(|f| f.enabled) {
        for node in flow.nodes.iter().filter(|n| n.kind == "event") {
            let trigger = node
                .config
                .get("trigger")
                .and_then(Value::as_str)
                .unwrap_or("manual");
            let mut source = EventSource {
                flow: flow.id.clone(),
                node: node.id.clone(),
                interval: None,
                controlled: None,
                serial: None,
                sends_serial: flow.nodes.iter().any(|n| {
                    n.kind == "serial"
                        && n.config
                            .get("action")
                            .and_then(Value::as_str)
                            .is_some_and(|a| ["send", "communicate"].contains(&a))
                }),
            };
            match trigger {
                "startup" => {}
                "interval" => {
                    let ms = node
                        .config
                        .get("intervalMs")
                        .and_then(Value::as_u64)
                        .ok_or("intervalMs must be an integer")?;
                    if !(100..=86400000).contains(&ms) {
                        return Err("intervalMs must be between 100 and 86400000".into());
                    }
                    source.interval = Some(Duration::from_millis(ms));
                }
                "controlledInterval" => {
                    source.controlled = Some((
                        node.config
                            .get("interval")
                            .cloned()
                            .unwrap_or(json!({"source":"literal","value":1000})),
                        node.config
                            .get("enabled")
                            .cloned()
                            .unwrap_or(json!({"source":"literal","value":false})),
                    ));
                }
                "serial" => {
                    source.serial = Some((
                        node.config
                            .get("event")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        node.config
                            .get("connectionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        node.config
                            .get("direction")
                            .and_then(Value::as_str)
                            .unwrap_or("rx")
                            .into(),
                    ));
                }
                _ => continue,
            }
            result.push(source);
        }
    }
    Ok(result)
}
async fn run(session: &Session, source: &EventSource, input: Value, host: Option<&ScriptHost>) {
    if session.cancellation.is_cancelled() {
        return;
    }

    let _ = flow_v4::run_shared(
        session.engine.clone(),
        session.serial.clone(),
        &source.flow,
        Some(&source.node),
        input,
        session.cancellation.child_token(),
        host,
    )
    .await;
}
async fn run_periodic(
    session: &Session,
    source: &EventSource,
    host: Option<&ScriptHost>,
    expected_epoch: u64,
) {
    let Some(serial) = session.serial.as_ref().filter(|_| source.sends_serial) else {
        run(session, source, Value::Null, host).await;
        return;
    };
    let Some(invocation) = serial.periodic_run(expected_epoch, &session.cancellation) else {
        return;
    };
    let _ = flow_v4::run_shared(
        session.engine.clone(),
        session.serial.clone(),
        &source.flow,
        Some(&source.node),
        Value::Null,
        invocation.cancellation.clone(),
        host,
    )
    .await;
}
async fn dispatch_serial_blocks(
    session: &Session,
    event: &quickgui_engine::serial::SerialEvent,
    host: Option<&ScriptHost>,
) {
    let Some(serial) = &session.serial else {
        return;
    };
    let targets = {
        let engine = session.engine.lock().await;
        let mut targets = Vec::new();
        for flow in engine.project().flows.iter().filter(|f| f.enabled) {
            for node in flow.nodes.iter().filter(|n| n.kind == "serial") {
                let action = node
                    .config
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let port = match (action, event.kind.as_str()) {
                    ("discover", "devices")
                        if serial.watching_discovery(&flow.id, &node.id, event.sequence) =>
                    {
                        "changed"
                    }
                    ("discover", "error")
                        if event.connection_id.is_none()
                            && serial.watching_discovery(&flow.id, &node.id, event.sequence) =>
                    {
                        "error"
                    }
                    ("communicate", "data")
                        if node.config.get("connectionId").and_then(Value::as_str)
                            == event.connection_id.as_deref() =>
                    {
                        if event.payload["direction"] == "tx" {
                            "tx"
                        } else {
                            "rx"
                        }
                    }
                    ("communicate", "state" | "error")
                        if node.config.get("connectionId").and_then(Value::as_str)
                            == event.connection_id.as_deref() =>
                    {
                        event.kind.as_str()
                    }
                    _ => continue,
                };
                if !flow.edges.iter().any(|e| {
                    !quickgui_engine::function_blocks::is_data(e)
                        && e.source == node.id
                        && e.source_handle.as_deref() == Some(port)
                }) {
                    continue;
                }
                let mut value = event.payload.clone();
                if action == "discover" && port != "error" {
                    let resolve = |key: &str| {
                        flow_v4::resolve_ref(&engine, &event.payload, &node.config[key])
                    };
                    let filtered = (|| -> Result<Value, String> {
                        let filter = quickgui_engine::serial::SerialFilter {
                            vid: flow_v4::filter_id(&resolve("vid")?)?,
                            pid: flow_v4::filter_id(&resolve("pid")?)?,
                        };
                        let ports: Vec<quickgui_engine::serial::SerialPortInfo> =
                            serde_json::from_value(value["ports"].clone())
                                .map_err(|e| e.to_string())?;
                        value["ports"] = json!(ports
                            .into_iter()
                            .filter(|p| filter.matches(p))
                            .collect::<Vec<_>>());
                        Ok(value.clone())
                    })();
                    match filtered {
                        Ok(v) => value = v,
                        Err(e) => {
                            targets.push((
                                flow.id.clone(),
                                node.id.clone(),
                                "error".to_owned(),
                                json!({"code":"INVALID_FILTER","message":e}),
                            ));
                            continue;
                        }
                    }
                }
                targets.push((
                    flow.id.clone(),
                    node.id.clone(),
                    port.to_owned(),
                    if port == "error" {
                        value
                    } else {
                        quickgui_engine::usb::envelope(value, port)
                    },
                ));
            }
        }
        targets
    };
    for (flow, node, port, value) in targets {
        if session.cancellation.is_cancelled() || !serial.current_event(event) {
            break;
        }
        let _ = flow_v4::run_output_shared(
            session.engine.clone(),
            session.serial.clone(),
            &flow,
            &node,
            &port,
            value,
            session.cancellation.child_token(),
            host,
        )
        .await;
    }
}
pub fn start(session: Session, sources: Vec<EventSource>, runner: Option<PathBuf>) {
    let (serial_sources, sources): (Vec<_>, Vec<_>) =
        sources.into_iter().partition(|s| s.serial.is_some());
    if let Some(serial) = session.serial.clone() {
        let owner = session.clone();
        let usb = serial.usb().clone();
        let usb_runner = runner.clone();
        tauri::async_runtime::spawn(async move {
            let host = usb_runner.map(ScriptHost::new);
            while let Some(event) = usb.next_event(&owner.cancellation).await {
                if !usb.current(&event) {
                    continue;
                }
                let _gate = tokio::select! {_=owner.cancellation.cancelled()=>break,gate=owner.flow_gate.lock()=>gate};
                if !usb.current(&event) {
                    continue;
                }
                let targets = {
                    let engine = owner.engine.lock().await;
                    engine
                        .project()
                        .flows
                        .iter()
                        .filter(|f| f.enabled)
                        .flat_map(|f| {
                            f.nodes
                                .iter()
                                .filter(|n| {
                                    n.kind == "usb"
                                        && (event.target.as_ref().is_some_and(|(flow, node)| {
                                            flow == &f.id && node == &n.id
                                        }) || event.session_id.as_ref().is_some_and(|id| {
                                            n.config.get("sessionId").and_then(Value::as_str)
                                                == Some(id.as_str())
                                        }))
                                        && f.edges.iter().any(|e| {
                                            !quickgui_engine::function_blocks::is_data(e)
                                                && e.source == n.id
                                                && e.source_handle.as_deref() == Some(&event.port)
                                        })
                                })
                                .map(|n| (f.id.clone(), n.id.clone()))
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>()
                };
                if event.port == "error" && targets.is_empty() {
                    owner
                        .engine
                        .lock()
                        .await
                        .external_error(event.value.to_string());
                }
                for (flow, node) in targets {
                    if !usb.current(&event) {
                        break;
                    }
                    let _ = flow_v4::run_output_shared(
                        owner.engine.clone(),
                        owner.serial.clone(),
                        &flow,
                        &node,
                        &event.port,
                        event.value.clone(),
                        owner.cancellation.child_token(),
                        host.as_ref(),
                    )
                    .await;
                }
            }
        });
        let owner = session.clone();
        let state_service = serial.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(state) = state_service.next_state(&owner.cancellation).await {
                let mut e = owner.engine.lock().await;
                if owner.cancellation.is_cancelled() {
                    break;
                }
                e.update_serial_state(state);
            }
        });
        let owner = session.clone();
        let runner = runner.clone();
        tauri::async_runtime::spawn(async move {
            let host = runner.map(ScriptHost::new);
            while let Some(mut delivery) = serial.next_event(&owner.cancellation).await {
                if !serial.current_event(&delivery.event) {
                    continue;
                }
                {
                    let mut engine = owner.engine.lock().await;
                    if owner.cancellation.is_cancelled() {
                        break;
                    }
                    engine.update_serial_state(serial.snapshot_map());
                    engine.external_event(
                        &format!("serial.{}", delivery.event.kind),
                        delivery.event.payload.clone(),
                    );
                    if delivery.event.kind == "error" && delivery.event.connection_id.is_none() {
                        engine.external_error(delivery.event.payload.to_string());
                    }
                }
                let targets: Vec<_> = serial_sources
                    .iter()
                    .filter(|source| {
                        let (kind, id, direction) = source.serial.as_ref().unwrap();
                        kind == &delivery.event.kind
                            && (kind == "devices" || id == &delivery.event.connection_id)
                            && (kind != "data"
                                || direction == "both"
                                || delivery.event.payload["direction"] == direction.as_str())
                    })
                    .collect();
                let _gate = tokio::select! {_=owner.cancellation.cancelled()=>break,gate=owner.flow_gate.lock()=>gate};
                if !serial.current_event(&delivery.event) {
                    continue;
                }
                if !serial.refresh_state_event(&mut delivery.event) {
                    continue;
                }
                dispatch_serial_blocks(&owner, &delivery.event, host.as_ref()).await;
                for source in targets {
                    if owner.cancellation.is_cancelled()
                        || !serial.refresh_state_event(&mut delivery.event)
                    {
                        break;
                    }
                    run(
                        &owner,
                        source,
                        delivery.event.payload.clone(),
                        host.as_ref(),
                    )
                    .await;
                }
            }
        });
    }
    for source in sources {
        let owner = session.clone();
        let runner = runner.clone();
        tauri::async_runtime::spawn(async move {
            let host = runner.map(ScriptHost::new);
            if let Some((period, enabled)) = &source.controlled {
                let mut clock = tokio::time::interval(Duration::from_millis(100));
                clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut deadline = tokio::time::Instant::now();
                let mut was_enabled = false;
                let mut previous_period = 0;
                let mut paused = false;
                let mut pause_epoch = owner
                    .serial
                    .as_ref()
                    .map(|s| s.periodic_epoch())
                    .unwrap_or(0);
                let mut last_error = String::new();
                loop {
                    tokio::select! {_=owner.cancellation.cancelled()=>break,_=clock.tick()=>{}}
                    let Some(mut engine) = owner.engine.try_lock().ok() else {
                        continue;
                    };
                    let settings = (|| -> Result<(u64, bool), String> {
                        let ms = flow_v4::resolve_ref(&engine, &Value::Null, period)?
                            .as_u64()
                            .filter(|n| (100..=86400000).contains(n))
                            .ok_or("Controlled interval must be 100..86400000 ms")?;
                        let on = flow_v4::resolve_ref(&engine, &Value::Null, enabled)?
                            .as_bool()
                            .ok_or("Controlled interval enabled must be boolean")?;
                        Ok((ms, on))
                    })();
                    let (ms, on) = match settings {
                        Ok(v) => {
                            last_error.clear();
                            v
                        }
                        Err(error) => {
                            if last_error != error {
                                engine.external_error(error.clone());
                                last_error = error;
                            }
                            continue;
                        }
                    };
                    drop(engine);
                    if source.sends_serial {
                        let epoch = owner
                            .serial
                            .as_ref()
                            .map(|s| s.periodic_epoch())
                            .unwrap_or(0);
                        if epoch != pause_epoch {
                            paused = true;
                            pause_epoch = epoch;
                        }
                        if !on {
                            paused = false;
                        }
                    }
                    if !on || paused {
                        was_enabled = false;
                        continue;
                    }
                    let now = tokio::time::Instant::now();
                    if !was_enabled || previous_period != ms {
                        deadline = now + Duration::from_millis(ms);
                        was_enabled = true;
                        previous_period = ms;
                        continue;
                    }
                    if now < deadline {
                        continue;
                    }
                    deadline = now + Duration::from_millis(ms);
                    if let Ok(_gate) = owner.flow_gate.try_lock() {
                        run_periodic(&owner, &source, host.as_ref(), pause_epoch).await;
                    }
                }
            } else if let Some(period) = source.interval {
                let pause_epoch = owner
                    .serial
                    .as_ref()
                    .map(|service| service.periodic_epoch())
                    .unwrap_or(0);
                let mut ticks =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {_=owner.cancellation.cancelled()=>break,_=ticks.tick()=>{}}
                    if let Ok(_gate) = owner.flow_gate.try_lock() {
                        run_periodic(&owner, &source, host.as_ref(), pause_epoch).await;
                    }
                }
            } else {
                let _gate = tokio::select! {_=owner.cancellation.cancelled()=>return,gate=owner.flow_gate.lock()=>gate};
                if !owner
                    .booted
                    .lock()
                    .map(|mut set| set.insert((source.flow.clone(), source.node.clone())))
                    .unwrap_or(false)
                {
                    return;
                }
                run(&owner, &source, Value::Null, host.as_ref()).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quickgui_engine::{CancellationToken, Engine};
    use serde_json::json;
    use std::sync::Arc;

    fn project(trigger: &str, period: u64) -> Project {
        serde_json::from_value(json!({
            "schemaVersion":1,"id":"timers","name":"Timers","revision":1,"locale":"en",
            "theme":{},"window":{"title":"Timers","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"publish":{},
            "variables":[{"id":"v","name":"count","type":"number","initial":0}],
            "flows":[{"id":"f","name":"Counter","enabled":true,"nodes":[
                {"id":"start","kind":"event","label":"Clock","config":{"trigger":trigger,"intervalMs":period}},
                {"id":"read","kind":"read","label":"Read","config":{"variable":"v"}},
                {"id":"add","kind":"math","label":"Increment","config":{"operation":"add","operand":1}},
                {"id":"write","kind":"write","label":"Write","config":{"variable":"v"}}
            ],"edges":[{"id":"a","source":"start","target":"read"},{"id":"b","source":"read","target":"add"},{"id":"c","source":"add","target":"write"}]}]
        })).unwrap()
    }

    #[tokio::test]
    async fn usb_commands_deliver_native_state_back_through_the_communication_fb() {
        let mut project = project("manual", 0);
        project.variables = serde_json::from_value(
            json!([{"id":"status","name":"status","type":"json","initial":null}]),
        )
        .unwrap();
        project.flows=serde_json::from_value(json!([{"id":"usb","name":"USB","enabled":true,"nodes":[
            {"id":"start","kind":"event","label":"Close","config":{"trigger":"manual"}},
            {"id":"io","kind":"usb","label":"USB","config":{"action":"communicate","sessionId":"usb-main","device":{"source":"literal","value":null},"options":{"source":"literal","value":{}},"data":{"source":"literal","value":""},"encoding":{"source":"literal","value":"hex"},"reportId":{"source":"literal","value":0},"length":{"source":"literal","value":64}}},
            {"id":"state","kind":"write","label":"State","config":{"variable":"status"}}
        ],"edges":[{"id":"close","source":"start","target":"io","targetHandle":"close"},{"id":"state","source":"io","target":"state","sourceHandle":"state"}]}])).unwrap();
        let cancellation = CancellationToken::new();
        let serial = quickgui_engine::serial::SerialService::new(cancellation.child_token());
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(
                Engine::new(project.clone()).unwrap(),
            )),
            cancellation,
            booted: Arc::new(std::sync::Mutex::new(Default::default())),
            project_id: project.id.clone(),
            history: None,
            epoch: 0,
            revision: 1,
            logic_key: String::new(),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: Some(serial.clone()),
        };
        start(session.clone(), sources(&project).unwrap(), None);
        flow_v4::run_shared(
            session.engine.clone(),
            session.serial.clone(),
            "usb",
            None,
            Value::Null,
            session.cancellation.child_token(),
            None,
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if session.engine.lock().await.snapshot().values["status"].value["status"]
                    == "closed"
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("native USB state should enter the FB STATE output");
        session.cancellation.cancel();
        serial.shutdown().await;
    }

    #[tokio::test]
    async fn interval_sources_run_without_a_webview_and_stop_on_cancellation() {
        let project = project("interval", 100);
        let sources = sources(&project).unwrap();
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(Engine::new(project).unwrap())),
            cancellation: CancellationToken::new(),
            booted: Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new())),
            project_id: "timers".into(),
            history: None,
            epoch: 0,
            revision: 1,
            logic_key: String::new(),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: None,
        };
        start(session.clone(), sources, None);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if session.engine.lock().await.snapshot().values["v"]
                    .value
                    .as_f64()
                    .unwrap()
                    >= 2.0
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("native timer should produce events");
        session.cancellation.cancel();
        let value = session.engine.lock().await.snapshot().values["v"]
            .value
            .clone();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            session.engine.lock().await.snapshot().values["v"].value,
            value
        );
    }

    #[tokio::test]
    async fn controlled_intervals_read_live_values_and_require_rearm_after_serial_close() {
        let mut project = project("manual", 0);
        project.schema_version = 4;
        project.windows = Some(Vec::new());
        project.variables.push(
            serde_json::from_value(
                json!({"id":"enabled","name":"enabled","type":"boolean","initial":false}),
            )
            .unwrap(),
        );
        project.flows[0].nodes[0].config = serde_json::from_value(json!({"trigger":"controlledInterval","interval":{"source":"literal","value":100},"enabled":{"source":"variable","variable":"enabled"}})).unwrap();
        // A disconnected send branch is enough for the conservative dependency
        // check to classify this timer as a serial sender; no device is faked.
        project
            .connections
            .push(json!({"id":"serial","name":"Serial","protocol":"serial","config":{}}));
        project.flows[0].nodes.push(serde_json::from_value(json!({"id":"send","kind":"serial","label":"Send","config":{"action":"send","connectionId":"serial","data":{"source":"literal","value":"x"},"encoding":{"source":"literal","value":"utf8"},"lineEnding":{"source":"literal","value":"none"}}})).unwrap());
        let serial = quickgui_engine::serial::SerialService::new(CancellationToken::new());
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(
                Engine::new(project.clone()).unwrap(),
            )),
            cancellation: CancellationToken::new(),
            booted: Default::default(),
            project_id: project.id.clone(),
            history: None,
            epoch: 0,
            revision: 1,
            logic_key: flow_v4::execution_key(&project),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: Some(serial.clone()),
        };
        start(session.clone(), sources(&project).unwrap(), None);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            session.engine.lock().await.snapshot().values["v"].value,
            json!(0)
        );
        session
            .engine
            .lock()
            .await
            .set_variable("enabled", json!(true))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while session.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64()
                .unwrap()
                < 1.
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let gate = session.flow_gate.lock().await;
        serial.close("serial").await.unwrap();
        let before = session.engine.lock().await.snapshot().values["v"]
            .value
            .as_f64()
            .unwrap();
        drop(gate);
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            session.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64(),
            Some(before)
        );
        session
            .engine
            .lock()
            .await
            .set_variable("enabled", json!(false))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        session
            .engine
            .lock()
            .await
            .set_variable("enabled", json!(true))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while session.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64()
                .unwrap()
                <= before
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        session.cancellation.cancel();
        serial.shutdown().await;
    }

    #[test]
    fn invalid_intervals_are_rejected_before_replacing_a_session() {
        assert!(sources(&project("interval", 99)).is_err());
        assert!(sources(&project("interval", 100)).is_ok());
        assert_eq!(sources(&project("manual", 0)).unwrap().len(), 0);
        assert!(sources(&project("startup", 0)).unwrap()[0]
            .interval
            .is_none());
    }

    #[tokio::test]
    async fn serial_close_cancels_a_timer_wait_before_any_later_side_effect() {
        let mut project = project("manual", 0);
        project.schema_version = 4;
        project.windows = Some(Vec::new());
        project.flows[0].nodes[0].config = serde_json::from_value(json!({"trigger":"controlledInterval","interval":{"source":"literal","value":100},"enabled":{"source":"literal","value":true}})).unwrap();
        project.flows[0].nodes.push(
            serde_json::from_value(
                json!({"id":"wait","kind":"delay","label":"Wait","config":{"ms":1000}}),
            )
            .unwrap(),
        );
        project.flows[0].edges[1].target = "wait".into();
        project.flows[0].edges.push(
            serde_json::from_value(json!({"id":"wait-add","source":"wait","target":"add"}))
                .unwrap(),
        );
        project
            .connections
            .push(json!({"id":"serial","name":"Serial","protocol":"serial","config":{}}));
        project.flows[0].nodes.push(serde_json::from_value(json!({"id":"send","kind":"serial","label":"Send","config":{"action":"send","connectionId":"serial","data":{"source":"literal","value":"x"},"encoding":{"source":"literal","value":"utf8"},"lineEnding":{"source":"literal","value":"none"}}})).unwrap());
        let serial = quickgui_engine::serial::SerialService::new(CancellationToken::new());
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(
                Engine::new(project.clone()).unwrap(),
            )),
            cancellation: CancellationToken::new(),
            booted: Default::default(),
            project_id: project.id.clone(),
            history: None,
            epoch: 0,
            revision: 1,
            logic_key: flow_v4::execution_key(&project),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: Some(serial.clone()),
        };
        start(session.clone(), sources(&project).unwrap(), None);
        tokio::time::timeout(Duration::from_secs(2), async {
            while !session
                .engine
                .lock()
                .await
                .snapshot()
                .active_nodes
                .contains(&"wait".into())
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        serial.close("serial").await.unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while !session
                .engine
                .lock()
                .await
                .snapshot()
                .active_nodes
                .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("close synchronously cancels the active periodic invocation");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(
            session.engine.lock().await.snapshot().values["v"].value,
            json!(0)
        );
        session.cancellation.cancel();
        serial.shutdown().await;
    }

    #[tokio::test]
    async fn startup_is_not_repeated_when_a_project_revision_reuses_the_session() {
        let mut project = project("startup", 0);
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(
                Engine::new(project.clone()).unwrap(),
            )),
            cancellation: CancellationToken::new(),
            booted: Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new())),
            project_id: "timers".into(),
            history: None,
            epoch: 0,
            revision: 1,
            logic_key: String::new(),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: None,
        };
        start(session.clone(), sources(&project).unwrap(), None);
        tokio::time::timeout(Duration::from_secs(3), async {
            while session.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64()
                .unwrap()
                < 1.0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        session.cancellation.cancel();
        project.revision += 1;
        session
            .engine
            .lock()
            .await
            .apply_project(project.clone())
            .unwrap();
        let next = Session {
            engine: session.engine.clone(),
            cancellation: CancellationToken::new(),
            booted: session.booted.clone(),
            project_id: "timers".into(),
            history: None,
            epoch: 1,
            revision: 2,
            logic_key: String::new(),
            flow_gate: Arc::new(tokio::sync::Mutex::new(())),
            serial: None,
        };
        start(next.clone(), sources(&project).unwrap(), None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            next.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64(),
            Some(1.0)
        );
        next.cancellation.cancel();
    }
}
