#![cfg(not(feature = "aot"))]
use quickgui_engine::{CancellationToken, ScriptHost, ScriptRequest};
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// These tests assert compilation/IPC behavior, not cold process-start latency.
// Validation also starts a separate capabilities probe. Timeout/cancellation
// behavior has its own explicit 100 ms test below.
const DEFAULT_TEST_TIMEOUT_MS: u64 = 5_000;

fn request(source: &str) -> ScriptRequest {
    ScriptRequest {
        source: source.into(),
        input: json!(5),
        variables: BTreeMap::from([("temperature".into(), 20.)]),
        state: BTreeMap::from([("runs".into(), 3.)]),
        timeout_ms: DEFAULT_TEST_TIMEOUT_MS,
    }
}
fn worker() -> ScriptHost {
    ScriptHost::new(env!("CARGO_BIN_EXE_quickgui-c-runner").into())
}
fn raw_request(input: &str, missing_library: bool) -> serde_json::Value {
    raw_request_mode(input, missing_library, false)
}
fn raw_request_mode(input: &str, missing_library: bool, check_only: bool) -> serde_json::Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_quickgui-c-runner"));
    if check_only {
        command.arg("--check");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if missing_library {
        command.env(
            "QG_LIBTCC",
            std::env::temp_dir().join("quickgui-does-not-exist-libtcc"),
        );
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn malformed_request_is_a_protocol_error() {
    let value = raw_request("{\"source\":7}\n", false);
    assert!(value["error"]
        .as_str()
        .unwrap()
        .contains("Invalid ScriptRequest"));
}
#[test]
fn missing_compiler_is_explicit_not_a_fake_result() {
    let line = format!(
        "{}\n",
        serde_json::to_string(&request("void qg_process(void) {} ")).unwrap()
    );
    let value = raw_request(&line, true);
    assert!(value["error"]
        .as_str()
        .unwrap()
        .contains("libtcc is unavailable"));
    assert!(value.get("output").is_none());
}

#[test]
fn unknown_cli_flags_are_rejected_and_compile_check_is_advertised() {
    let output = Command::new(env!("CARGO_BIN_EXE_quickgui-c-runner"))
        .arg("--chek")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unsupported C worker argument"));
    let output = Command::new(env!("CARGO_BIN_EXE_quickgui-c-runner"))
        .arg("--capabilities")
        .output()
        .unwrap();
    let capabilities: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(capabilities["compileCheck"], json!(true));
}

#[cfg(unix)]
#[tokio::test]
async fn old_abi2_worker_is_rejected_before_receiving_user_source() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!(
        "quickgui-old-worker-{}-{}",
        std::process::id(),
        quickgui_engine::now_ms()
    ));
    std::fs::create_dir(&directory).unwrap();
    let executable = directory.join("old-runner");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
if [ "$1" = "--capabilities" ]; then
  printf '%s\n' '{"available":true,"hostAbi":2}'
else
  printf 'called\n' > "$0.executed"
  cat >/dev/null
  printf '%s\n' '{"output":0,"writes":{},"state":{},"logs":[]}'
fi
"#,
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let host = ScriptHost::new(executable.clone());
    let error = host
        .validate(
            request("void qg_process(void){qg_set_number(\"temperature\",999);}"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("compile-only validation"), "{error}");
    assert!(!directory.join("old-runner.executed").exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires pinned libtcc; run node scripts/setup-tcc.mjs first"]
async fn real_c_compiles_and_returns_writes_state_and_logs() {
    let result=worker().execute(request("void qg_process(void){qg_emit_number(qg_input_number()+qg_get_number(\"temperature\"));qg_set_number(\"temperature\",42);qg_state_set(\"runs\",qg_state_get(\"runs\")+1);qg_log(\"compiled C\");}"),CancellationToken::new()).await.unwrap();
    assert_eq!(result.output, 25.);
    assert_eq!(result.writes["temperature"], 42.);
    assert_eq!(result.state["runs"], 4.);
    assert_eq!(result.logs, vec!["compiled C"]);
}
#[tokio::test]
#[ignore = "requires pinned libtcc; exercises an intentional child-process crash"]
async fn c_crash_is_contained_and_next_worker_runs() {
    let mut crash = request("void qg_process(void){*(volatile int*)0=1;}");
    // Allow OS crash-report collection before requiring abnormal-exit
    // classification; the separate timeout test keeps its strict deadline.
    crash.timeout_ms = 10_000;
    let error = worker()
        .execute(crash, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("exited abnormally"), "{error}");
    let result = worker()
        .execute(
            request("void qg_process(void){qg_emit_number(7);}"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.output, 7.);
}
#[tokio::test]
#[ignore = "requires pinned libtcc; exercises an intentionally infinite C loop"]
async fn infinite_c_loop_times_out_and_cancellation_kills_worker() {
    let mut req = request("void qg_process(void){for(;;){}}");
    req.timeout_ms = 100;
    let started = Instant::now();
    let error = worker()
        .execute(req.clone(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("timed out"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(3));
    req.timeout_ms = 5000;
    let token = CancellationToken::new();
    let c = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c.cancel();
    });
    let error = worker().execute(req, token).await.unwrap_err();
    assert!(error.contains("cancelled"), "{error}");
}
#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn compile_errors_and_invalid_numeric_outputs_are_rejected() {
    let error = worker()
        .execute(
            request("void qg_process(void){ this is invalid C; }"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("compile error"), "{error}");
    let error = worker()
        .execute(
            request("void qg_process(void){qg_emit_number(qg_input_number()/0.0);}"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("Non-finite"), "{error}");
}

#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn string_input_pointer_survives_host_calls_and_utf8_round_trips() {
    let mut req = request(
        r#"void qg_process(void){const char *input=qg_input_string();qg_state_set("runs",qg_state_get("runs")+1);qg_log("copied string");qg_emit_string(input);}"#,
    );
    req.input = json!("串口响应: ok\n\"ready\"");
    let input = req.input.clone();
    let response = worker()
        .execute(req, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(response.output, input);
    assert_eq!(response.state["runs"], 4.);
}
#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn json_inputs_and_object_outputs_are_real_c_results() {
    let mut req=request("void qg_process(void){const char *input=qg_input_json();qg_log(\"JSON input\");qg_emit_json(input);}");
    req.input = json!({"received":"ok","values":[1,true,null],"embedded":"a\u{0}b"});
    let input = req.input.clone();
    assert_eq!(
        worker()
            .execute(req, CancellationToken::new())
            .await
            .unwrap()
            .output,
        input
    );
    let req =
        request(r#"void qg_process(void){qg_emit_json("{\"ok\":true,\"samples\":[1,2,3]}");}"#);
    assert_eq!(
        worker()
            .execute(req, CancellationToken::new())
            .await
            .unwrap()
            .output,
        json!({"ok":true,"samples":[1,2,3]})
    );
}
#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn invalid_json_and_wrong_numeric_accessor_are_explicit_errors() {
    let mut req = request("void qg_process(void){qg_emit_json(qg_input_string());}");
    req.input = json!("{invalid json");
    let error = worker()
        .execute(req, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("invalid JSON"), "{error}");
    let mut req = request("void qg_process(void){qg_emit_number(qg_input_number()+1);}");
    req.input = json!({"value":7});
    let error = worker()
        .execute(req, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("qg_input_number requires"), "{error}");
}

#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn engine_pipeline_accepts_string_script_input_and_output() {
    let project:quickgui_engine::Project=serde_json::from_value(json!({"schemaVersion":1,"id":"string-pipeline","name":"String pipeline","revision":0,"locale":"en","theme":{},"publish":{},"window":{"title":"P","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"result","name":"resultText","type":"string","initial":""}],"scripts":[{"id":"s","name":"Echo","source":"void qg_process(void){qg_emit_string(qg_input_string());}","timeoutMs":DEFAULT_TEST_TIMEOUT_MS}],"flows":[{"id":"f","name":"Pipeline","enabled":true,"nodes":[{"id":"start","kind":"event","label":"Start","config":{}},{"id":"script","kind":"script","label":"C","config":{"scriptId":"s"}},{"id":"write","kind":"write","label":"Store","config":{"variable":"result"}}],"edges":[{"id":"a","source":"start","target":"script"},{"id":"b","source":"script","target":"write"}]}]})).unwrap();
    let mut engine = quickgui_engine::Engine::new(project).unwrap();
    let host = worker();
    let snapshot = engine
        .run_flow(
            "f",
            json!("HTTP/串口 response"),
            CancellationToken::new(),
            Some(&host),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.values["result"].value, json!("HTTP/串口 response"));
}

#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn check_compiles_and_links_but_never_executes_user_side_effects_or_loops() {
    let req = request(
        r#"void qg_process(void){qg_set_number("temperature",999);qg_state_set("runs",999);qg_log("must not run");for(;;){}}"#,
    );
    worker()
        .validate(req.clone(), CancellationToken::new())
        .await
        .unwrap();
    let line = format!("{}\n", serde_json::to_string(&req).unwrap());
    let response = raw_request_mode(&line, false, true);
    assert_eq!(response["writes"], json!({}));
    assert_eq!(response["logs"], json!([]));
    assert_eq!(response["state"], json!({"runs":3.0}));
    assert_eq!(response["output"], req.input);
}
#[tokio::test]
#[ignore = "requires pinned libtcc"]
async fn check_rejects_syntax_link_errors_and_missing_entry_and_honors_cancellation() {
    let error = worker()
        .validate(
            request("void qg_process(void){ invalid syntax C; }"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("compile error"), "{error}");
    let error = worker()
        .validate(
            request(
                "extern void qg_missing_symbol(void);void qg_process(void){qg_missing_symbol();}",
            ),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("link/relocation"), "{error}");
    let error = worker()
        .validate(
            request("void another_function(void){}"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("must define void qg_process"), "{error}");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = worker()
        .validate(request("void qg_process(void){}"), cancel)
        .await
        .unwrap_err();
    assert!(error.contains("cancelled"), "{error}");
}
