use super::*;

fn project(mut nodes: Value, edges: Value) -> Project {
    if !nodes
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["kind"] == "event")
    {
        nodes
            .as_array_mut()
            .unwrap()
            .push(node("fixture-entry", "event", json!({})));
    }
    serde_json::from_value(json!({"schemaVersion":4,"windows":[],"id":"v4-test","name":"V4","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"v","name":"value","type":"number","initial":0},{"id":"history","name":"history","type":"json","initial":{"items":[],"dropped":0}},{"id":"error","name":"error","type":"json","initial":null}],"flows":[{"id":"f","name":"V4 test","enabled":true,"nodes":nodes,"edges":edges}],"connections":[{"id":"serial","name":"Serial","protocol":"serial","config":{"address":"/dev/test"}}]})).unwrap()
}
fn node(id: &str, kind: &str, config: Value) -> Value {
    json!({"id":id,"kind":kind,"label":id,"config":config})
}
#[test]
fn manual_commands_choose_one_entry_and_reject_ambiguous_or_automatic_entries() {
    let mut p = project(
        json!([
            node("a", "event", json!({"trigger":"manual"})),
            node("b", "event", json!({"trigger":"manual"})),
            node("startup", "event", json!({"trigger":"startup"}))
        ]),
        json!([]),
    );
    assert!(manual_entry_id(&p.flows[0], None)
        .unwrap_err()
        .contains("Choose"));
    assert_eq!(manual_entry_id(&p.flows[0], Some("b")).unwrap(), "b");
    for id in ["missing", "startup"] {
        assert!(manual_entry_id(&p.flows[0], Some(id)).is_err());
    }
    p.flows[0].nodes.remove(1);
    assert_eq!(manual_entry_id(&p.flows[0], None).unwrap(), "a");
}
fn edge(source: &str, target: &str, port: Option<&str>) -> Value {
    let mut edge = json!({"id":format!("{source}-{target}"),"source":source,"target":target});
    if let Some(port) = port {
        edge["sourceHandle"] = json!(port);
    }
    edge
}

#[tokio::test]
async fn repeated_events_reuse_validated_plans_and_invalid_edits_preserve_them() {
    let mut p = project(
        json!([
            node("start", "event", json!({})),
            node("add", "math", json!({"operation":"add","operand":1})),
            node("write", "write", json!({"variable":"v"}))
        ]),
        json!([edge("start", "add", None), edge("add", "write", None)]),
    );
    let engine = Arc::new(Mutex::new(Engine::new(p.clone()).unwrap()));
    let plan = engine.lock().await.flow_plans["f"].clone();
    for input in 0..8 {
        let result = run_shared(
            engine.clone(),
            None,
            "f",
            None,
            json!(input),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.values["v"].value, json!((input + 1) as f64));
        let e = engine.lock().await;
        assert!(Arc::ptr_eq(&plan.0, &e.flow_plans["f"].0));
        assert!(Arc::ptr_eq(&plan.1, &e.flow_plans["f"].1));
    }
    let mut invalid = p.clone();
    invalid.flows[0].edges[0].target = "missing".into();
    {
        let mut e = engine.lock().await;
        assert!(e.apply_project(invalid).is_err());
        assert!(Arc::ptr_eq(&plan.0, &e.flow_plans["f"].0));
        assert_eq!(e.snapshot().values["v"].value, json!(8.));
        p.flows[0].nodes[1]
            .config
            .insert("operand".into(), json!(100));
        e.apply_project(p).unwrap();
        assert!(!Arc::ptr_eq(&plan.0, &e.flow_plans["f"].0));
    }
    let result = run_shared(
        engine,
        None,
        "f",
        None,
        json!(7),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.values["v"].value, json!(107.));
}

#[tokio::test]
async fn activity_sampling_keeps_value_writes_events_errors_and_final_cleanup_immediate() {
    let mut nodes = vec![node("start", "event", json!({}))];
    for i in 0..80 {
        nodes.push(node(
            &format!("add-{i}"),
            "math",
            json!({"operation":"add","operand":1}),
        ));
        if i == 39 {
            nodes.push(node("middle", "write", json!({"variable":"v"})));
        }
    }
    nodes.extend([
        node("write", "write", json!({"variable":"v"})),
        node("emit", "emit", json!({"event":"received"})),
        node("log", "log", json!({"message":"packet processed"})),
        node(
            "fail",
            "map",
            json!({"operation":"value","value":{"source":"input","path":["missing"]}}),
        ),
    ]);
    let edges: Vec<_> = nodes
        .windows(2)
        .map(|pair| {
            edge(
                pair[0]["id"].as_str().unwrap(),
                pair[1]["id"].as_str().unwrap(),
                None,
            )
        })
        .collect();
    let engine = Arc::new(Mutex::new(
        Engine::new(project(json!(nodes), json!(edges))).unwrap(),
    ));
    let snapshots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let mut e = engine.lock().await;
        let collected = snapshots.clone();
        e.set_observer(Arc::new(move |snapshot| {
            // Model an expensive synchronous WebView/history subscriber. Its
            // own time must not defeat activity sampling on the next node.
            if !snapshot.active_nodes.is_empty() && snapshot.values["v"].value == json!(0) {
                std::thread::sleep(Duration::from_millis(20));
            }
            collected.lock().unwrap().push(snapshot)
        }));
        let collected = events.clone();
        e.set_event_observer(Arc::new(move |event| collected.lock().unwrap().push(event)));
    }
    assert!(run_shared(
        engine.clone(),
        None,
        "f",
        None,
        json!(0),
        CancellationToken::new(),
        None,
    )
    .await
    .is_err());
    let collected = snapshots.lock().unwrap();
    assert!(
        collected.len() < 40,
        "highlights must not broadcast a full snapshot per node: {}",
        collected.len()
    );
    let mut values: Vec<_> = collected
        .iter()
        .map(|s| s.values["v"].value.as_f64().unwrap())
        .collect();
    values.dedup();
    assert_eq!(
        values,
        [0., 40., 80.],
        "each write is observable even within one visual sample"
    );
    let last = collected.last().unwrap();
    assert!(last.active_nodes.is_empty());
    assert!(last.logs.iter().any(|l| l.message == "packet processed"));
    assert_eq!(last.logs.last().unwrap().level, "error");
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0].payload, json!(80.));
}

#[tokio::test]
async fn a_waiting_node_remains_observable_when_earlier_node_highlights_were_sampled() {
    let engine = Arc::new(Mutex::new(Engine::new(delay_project()).unwrap()));
    let snapshots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    engine.lock().await.set_observer(Arc::new(move |snapshot| {
        collected.lock().unwrap().push(snapshot);
    }));
    let cancel = CancellationToken::new();
    let active = engine.clone();
    let stop = cancel.clone();
    let task =
        tokio::spawn(
            async move { run_shared(active, None, "f", None, Value::Null, stop, None).await },
        );
    wait_active(&engine, "wait").await;
    assert!(snapshots
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.active_nodes == ["wait"]));
    cancel.cancel();
    assert!(task.await.unwrap().is_err());
    assert!(snapshots
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .active_nodes
        .is_empty());
}

fn delay_project() -> Project {
    project(
        json!([
            node("start", "event", json!({})),
            node("wait", "delay", json!({"ms":150})),
            node("write", "write", json!({"variable":"v"}))
        ]),
        json!([edge("start", "wait", None), edge("wait", "write", None)]),
    )
}
async fn wait_active(engine: &Arc<Mutex<Engine>>, id: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if engine
                .lock()
                .await
                .snapshot()
                .active_nodes
                .iter()
                .any(|n| n == id)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("active flow node");
}

#[test]
fn schema_config_and_reference_validation_are_strict() {
    let p = project(
        json!([node(
            "m",
            "map",
            json!({"operation":"value","value":{"source":"input"}})
        )]),
        json!([]),
    );
    assert!(Engine::new(p.clone()).is_ok());
    for version in [1, 2, 3, 6] {
        let mut legacy = p.clone();
        legacy.schema_version = version;
        if version == 6 {
            assert!(Engine::new(legacy).is_err());
        } else {
            assert_eq!(Engine::new(legacy).unwrap().project().schema_version, 5);
        }
    }
    let mut invalid = p.clone();
    invalid.flows[0].nodes[0]
        .config
        .insert("extra".into(), json!(1));
    assert!(Engine::new(invalid).is_err());
    let mut invalid = p;
    invalid.flows[0].nodes[0]
        .config
        .insert("value".into(), json!({"source":"input","variable":"v"}));
    assert!(Engine::new(invalid).is_err());
    let overlap = project(
        json!([node(
            "a",
            "append",
            json!({"variable":"history","item":{"source":"input"},"path":["items"],"droppedPath":["items",0]})
        )]),
        json!([]),
    );
    assert!(Engine::new(overlap).is_err());
    for config in [
        json!({"action":"open","connectionId":"serial"}),
        json!({"action":"send","connectionId":"serial"}),
        json!({"action":"setReconnect","connectionId":"serial"}),
    ] {
        assert!(
            Engine::new(project(json!([node("s", "serial", config)]), json!([])))
                .err()
                .unwrap()
                .contains("ValueRef is required")
        );
    }
    for config in [
        json!({"action":"setReconnect","connectionId":"serial","enabled":{"source":"literal","value":1}}),
        json!({"action":"open","connectionId":"serial","settings":{"source":"literal","value":{"baudRate":0}}}),
    ] {
        assert!(Engine::new(project(json!([node("s", "serial", config)]), json!([]))).is_err());
    }
}

#[tokio::test]
async fn usb_filters_match_browser_trimming_and_preserve_unknown_metadata() {
    assert_eq!(
        filter_id(&json!(" \u{feff}0x12Ab\t")).unwrap(),
        Some(0x12ab)
    );
    assert_eq!(filter_id(&json!(" \r\n")).unwrap(), None);
    let ports = json!([{"portName":"A","vid":0x12ab,"pid":1,"extra":{"ok":true}},{"portName":"B","vid":null,"pid":1}]);
    let service = SerialService::new(CancellationToken::new());
    let result = serial_action(
        &service,
        SerialAction::Filter {
            ports: ports.clone(),
            filter: SerialFilter {
                vid: Some(0x12ab),
                pid: Some(1),
            },
        },
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result, json!([ports[0]]));
    assert!(serial_action(
        &service,
        SerialAction::Filter {
            ports: json!([{"portName":"A","vid":"12ab"}]),
            filter: SerialFilter::default()
        },
        CancellationToken::new()
    )
    .await
    .is_err());
    service.shutdown().await;
}

#[test]
fn map_uses_item_relative_paths_and_stable_variable_ids() {
    let engine = Engine::new(project(json!([]), json!([]))).unwrap();
    let node: FlowNode = serde_json::from_value(node("map","map",json!({"operation":"array","items":{"source":"input","path":["ports"]},"fields":{"label":{"source":"input","path":["name"]},"count":{"source":"variable","variable":"v"}}}))).unwrap();
    assert_eq!(
        map_value(
            &engine,
            &node,
            &json!({"ports":[{"name":"A"},{"name":"B"}]})
        )
        .unwrap(),
        json!([{"label":"A","count":0},{"label":"B","count":0}])
    );
    assert!(map_value(&engine, &node, &json!({"ports":[{}]})).is_err());
    assert!(resolve_ref(
        &engine,
        &Value::Null,
        &json!({"source":"variable","variable":"value"})
    )
    .is_err());
}

#[test]
fn append_utf8_budget_dropped_count_and_failures_are_atomic() {
    let mut engine = Engine::new(project(json!([]), json!([]))).unwrap();
    let mut node: FlowNode = serde_json::from_value(node("a","append",json!({"variable":"history","path":["items"],"droppedPath":["dropped"],"item":{"source":"input"},"maxItems":2,"maxBytes":12}))).unwrap();
    assert_eq!(
        append_value(&mut engine, &node, &json!("你")).unwrap()["droppedItems"],
        0
    );
    let output = append_value(&mut engine, &node, &json!("好")).unwrap();
    assert_eq!(
        output,
        json!({"items":["好"],"droppedItems":1,"droppedTotal":1})
    );
    let before = engine.snapshot().values["history"].value.clone();
    assert!(append_value(&mut engine, &node, &json!("too big for this history")).is_err());
    assert_eq!(engine.snapshot().values["history"].value, before);
    node.config.insert("maxBytes".into(), json!(100));
    node.config.insert("order".into(), json!("latestFirst"));
    append_value(&mut engine, &node, &json!("A")).unwrap();
    let output = append_value(&mut engine, &node, &json!("B")).unwrap();
    assert_eq!(
        output,
        json!({"items":["B","A"],"droppedItems":1,"droppedTotal":2})
    );
    engine
        .set_variable(
            "history",
            json!({"items":[1,2],"dropped":9_007_199_254_740_991_u64}),
        )
        .unwrap();
    let before = engine.snapshot().values["history"].value.clone();
    assert!(append_value(&mut engine, &node, &json!(3)).is_err());
    assert_eq!(engine.snapshot().values["history"].value, before);
}

#[tokio::test]
async fn manual_runs_never_fabricate_serial_events_and_domain_stays_running() {
    let p = project(
        json!([
            node("manual", "event", json!({})),
            node(
                "devices",
                "event",
                json!({"trigger":"serial","event":"devices"})
            ),
            node("write", "write", json!({"variable":"v"})),
            node(
                "map",
                "map",
                json!({"operation":"value","value":{"source":"literal","value":99}})
            )
        ]),
        json!([
            edge("manual", "write", None),
            edge("devices", "map", None),
            edge("map", "write", None)
        ]),
    );
    let engine = Arc::new(Mutex::new(Engine::new(p).unwrap()));
    let result = run_shared(
        engine,
        None,
        "f",
        None,
        json!(7),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.values["v"].value, json!(7));
    assert!(result.running);
    assert!(result.active_nodes.is_empty());
}

#[tokio::test]
async fn action_errors_route_structured_payload_and_unconnected_errors_fail() {
    let mut p = project(
        json!([
            node("start", "event", json!({})),
            node(
                "bad",
                "map",
                json!({"operation":"value","value":{"source":"input","path":["missing"]}})
            ),
            node("capture", "write", json!({"variable":"error"}))
        ]),
        json!([
            edge("start", "bad", None),
            edge("bad", "capture", Some("error"))
        ]),
    );
    let engine = Arc::new(Mutex::new(Engine::new(p.clone()).unwrap()));
    let result = run_shared(
        engine,
        None,
        "f",
        None,
        json!({}),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.values["error"].value["code"], "MAP_ERROR");
    assert_eq!(result.values["error"].value["operation"], "map");
    p.flows[0].edges.pop();
    let engine = Arc::new(Mutex::new(Engine::new(p).unwrap()));
    assert!(run_shared(
        engine.clone(),
        None,
        "f",
        None,
        json!({}),
        CancellationToken::new(),
        None
    )
    .await
    .is_err());
    let snapshot = engine.lock().await.snapshot();
    assert!(snapshot.running);
    assert!(snapshot.active_nodes.is_empty());
    assert!(snapshot.logs.iter().any(|log| log.level == "error"));
}

#[tokio::test]
async fn ui_hot_reload_keeps_inflight_continuation_and_engine_writable() {
    let mut p = delay_project();
    let engine = Arc::new(Mutex::new(Engine::new(p.clone()).unwrap()));
    let active = engine.clone();
    let task = tokio::spawn(async move {
        run_shared(
            active,
            None,
            "f",
            None,
            json!(42),
            CancellationToken::new(),
            None,
        )
        .await
    });
    wait_active(&engine, "wait").await;
    let mut state = tokio::time::timeout(Duration::from_millis(50), engine.lock())
        .await
        .expect("delay releases Engine mutex");
    state.set_variable("v", json!(2)).unwrap();
    p.revision += 1;
    p.theme = json!({"mode":"dark"});
    p.window.title = "UI edited".into();
    p.flows[0].nodes[1].label = "Renamed wait".into();
    p.flows[0].nodes[1].position = json!({"x":50,"y":90});
    state.apply_project(p).unwrap();
    assert_eq!(state.snapshot().active_nodes, ["wait"]);
    drop(state);
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.values["v"].value, json!(42));
}

#[tokio::test]
async fn logic_edits_even_when_reverted_permanently_invalidate_old_work() {
    let p = delay_project();
    let engine = Arc::new(Mutex::new(Engine::new(p.clone()).unwrap()));
    let active = engine.clone();
    let task = tokio::spawn(async move {
        run_shared(
            active,
            None,
            "f",
            None,
            json!(99),
            CancellationToken::new(),
            None,
        )
        .await
    });
    wait_active(&engine, "wait").await;
    let mut changed = p.clone();
    changed.flows[0].nodes[1]
        .config
        .insert("ms".into(), json!(100));
    {
        let mut e = engine.lock().await;
        e.apply_project(changed).unwrap();
        e.apply_project(p).unwrap();
    }
    assert!(task.await.unwrap().is_err());
    assert_eq!(engine.lock().await.snapshot().values["v"].value, json!(0));
    let next = run_shared(
        engine,
        None,
        "f",
        None,
        json!(5),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(next.values["v"].value, json!(5));
}

#[tokio::test]
async fn network_wait_releases_engine_and_stale_response_cannot_write() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        started_tx.send(()).unwrap();
        release_rx.await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n8")
            .await
            .unwrap();
    });
    let mut p = project(
        json!([
            node("start", "event", json!({})),
            node("http", "http", json!({"url":format!("http://{address}" )})),
            node("write", "write", json!({"variable":"v"}))
        ]),
        json!([edge("start", "http", None), edge("http", "write", None)]),
    );
    let engine = Arc::new(Mutex::new(Engine::new(p.clone()).unwrap()));
    let active = engine.clone();
    let task = tokio::spawn(async move {
        run_shared(
            active,
            None,
            "f",
            None,
            Value::Null,
            CancellationToken::new(),
            None,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), started_rx)
        .await
        .unwrap()
        .unwrap();
    {
        let mut e = tokio::time::timeout(Duration::from_millis(50), engine.lock())
            .await
            .unwrap();
        e.set_variable("v", json!(3)).unwrap();
        p.flows[0].enabled = false;
        e.apply_project(p).unwrap();
    }
    release_tx.send(()).unwrap();
    server.await.unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!(engine.lock().await.snapshot().values["v"].value, json!(3));
}
