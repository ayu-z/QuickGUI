use quickgui_engine::{flow_v4, CancellationToken, Engine, Project, ScriptHost};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
const SOURCE: &str = include_str!("../../../sdk/tests/function-block.c");

fn project() -> Project {
    let mut raw: Value = serde_json::from_str(include_str!(
        "../../quickgui-engine/tests/fixtures/function-blocks.json"
    ))
    .unwrap();
    raw["scripts"] =
        json!([{"id":"s","name":"Multi-input/output FB","source":SOURCE,"timeoutMs":5000}]);
    raw["variables"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"calls","name":"calls","type":"number","initial":0}));
    raw["variables"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"other-calls","name":"other-calls","type":"number","initial":0}));
    let node = &mut raw["flows"][0]["nodes"][3];
    node["kind"] = json!("script");
    node["config"] = json!({"scriptId":"s"});
    node["block"]["inputs"] = json!([{"id":"a","name":"A","type":"number","binding":"field","key":"a"},{"id":"b","name":"B","type":"number","binding":"field","key":"b"}]);
    node["block"]["outputs"] = json!([{"id":"q","name":"SUM","type":"number","path":["sum"]},{"id":"difference","name":"DIFF","type":"number","path":["difference"]},{"id":"calls","name":"RUNS","type":"number","path":["runs"]}]);
    raw["flows"][0]["edges"][7]["sourceHandle"] = json!("data-out:difference");
    raw["flows"][0]["nodes"].as_array_mut().unwrap().push(json!({"id":"save-calls","kind":"write","label":"calls","config":{"variable":"calls"},"block":{"version":1,"inputs":[{"id":"in","name":"IN","type":"number","binding":"input"}],"outputs":[]}}));
    raw["flows"][0]["edges"].as_array_mut().unwrap().extend([
        json!({"id":"calls-exec","source":"save-copy","target":"save-calls"}),
        json!({"id":"calls-data","source":"add","target":"save-calls","sourceHandle":"data-out:calls","targetHandle":"data-in:in","kind":"data"}),
    ]);
    let mut second = raw["flows"][0]["nodes"][3].clone();
    second["id"] = json!("second-instance");
    raw["flows"][0]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(second);
    raw["flows"][0]["nodes"].as_array_mut().unwrap().push(json!({"id":"save-other-calls","kind":"write","label":"other calls","config":{"variable":"other-calls"},"block":{"version":1,"inputs":[{"id":"in","name":"IN","type":"number","binding":"input"}],"outputs":[]}}));
    raw["flows"][0]["edges"].as_array_mut().unwrap().extend([
        json!({"id":"second-exec","source":"start","target":"save-other-calls"}),
        json!({"id":"second-left","source":"left","sourceHandle":"data-out:q","target":"second-instance","targetHandle":"data-in:a","kind":"data"}),
        json!({"id":"second-right","source":"right","sourceHandle":"data-out:q","target":"second-instance","targetHandle":"data-in:b","kind":"data"}),
        json!({"id":"second-calls","source":"second-instance","sourceHandle":"data-out:calls","target":"save-other-calls","targetHandle":"data-in:in","kind":"data"}),
    ]);
    serde_json::from_value(raw).unwrap()
}
async fn contract(host: ScriptHost) {
    let engine = Arc::new(Mutex::new(Engine::new(project()).unwrap()));
    for (a, b, expected_sum, expected_difference, calls) in
        [(10., 4., 14., 6., 1.), (9., 3., 12., 6., 2.)]
    {
        {
            let mut e = engine.lock().await;
            e.set_variable("a", json!(a)).unwrap();
            e.set_variable("b", json!(b)).unwrap();
        }
        let result = flow_v4::run_shared(
            engine.clone(),
            None,
            "fb",
            Some("start"),
            Value::Null,
            CancellationToken::new(),
            Some(&host),
        )
        .await
        .unwrap();
        assert_eq!(result.values["sum"].value.as_f64(), Some(expected_sum));
        assert_eq!(
            result.values["copy"].value.as_f64(),
            Some(expected_difference)
        );
        assert_eq!(
            result.values["calls"].value.as_f64(),
            Some(calls),
            "three outputs must share one C invocation per flow activation"
        );
        assert_eq!(
            result.values["other-calls"].value.as_f64(),
            Some(calls),
            "instances sharing C source must keep independent FB state"
        );
    }
}
#[tokio::test]
#[ignore = "requires pinned libtcc and QG_TEST_FB_AOT_RUNNER from build-aot sdk/tests/function-block.c"]
async fn real_c_named_inputs_and_multiple_outputs_are_equivalent_in_jit_and_aot() {
    contract(ScriptHost::new(
        env!("CARGO_BIN_EXE_quickgui-c-runner").into(),
    ))
    .await;
    contract(ScriptHost::new(
        std::env::var("QG_TEST_FB_AOT_RUNNER")
            .expect("set QG_TEST_FB_AOT_RUNNER")
            .into(),
    ))
    .await;
}
