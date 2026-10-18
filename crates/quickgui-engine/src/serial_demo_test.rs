//! Opt-in integration against the externally supplied, unmodified designer demo.
//! The only enumeration addition is a real OS PTY. Production builds contain
//! neither this registry nor its scan/open hooks, and no physical port is opened.
//! macOS PTYs reject serialport's hardware modem ioctls, so the test supplies the
//! real, already opened PTY slave; baud/parity hardware configuration is not
//! claimed as tested. All session/open acknowledgement and byte IO stay native.
use super::*;

static PTYS: OnceLock<Mutex<BTreeMap<String, SerialPortInfo>>> = OnceLock::new();
static HANDLES: OnceLock<Mutex<BTreeMap<String, tokio_serial::SerialStream>>> = OnceLock::new();
pub(super) fn take_registered_pty(name: &str) -> Option<tokio_serial::SerialStream> {
    HANDLES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(name)
}
pub(super) fn registered_pty_ports() -> Vec<SerialPortInfo> {
    PTYS.get_or_init(Default::default)
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}
#[cfg(unix)]
struct Registration(String);
#[cfg(unix)]
impl Drop for Registration {
    fn drop(&mut self) {
        PTYS.get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&self.0);
        HANDLES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&self.0);
    }
}

#[cfg(unix)]
type SharedEngine = Arc<tokio::sync::Mutex<crate::Engine>>;

#[cfg(unix)]
async fn manual(engine: &SharedEngine, service: &SerialService, id: &str) {
    crate::flow_v4::run_shared(
        engine.clone(),
        Some(service.clone()),
        id,
        None,
        Value::Null,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap_or_else(|error| panic!("Demo flow {id}: {error}"));
}

#[cfg(unix)]
async fn until(
    engine: &SharedEngine,
    label: &str,
    predicate: impl Fn(&crate::RuntimeSnapshot) -> bool,
) -> crate::RuntimeSnapshot {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = engine.lock().await.snapshot();
            if predicate(&snapshot) {
                return snapshot;
            }
            assert_eq!(
                snapshot.values["serial_error"].value["code"], "",
                "Demo error while waiting for {label}: {:?}",
                snapshot.values["serial_error"].value
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Timed out waiting for {label}"))
}

#[cfg(unix)]
fn rows(snapshot: &crate::RuntimeSnapshot, direction: &str) -> Vec<Value> {
    snapshot.values["serial_history"].value["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["direction"] == direction)
        .cloned()
        .collect()
}

#[cfg(unix)]
async fn deliver_demo_events(
    project: crate::Project,
    engine: SharedEngine,
    service: SerialService,
    cancel: CancellationToken,
) -> Result<(), String> {
    while let Some(mut delivery) = service.next_event(&cancel).await {
        if !service.current_event(&delivery.event) {
            continue;
        }
        {
            let mut e = engine.lock().await;
            e.update_serial_state(service.snapshot_map());
            e.external_event(
                &format!("serial.{}", delivery.event.kind),
                delivery.event.payload.clone(),
            );
        }
        for flow in project.flows.iter().filter(|flow| flow.enabled) {
            for node in &flow.nodes {
                if node.kind != "event"
                    || node.config.get("trigger").and_then(Value::as_str) != Some("serial")
                    || node.config.get("event").and_then(Value::as_str)
                        != Some(delivery.event.kind.as_str())
                {
                    continue;
                }
                if delivery.event.kind != "devices"
                    && node.config.get("connectionId").and_then(Value::as_str)
                        != delivery.event.connection_id.as_deref()
                {
                    continue;
                }
                let direction = node
                    .config
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or("rx");
                if delivery.event.kind == "data"
                    && direction != "both"
                    && delivery.event.payload["direction"] != direction
                {
                    continue;
                }
                if !service.refresh_state_event(&mut delivery.event) {
                    break;
                }
                crate::flow_v4::run_shared(
                    engine.clone(),
                    Some(service.clone()),
                    &flow.id,
                    Some(&node.id),
                    delivery.event.payload.clone(),
                    CancellationToken::new(), // Finish an accepted batch when pausing this test pump.
                    None,
                )
                .await
                .map_err(|error| format!("Demo event flow {}: {error}", flow.id))?;
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires QG_SERIAL_DEMO_FIXTURE pointing to the actual serial-assistant quickgui.json"]
async fn actual_demo_opens_a_real_pty_and_routes_rx_tx_state_without_widget_code() {
    use tokio_serial::SerialPort;
    let fixture = std::env::var_os("QG_SERIAL_DEMO_FIXTURE")
        .expect("set QG_SERIAL_DEMO_FIXTURE to examples/serial-assistant/quickgui.json");
    let project: crate::Project = serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    assert_eq!(project.schema_version, 4);
    let engine = Arc::new(tokio::sync::Mutex::new(
        crate::Engine::new(project.clone())
            .expect("actual demo must pass native schema validation"),
    ));
    let (mut peer, slave) = tokio_serial::SerialStream::pair().unwrap();
    let path = slave.name().expect("OS PTY has a real device path");
    let port = SerialPortInfo {
        port_name: path.clone(),
        port_type: "unknown".into(),
        vid: None,
        pid: None,
        serial_number: None,
        manufacturer: None,
        product: None,
        usb_location: None,
        display_name: "Integration PTY".into(),
    };
    PTYS.get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path.clone(), port);
    let _registration = Registration(path.clone());
    HANDLES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path.clone(), slave);
    let service = SerialService::new(CancellationToken::new());
    service.reconcile(&project).await;
    let events_cancel = CancellationToken::new();
    let events = tokio::spawn(deliver_demo_events(
        project.clone(),
        engine.clone(),
        service.clone(),
        events_cancel.clone(),
    ));

    manual(&engine, &service, "serial_scan").await;
    assert!(engine.lock().await.snapshot().values["serial_options"]
        .value
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["value"] == path));
    engine
        .lock()
        .await
        .set_variable_path("serial_settings", json!(path), Some(&[json!("portName")]))
        .unwrap();
    manual(&engine, &service, "serial_open").await;
    let opened = until(&engine, "open and listen", |s| {
        s.values["serial_state"].value["status"] == "open"
            && s.values["serial_state"].value["listening"] == true
    })
    .await;
    assert_eq!(
        opened.values["serial_state"].value["port"]["portName"],
        path
    );
    assert_eq!(opened.values["serial_state"].value["autoReconnect"], false);
    assert!(opened.values["serial_state"].value["sessionId"]
        .as_u64()
        .is_some());
    assert!(PortLease::acquire(&path).is_err());

    let rx = "设备 RX\r\n".as_bytes();
    peer.write_all(rx).await.unwrap();
    let received = until(&engine, "RX log and counters", |s| {
        rows(s, "rx")
            .iter()
            .map(|row| row["bytes"].as_u64().unwrap())
            .sum::<u64>()
            == rx.len() as u64
            && s.values["serial_state"].value["counters"]["rxBytes"] == rx.len()
            && s.values["serial_last_rx"].value != "—"
    })
    .await;
    assert_eq!(
        rows(&received, "rx")
            .iter()
            .map(|row| row["text"].as_str().unwrap())
            .collect::<String>(),
        String::from_utf8_lossy(rx)
    );
    assert!(rows(&received, "rx")
        .iter()
        .all(|row| row["time"].as_str().unwrap().ends_with('Z')));

    {
        let mut e = engine.lock().await;
        e.set_variable_path("serial_tx", json!("发出 TX"), Some(&[json!("data")]))
            .unwrap();
        e.set_variable_path("serial_tx", json!("crlf"), Some(&[json!("lineEnding")]))
            .unwrap();
    }
    manual(&engine, &service, "serial_send").await;
    let tx = "发出 TX\r\n".as_bytes();
    let mut bytes = vec![0; tx.len()];
    tokio::time::timeout(Duration::from_secs(2), peer.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes, tx);
    let transmitted = until(&engine, "TX log and counters", |s| {
        rows(s, "tx").len() == 1
            && s.values["serial_state"].value["counters"]["txBytes"] == tx.len()
            && s.values["serial_last_tx"].value != "—"
    })
    .await;
    assert_eq!(
        rows(&transmitted, "tx")[0]["text"],
        String::from_utf8_lossy(tx).as_ref()
    );
    assert_eq!(rows(&transmitted, "tx")[0]["hex"], hex(tx));
    assert_eq!(
        transmitted.values["serial_state"].value["counters"]["txPackets"],
        1
    );

    {
        let mut e = engine.lock().await;
        e.set_variable_path("serial_tx", json!("00 fF 41"), Some(&[json!("data")]))
            .unwrap();
        e.set_variable_path("serial_tx", json!("hex"), Some(&[json!("encoding")]))
            .unwrap();
        e.set_variable_path("serial_tx", json!("none"), Some(&[json!("lineEnding")]))
            .unwrap();
    }
    manual(&engine, &service, "serial_send").await;
    let mut bytes = [0; 3];
    tokio::time::timeout(Duration::from_secs(2), peer.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes, [0, 255, 65]);
    let transmitted = until(&engine, "HEX TX event", |s| {
        rows(s, "tx").len() == 2
            && s.values["serial_state"].value["counters"]["txBytes"] == tx.len() + 3
    })
    .await;
    assert_eq!(rows(&transmitted, "tx")[1]["hex"], "00 FF 41");
    assert_eq!(
        transmitted.values["serial_state"].value["counters"]["txPackets"],
        2
    );

    manual(&engine, &service, "serial_listen_stop").await;
    until(&engine, "listen stopped", |s| {
        s.values["serial_state"].value["listening"] == false
    })
    .await;
    let retained = rows(&engine.lock().await.snapshot(), "rx").len();
    peer.write_all(b"discard").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.snapshot()[0].rx_bytes != rx.len() as u64 + 7 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(rows(&engine.lock().await.snapshot(), "rx").len(), retained);
    until(
        &engine,
        "authoritative counters while listening is stopped",
        |s| s.values["serial_state"].value["counters"]["rxBytes"] == rx.len() + 7,
    )
    .await;
    manual(&engine, &service, "serial_listen_start").await;
    until(&engine, "listen resumed", |s| {
        s.values["serial_state"].value["listening"] == true
    })
    .await;
    peer.write_all(b"resume").await.unwrap();
    let resumed = until(&engine, "RX after resume", |s| {
        s.values["serial_state"].value["counters"]["rxBytes"] == rx.len() + 7 + 6
            && rows(s, "rx").len() > retained
    })
    .await;
    assert_eq!(
        rows(&resumed, "rx")
            .iter()
            .map(|row| row["text"].as_str().unwrap())
            .collect::<String>(),
        format!("{}resume", String::from_utf8_lossy(rx))
    );

    manual(&engine, &service, "serial_clear").await;
    assert_eq!(
        engine.lock().await.snapshot().values["serial_history"].value,
        json!({"rows":[],"dropped":0})
    );
    manual(&engine, &service, "serial_reset_counters").await;
    until(&engine, "counter reset", |s| {
        s.values["serial_state"].value["counters"]
            == json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})
    })
    .await;

    // Let RX and TX queue while the flow consumer is paused, then reset before
    // consuming them. Control state(0) must not be overwritten by old data's
    // counters, and both original records must still reach the unmodified demo.
    events_cancel.cancel();
    events.await.unwrap().unwrap();
    peer.write_all(b"queued RX").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.snapshot()[0].rx_bytes != 9 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    manual(&engine, &service, "serial_send").await;
    let mut queued_tx = [0; 3];
    tokio::time::timeout(Duration::from_secs(2), peer.read_exact(&mut queued_tx))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(queued_tx, [0, 255, 65]);
    manual(&engine, &service, "serial_reset_counters").await;
    let observed = Arc::new(Mutex::new(Vec::new()));
    let capture = observed.clone();
    engine.lock().await.set_observer(Arc::new(move |snapshot| {
        capture
            .lock()
            .unwrap()
            .push(snapshot.values["serial_state"].value["counters"].clone());
    }));
    let events_cancel = CancellationToken::new();
    let events = tokio::spawn(deliver_demo_events(
        project,
        engine.clone(),
        service.clone(),
        events_cancel.clone(),
    ));
    let reset_with_records = until(&engine, "queued records after reset", |s| {
        rows(s, "rx").len() == 1
            && rows(s, "tx").len() == 1
            && s.values["serial_state"].value["counters"]
                == json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})
    })
    .await;
    assert_eq!(rows(&reset_with_records, "rx")[0]["text"], "queued RX");
    assert_eq!(rows(&reset_with_records, "rx")[0]["bytes"], 9);
    assert_eq!(rows(&reset_with_records, "tx")[0]["hex"], "00 FF 41");
    assert_eq!(rows(&reset_with_records, "tx")[0]["bytes"], 3);
    assert!(
        observed
            .lock()
            .unwrap()
            .iter()
            .all(|counters| *counters
                == json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})),
        "old queued data must never restore pre-reset counts"
    );

    manual(&engine, &service, "serial_close").await;
    let closed = until(&engine, "closed session", |s| {
        s.values["serial_state"].value["status"] == "closed"
    })
    .await;
    assert_eq!(closed.values["serial_tx"].value["periodic"], false);
    assert_eq!(
        closed.values["serial_error"].value,
        json!({"code":"","message":""})
    );
    assert!(
        !closed.logs.iter().any(|log| log.level == "error"),
        "{:?}",
        closed.logs
    );
    assert!(PortLease::acquire(&path).is_ok());
    events_cancel.cancel();
    events.await.unwrap().unwrap();
    service.shutdown().await;
    eprintln!("Actual demo + real PTY: scan/open/listen, UTF-8 RX/TX, HEX TX, state/log/counters, no listen replay, queued RX+TX after reset keep counters zero and preserve records, clear/reset/close passed");
}
