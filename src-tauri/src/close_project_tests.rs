use super::*;
use serde_json::json;
use std::time::Duration;

pub(super) fn project(id: &str) -> Project {
    serde_json::from_value(json!({
        "schemaVersion":1,"id":id,"name":"Close test","revision":1,"locale":"en","theme":{},"publish":{},
        "window":{"title":"Close test","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#000000","contentRadius":0,"cornerPreference":"system"},
        "variables":[{"id":"value","name":"value","type":"number","initial":1,"persistent":true}]
    })).unwrap()
}

pub(super) fn install_session(
    state: &HostState,
    label: &str,
    project: Project,
    recorder: Option<history::Recorder>,
) -> Session {
    let id = project.id.clone();
    let logic_key = quickgui_engine::flow_v4::execution_key(&project);
    let mut engine = Engine::new(project).unwrap();
    engine.set_variable("value", json!(42)).unwrap();
    let session = Session {
        engine: Arc::new(tokio::sync::Mutex::new(engine)),
        cancellation: CancellationToken::new(),
        booted: Arc::new(Mutex::new(BTreeSet::new())),
        project_id: id,
        history: recorder,
        epoch: state.next_epoch.fetch_add(1, Ordering::Relaxed),
        revision: 1,
        logic_key,
        flow_gate: Arc::new(tokio::sync::Mutex::new(())),
        serial: None,
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(label.into(), session.clone());
    session
}

#[tokio::test]
async fn close_cancels_window_work_flushes_values_and_clears_both_sessions() {
    let state = Arc::new(HostState::default());
    let p = project("persistent");
    let recorder = history::Recorder::open(":memory:".into(), Arc::new(|error| panic!("{error}")))
        .await
        .unwrap();
    let main = install_session(&state, "main", p.clone(), Some(recorder.clone()));
    let preview = install_session(&state, "preview", p.clone(), None);
    *state.preview.lock().unwrap() = Some(serde_json::to_value(&p).unwrap());
    *state.preview_config.lock().unwrap() =
        Some(serde_json::from_value(serde_json::to_value(&p.window).unwrap()).unwrap());
    let work = begin_work(&state, "main", Some(0)).unwrap();
    let build_token = work.cancellation.clone();
    state
        .builds
        .lock()
        .unwrap()
        .insert("main".into(), build_token.clone());
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        work.cancellation.cancelled().await;
        worker_state.builds.lock().unwrap().remove("main");
        drop(work);
    });
    let preview_closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let closed = preview_closed.clone();
    let result = close_project_state(&state, "main".into(), move || {
        closed.store(true, Ordering::Release);
        Ok(())
    })
    .await
    .unwrap();
    worker.await.unwrap();
    assert_eq!(result.generation, 1);
    assert!(
        main.cancellation.is_cancelled()
            && preview.cancellation.is_cancelled()
            && build_token.is_cancelled()
    );
    assert!(state.sessions.lock().unwrap().is_empty());
    assert!(
        state.preview.lock().unwrap().is_none() && state.preview_config.lock().unwrap().is_none()
    );
    assert!(preview_closed.load(Ordering::Acquire));
    assert_eq!(recorder.restore(p).await.unwrap()["value"], json!(42));
    assert!(project_work(&state, "main", Some(0), true).is_err());
    assert!(project_work(&state, "main", Some(1), false).is_err());
    assert!(begin_work(&state, "main", Some(0)).is_err());
}

#[tokio::test]
async fn v4_hmi_children_share_serial_lifetime_while_designer_is_independent() {
    let state = HostState::default();
    let mut p = project("serial-lifecycle");
    p.schema_version = 4;
    p.windows = Some(Vec::new());
    install_session(&state, "preview", p.clone(), None);
    install_session(&state, "main", p, None);
    let preview_serial = quickgui_engine::serial::SerialService::new(CancellationToken::new());
    let designer_serial = quickgui_engine::serial::SerialService::new(CancellationToken::new());
    state
        .sessions
        .lock()
        .unwrap()
        .get_mut("preview")
        .unwrap()
        .serial = Some(preview_serial.clone());
    state
        .sessions
        .lock()
        .unwrap()
        .get_mut("main")
        .unwrap()
        .serial = Some(designer_serial.clone());
    let child = session(&state, "preview__child").unwrap();
    invalidate_project(&state, "preview__child").unwrap();
    assert!(!child.serial.as_ref().unwrap().is_cancelled());
    assert!(!preview_serial.is_cancelled());
    close_project_state(&state, "preview".into(), || Ok(()))
        .await
        .unwrap();
    assert!(preview_serial.is_cancelled());
    assert!(child.serial.as_ref().unwrap().is_cancelled());
    assert!(!designer_serial.is_cancelled());
    assert!(state.sessions.lock().unwrap().contains_key("main"));
    designer_serial.shutdown().await;
}

#[tokio::test]
async fn close_invalidates_a_start_waiting_for_the_lifecycle_lock() {
    let state = Arc::new(HostState::default());
    let lock = lifecycle(&state, "main").unwrap();
    let guard = lock.lock().await;
    let starter_state = state.clone();
    let queued = tokio::spawn(async move {
        let lock = lifecycle(&starter_state, "main").unwrap();
        let _guard = lock.lock().await;
        project_work(&starter_state, "main", Some(0), true)
    });
    tokio::task::yield_now().await;
    let closer_state = state.clone();
    let closing =
        tokio::spawn(
            async move { close_project_state(&closer_state, "main".into(), || Ok(())).await },
        );
    tokio::task::yield_now().await;
    drop(guard);
    assert!(queued.await.unwrap().is_err());
    assert_eq!(closing.await.unwrap().unwrap().generation, 1);
    assert!(state.sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn project_close_invalidates_every_hmi_child_and_cancels_the_shared_engine_once() {
    let state = HostState::default();
    let primary = install_session(&state, "preview", project("multi"), None);
    for label in ["preview", "preview__one", "preview__two"] {
        state
            .projects
            .lock()
            .unwrap()
            .insert(label.into(), ProjectWork::default());
    }
    let work = begin_work(&state, "preview__two", Some(0)).unwrap();
    let child_token = work.cancellation.clone();
    let task = tokio::spawn(async move {
        work.cancellation.cancelled().await;
        drop(work);
    });
    *state.pending_window_open.lock().unwrap() = Some(("multi".into(), 1, "one".into()));
    let result = close_project_state(&state, "preview".into(), || Ok(()))
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(result.generation, 1);
    assert!(primary.cancellation.is_cancelled() && child_token.is_cancelled());
    assert!(state.sessions.lock().unwrap().is_empty());
    assert!(state.pending_window_open.lock().unwrap().is_none());
    for label in ["preview", "preview__one", "preview__two"] {
        assert!(project_work(&state, label, Some(0), true).is_err());
        assert!(state.projects.lock().unwrap().get(label).unwrap().closed);
    }
}

#[tokio::test]
async fn a_retried_close_still_waits_for_work_from_an_older_generation() {
    let state = HostState::default();
    let work = begin_work(&state, "main", Some(0)).unwrap();
    invalidate_project(&state, "main").unwrap();
    let retry = invalidate_project(&state, "main").unwrap();
    let waiter = tokio::spawn(async move { wait_for_work(&retry).await });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    drop(work);
    tokio::time::timeout(Duration::from_secs(1), waiter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn failed_final_transaction_keeps_stopped_sessions_for_retry() {
    let state = HostState::default();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let reported = errors.clone();
    let recorder = history::Recorder::open(
        ":memory:".into(),
        Arc::new(move |error| reported.lock().unwrap().push(error)),
    )
    .await
    .unwrap();
    let existing = project("different-database-owner");
    recorder
        .record_and_flush(
            Arc::new(existing.clone()),
            Engine::new(existing).unwrap().snapshot(),
        )
        .await
        .unwrap();
    let session = install_session(&state, "main", project("current-project"), Some(recorder));
    assert!(close_project_state(&state, "main".into(), || Ok(()))
        .await
        .is_err());
    assert!(session.cancellation.is_cancelled());
    assert!(state.sessions.lock().unwrap().contains_key("main"));
    assert!(!errors.lock().unwrap().is_empty());
    let replacement =
        history::Recorder::open(":memory:".into(), Arc::new(|error| panic!("{error}")))
            .await
            .unwrap();
    state
        .sessions
        .lock()
        .unwrap()
        .get_mut("main")
        .unwrap()
        .history = Some(replacement.clone());
    let result = close_project_state(&state, "main".into(), || Ok(()))
        .await
        .unwrap();
    assert_eq!(result.generation, 2);
    assert!(state.sessions.lock().unwrap().is_empty());
    assert_eq!(
        replacement
            .restore(project("current-project"))
            .await
            .unwrap()["value"],
        json!(42)
    );
}

#[tokio::test]
#[ignore = "Requires a prepared native C runner and libtcc"]
async fn close_cancels_a_real_inflight_c_worker() {
    let state = Arc::new(HostState::default());
    install_session(&state, "main", project("c-worker"), None);
    let work = begin_work(&state, "main", Some(0)).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let executable = root.join("target/debug").join(if cfg!(windows) {
        "quickgui-c-runner.exe"
    } else {
        "quickgui-c-runner"
    });
    let task = tokio::spawn(async move {
        let request:ScriptRequest=serde_json::from_value(json!({"source":"#include \"quickgui.h\"\nvoid qg_process(void) { for (;;) {} }","input":null,"variables":{},"state":{},"timeoutMs":10000})).unwrap();
        ScriptHost::new(executable)
            .execute(request, work.cancellation.clone())
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::time::timeout(
        Duration::from_secs(2),
        close_project_state(&state, "main".into(), || Ok(())),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(task
        .await
        .unwrap()
        .unwrap_err()
        .to_lowercase()
        .contains("cancel"));
    assert!(state.sessions.lock().unwrap().is_empty());
}
