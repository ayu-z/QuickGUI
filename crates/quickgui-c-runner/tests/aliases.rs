use quickgui_engine::{CancellationToken, Engine, Project, ScriptHost, ScriptRequest};
use serde_json::json;
use std::collections::BTreeMap;
const SOURCE: &str = include_str!("../../../sdk/tests/aliases.c");
fn request(target: &str) -> ScriptRequest {
    ScriptRequest {
        source: SOURCE.into(),
        input: json!(0),
        variables: BTreeMap::from([
            ("one".into(), 10.),
            ("two".into(), 20.),
            ("left".into(), 99.),
            ("locked".into(), 0.),
        ]),
        variable_aliases: Some(BTreeMap::from([
            ("left".into(), target.into()),
            ("right".into(), target.into()),
            ("locked".into(), "locked".into()),
        ])),
        state: BTreeMap::new(),
        timeout_ms: 5000,
    }
}
fn project() -> Project {
    serde_json::from_value(json!({"schemaVersion":3,"windows":[],"id":"alias-test","name":"Aliases","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"one","name":"left","type":"number","initial":10},{"id":"left","name":"other","type":"number","initial":99},{"id":"locked","name":"locked","type":"number","initial":0,"readOnly":true},{"id":"json","name":"json","type":"json","initial":5}],"scripts":[{"id":"s","name":"Alias test","source":SOURCE,"timeoutMs":5000,"variableAliases":{"left":"one","right":"one","locked":"locked"}}]})).unwrap()
}
async fn contract(host: &ScriptHost) {
    for (target, expected) in [("one", 11.), ("two", 21.), ("left", 100.)] {
        let response = host
            .execute(request(target), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.output, json!(expected));
        assert_eq!(response.writes, BTreeMap::from([(target.into(), expected)]));
        assert_eq!(response.state["runs"], 1.);
    }
    let mut empty = request("one");
    empty.variable_aliases = Some(BTreeMap::new());
    assert!(host
        .execute(empty, CancellationToken::new())
        .await
        .unwrap_err()
        .contains("Unknown"));
    for mode in [1, 3, 4] {
        let mut req = request("one");
        req.input = json!(mode);
        assert!(host.execute(req, CancellationToken::new()).await.is_err());
    }
    let mut unknown = request("missing");
    assert!(host
        .execute(unknown.clone(), CancellationToken::new())
        .await
        .is_err());
    unknown.variable_aliases = None;
    let mut engine = Engine::new(project()).unwrap();
    let first = engine
        .execute_script("s", json!(0), CancellationToken::new(), host)
        .await
        .unwrap();
    assert_eq!(first.state["runs"], 1.);
    assert_eq!(engine.snapshot().values["one"].value, json!(11.));
    assert!(engine
        .execute_script("s", json!(2), CancellationToken::new(), host)
        .await
        .is_err());
    assert_eq!(engine.snapshot().values["one"].value, json!(11.));
    assert_eq!(engine.snapshot().values["locked"].value, json!(0));
    let next = engine
        .execute_script("s", json!(0), CancellationToken::new(), host)
        .await
        .unwrap();
    assert_eq!(
        next.state["runs"], 2.,
        "failed writes must not commit C state"
    );
    assert_eq!(next.output, json!(12.));
    let mut invalid = project();
    invalid.scripts[0]
        .variable_aliases
        .as_mut()
        .unwrap()
        .insert("left".into(), "json".into());
    assert!(Engine::new(invalid).is_err());
}
#[tokio::test]
#[ignore = "requires pinned libtcc and QG_TEST_AOT_RUNNER from build-aot sdk/tests/aliases.c"]
async fn jit_and_aot_share_alias_and_atomic_write_contract() {
    let jit = ScriptHost::new(env!("CARGO_BIN_EXE_quickgui-c-runner").into());
    let aot = ScriptHost::new(
        std::env::var("QG_TEST_AOT_RUNNER")
            .expect("set QG_TEST_AOT_RUNNER to the alias AOT worker directory/quickgui-c-runner")
            .into(),
    );
    contract(&jit).await;
    contract(&aot).await;
}
