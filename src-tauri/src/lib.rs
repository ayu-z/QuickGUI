use quickgui_engine::{
    CancellationToken, Engine, Project, RuntimeSnapshot, ScriptHost, ScriptRequest, ScriptResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

mod build_runtime;
mod history;
mod project_file;
mod scheduler;
mod source_export;
mod windows;

#[derive(Clone)]
struct Session {
    engine: Arc<tokio::sync::Mutex<Engine>>,
    cancellation: CancellationToken,
    booted: Arc<Mutex<BTreeSet<(String, String)>>>,
    project_id: String,
    history: Option<history::Recorder>,
    epoch: u64,
    revision: u64,
}

#[derive(Default)]
struct HostState {
    sessions: Mutex<HashMap<String, Session>>,
    preview: Mutex<Option<Value>>,
    preview_config: Mutex<Option<WindowConfig>>,
    child_configs: Mutex<HashMap<String, WindowConfig>>,
    window_projects: Mutex<HashMap<String, String>>,
    committed_preview: Mutex<Option<Value>>,
    latest_snapshots: Mutex<HashMap<String, RuntimeSnapshot>>,
    window_sync_ticket: Mutex<Option<windows::SyncTicket>>,
    applied_window_state: Mutex<Option<(String, u64)>>,
    pending_window_open: Mutex<Option<(String, u64, String)>>,
    retiring_windows: Mutex<HashMap<String, VecDeque<u64>>>,
    closing_windows: Mutex<HashMap<String, u64>>,
    builds: Mutex<HashMap<String, CancellationToken>>,
    lifecycle: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_epoch: AtomicU64,
    projects: Mutex<HashMap<String, ProjectWork>>,
}

#[derive(Default)]
struct WorkCount {
    active: AtomicUsize,
    completed: tokio::sync::Notify,
}

#[derive(Clone)]
struct ProjectWork {
    generation: u64,
    cancellation: CancellationToken,
    jobs: Arc<WorkCount>,
    closed: bool,
}

impl Default for ProjectWork {
    fn default() -> Self {
        Self {
            generation: 0,
            cancellation: CancellationToken::new(),
            jobs: Arc::new(WorkCount::default()),
            closed: false,
        }
    }
}

pub(crate) struct TrackedWork {
    pub(crate) cancellation: CancellationToken,
    jobs: Arc<WorkCount>,
}

impl Drop for TrackedWork {
    fn drop(&mut self) {
        if self.jobs.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.jobs.completed.notify_waiters();
        }
    }
}

fn project_work(
    state: &HostState,
    label: &str,
    generation: Option<u64>,
    allow_closed: bool,
) -> Result<ProjectWork, String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    if windows::is_child(label) && projects.get("preview").is_some_and(|p| p.closed) {
        return Err("The HMI project is closed".into());
    }
    let current = projects.entry(label.to_owned()).or_default();
    if generation.unwrap_or(0) != current.generation {
        return Err("Project generation changed; the stale operation was cancelled".into());
    }
    if current.closed && !allow_closed {
        return Err("The project is closed".into());
    }
    Ok(current.clone())
}

pub(crate) fn begin_work(
    state: &HostState,
    label: &str,
    generation: Option<u64>,
) -> Result<TrackedWork, String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    if windows::is_child(label) && projects.get("preview").is_some_and(|p| p.closed) {
        return Err("The HMI project is closed".into());
    }
    let current = projects.entry(label.to_owned()).or_default();
    if generation.unwrap_or(0) != current.generation {
        return Err("Project generation changed; the stale operation was cancelled".into());
    }
    current.jobs.active.fetch_add(1, Ordering::AcqRel);
    Ok(TrackedWork {
        cancellation: current.cancellation.child_token(),
        jobs: current.jobs.clone(),
    })
}

fn invalidate_project(state: &HostState, label: &str) -> Result<ProjectWork, String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    let current = projects.entry(label.to_owned()).or_default();
    let retired = current.clone();
    retired.cancellation.cancel();
    *current = ProjectWork {
        generation: retired
            .generation
            .checked_add(1)
            .ok_or("Project generation overflow")?,
        // Keep unfinished older jobs visible to a retry after a cancellation timeout.
        jobs: retired.jobs.clone(),
        closed: true,
        ..Default::default()
    };
    if !windows::is_child(label) {
        if let Ok(active) = session(state, label) {
            active.cancellation.cancel();
        }
    }
    if let Some(build) = state.builds.lock().map_err(|e| e.to_string())?.get(label) {
        build.cancel();
    }
    Ok(retired)
}

async fn wait_for_work(work: &ProjectWork) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let completed = work.jobs.completed.notified();
            tokio::pin!(completed);
            completed.as_mut().enable();
            if work.jobs.active.load(Ordering::Acquire) == 0 {
                break;
            }
            completed.await;
        }
    })
    .await
    .map_err(|_| "Cancellation is still pending for a native task".to_owned())
}

#[derive(Serialize)]
pub struct CloseProjectResult {
    generation: u64,
}

#[tauri::command]
fn project_generation(window: WebviewWindow, state: State<'_, HostState>) -> Result<u64, String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    Ok(projects
        .entry(window.label().to_owned())
        .or_default()
        .generation)
}

async fn flush_session(state: &HostState, label: &str) -> Result<Option<u64>, String> {
    let Ok(active) = session(state, label) else {
        return Ok(None);
    };
    active.cancellation.cancel();
    let mut engine = active.engine.lock().await;
    engine.stop();
    let snapshot = engine.snapshot();
    if let Some(recorder) = &active.history {
        recorder
            .record_and_flush(Arc::new(engine.project().clone()), snapshot)
            .await?;
    }
    Ok(Some(active.epoch))
}

#[tauri::command]
async fn close_project(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<CloseProjectResult, String> {
    let label = window.label().to_owned();
    close_project_state(&state, label.clone(), || {
        for (label, view) in app.webview_windows() {
            if windows::is_child(&label) {
                windows::destroy_view(&view)?;
            }
        }
        if let Some(preview) = app.get_webview_window("preview") {
            windows::destroy_view(&preview)?;
        }
        Ok(())
    })
    .await
}

async fn close_project_state<F>(
    state: &HostState,
    label: String,
    close_windows: F,
) -> Result<CloseProjectResult, String>
where
    F: FnOnce() -> Result<(), String> + Send,
{
    let owner = windows::owner(&label).to_owned();
    let mut retired = Vec::new();
    for view in windows::group_labels(state, &owner)? {
        retired.push((view.clone(), invalidate_project(state, &view)?));
    }
    *state.window_sync_ticket.lock().map_err(|e| e.to_string())? = None;
    state
        .closing_windows
        .lock()
        .map_err(|e| e.to_string())?
        .clear();
    *state
        .applied_window_state
        .lock()
        .map_err(|e| e.to_string())? = None;
    let owner_labels: Vec<_> = retired
        .iter()
        .map(|(label, _)| label.clone())
        .filter(|label| !windows::is_child(label))
        .collect();
    let locks = owner_labels
        .iter()
        .map(|label| lifecycle(state, label))
        .collect::<Result<Vec<_>, _>>()?;
    let mut guards = Vec::new();
    for lock in &locks {
        guards.push(lock.lock().await);
    }
    // Include a child reserved by a window-creation task before owner invalidation.
    for view in windows::group_labels(state, &owner)? {
        if !retired.iter().any(|(label, _)| *label == view) {
            retired.push((view.clone(), invalidate_project(state, &view)?));
        }
    }
    for (_, work) in &retired {
        wait_for_work(work).await?;
    }
    let mut epochs = Vec::new();
    for owner in &owner_labels {
        epochs.push((owner.clone(), flush_session(state, owner).await?));
    }
    // Preserve stopped sessions if durability or native teardown fails, so retry works.
    close_windows()?;
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        for (owner, epoch) in epochs {
            if sessions
                .get(&owner)
                .is_some_and(|session| Some(session.epoch) == epoch)
            {
                sessions.remove(&owner);
            }
        }
    }
    *state.preview.lock().map_err(|e| e.to_string())? = None;
    *state.committed_preview.lock().map_err(|e| e.to_string())? = None;
    *state.preview_config.lock().map_err(|e| e.to_string())? = None;
    state
        .child_configs
        .lock()
        .map_err(|e| e.to_string())?
        .clear();
    state
        .window_projects
        .lock()
        .map_err(|e| e.to_string())?
        .clear();
    state
        .pending_window_open
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    for owner in owner_labels {
        state
            .latest_snapshots
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&owner);
    }
    let generation = {
        let projects = state.projects.lock().map_err(|e| e.to_string())?;
        projects
            .get(&label)
            .or_else(|| projects.get(&owner))
            .map(|p| p.generation)
    };
    // label is always included for root commands; child callers use their own lease.
    let generation = match generation {
        Some(value) => value,
        None => {
            state
                .projects
                .lock()
                .map_err(|e| e.to_string())?
                .get(&owner)
                .ok_or("Project generation is unavailable")?
                .generation
        }
    };
    Ok(CloseProjectResult { generation })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
    title: String,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    resizable: bool,
    always_on_top: bool,
    fullscreen: bool,
    maximized: bool,
    center: bool,
    remember_position: bool,
    background: String,
    content_radius: f64,
    corner_preference: String,
    icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowApplyResult {
    warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ScopedSnapshot<'a> {
    #[serde(flatten)]
    snapshot: &'a RuntimeSnapshot,
    #[serde(rename = "projectGeneration")]
    generation: u64,
}

fn emit_snapshot(
    window: &WebviewWindow,
    snapshot: &RuntimeSnapshot,
    generation: u64,
) -> Result<(), tauri::Error> {
    window.emit(
        "runtime-snapshot",
        ScopedSnapshot {
            snapshot,
            generation,
        },
    )
}

fn runner_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "quickgui-c-runner.exe"
    } else {
        "quickgui-c-runner"
    };
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("c-runner").join(name));
    }
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        candidates.push(root.join("target/debug").join(name));
        candidates.push(root.join("target/release").join(name));
    }
    candidates.into_iter().find(|p| p.is_file() || p.parent().is_some_and(|dir| dir.join("aot-manifest.json").is_file())).ok_or_else(|| "C runner is not installed. Build quickgui-c-runner and stage libtcc with node scripts/build-native.mjs --prepare.".into())
}

fn session(state: &HostState, label: &str) -> Result<Session, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(windows::owner(label))
        .cloned()
        .ok_or_else(|| "Runtime is not started for this window".into())
}

fn lifecycle(state: &HostState, label: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    Ok(state
        .lifecycle
        .lock()
        .map_err(|e| e.to_string())?
        .entry(label.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

fn require_current(
    state: &HostState,
    label: &str,
    active: &Session,
    engine: &Engine,
) -> Result<(), String> {
    if state
        .projects
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .is_some_and(|project| project.closed)
    {
        return Err("The project is closed".into());
    }
    if windows::is_child(label)
        && state
            .projects
            .lock()
            .map_err(|e| e.to_string())?
            .get("preview")
            .is_some_and(|p| p.closed)
    {
        return Err("The HMI project is closed".into());
    }
    if session(state, label)?.epoch != active.epoch
        || engine.project().id != active.project_id
        || engine.project().revision != active.revision
    {
        return Err("Runtime session was replaced; the stale command was cancelled".into());
    }
    Ok(())
}

#[tauri::command]
async fn execute_c(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    request: ScriptRequest,
    generation: Option<u64>,
) -> Result<ScriptResponse, String> {
    window
        .is_visible()
        .map_err(|_| "The runtime window has already closed")?;
    project_work(&state, window.label(), generation, false)?;
    let work = begin_work(&state, window.label(), generation)?;
    ScriptHost::new(runner_path(&app)?)
        .execute(request, work.cancellation.clone())
        .await
}

#[tauri::command]
async fn validate_c(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    request: ScriptRequest,
    generation: Option<u64>,
) -> Result<(), String> {
    window
        .is_visible()
        .map_err(|_| "The runtime window has already closed")?;
    let work = begin_work(&state, window.label(), generation)?;
    ScriptHost::new(runner_path(&app)?)
        .validate(request, work.cancellation.clone())
        .await
}

#[tauri::command]
async fn test_connection(
    window: WebviewWindow,
    state: State<'_, HostState>,
    connection: quickgui_engine::Connection,
    generation: Option<u64>,
) -> Result<quickgui_engine::ConnectionTestResult, String> {
    window
        .is_visible()
        .map_err(|_| "The runtime window has already closed")?;
    project_work(&state, window.label(), generation, false)?;
    let work = begin_work(&state, window.label(), generation)?;
    tokio::select! {
        _ = work.cancellation.cancelled() => Err("Connection diagnostic cancelled by project close".into()),
        result = quickgui_engine::test_connection(connection) => result,
    }
}

#[tauri::command]
async fn runtime_start(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    project: Value,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    if windows::is_child(window.label()) {
        return Err("Child HMI windows must attach to the shared runtime".into());
    }
    let lock = lifecycle(&state, window.label())?;
    let _guard = lock.lock().await;
    window
        .is_visible()
        .map_err(|_| "The runtime window has already closed")?;
    let work = project_work(&state, window.label(), generation, true)?;
    let document = project.clone();
    let project: Project = serde_json::from_value(project).map_err(|e| e.to_string())?;
    let event_sources = scheduler::sources(&project)?;
    // Reject invalid edits before cancelling the currently running version.
    let mut checked_engine = Engine::new(project.clone())?;
    let previous = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .cloned();
    let same_project = previous
        .as_ref()
        .is_some_and(|previous| previous.project_id == project.id);
    if same_project
        && previous
            .as_ref()
            .is_some_and(|previous| project.revision < previous.revision)
    {
        return Err("Stale project revision cannot replace the active runtime".into());
    }
    let recorder = if same_project {
        previous
            .as_ref()
            .and_then(|previous| previous.history.clone())
            .ok_or("Missing history recorder")?
    } else {
        use sha2::{Digest, Sha256};
        let project_key = format!("{:x}", Sha256::digest(project.id.as_bytes()));
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("runtime")
            .join(window.label());
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let reporter = app.clone();
        let reporter_owner = window.label().to_owned();
        history::Recorder::open(
            directory.join(format!("{project_key}.sqlite")),
            Arc::new(move |error| {
                windows::broadcast_event(&reporter, &reporter_owner, "storage-error", error);
            }),
        )
        .await?
    };
    if !same_project {
        checked_engine.restore_persistent_values(&recorder.restore(project.clone()).await?)?;
    }
    project_work(&state, window.label(), generation, true)?;
    let recording_project = Arc::new(project.clone());
    let recording_history = recorder.clone();
    let event_generation = work.generation;
    let epoch = state.next_epoch.fetch_add(1, Ordering::Relaxed);
    let listener = app.clone();
    let owner_label = window.label().to_owned();
    let window_project = recording_project.clone();
    let observer = Arc::new(move |snapshot: RuntimeSnapshot| {
        let state = listener.state::<HostState>();
        let current = session(&state, &owner_label)
            .is_ok_and(|s| s.epoch == epoch && s.revision == snapshot.revision)
            && state
                .projects
                .lock()
                .ok()
                .and_then(|p| p.get(&owner_label).cloned())
                .is_some_and(|p| p.generation == event_generation && !p.closed);
        if !current {
            return;
        }
        if recording_project.revision == snapshot.revision {
            recording_history.record(recording_project.clone(), snapshot.clone());
        }
        windows::broadcast_snapshot(&listener, &owner_label, &snapshot);
        if owner_label == "preview" {
            windows::queue_sync(
                listener.clone(),
                window_project.clone(),
                &snapshot,
                epoch,
                event_generation,
            );
        }
    });
    let listener = app.clone();
    let event_owner = window.label().to_owned();
    let event_observer = Arc::new(move |event: quickgui_engine::RuntimeEvent| {
        if session(&listener.state::<HostState>(), &event_owner)
            .is_ok_and(|s| s.epoch == epoch && !s.cancellation.is_cancelled())
        {
            windows::broadcast_event(&listener, &event_owner, "runtime-event", event);
        }
    });
    let project_id = project.id.clone();
    let revision = project.revision;
    let initial_project = Arc::new(project.clone());
    let pending_window = {
        let mut pending = state
            .pending_window_open
            .lock()
            .map_err(|e| e.to_string())?;
        if window.label() == "preview"
            && pending
                .as_ref()
                .is_some_and(|(id, revision, _)| id == &project.id && *revision <= project.revision)
        {
            pending.take().map(|(_, _, id)| id)
        } else {
            None
        }
    };
    let (engine, snapshot, booted) = if let Some(previous) = previous {
        previous.cancellation.cancel();
        let mut engine = previous.engine.lock().await;
        let booted = if engine.project().id == project.id {
            previous.booted.clone()
        } else {
            Arc::new(Mutex::new(BTreeSet::new()))
        };
        if same_project {
            engine.apply_project(project)?;
        } else {
            *engine = checked_engine;
        }
        engine.set_observer(observer);
        engine.set_event_observer(event_observer);
        if let Some(id) = &pending_window {
            let _ = engine.window_action("open", id);
        }
        (previous.engine.clone(), engine.snapshot(), booted)
    } else {
        let mut engine = checked_engine;
        engine.set_observer(observer);
        engine.set_event_observer(event_observer);
        if let Some(id) = &pending_window {
            let _ = engine.window_action("open", id);
        }
        let snapshot = engine.snapshot();
        (
            Arc::new(tokio::sync::Mutex::new(engine)),
            snapshot,
            Arc::new(Mutex::new(BTreeSet::new())),
        )
    };
    let next = Session {
        engine,
        cancellation: work.cancellation.child_token(),
        booted,
        project_id,
        history: Some(recorder.clone()),
        epoch,
        revision,
    };
    {
        let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
        let current = projects
            .get_mut(window.label())
            .ok_or("Project generation is unavailable")?;
        if current.generation != work.generation {
            return Err("Project closed while initialization was pending".into());
        }
        current.closed = false;
    }
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.label().into(), next.clone());
    recorder.record(initial_project.clone(), snapshot.clone());
    windows::broadcast_snapshot(&app, window.label(), &snapshot);
    if window.label() == "preview" {
        *state.committed_preview.lock().map_err(|e| e.to_string())? = Some(document.clone());
        state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .insert("preview".into(), initial_project.id.clone());
        for (label, child) in app.webview_windows() {
            if windows::is_child(&label) {
                let _ = windows::emit_project(&child, &document);
            }
        }
        windows::queue_sync(
            app.clone(),
            initial_project,
            &snapshot,
            epoch,
            event_generation,
        );
    }
    scheduler::start(next, event_sources, runner_path(&app).ok());
    Ok(snapshot)
}

#[tauri::command]
async fn runtime_attach(
    window: WebviewWindow,
    state: State<'_, HostState>,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    project_work(&state, window.label(), generation, false)?;
    let active = session(&state, window.label())?;
    if windows::is_child(window.label()) {
        let registered = state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .get(window.label())
            .cloned();
        if registered.as_deref() != Some(active.project_id.as_str()) {
            return Err("The child window is not attached to this project".into());
        }
    }
    if let Some(snapshot) = state
        .latest_snapshots
        .lock()
        .map_err(|e| e.to_string())?
        .get(windows::owner(window.label()))
        .cloned()
        .filter(|snapshot| {
            snapshot.project_id == active.project_id && snapshot.revision == active.revision
        })
    {
        project_work(&state, window.label(), generation, false)?;
        return Ok(snapshot);
    }
    let engine = active.engine.lock().await;
    project_work(&state, window.label(), generation, false)?;
    require_current(&state, window.label(), &active, &engine)?;
    Ok(engine.snapshot())
}

#[tauri::command]
async fn runtime_window_action(
    window: WebviewWindow,
    state: State<'_, HostState>,
    action: String,
    window_id: String,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    project_work(&state, window.label(), generation, false)?;
    let active = session(&state, window.label())?;
    let mut engine = active.engine.lock().await;
    project_work(&state, window.label(), generation, false)?;
    require_current(&state, window.label(), &active, &engine)?;
    engine.window_action(&action, &window_id)?;
    Ok(engine.snapshot())
}

#[tauri::command]
async fn runtime_run_flow(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    flow_id: String,
    input: Value,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    project_work(&state, window.label(), generation, false)?;
    let active = session(&state, window.label())?;
    let host = runner_path(&app).ok().map(ScriptHost::new);
    let mut engine = active.engine.lock().await;
    project_work(&state, window.label(), generation, false)?;
    require_current(&state, window.label(), &active, &engine)?;
    let result = engine
        .run_flow(
            &flow_id,
            input,
            active.cancellation.child_token(),
            host.as_ref(),
        )
        .await;
    result
}

#[tauri::command]
async fn runtime_set_variable(
    window: WebviewWindow,
    state: State<'_, HostState>,
    name: String,
    value: Value,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    project_work(&state, window.label(), generation, false)?;
    let active = session(&state, window.label())?;
    let mut engine = active.engine.lock().await;
    project_work(&state, window.label(), generation, false)?;
    require_current(&state, window.label(), &active, &engine)?;
    engine.set_variable(&name, value)?;
    let snapshot = engine.snapshot();
    windows::broadcast_snapshot(
        window.app_handle(),
        windows::owner(window.label()),
        &snapshot,
    );
    Ok(snapshot)
}

#[tauri::command]
async fn runtime_snapshot(
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<RuntimeSnapshot, String> {
    let active = session(&state, window.label())?;
    let snapshot = active.engine.lock().await.snapshot();
    Ok(snapshot)
}

#[tauri::command]
async fn runtime_stop(
    window: WebviewWindow,
    state: State<'_, HostState>,
    generation: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    let lock = lifecycle(&state, windows::owner(window.label()))?;
    let _guard = lock.lock().await;
    project_work(&state, window.label(), generation, false)?;
    let active = session(&state, window.label())?;
    active.cancellation.cancel();
    let mut engine = active.engine.lock().await;
    engine.stop();
    let snapshot = engine.snapshot();
    let project = Arc::new(engine.project().clone());
    if let Some(recorder) = active.history {
        recorder.record_and_flush(project, snapshot.clone()).await?;
    }
    Ok(snapshot)
}

fn apply_config(
    window: &WebviewWindow,
    config: &WindowConfig,
) -> Result<WindowApplyResult, String> {
    if !(200.0..=10000.0).contains(&config.width)
        || !(100.0..=10000.0).contains(&config.height)
        || !(0.0..=config.width).contains(&config.min_width)
        || !(0.0..=config.height).contains(&config.min_height)
    {
        return Err("Invalid window dimensions or minimum size".into());
    }
    let map = |e: tauri::Error| e.to_string();
    let state = window.state::<HostState>();
    let previous = if windows::is_child(window.label()) {
        state
            .child_configs
            .lock()
            .map_err(|e| e.to_string())?
            .get(window.label())
            .cloned()
    } else {
        state
            .preview_config
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
    };
    let resized = previous.as_ref().is_none_or(|old| {
        old.width != config.width
            || old.height != config.height
            || old.min_width != config.min_width
            || old.min_height != config.min_height
    });
    let fullscreen_changed = previous
        .as_ref()
        .is_none_or(|old| old.fullscreen != config.fullscreen);
    let maximized_changed = previous
        .as_ref()
        .is_none_or(|old| old.maximized != config.maximized);
    if previous
        .as_ref()
        .is_none_or(|old| old.title != config.title)
    {
        window.set_title(&config.title).map_err(map)?;
    }
    if resized || fullscreen_changed {
        window.set_fullscreen(false).map_err(map)?;
    }
    if resized || maximized_changed {
        window.unmaximize().map_err(map)?;
    }
    if resized {
        window
            .set_min_size(Some(tauri::LogicalSize::new(
                config.min_width.min(config.width),
                config.min_height.min(config.height),
            )))
            .map_err(map)?;
        window
            .set_size(tauri::LogicalSize::new(config.width, config.height))
            .map_err(map)?;
    }
    if previous
        .as_ref()
        .is_none_or(|old| old.resizable != config.resizable)
    {
        window.set_resizable(config.resizable).map_err(map)?;
    }
    if previous
        .as_ref()
        .is_none_or(|old| old.always_on_top != config.always_on_top)
    {
        window
            .set_always_on_top(config.always_on_top)
            .map_err(map)?;
    }
    let restored = previous.is_none() && config.remember_position && restore_position(window);
    if !restored && config.center && (resized || previous.as_ref().is_none_or(|old| !old.center)) {
        window.center().map_err(map)?;
    }
    if config.maximized && (resized || maximized_changed) {
        window.maximize().map_err(map)?;
    }
    if resized || fullscreen_changed {
        window.set_fullscreen(config.fullscreen).map_err(map)?;
    }
    if previous
        .as_ref()
        .is_none_or(|old| old.background != config.background)
    {
        if let Some(color) = parse_color(&config.background) {
            window.set_background_color(Some(color)).map_err(map)?;
        }
    }
    let mut warnings = Vec::new();
    if let Some(reference) = &config.icon {
        let state = window.state::<HostState>();
        let project = state
            .committed_preview
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| state.preview.lock().ok().and_then(|p| p.clone()));
        let icon = project
            .as_ref()
            .and_then(|p| p.get("assets"))
            .and_then(Value::as_array)
            .and_then(|assets| {
                assets
                    .iter()
                    .find(|a| a.get("id").and_then(Value::as_str) == Some(reference))
            })
            .and_then(|a| a.get("data"))
            .and_then(Value::as_str)
            .unwrap_or(reference);
        if let Some((header, payload)) = icon.split_once(',') {
            if header.contains(";base64")
                && (header.contains("image/png")
                    || header.contains("image/x-icon")
                    || header.contains("image/vnd.microsoft.icon"))
            {
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| {
                        tauri::image::Image::from_bytes(&bytes).map_err(|e| e.to_string())
                    }) {
                    Ok(image) => window.set_icon(image).map_err(map)?,
                    Err(error) => warnings.push(format!("Could not apply window icon: {error}")),
                }
            } else {
                warnings.push("Live window icons require PNG or ICO; publish converts embedded SVG to platform icons.".into());
            }
        }
    }
    if previous
        .as_ref()
        .is_none_or(|old| old.corner_preference != config.corner_preference)
    {
        apply_corner(window, &config.corner_preference, &mut warnings);
    }
    Ok(WindowApplyResult { warnings })
}

fn clamp_position(
    position: [i32; 2],
    size: [u32; 2],
    area_origin: [i32; 2],
    area_size: [u32; 2],
) -> [i32; 2] {
    let mut result = position;
    for axis in 0..2 {
        let min = i64::from(area_origin[axis]);
        let max = min + i64::from(area_size[axis].saturating_sub(size[axis]));
        result[axis] = i64::from(position[axis])
            .clamp(min, max)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    }
    result
}

fn restore_position(window: &WebviewWindow) -> bool {
    let Some(position) = windows::position_path(window)
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<[i32; 2]>(&bytes).ok())
    else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            i64::from(position[0]) >= i64::from(area.position.x)
                && i64::from(position[0]) < i64::from(area.position.x) + i64::from(area.size.width)
                && i64::from(position[1]) >= i64::from(area.position.y)
                && i64::from(position[1]) < i64::from(area.position.y) + i64::from(area.size.height)
        })
        .cloned()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(monitor) = monitor else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let area = monitor.work_area();
    let position = clamp_position(
        position,
        [size.width, size.height],
        [area.position.x, area.position.y],
        [area.size.width, area.size.height],
    );
    window
        .set_position(tauri::PhysicalPosition::new(position[0], position[1]))
        .is_ok()
}

fn parse_color(value: &str) -> Option<tauri::window::Color> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    Some(tauri::window::Color(
        bytes[0],
        bytes[1],
        bytes[2],
        *bytes.get(3).unwrap_or(&255),
    ))
}

#[cfg(windows)]
fn apply_corner(window: &WebviewWindow, preference: &str, warnings: &mut Vec<String>) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    let value: u32 = match preference {
        "square" => 1,
        "round" => 2,
        "small" => 3,
        _ => 0,
    };
    if let Ok(hwnd) = window.hwnd() {
        let hr = unsafe {
            DwmSetWindowAttribute(hwnd.0 as *mut _, 33, &value as *const _ as *const _, 4)
        };
        if hr < 0 {
            warnings.push("Window corner preferences require Windows 11; the system decoration remains active.".into());
        }
    }
}

#[cfg(not(windows))]
fn apply_corner(_window: &WebviewWindow, preference: &str, warnings: &mut Vec<String>) {
    if preference != "system" {
        warnings.push("This platform uses system window corners. Content rounding is applied by the renderer.".into());
    }
}

#[tauri::command]
fn apply_window(
    window: WebviewWindow,
    state: State<'_, HostState>,
    config: WindowConfig,
) -> Result<WindowApplyResult, String> {
    if windows::id(window.label()).is_none() {
        return Err("Window settings are only applied to the preview/runtime window".into());
    }
    let result = apply_config(&window, &config)?;
    if windows::is_child(window.label()) {
        state
            .child_configs
            .lock()
            .map_err(|e| e.to_string())?
            .insert(window.label().into(), config);
    } else {
        *state.preview_config.lock().map_err(|e| e.to_string())? = Some(config);
    }
    Ok(result)
}

#[tauri::command]
async fn open_preview(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    project: Value,
    generation: Option<u64>,
    window_id: Option<String>,
) -> Result<WindowApplyResult, String> {
    let lock = lifecycle(&state, window.label())?;
    let _guard = lock.lock().await;
    window
        .is_visible()
        .map_err(|_| "The designer window has already closed")?;
    project_work(&state, window.label(), generation, true)?;
    let preview_lock = if window.label() != "preview" {
        Some(lifecycle(&state, "preview")?)
    } else {
        None
    };
    let _preview_guard = match &preview_lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let parsed: Project = serde_json::from_value(project.clone()).map_err(|e| e.to_string())?;
    if let Some(id) = &window_id {
        if id != "main"
            && !parsed
                .windows
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|w| w.id == *id)
        {
            return Err(format!("Unknown preview window: {id}"));
        }
        *state
            .pending_window_open
            .lock()
            .map_err(|e| e.to_string())? = Some((parsed.id.clone(), parsed.revision, id.clone()));
    }
    let config: WindowConfig = serde_json::from_value(
        project
            .get("window")
            .cloned()
            .ok_or("Missing window settings")?,
    )
    .map_err(|e| e.to_string())?;
    *state.preview.lock().map_err(|e| e.to_string())? = Some(project.clone());
    let existing = app.get_webview_window("preview");
    let is_new = existing.is_none();
    if is_new {
        *state.preview_config.lock().map_err(|e| e.to_string())? = None;
        *state.committed_preview.lock().map_err(|e| e.to_string())? = None;
        *state
            .applied_window_state
            .lock()
            .map_err(|e| e.to_string())? = None;
        invalidate_project(&state, "preview")?;
    }
    let window = match existing {
        Some(window) => window,
        None => WebviewWindowBuilder::new(
            &app,
            "preview",
            WebviewUrl::App("index.html?preview=1".into()),
        )
        .title(&config.title)
        .inner_size(config.width, config.height)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?,
    };
    let result = if is_new {
        state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .insert("preview".into(), parsed.id.clone());
        let result = apply_config(&window, &config)?;
        *state.preview_config.lock().map_err(|e| e.to_string())? = Some(config);
        result
    } else {
        WindowApplyResult {
            warnings: Vec::new(),
        }
    };
    windows::emit_project(&window, &project)?;
    window.show().map_err(|e| e.to_string())?;
    if is_new || window_id.as_deref() == Some("main") {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(id) = window_id {
        if let Ok(active) = session(&state, "preview") {
            if active.project_id == parsed.id
                && active.revision == parsed.revision
                && !active.cancellation.is_cancelled()
            {
                let mut engine = active.engine.lock().await;
                if engine.project().id == parsed.id && engine.project().revision == parsed.revision
                {
                    engine.window_action("open", &id)?;
                    state
                        .pending_window_open
                        .lock()
                        .map_err(|e| e.to_string())?
                        .take();
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn get_preview_project(
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<Value, String> {
    if windows::is_child(window.label()) {
        return state
            .committed_preview
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "The shared HMI runtime is not ready".into());
    }
    state
        .preview
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "No preview project has been loaded".into())
}

#[tauri::command]
fn close_preview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("preview") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn save_project(
    app: tauri::AppHandle,
    project: Value,
    path: Option<String>,
) -> Result<Option<String>, String> {
    let parsed: Project = serde_json::from_value(project.clone()).map_err(|e| e.to_string())?;
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => match app
            .dialog()
            .file()
            .add_filter("QuickGUI project", &["qgui", "json"])
            .set_file_name(project_file::suggested_filename(&parsed.name))
            .blocking_save_file()
        {
            Some(path) => path.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    project_file::save(&path, &project)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn load_project(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<Option<Value>, String> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => match app
            .dialog()
            .file()
            .add_filter("QuickGUI project", &["qgui", "json"])
            .blocking_pick_file()
        {
            Some(path) => path.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 30_000_000 {
        return Err("Project exceeds the 30 MB import limit".into());
    }
    let project = project_file::decode(&fs::read(path).map_err(|e| e.to_string())?)?;
    let _: Project = serde_json::from_value(project.clone()).map_err(|e| e.to_string())?;
    Ok(Some(project))
}

#[tauri::command]
async fn export_source(
    app: tauri::AppHandle,
    project: Value,
    output_dir: Option<String>,
) -> Result<Option<String>, String> {
    let dir = match output_dir {
        Some(dir) => PathBuf::from(dir),
        None => match app.dialog().file().blocking_pick_folder() {
            Some(path) => path
                .into_path()
                .map_err(|e| e.to_string())?
                .join("quickgui-export"),
            None => return Ok(None),
        },
    };
    source_export::export(&project, &dir)?;
    Ok(Some(dir.to_string_lossy().into_owned()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(HostState::default())
        .invoke_handler(tauri::generate_handler![
            execute_c,
            validate_c,
            project_generation,
            close_project,
            test_connection,
            runtime_start,
            runtime_attach,
            runtime_window_action,
            runtime_run_flow,
            runtime_set_variable,
            runtime_snapshot,
            runtime_stop,
            open_preview,
            close_preview,
            get_preview_project,
            apply_window,
            save_project,
            load_project,
            export_source,
            build_runtime::build_runtime,
            build_runtime::cancel_build,
            history::query_history,
            history::query_alarms,
            history::ack_alarm
        ])
        .on_window_event(|window, event| {
            let state = window.state::<HostState>();
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let label = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    if windows::is_child(&label) {
                        if let Err(error) = windows::close_child(app.clone(), label.clone()).await {
                            if let Some(window) = app.get_webview_window(&label) {
                                let _ = window.emit("storage-error", error);
                            }
                        }
                        return;
                    }
                    let state = app.state::<HostState>();
                    let destroy_app = app.clone();
                    let result = close_project_state(&state, label.clone(), move || {
                        for (label, view) in destroy_app.webview_windows() {
                            if windows::is_child(&label) {
                                windows::destroy_view(&view)?;
                            }
                        }
                        if let Some(primary) = destroy_app.get_webview_window("preview") {
                            windows::destroy_view(&primary)?;
                        }
                        Ok(())
                    })
                    .await;
                    match result {
                        Ok(_) => {
                            if let Some(window) = app.get_webview_window(&label) {
                                let _ = windows::destroy_view(&window);
                            }
                        }
                        Err(error) => {
                            if let Some(window) = app.get_webview_window(&label) {
                                let _ = window.emit("storage-error", error);
                            }
                        }
                    }
                });
            }
            if let tauri::WindowEvent::Moved(position) = event {
                let config = if windows::is_child(window.label()) {
                    state
                        .child_configs
                        .lock()
                        .ok()
                        .and_then(|values| values.get(window.label()).cloned())
                } else {
                    state
                        .preview_config
                        .lock()
                        .ok()
                        .and_then(|value| value.clone())
                };
                if windows::id(window.label()).is_some()
                    && config.is_some_and(|config| config.remember_position)
                    && !window.is_maximized().unwrap_or(false)
                    && !window.is_fullscreen().unwrap_or(false)
                {
                    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                        if let Some(path) = windows::position_path(&webview) {
                            if let Some(parent) = path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::write(path, format!("[{},{}]", position.x, position.y));
                        }
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if !windows::destroyed_lease_current(&state, window.label()) {
                    return;
                }
                let _ = invalidate_project(&state, window.label());
                if let Ok(mut configs) = state.child_configs.lock() {
                    configs.remove(window.label());
                }
                if let Ok(mut projects) = state.window_projects.lock() {
                    projects.remove(window.label());
                }
                if matches!(window.label(), "main" | "preview") {
                    if let Ok(mut applied) = state.applied_window_state.lock() {
                        *applied = None;
                    }
                    if let Ok(mut ticket) = state.window_sync_ticket.lock() {
                        *ticket = None;
                    }
                    let _ = invalidate_project(&state, "preview");
                    for (label, child) in window.app_handle().webview_windows() {
                        if windows::is_child(&label) {
                            let _ = invalidate_project(&state, &label);
                            let _ = windows::destroy_view(&child);
                        }
                    }
                    if window.label() == "main" {
                        if let Some(primary) = window.app_handle().get_webview_window("preview") {
                            let _ = windows::destroy_view(&primary);
                        }
                    }
                }
                if window.label() == "preview" {
                    if let Some(designer) = window.app_handle().get_webview_window("main") {
                        let _ = designer.emit("preview-closed", ());
                    }
                }
                if let Ok(mut sessions) = state.sessions.lock() {
                    if let Some(session) = sessions.remove(window.label()) {
                        session.cancellation.cancel();
                    }
                }
                if let Ok(builds) = state.builds.lock() {
                    if let Some(token) = builds.get(window.label()) {
                        token.cancel();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to launch QuickGUI native host");
}

#[cfg(test)]
mod close_project_tests;

#[cfg(test)]
mod window_tests {
    use super::*;
    #[test]
    fn remembered_windows_are_clamped_to_the_monitor_work_area() {
        assert_eq!(
            clamp_position([99999, -99999], [800, 600], [0, 24], [1920, 1056]),
            [1120, 24]
        );
        assert_eq!(
            clamp_position([-1600, 100], [800, 600], [-1920, 0], [1920, 1080]),
            [-1600, 100]
        );
        assert_eq!(
            clamp_position([50, 50], [2000, 1400], [0, 24], [1920, 1056]),
            [0, 24]
        );
        assert!(parse_color("#中文").is_none());
    }
}
