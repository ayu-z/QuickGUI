use super::*;
use crate::{flow_v4, CancellationToken};

fn raw() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/function-blocks.json")).unwrap()
}
fn project() -> Project {
    serde_json::from_value(raw()).unwrap()
}
fn engine(project: Project) -> Arc<Mutex<Engine>> {
    Arc::new(Mutex::new(Engine::new(project).unwrap()))
}
async fn run(
    engine: Arc<Mutex<Engine>>,
    entry: Option<&str>,
) -> Result<crate::RuntimeSnapshot, String> {
    flow_v4::run_shared(
        engine,
        None,
        "fb",
        entry,
        Value::Null,
        CancellationToken::new(),
        None,
    )
    .await
}

#[tokio::test]
async fn multiple_parameters_fan_out_and_comparison_outputs_match_the_browser_fixture() {
    let shared = engine(project());
    let first = run(shared.clone(), None).await.unwrap();
    assert_eq!(first.values["sum"].value, json!(14.));
    assert_eq!(first.values["copy"].value, json!(14.));
    assert_eq!(first.values["flag"].value, json!(true));
    {
        let mut e = shared.lock().await;
        e.set_variable("a", json!(2)).unwrap();
        e.set_variable("flag", json!(false)).unwrap();
    }
    let next = run(shared, None).await.unwrap();
    assert_eq!(next.values["sum"].value, json!(6.));
    assert_eq!(next.values["copy"].value, json!(6.));
    assert_eq!(next.values["flag"].value, json!(false));
    let mut direct = Engine::new(project()).unwrap();
    let result = direct
        .run_flow("fb", Value::Null, CancellationToken::new(), None)
        .await
        .unwrap();
    assert_eq!(result.values["sum"].value, json!(14.));
}

#[test]
fn v5_interfaces_and_edges_are_strict_and_preserve_null_defaults() {
    let p = project();
    assert_eq!(serde_json::to_value(&p).unwrap()["flows"], raw()["flows"]);
    for version in [1, 2, 3, 4, 6] {
        let mut old = p.clone();
        old.schema_version = version;
        if version == 6 {
            assert!(Engine::new(old).is_err());
        } else {
            assert_eq!(Engine::new(old).unwrap().project().schema_version, 5);
        }
    }
    let mut invalid = p.clone();
    invalid.flows[0].nodes[3].block.as_mut().unwrap().version = 2;
    assert!(Engine::new(invalid).is_err());
    let mut invalid = p.clone();
    invalid.flows[0].nodes[3].block.as_mut().unwrap().inputs[1].id = "a".into();
    assert!(Engine::new(invalid).is_err());
    let mut invalid = p.clone();
    invalid.flows[0].nodes[4].block.as_mut().unwrap().inputs[0].value_type = "boolean".into();
    assert!(Engine::new(invalid).is_err());
    let mut invalid = p.clone();
    let mut duplicate = invalid.flows[0].edges[4].clone();
    duplicate.id = "duplicate".into();
    invalid.flows[0].edges.push(duplicate);
    assert!(Engine::new(invalid).is_err());
    let mut invalid = raw();
    invalid["flows"][0]["nodes"][3]["block"]["extra"] = json!(true);
    assert!(serde_json::from_value::<Project>(invalid).is_err());
    let null: DataInput = serde_json::from_value(json!({"id":"p","name":"NULL","type":"json","binding":"field","key":"IN","defaultValue":null})).unwrap();
    assert_eq!(null.default_value, Some(Value::Null));
    assert!(serde_json::to_value(null)
        .unwrap()
        .get("defaultValue")
        .unwrap()
        .is_null());
}

#[tokio::test]
async fn a_multi_output_data_block_evaluates_fields_and_projects_each_result() {
    let mut raw = raw();
    let node = &mut raw["flows"][0]["nodes"][3];
    node["kind"] = json!("map");
    node["config"] = json!({"operation":"object","fields":{"left":{"source":"input","path":["a"]},"right":{"source":"input","path":["b"]}}});
    node["block"]["inputs"] = json!([{"id":"a","name":"A","type":"number","binding":"field","key":"a"},{"id":"b","name":"B","type":"number","binding":"field","key":"b"}]);
    node["block"]["outputs"] = json!([{"id":"q","name":"LEFT","type":"number","path":["left"]},{"id":"right","name":"RIGHT","type":"number","path":["right"]}]);
    raw["flows"][0]["edges"][7]["sourceHandle"] = json!("data-out:right");
    let result = run(engine(serde_json::from_value(raw).unwrap()), None)
        .await
        .unwrap();
    assert_eq!(result.values["sum"].value, json!(10));
    assert_eq!(result.values["copy"].value, json!(4));
}

#[tokio::test]
async fn block_errors_take_the_error_exit_and_never_emit_success_data() {
    let mut p = project();
    p.variables
        .iter_mut()
        .find(|v| v.id == "b")
        .unwrap()
        .initial = json!(0);
    let f = &mut p.flows[0];
    f.nodes[3]
        .config
        .insert("operation".into(), json!("divide"));
    f.edges.retain(|e| {
        e.target != "save"
            && e.target != "save-copy"
            && !(e.source == "start" && e.target == "compare")
    });
    f.nodes.push(
        serde_json::from_value(
            json!({"id":"save-error","kind":"write","label":"error","config":{"variable":"error"}}),
        )
        .unwrap(),
    );
    f.edges.push(
        serde_json::from_value(
            json!({"id":"error","source":"add","sourceHandle":"error","target":"save-error"}),
        )
        .unwrap(),
    );
    f.edges.push(
        serde_json::from_value(json!({"id":"trigger","source":"start","target":"add"})).unwrap(),
    );
    let result = run(engine(p), None).await.unwrap();
    assert_eq!(result.values["sum"].value, json!(0));
    assert_eq!(result.values["error"].value["code"], json!("BLOCK_ERROR"));
}

#[tokio::test]
async fn a_gated_source_cannot_supply_data_from_a_previous_run() {
    let mut raw = raw();
    raw["flows"][0]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"other","kind":"event","label":"other","config":{"trigger":"manual"}}));
    raw["flows"][0]["edges"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"gate","source":"other","target":"right"}));
    let shared = engine(serde_json::from_value(raw).unwrap());
    run(shared.clone(), Some("other")).await.unwrap();
    let error = run(shared.clone(), Some("start")).await.unwrap_err();
    assert!(error.contains("has not executed in this run"));
    assert_eq!(shared.lock().await.snapshot().values["sum"].value, json!(0));
}
#[tokio::test]
async fn lazy_upstream_errors_run_the_handler_and_skip_data_consumers() {
    let mut p = project();
    p.variables
        .iter_mut()
        .find(|v| v.id == "b")
        .unwrap()
        .initial = json!(0);
    let flow = &mut p.flows[0];
    flow.nodes[3]
        .config
        .insert("operation".into(), json!("divide"));
    flow.edges
        .retain(|e| !(e.source == "start" && e.target == "compare"));
    flow.nodes.push(
        serde_json::from_value(
            json!({"id":"save-error","kind":"write","label":"error","config":{"variable":"error"}}),
        )
        .unwrap(),
    );
    flow.edges.push(
        serde_json::from_value(
            json!({"id":"error","source":"add","sourceHandle":"error","target":"save-error"}),
        )
        .unwrap(),
    );
    let result = run(engine(p), None).await.unwrap();
    assert_eq!(result.values["error"].value["code"], json!("BLOCK_ERROR"));
    assert_eq!(result.values["sum"].value, json!(0));
    assert_eq!(result.values["copy"].value, json!(0));
}

#[tokio::test]
async fn an_invalid_output_does_not_reach_downstream_writes() {
    let mut p = project();
    p.flows[0].nodes[3].block.as_mut().unwrap().outputs[0].path = vec![json!("missing")];
    let shared = engine(p);
    assert!(run(shared.clone(), None).await.is_err());
    assert_eq!(shared.lock().await.snapshot().values["sum"].value, json!(0));
}

#[tokio::test]
async fn changing_a_block_interface_cancels_inflight_continuations() {
    let mut raw = raw();
    raw["flows"][0]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"wait","kind":"delay","label":"wait","config":{"ms":200}}));
    raw["flows"][0]["edges"][0]["target"] = json!("wait");
    raw["flows"][0]["edges"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"after-wait","source":"wait","target":"save"}));
    let p: Project = serde_json::from_value(raw).unwrap();
    let shared = engine(p.clone());
    let task = tokio::spawn(run(shared.clone(), None));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if shared
                .lock()
                .await
                .snapshot()
                .active_nodes
                .iter()
                .any(|id| id == "wait")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut next = p;
    next.revision += 1;
    next.flows[0].nodes[3].block.as_mut().unwrap().inputs[0].default_value = Some(json!(3));
    shared.lock().await.apply_project(next).unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!(shared.lock().await.snapshot().values["sum"].value, json!(0));
}
