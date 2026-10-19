use super::*;

fn info(name: &str) -> SerialPortInfo {
    SerialPortInfo {
        port_name: name.into(),
        port_type: "usb".into(),
        vid: Some(0x1234),
        pid: Some(0xabcd),
        serial_number: Some("not-an-identity-substitute".into()),
        manufacturer: None,
        product: None,
        usb_location: Some(UsbLocation {
            bus_id: "bus-1".into(),
            port_chain: vec![2, 3],
        }),
        display_name: name.into(),
    }
}

#[test]
fn reconnect_requires_every_part_of_the_physical_identity() {
    let a = info("/dev/test-a");
    assert!(a.same_identity(&a));
    let mut b = a.clone();
    b.serial_number = None;
    assert!(a.same_identity(&b));
    for field in 0..6 {
        let mut b = a.clone();
        match field {
            0 => b.port_name = "/dev/test-b".into(),
            1 => b.vid = Some(42),
            2 => b.pid = None,
            3 => b.usb_location.as_mut().unwrap().bus_id = "bus-2".into(),
            4 => b.usb_location.as_mut().unwrap().port_chain = vec![2, 4],
            _ => b.usb_location = None,
        }
        assert!(!a.same_identity(&b), "identity component {field}");
    }
    let mut missing = a.clone();
    missing.usb_location.as_mut().unwrap().port_chain.clear();
    assert!(!missing.can_reconnect());
    let mut unknown = a.clone();
    unknown.vid = None;
    assert!(!SerialFilter {
        vid: a.vid,
        pid: a.pid
    }
    .matches(&unknown));
    assert!(SerialFilter::default().matches(&unknown));
    assert!(!SerialFilter {
        vid: a.vid,
        pid: Some(1)
    }
    .matches(&a));
}

#[test]
fn hex_rejects_invalid_input_and_utf8_decoder_preserves_split_codepoints() {
    assert_eq!(
        encode_serial("00 ff A1\r\n\t\u{000b}42", "hex", "none").unwrap(),
        [0, 255, 161, 66]
    );
    for invalid in ["0", "fg", "0x01", "AA:BB", "00\u{a0}01", "你好"] {
        assert_eq!(
            encode_serial(invalid, "hex", "none").unwrap_err().code,
            "INVALID_HEX"
        );
    }
    assert_eq!(
        encode_serial("你好", "utf8", "crlf").unwrap(),
        "你好\r\n".as_bytes()
    );
    assert!(encode_serial(&"a".repeat(MAX_MESSAGE), "utf8", "lf").is_err());
    let mut utf8 = Utf8Stream::default();
    assert_eq!(utf8.push(&[0xe4]), "");
    assert_eq!(utf8.push(&[0xbd, 0xa0, 0xe5]), "你");
    assert_eq!(utf8.push(&[0xa5, 0xbd, 0xff, b'a']), "好\u{fffd}a");
    assert_eq!(timestamp_iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(timestamp_iso(951_782_400_123), "2000-02-29T00:00:00.123Z");
}

#[test]
fn credits_bound_batches_and_bytes_independently_and_release_on_drop() {
    let budget = Arc::new(Budget {
        batches: AtomicUsize::new(0),
        bytes: AtomicUsize::new(0),
    });
    let credits: Vec<_> = (0..RX_BATCH_LIMIT)
        .map(|_| budget.acquire(1, RX_BATCH_LIMIT, RX_BYTE_LIMIT).unwrap())
        .collect();
    assert!(budget.acquire(1, RX_BATCH_LIMIT, RX_BYTE_LIMIT).is_none());
    drop(credits);
    assert_eq!(budget.batches.load(Ordering::Acquire), 0);
    let credit = budget
        .acquire(RX_BYTE_LIMIT, RX_BATCH_LIMIT, RX_BYTE_LIMIT)
        .unwrap();
    assert!(budget.acquire(1, RX_BATCH_LIMIT, RX_BYTE_LIMIT).is_none());
    drop(credit);
    assert_eq!(budget.bytes.load(Ordering::Acquire), 0);
}

#[test]
fn process_lease_disallows_competing_owners_and_releases() {
    let lease = PortLease::acquire("quickgui-lease-unit-test").unwrap();
    assert!(
        matches!(PortLease::acquire("quickgui-lease-unit-test"), Err(SerialError {code, ..}) if code == "PORT_IN_USE")
    );
    drop(lease);
    assert!(PortLease::acquire("quickgui-lease-unit-test").is_ok());
}

#[test]
fn reconnect_wait_locks_open_settings_until_manual_control() {
    let mut state = SerialState::closed("serial");
    state.status = "disconnected".into();
    state.auto_reconnect = true;
    assert_eq!(state.value()["status"], "reconnecting");
    assert_eq!(state.value()["canOpen"], false);
    assert_eq!(state.value()["canClose"], true);
    state.auto_reconnect = false;
    assert_eq!(state.value()["status"], "needsManualOpen");
    assert_eq!(state.value()["canOpen"], true);
    state.auto_reconnect = true;
    state.reconnect_paused = true;
    assert_eq!(state.value()["status"], "needsManualOpen");
    assert_eq!(state.value()["canOpen"], true);
    for status in ["closed", "error"] {
        state.status = status.into();
        assert_eq!(state.value()["canOpen"], true);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn reset_publishes_latest_state_without_rewriting_queued_data_snapshots() {
    let (service, mut peer, _) = attached("raw").await;
    peer.write_all(b"queued RX").await.unwrap();
    wait_for(|| service.snapshot()[0].rx_batches == 1).await;
    service
        .send("serial", b"TX".to_vec(), 1000, CancellationToken::new())
        .await
        .unwrap();
    let mut wire = [0; 2];
    peer.read_exact(&mut wire).await.unwrap();
    assert_eq!(&wire, b"TX");
    let original: Vec<_> = service
        .inner
        .ingress
        .lock()
        .unwrap()
        .data
        .iter()
        .map(|delivery| delivery.event.clone())
        .collect();
    assert_eq!(original.len(), 2);
    service.reset_counters("serial").unwrap();
    let state = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_eq!(state.event.kind, "state");
    assert_eq!(
        state.event.payload["counters"],
        json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})
    );
    for old in original {
        let delivery = service.next_event(&CancellationToken::new()).await.unwrap();
        assert_eq!(delivery.event.kind, "data");
        assert_eq!(delivery.event.sequence, old.sequence);
        assert_eq!(
            delivery.event.payload, old.payload,
            "data is an immutable record, including its counter snapshot"
        );
        for key in [
            "hex",
            "text",
            "byteLength",
            "timestamp",
            "timestampIso",
            "sequence",
            "direction",
            "sessionId",
        ] {
            assert_eq!(
                delivery.event.payload[key], old.payload[key],
                "record field {key}"
            );
        }
    }
    service.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn counter_states_cannot_starve_real_data_and_faults_keep_priority() {
    let (service, mut peer, _) = attached("line").await;
    peer.write_all(b"one\ntwo\nthree\nfour\n").await.unwrap();
    wait_for(|| service.snapshot()[0].rx_batches == 4).await;
    assert_eq!(
        service
            .next_event(&CancellationToken::new())
            .await
            .unwrap()
            .event
            .kind,
        "state"
    );
    for expected in ["one", "two", "three", "four"] {
        for _ in 0..10 {
            service.counter_state_event("serial");
        }
        assert_eq!(
            service.inner.ingress.lock().unwrap().control.len(),
            1,
            "ordinary state stays coalesced"
        );
        let data = service.next_event(&CancellationToken::new()).await.unwrap();
        assert_eq!(data.event.kind, "data");
        assert_eq!(data.event.payload["text"], expected);
        assert_eq!(
            service
                .next_event(&CancellationToken::new())
                .await
                .unwrap()
                .event
                .kind,
            "state"
        );
    }
    peer.write_all(b"retained\n").await.unwrap();
    wait_for(|| service.snapshot()[0].rx_batches == 5).await;
    service.fault(
        "serial",
        SerialError::new("IO_ERROR", "test transport fault"),
        false,
    );
    let fault = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_eq!(fault.event.kind, "state");
    assert_eq!(fault.event.payload["status"], "needsManualOpen");
    let error = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_eq!(error.event.kind, "error");
    assert_eq!(error.event.payload["code"], "IO_ERROR");
    let retained = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_eq!(retained.event.kind, "data");
    assert_eq!(retained.event.payload["text"], "retained");
    service.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn current_write_timeout_is_not_replaced_by_an_old_session_warning() {
    let (service, _peer, _) = attached("raw").await;
    service
        .inner
        .entries
        .lock()
        .unwrap()
        .get_mut("serial")
        .unwrap()
        .state
        .error = Some(SerialError::new(
        "IDENTITY_UNAVAILABLE",
        "old identity warning",
    ));
    service.state_event("serial");
    let error = service
        .send(
            "serial",
            vec![b'x'; MAX_MESSAGE],
            50,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "WRITE_TIMEOUT");
    assert!(error.bytes_accepted > 0);
    let delivered = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_eq!(delivered.event.kind, "error");
    assert_eq!(delivered.event.payload["code"], "WRITE_TIMEOUT");
    assert_eq!(delivered.event.payload["operation"], "send");
    assert_eq!(
        delivered.event.payload["bytesAccepted"],
        error.bytes_accepted
    );
    service.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn delayed_generic_map_and_write_keep_explicit_data_snapshot_semantics() {
    for (path, scalar) in [
        (json!(["counters"]), false),
        (json!(["counters", "rxBytes"]), true),
    ] {
        let (service, mut peer, _) = attached("raw").await;
        peer.write_all(b"abc").await.unwrap();
        let original = next_data(&service, "rx").await;
        let project: crate::Project = serde_json::from_value(json!({"schemaVersion":4,"windows":[],"id":"counter-reset","name":"Counters","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"connections":[{"id":"serial","name":"Serial","protocol":"serial","config":{}}],"variables":[{"id":"counter_result","name":"Result","type":if scalar{"number"}else{"json"},"initial":if scalar{json!(0)}else{json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})}},{"id":"records","name":"Records","type":"json","initial":[]}],"flows":[{"id":"data","name":"Data","enabled":true,"nodes":[{"id":"entry","kind":"event","label":"Data","config":{"trigger":"serial","event":"data","connectionId":"serial"}},{"id":"project","kind":"map","label":"Counters","config":{"operation":"value","value":{"source":"input","path":path}}},{"id":"wait","kind":"delay","label":"Wait","config":{"ms":100}},{"id":"write","kind":"write","label":"Store","config":{"variable":"counter_result"}},{"id":"record","kind":"map","label":"Record","config":{"operation":"object","fields":{"text":{"source":"input","path":["text"]},"bytes":{"source":"input","path":["byteLength"]},"time":{"source":"input","path":["timestampIso"]}}}},{"id":"append","kind":"append","label":"Append","config":{"variable":"records","item":{"source":"input"}}}],"edges":[{"id":"a","source":"entry","target":"project"},{"id":"b","source":"project","target":"wait"},{"id":"c","source":"wait","target":"write"},{"id":"d","source":"entry","target":"record"},{"id":"e","source":"record","target":"append"}]},{"id":"reset","name":"Reset","enabled":true,"nodes":[{"id":"manual","kind":"event","label":"Reset","config":{}},{"id":"reset-action","kind":"serial","label":"Reset","config":{"action":"resetCounters","connectionId":"serial"}}],"edges":[{"id":"r","source":"manual","target":"reset-action"}]}]})).unwrap();
        let engine = Arc::new(tokio::sync::Mutex::new(
            crate::Engine::new(project).unwrap(),
        ));
        let active = engine.clone();
        let serial = service.clone();
        let payload = original.event.payload.clone();
        let running = tokio::spawn(async move {
            crate::flow_v4::run_shared(
                active,
                Some(serial),
                "data",
                Some("entry"),
                payload,
                CancellationToken::new(),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !engine
                .lock()
                .await
                .snapshot()
                .active_nodes
                .contains(&"wait".into())
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        crate::flow_v4::run_shared(
            engine.clone(),
            Some(service.clone()),
            "reset",
            None,
            Value::Null,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        let result = running.await.unwrap().unwrap();
        let recorded = if scalar {
            json!(3)
        } else {
            json!({"rxBytes":3,"txBytes":0,"rxPackets":1,"txPackets":0})
        };
        assert_eq!(result.values["counter_result"].value, recorded);
        let authoritative = service.next_event(&CancellationToken::new()).await.unwrap();
        assert_eq!(authoritative.event.kind, "state");
        assert_eq!(
            authoritative.event.payload["counters"],
            json!({"rxBytes":0,"txBytes":0,"rxPackets":0,"txPackets":0})
        );
        assert_eq!(
            result.values["records"].value,
            json!([{"text":"abc","bytes":3,"time":original.event.payload["timestampIso"]}])
        );
        drop(original);
        service.shutdown().await;
    }
}

#[tokio::test]
async fn periodic_execution_is_cancelled_synchronously_and_old_epochs_cannot_register() {
    let service = SerialService::new(CancellationToken::new());
    let parent = CancellationToken::new();
    let epoch = service.periodic_epoch();
    let invocation = service.periodic_run(epoch, &parent).unwrap();
    service.close("not-open").await.unwrap();
    assert!(invocation.cancellation.is_cancelled());
    assert!(!parent.is_cancelled());
    assert!(service.periodic_run(epoch, &parent).is_none());
    let next = service
        .periodic_run(service.periodic_epoch(), &parent)
        .unwrap();
    parent.cancel();
    assert!(next.cancellation.is_cancelled());
    drop(invocation);
    drop(next);
    assert!(service
        .inner
        .periodic_runs
        .lock()
        .unwrap()
        .active
        .is_empty());
    service.shutdown().await;
}

#[cfg(unix)]
async fn attached(framing: &str) -> (SerialService, tokio_serial::SerialStream, String) {
    // PTYs exercise the real OS reader/writer. This helper is compiled only for
    // tests, and deliberately bypasses USB enumeration; it is not a simulator.
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let name = format!("quickgui-pty-test-{}", NEXT.fetch_add(1, Ordering::AcqRel));
    let lease = PortLease::acquire(&name).unwrap();
    let (peer, port) = tokio_serial::SerialStream::pair().unwrap();
    let service = attach_transport(&name, framing, port, Some(lease));
    (service, peer, name)
}

// Exercise the production IO actor on all platforms without occupying a device.
fn attach_transport<P>(
    name: &str,
    framing: &str,
    port: P,
    lease: Option<PortLease>,
) -> SerialService
where
    P: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let service = SerialService::new(CancellationToken::new());
    let cancel = service.inner.lifetime.child_token();
    let settings = serde_json::from_value(json!({"portName":name,"framing":framing})).unwrap();
    let mut state = SerialState::closed("serial");
    state.status = "open".into();
    state.session_id = 1;
    state.listening = true;
    state.listen_epoch = 1;
    state.port = Some(info(name));
    let (sender, receiver) = mpsc::channel(TX_BATCH_LIMIT);
    service.inner.entries.lock().unwrap().insert(
        "serial".into(),
        Entry {
            state,
            settings,
            cancel: cancel.clone(),
            sender,
            task: None,
        },
    );
    let owner = service.clone();
    let task = tokio::spawn(async move {
        let _lease = lease;
        owner
            .run_port("serial".into(), 1, port, receiver, cancel)
            .await;
    });
    service
        .inner
        .entries
        .lock()
        .unwrap()
        .get_mut("serial")
        .unwrap()
        .task = Some(task);
    service
}

async fn next_data(service: &SerialService, direction: &str) -> SerialDelivery {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = service.next_event(&CancellationToken::new()).await.unwrap();
            if event.event.kind == "data" && event.event.payload["direction"] == direction {
                return event;
            }
        }
    })
    .await
    .expect("serial data event")
}

#[test]
fn framed_receive_buffer_preserves_frames_and_partial_tails_at_every_read_boundary() {
    fn drain(buffer: &mut ReceiveBuffer, mode: &str, frames: &mut Vec<(Vec<u8>, usize)>) {
        while let Some((wire, start, end)) = buffer.frame(mode) {
            frames.push((buffer.payload(start, end).to_vec(), wire));
            buffer.consume(wire);
        }
    }
    for (mode, wire, tail, expected) in [
        (
            "line",
            b"\r\none\r\n\nend".as_slice(),
            b"\n".as_slice(),
            vec![
                (vec![], 2),
                (b"one".to_vec(), 5),
                (vec![], 1),
                (b"end".to_vec(), 4),
            ],
        ),
        (
            "length16",
            b"\0\0\0\x03one\0\x03two\0\x03en".as_slice(),
            b"d".as_slice(),
            vec![
                (vec![], 2),
                (b"one".to_vec(), 5),
                (b"two".to_vec(), 5),
                (b"end".to_vec(), 5),
            ],
        ),
    ] {
        for split in 0..=wire.len() {
            let mut buffer = ReceiveBuffer::default();
            let mut frames = Vec::new();
            buffer.append(&wire[..split]);
            drain(&mut buffer, mode, &mut frames);
            buffer.append(&wire[split..]);
            drain(&mut buffer, mode, &mut frames);
            assert_eq!(
                frames,
                expected[..3],
                "{mode} split {split} waits for the incomplete tail"
            );
            buffer.append(tail);
            drain(&mut buffer, mode, &mut frames);
            assert_eq!(frames, expected, "{mode} split {split}");
            assert!(buffer.is_empty());
        }
    }
}

#[test]
fn fragmented_long_lines_reuse_the_search_cursor_and_consuming_frames_does_not_move_the_tail() {
    let mut buffer = ReceiveBuffer::default();
    for _ in 0..1024 {
        buffer.append(b"abcdefgh");
        assert!(buffer.frame("line").is_none());
        assert_eq!(buffer.scanned, buffer.bytes.len());
    }
    buffer.append(b"\r\nsecond\npartial");
    let (wire, start, end) = buffer.frame("line").unwrap();
    assert_eq!(end - start, 8192);
    let allocation = buffer.bytes.as_ptr();
    buffer.consume(wire);
    assert_eq!(buffer.bytes.as_ptr(), allocation);
    assert_eq!(buffer.start, wire);
    let (wire, start, end) = buffer.frame("line").unwrap();
    assert_eq!(buffer.payload(start, end), b"second");
    buffer.consume(wire);
    assert!(buffer.frame("line").is_none());
    buffer.append(b" end\n");
    let (_, start, end) = buffer.frame("line").unwrap();
    assert_eq!(buffer.payload(start, end), b"partial end");
    buffer.clear();
    buffer.append(b"raw");
    assert_eq!(buffer.frame("raw"), Some((3, 0, 3)));
}

#[tokio::test]
async fn length_prefixes_split_across_reads_keep_wire_counts_utf8_and_budget_accounting() {
    let (port, mut peer) = tokio::io::duplex(16);
    let service = attach_transport("memory-length16", "length16", port, None);
    peer.write_all(&[0]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.snapshot()[0].rx_bytes < 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(service.inner.ingress.lock().unwrap().data.is_empty());
    peer.write_all(b"\x03\xe4\xbd\xa0\0\0\0\x03end")
        .await
        .unwrap();
    for (expected, bytes) in [("你", 5), ("", 2), ("end", 5)] {
        let frame = next_data(&service, "rx").await;
        assert_eq!(frame.event.payload["text"], expected);
        assert_eq!(frame.event.payload["byteLength"], bytes);
    }
    service.shutdown().await;
    assert_eq!(service.inner.rx.bytes.load(Ordering::Acquire), 0);
    assert_eq!(service.inner.rx.batches.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn small_packets_use_the_same_actor_without_waiting_for_a_full_buffer() {
    let (port, mut peer) = tokio::io::duplex(8);
    let service = attach_transport("memory-loopback", "line", port, None);
    let echo = tokio::spawn(async move {
        let mut byte = [0];
        // Small buffers force partial writes and split RX framing.
        while peer.read_exact(&mut byte).await.is_ok() {
            peer.write_all(&byte).await.unwrap();
        }
    });
    for i in 0..16 {
        let message = format!("{i}:123456");
        service
            .send(
                "serial",
                format!("{message}\n").into_bytes(),
                1000,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let rx = next_data(&service, "rx").await;
        assert_eq!(rx.event.payload["text"], message);
        assert_eq!(rx.event.payload["byteLength"], message.len() + 1);
        assert_eq!(rx.event.payload["timestamp"], rx.event.timestamp);
        assert_eq!(
            rx.event.payload["timestampIso"],
            timestamp_iso(rx.event.timestamp)
        );
    }
    let state = service.snapshot().remove(0);
    assert_eq!(state.tx_messages, 16);
    assert_eq!(state.rx_batches, 16);
    tokio::time::timeout(Duration::from_secs(2), service.shutdown())
        .await
        .expect("shutdown cancels an idle read");
    echo.await.unwrap();
    assert_eq!(service.inner.rx.bytes.load(Ordering::Acquire), 0);
    assert_eq!(service.inner.tx.bytes.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn a_slow_consumer_cannot_turn_small_packet_delivery_into_an_unbounded_queue() {
    let (port, mut peer) = tokio::io::duplex(4096);
    let service = attach_transport("memory-overflow", "line", port, None);
    peer.write_all(&b"x\n".repeat(RX_BATCH_LIMIT + 1))
        .await
        .unwrap();
    let stopped = service.inner.entries.lock().unwrap()["serial"]
        .cancel
        .clone();
    tokio::time::timeout(Duration::from_secs(2), stopped.cancelled())
        .await
        .expect("full RX budget closes the actor without a consumer");
    let first = service.next_event(&CancellationToken::new()).await.unwrap();
    assert_ne!(first.event.kind, "data", "fault control precedes data");
    let fault = if first.event.kind == "error" {
        first
    } else {
        assert_eq!(first.event.payload["error"]["code"], "RX_OVERFLOW");
        service.next_event(&CancellationToken::new()).await.unwrap()
    };
    assert_eq!(fault.event.kind, "error");
    assert_eq!(fault.event.payload["code"], "RX_OVERFLOW");
    assert!(service.snapshot()[0].reconnect_paused);
    drop(fault);
    service.shutdown().await;
    assert_eq!(service.inner.rx.bytes.load(Ordering::Acquire), 0);
    assert_eq!(service.inner.rx.batches.load(Ordering::Acquire), 0);
}

#[cfg(unix)]
async fn wait_for(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("serial state transition");
}

#[cfg(unix)]
#[tokio::test]
async fn pty_reads_writes_and_listen_resume_has_no_replay() {
    let (service, mut peer, name) = attached("raw").await;
    peer.write_all(b"hello").await.unwrap();
    let rx = next_data(&service, "rx").await;
    assert_eq!(rx.event.payload["text"], "hello");
    assert_eq!(rx.event.payload["hex"], "68 65 6C 6C 6F");
    assert_eq!(rx.event.payload["byteLength"], 5);
    assert!(service.current_event(&rx.event));
    service.listen("serial", false).unwrap();
    assert!(!service.current_event(&rx.event));
    drop(rx);
    peer.write_all(b"discarded").await.unwrap();
    wait_for(|| service.snapshot()[0].rx_bytes == 14).await;
    service.listen("serial", true).unwrap();
    peer.write_all(b"new").await.unwrap();
    let rx = next_data(&service, "rx").await;
    assert_eq!(rx.event.payload["text"], "new");
    drop(rx);
    let written = service
        .send("serial", b"tx".to_vec(), 1000, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(written["bytesAccepted"], 2);
    let mut actual = [0; 2];
    peer.read_exact(&mut actual).await.unwrap();
    assert_eq!(&actual, b"tx");
    let tx = next_data(&service, "tx").await;
    assert_eq!(tx.event.payload["text"], "tx");
    drop(tx);
    service.close("serial").await.unwrap();
    assert_eq!(service.snapshot()[0].status, "closed");
    assert!(PortLease::acquire(&name).is_ok());
    service.shutdown().await;
    assert_eq!(service.inner.rx.bytes.load(Ordering::Acquire), 0);
    assert_eq!(service.inner.tx.bytes.load(Ordering::Acquire), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn pty_line_and_length_framing_count_wire_bytes() {
    for (framing, wire, expected, bytes) in [
        ("line", b"one\r\ntwo\n".as_slice(), ["one", "two"], [5, 4]),
        (
            "length16",
            b"\0\x03one\0\x03two".as_slice(),
            ["one", "two"],
            [5, 5],
        ),
    ] {
        let (service, mut peer, _) = attached(framing).await;
        peer.write_all(&wire[..1]).await.unwrap();
        peer.write_all(&wire[1..]).await.unwrap();
        for (text, byte_length) in expected.into_iter().zip(bytes) {
            let event = next_data(&service, "rx").await;
            assert_eq!(event.event.payload["text"], text);
            assert_eq!(event.event.payload["byteLength"], byte_length);
        }
        service.shutdown().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pty_overflow_latches_fault_and_preserves_control_delivery() {
    let (service, mut peer, name) = attached("line").await;
    service.set_reconnect("serial", true).unwrap();
    let epoch = service.periodic_epoch();
    peer.write_all(&b"x\n".repeat(RX_BATCH_LIMIT + 1))
        .await
        .unwrap();
    wait_for(|| service.snapshot()[0].status == "faulted").await;
    let state = service.snapshot()[0].clone();
    assert_eq!(state.error.as_ref().unwrap().code, "RX_OVERFLOW");
    assert!(state.reconnect_paused);
    assert!(!state.listening);
    assert!(service.periodic_epoch() > epoch);
    assert!(service.set_reconnect("serial", true).is_err());
    assert!(service
        .send(
            "serial",
            b"must-not-send".to_vec(),
            1000,
            CancellationToken::new()
        )
        .await
        .is_err());
    let fault = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let delivery = service.next_event(&CancellationToken::new()).await.unwrap();
            if delivery.event.kind == "error" {
                break delivery;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(fault.event.payload["code"], "RX_OVERFLOW");
    assert!(service.inner.ingress.lock().unwrap().data.is_empty());
    service.shutdown().await;
    assert_eq!(service.inner.rx.batches.load(Ordering::Acquire), 0);
    assert_eq!(service.inner.rx.bytes.load(Ordering::Acquire), 0);
    assert!(PortLease::acquire(&name).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn pty_partial_write_timeout_counts_accepted_bytes_without_retry() {
    let (service, mut peer, _) = attached("raw").await;
    let result = service
        .send(
            "serial",
            vec![b'z'; MAX_MESSAGE],
            50,
            CancellationToken::new(),
        )
        .await;
    let error = result.expect_err("a full PTY must stop a write when the peer is not draining");
    assert_eq!(error.code, "WRITE_TIMEOUT");
    assert!(error.bytes_accepted > 0 && error.bytes_accepted < MAX_MESSAGE);
    assert_eq!(service.snapshot()[0].tx_bytes, error.bytes_accepted as u64);
    let mut received = vec![0; error.bytes_accepted];
    tokio::time::timeout(Duration::from_secs(2), peer.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert!(received.iter().all(|b| *b == b'z'));
    service
        .send("serial", b"end".to_vec(), 1000, CancellationToken::new())
        .await
        .unwrap();
    let mut end = [0; 3];
    peer.read_exact(&mut end).await.unwrap();
    assert_eq!(&end, b"end");
    let tx = next_data(&service, "tx").await;
    assert_eq!(tx.event.payload["byteLength"], 3);
    drop(tx);
    assert_eq!(service.snapshot()[0].tx_messages, 1);
    service.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn close_preempts_a_blocked_real_write_and_releases_the_lease() {
    let (service, _peer, name) = attached("raw").await;
    let sender = service.clone();
    let writing = tokio::spawn(async move {
        sender
            .send(
                "serial",
                vec![b'x'; MAX_MESSAGE],
                15_000,
                CancellationToken::new(),
            )
            .await
    });
    wait_for(|| service.snapshot()[0].tx_bytes > 0).await;
    tokio::time::timeout(Duration::from_secs(1), service.close("serial"))
        .await
        .unwrap()
        .unwrap();
    let error = writing.await.unwrap().unwrap_err();
    assert_eq!(error.code, "DISCONNECTED");
    assert!(error.bytes_accepted > 0 && error.bytes_accepted < MAX_MESSAGE);
    assert_eq!(service.snapshot()[0].tx_bytes, error.bytes_accepted as u64);
    assert!(PortLease::acquire(&name).is_ok());
    service.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn appearance_reconcile_preserves_real_io_and_logic_change_drops_old_events() {
    let (service, mut peer, name) = attached("raw").await;
    let mut p: crate::Project = serde_json::from_value(json!({"schemaVersion":4,"windows":[],"id":"serial-hot","name":"Hot","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"connections":[{"id":"serial","name":"Test","protocol":"serial","config":{"address":name}}]})).unwrap();
    service.reconcile(&p).await;
    peer.write_all(b"before").await.unwrap();
    let before = next_data(&service, "rx").await;
    let epoch = service.inner.revision.load(Ordering::Acquire);
    p.revision += 1;
    p.theme = json!({"mode":"dark"});
    p.window.title = "New title".into();
    service.reconcile(&p).await;
    assert_eq!(service.inner.revision.load(Ordering::Acquire), epoch);
    assert!(service.current_event(&before.event));
    assert_eq!(service.snapshot()[0].session_id, 1);
    peer.write_all(b"after").await.unwrap();
    let after = next_data(&service, "rx").await;
    assert_eq!(after.event.payload["text"], "after");
    p.connections[0]["config"]["baudRate"] = json!(9600);
    service.reconcile(&p).await;
    assert!(!service.current_event(&before.event));
    assert_eq!(service.snapshot()[0].status, "closed");
    assert!(PortLease::acquire(&name).is_ok());
    drop(before);
    drop(after);
    service.shutdown().await;
}

#[tokio::test]
async fn native_enumeration_returns_real_metadata_without_inventing_usb_identity() {
    let ports = tokio::time::timeout(Duration::from_secs(10), scan_ports(SerialFilter::default()))
        .await
        .unwrap()
        .unwrap();
    eprintln!("Native serial enumeration: {} ports", ports.len());
    for port in ports {
        let value = serde_json::to_value(&port).unwrap();
        assert!(value.get("usbLocation").is_some());
        let decoded: SerialPortInfo = serde_json::from_value(value).unwrap();
        assert_eq!(decoded, port);
        if decoded.usb_location.is_none() {
            assert!(!decoded.can_reconnect());
        }
    }
}
