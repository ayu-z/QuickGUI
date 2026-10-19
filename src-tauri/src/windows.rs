use super::*;
use quickgui_engine::RuntimeWindowState;

pub(crate) const CHILD_PREFIX: &str = "preview__";
pub(crate) fn is_child(label: &str) -> bool {
    label.starts_with(CHILD_PREFIX)
}
pub(crate) fn owner(label: &str) -> &str {
    if is_child(label) {
        "preview"
    } else {
        label
    }
}
pub(crate) fn label(id: &str) -> String {
    if id == "main" {
        "preview".into()
    } else {
        format!("{CHILD_PREFIX}{id}")
    }
}
pub(crate) fn id(label: &str) -> Option<&str> {
    if label == "preview" {
        Some("main")
    } else {
        label.strip_prefix(CHILD_PREFIX)
    }
}
pub(crate) fn needs_replacement(has_native: bool, lease: Option<&ProjectWork>) -> bool {
    has_native && lease.is_none_or(|p| p.closed)
}
fn hold_closed_view(closing_revision: Option<u64>, desired: &RuntimeWindowState, id: &str) -> bool {
    closing_revision.is_some_and(|revision| desired.revision <= revision || desired.focused != id)
}
pub(crate) fn closed_lease_matches(state: &HostState, label: &str, generation: u64) -> bool {
    state
        .projects
        .lock()
        .ok()
        .and_then(|p| p.get(label).cloned())
        .is_some_and(|p| p.closed && p.generation == generation)
}
pub(crate) fn destroy_view(window: &WebviewWindow) -> Result<(), String> {
    let state = window.state::<HostState>();
    let generation = state
        .projects
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .map(|p| p.generation)
        .unwrap_or(0);
    {
        let mut retiring = state.retiring_windows.lock().map_err(|e| e.to_string())?;
        let queue = retiring.entry(window.label().into()).or_default();
        if !queue.contains(&generation) {
            queue.push_back(generation);
        }
    }
    window.destroy().map_err(|e| e.to_string())
}
pub(crate) fn destroyed_lease_current(state: &HostState, label: &str) -> bool {
    let retired = state.retiring_windows.lock().ok().and_then(|mut values| {
        let queue = values.get_mut(label)?;
        let generation = queue.pop_front();
        if queue.is_empty() {
            values.remove(label);
        }
        generation
    });
    retired.is_none_or(|generation| {
        state
            .projects
            .lock()
            .ok()
            .and_then(|p| p.get(label).map(|p| p.generation))
            .unwrap_or(0)
            == generation
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SyncTicket {
    pub epoch: u64,
    pub generation: u64,
    pub project_revision: u64,
    pub window_revision: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WindowPlan {
    pub open: Vec<String>,
    pub close: Vec<String>,
    pub focus: Option<String>,
}
pub(crate) fn plan(desired: &RuntimeWindowState, existing: &BTreeSet<String>) -> WindowPlan {
    let wanted: BTreeSet<_> = desired
        .open
        .iter()
        .filter(|id| id.as_str() != "main")
        .cloned()
        .collect();
    WindowPlan {
        open: wanted.difference(existing).cloned().collect(),
        close: existing.difference(&wanted).cloned().collect(),
        focus: desired
            .open
            .contains(&desired.focused)
            .then(|| desired.focused.clone()),
    }
}
pub(crate) fn group_labels(state: &HostState, owner_label: &str) -> Result<Vec<String>, String> {
    let mut labels = BTreeSet::from([owner_label.to_owned()]);
    if owner_label == "main" {
        labels.insert("preview".into());
    }
    if matches!(owner_label, "main" | "preview") {
        labels.extend(
            state
                .projects
                .lock()
                .map_err(|e| e.to_string())?
                .keys()
                .filter(|label| is_child(label))
                .cloned(),
        );
        labels.extend(
            state
                .window_projects
                .lock()
                .map_err(|e| e.to_string())?
                .keys()
                .filter(|label| is_child(label))
                .cloned(),
        );
    }
    Ok(labels.into_iter().collect())
}
pub(crate) fn current(state: &HostState, ticket: &SyncTicket) -> bool {
    state
        .window_sync_ticket
        .lock()
        .ok()
        .is_some_and(|current| current.as_ref() == Some(ticket))
        && state
            .projects
            .lock()
            .ok()
            .and_then(|p| p.get("preview").cloned())
            .is_some_and(|p| p.generation == ticket.generation && !p.closed)
        && session(state, "preview")
            .is_ok_and(|s| s.epoch == ticket.epoch && s.revision == ticket.project_revision)
}
pub(crate) fn broadcast_snapshot(
    app: &tauri::AppHandle,
    owner_label: &str,
    snapshot: &RuntimeSnapshot,
) {
    remember_snapshot(app, owner_label, snapshot);
    publish_snapshot(app, owner_label, snapshot);
}
pub(crate) fn remember_snapshot(
    app: &tauri::AppHandle,
    owner_label: &str,
    snapshot: &RuntimeSnapshot,
) {
    let state = app.state::<HostState>();
    if let Ok(mut snapshots) = state.latest_snapshots.lock() {
        snapshots.insert(owner_label.into(), snapshot.clone());
    };
}
pub(crate) fn publish_snapshot(
    app: &tauri::AppHandle,
    owner_label: &str,
    snapshot: &RuntimeSnapshot,
) {
    let state = app.state::<HostState>();
    for (label, window) in app.webview_windows() {
        if owner(&label) != owner_label {
            continue;
        }
        if let Some(work) = state
            .projects
            .lock()
            .ok()
            .and_then(|p| p.get(&label).cloned())
            .filter(|p| !p.closed)
        {
            let _ = emit_snapshot(&window, snapshot, work.generation);
        }
    }
}
pub(crate) fn broadcast_event<T: Serialize + Clone>(
    app: &tauri::AppHandle,
    owner_label: &str,
    event: &str,
    payload: T,
) {
    for (label, window) in app.webview_windows() {
        if owner(&label) == owner_label {
            let _ = window.emit(event, payload.clone());
        }
    }
}
pub(crate) fn emit_project(window: &WebviewWindow, project: &Value) -> Result<(), String> {
    let state = window.state::<HostState>();
    let generation = state
        .projects
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .map(|p| p.generation)
        .unwrap_or(0);
    window
        .emit(
            "project-updated",
            serde_json::json!({"project":project,"projectGeneration":generation}),
        )
        .map_err(|e| e.to_string())
}
pub(crate) fn queue_sync(
    app: tauri::AppHandle,
    project: Arc<Project>,
    snapshot: &RuntimeSnapshot,
    epoch: u64,
    generation: u64,
) {
    let ticket = SyncTicket {
        epoch,
        generation,
        project_revision: project.revision,
        window_revision: snapshot.window_state.revision,
    };
    {
        let state = app.state::<HostState>();
        if let Ok(mut closing) = state.closing_windows.lock() {
            closing.retain(|label, _| {
                id(label).is_some_and(|id| snapshot.window_state.open.iter().any(|open| open == id))
            });
        }
        let Ok(mut previous) = state.window_sync_ticket.lock() else {
            return;
        };
        if previous.as_ref() == Some(&ticket) {
            return;
        }
        *previous = Some(ticket.clone());
    }
    let desired = snapshot.window_state.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<HostState>();
        let Ok(lock) = lifecycle(&state, "preview") else {
            return;
        };
        let _guard = lock.lock().await;
        if !current(&state, &ticket) {
            return;
        }
        if let Err(error) = sync(&app, &state, &project, &desired, &ticket).await {
            broadcast_event(
                &app,
                "preview",
                "storage-error",
                format!("Window synchronization failed: {error}"),
            );
            if let Ok(mut previous) = state.window_sync_ticket.lock() {
                if previous.as_ref() == Some(&ticket) {
                    *previous = None;
                }
            }
        }
    });
}
async fn sync(
    app: &tauri::AppHandle,
    state: &HostState,
    project: &Project,
    desired: &RuntimeWindowState,
    ticket: &SyncTicket,
) -> Result<(), String> {
    let existing: BTreeSet<String> = app
        .webview_windows()
        .keys()
        .filter_map(|label| label.strip_prefix(CHILD_PREFIX).map(str::to_owned))
        .collect();
    let operations = plan(desired, &existing);
    for id in &operations.close {
        if !current(state, ticket) {
            return Ok(());
        }
        let label = label(id);
        let retired = invalidate_project(state, &label)?;
        wait_for_work(&retired).await?;
        if let Some(window) = app.get_webview_window(&label) {
            destroy_view(&window)?;
        }
        state
            .child_configs
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&label);
        state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&label);
    }
    let runtime = app.get_webview_window("main").is_none();
    for id in desired.open.iter().filter(|id| id.as_str() != "main") {
        if !current(state, ticket) {
            return Ok(());
        }
        let definition = project
            .windows
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|window| window.id == *id)
            .ok_or_else(|| format!("Unknown runtime window: {id}"))?;
        let label = label(id);
        let config: WindowConfig = serde_json::from_value(
            serde_json::to_value(&definition.config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if hold_closed_view(
            state
                .closing_windows
                .lock()
                .map_err(|e| e.to_string())?
                .get(&label)
                .copied(),
            desired,
            id,
        ) {
            continue;
        }
        let lease = state
            .projects
            .lock()
            .map_err(|e| e.to_string())?
            .get(&label)
            .cloned();
        if needs_replacement(app.get_webview_window(&label).is_some(), lease.as_ref()) {
            if let Some(retired) = lease {
                wait_for_work(&retired).await?;
            }
            if !current(state, ticket) {
                return Ok(());
            }
            if let Some(previous) = app.get_webview_window(&label) {
                destroy_view(&previous)?;
            }
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while app.get_webview_window(&label).is_some() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "Previous child window is still closing")?;
            if !current(state, ticket) {
                return Ok(());
            }
            state
                .child_configs
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
        }
        let window = if let Some(existing) = app.get_webview_window(&label) {
            existing
        } else {
            invalidate_project(state, &label)?;
            state
                .closing_windows
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
            state
                .projects
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&label)
                .ok_or("Missing view generation")?
                .closed = false;
            state
                .window_projects
                .lock()
                .map_err(|e| e.to_string())?
                .insert(label.clone(), project.id.clone());
            let url = format!(
                "index.html?{}=1&windowId={}",
                if runtime { "runtime" } else { "preview" },
                id
            );
            match WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
                .title(&config.title)
                .inner_size(config.width, config.height)
                .decorations(true)
                .focused(false)
                .build()
            {
                Ok(window) => window,
                Err(error) => {
                    invalidate_project(state, &label)?;
                    state
                        .window_projects
                        .lock()
                        .map_err(|e| e.to_string())?
                        .remove(&label);
                    return Err(error.to_string());
                }
            }
        };
        if !current(state, ticket) {
            let _ = destroy_view(&window);
            return Ok(());
        }
        state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.clone(), project.id.clone());
        apply_config(&window, &config)?;
        state
            .child_configs
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label, config);
        window.show().map_err(|e| e.to_string())?;
    }
    if let Some(primary) = app.get_webview_window("preview") {
        state
            .window_projects
            .lock()
            .map_err(|e| e.to_string())?
            .insert("preview".into(), project.id.clone());
        let config: WindowConfig = serde_json::from_value(
            serde_json::to_value(&project.window).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        apply_config(&primary, &config)?;
        *state.preview_config.lock().map_err(|e| e.to_string())? = Some(config);
    }
    if current(state, ticket) {
        let should_focus = state
            .applied_window_state
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            != Some(&(project.id.clone(), desired.revision));
        if should_focus {
            if let Some(id) = operations.focus {
                if let Some(window) = app.get_webview_window(&label(&id)) {
                    let _ = window.set_focus();
                }
            }
        }
        *state
            .applied_window_state
            .lock()
            .map_err(|e| e.to_string())? = Some((project.id.clone(), desired.revision));
    }
    Ok(())
}
pub(crate) fn position_path(window: &WebviewWindow) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let state = window.state::<HostState>();
    let project = state
        .window_projects
        .lock()
        .ok()?
        .get(window.label())?
        .clone();
    let id = id(window.label())?;
    let key = format!("{:x}", Sha256::digest(project.as_bytes()));
    Some(
        window
            .app_handle()
            .path()
            .app_data_dir()
            .ok()?
            .join("window-positions")
            .join(key)
            .join(format!("{id}.json")),
    )
}

pub(crate) async fn close_child(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let state = app.state::<HostState>();
    let revision = state
        .latest_snapshots
        .lock()
        .map_err(|e| e.to_string())?
        .get("preview")
        .map(|snapshot| snapshot.window_state.revision)
        .unwrap_or(0);
    state
        .closing_windows
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), revision);
    let retired = invalidate_project(&state, &label)?;
    let generation = state
        .projects
        .lock()
        .map_err(|e| e.to_string())?
        .get(&label)
        .ok_or("Missing child generation")?
        .generation;
    if let Ok(active) = session(&state, &label) {
        let mut engine = active.engine.lock().await;
        let still_this_view = closed_lease_matches(&state, &label, generation);
        let same_project =
            session(&state, "preview").is_ok_and(|current| current.project_id == active.project_id);
        if still_this_view && same_project {
            if let Some(id) = id(&label) {
                let _ = engine.window_action("close", id);
            }
        }
    }
    wait_for_work(&retired).await?;
    if closed_lease_matches(&state, &label, generation) {
        if let Some(window) = app.get_webview_window(&label) {
            destroy_view(&window)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_keeps_designer_separate_and_shares_all_hmi_views() {
        assert_eq!(owner("main"), "main");
        assert_eq!(owner("preview"), "preview");
        assert_eq!(owner("preview__alarms"), "preview");
        assert_eq!(label("main"), "preview");
        assert_eq!(id("preview__alarms"), Some("alarms"));
    }
    #[test]
    fn window_plan_never_closes_primary_and_obeys_latest_open_state() {
        let state = RuntimeWindowState {
            open: vec!["main".into(), "alarms".into()],
            focused: "alarms".into(),
            revision: 2,
        };
        let p = plan(&state, &BTreeSet::from(["old".into()]));
        assert_eq!(p.open, vec!["alarms"]);
        assert_eq!(p.close, vec!["old"]);
        assert_eq!(p.focus, Some("alarms".into()));
    }
    #[test]
    fn invalidated_generation_prevents_queued_window_sync() {
        let state = HostState::default();
        let active = crate::close_project_tests::install_session(
            &state,
            "preview",
            crate::close_project_tests::project("windows"),
            None,
        );
        state
            .projects
            .lock()
            .unwrap()
            .insert("preview".into(), ProjectWork::default());
        let ticket = SyncTicket {
            epoch: active.epoch,
            generation: 0,
            project_revision: 1,
            window_revision: 1,
        };
        *state.window_sync_ticket.lock().unwrap() = Some(ticket.clone());
        assert!(current(&state, &ticket));
        let mut newer = ticket.clone();
        newer.window_revision += 1;
        *state.window_sync_ticket.lock().unwrap() = Some(newer.clone());
        assert!(!current(&state, &ticket));
        assert!(current(&state, &newer));
        invalidate_project(&state, "preview").unwrap();
        assert!(!current(&state, &ticket));
    }
    #[tokio::test]
    async fn child_views_share_state_but_retiring_one_does_not_stop_owner() {
        let state = HostState::default();
        let p = crate::close_project_tests::project("shared");
        let primary =
            crate::close_project_tests::install_session(&state, "preview", p.clone(), None);
        let designer = crate::close_project_tests::install_session(&state, "main", p, None);
        for label in ["preview", "preview__a", "preview__b"] {
            state
                .projects
                .lock()
                .unwrap()
                .insert(label.into(), ProjectWork::default());
        }
        let a = session(&state, "preview__a").unwrap();
        let b = session(&state, "preview__b").unwrap();
        assert!(Arc::ptr_eq(&a.engine, &primary.engine) && Arc::ptr_eq(&a.engine, &b.engine));
        a.engine
            .lock()
            .await
            .set_variable("value", serde_json::json!(99))
            .unwrap();
        assert_eq!(
            b.engine.lock().await.snapshot().values["value"].value,
            serde_json::json!(99)
        );
        assert_eq!(
            designer.engine.lock().await.snapshot().values["value"].value,
            serde_json::json!(42)
        );
        let work = begin_work(&state, "preview__a", Some(0)).unwrap();
        invalidate_project(&state, "preview__a").unwrap();
        assert!(work.cancellation.is_cancelled());
        assert!(!primary.cancellation.is_cancelled());
        assert!(project_work(&state, "preview__a", Some(0), true).is_err());
        assert!(project_work(&state, "preview__b", Some(0), false).is_ok());
    }
    #[test]
    fn reopening_replaces_closed_lease_and_old_destroy_cannot_invalidate_new_view() {
        let state = HostState::default();
        let label = "preview__alarms";
        state
            .projects
            .lock()
            .unwrap()
            .insert(label.into(), ProjectWork::default());
        invalidate_project(&state, label).unwrap();
        let old = state.projects.lock().unwrap().get(label).unwrap().clone();
        assert!(needs_replacement(true, Some(&old)));
        assert!(closed_lease_matches(&state, label, old.generation));
        state
            .retiring_windows
            .lock()
            .unwrap()
            .insert(label.into(), VecDeque::from([old.generation]));
        invalidate_project(&state, label).unwrap();
        state
            .projects
            .lock()
            .unwrap()
            .get_mut(label)
            .unwrap()
            .closed = false;
        assert!(!destroyed_lease_current(&state, label));
        assert!(!closed_lease_matches(&state, label, old.generation));
        assert!(!needs_replacement(
            true,
            state.projects.lock().unwrap().get(label)
        ));
        assert!(project_work(&state, label, Some(old.generation), false).is_err());
    }
    #[test]
    fn old_open_snapshot_cannot_reopen_a_view_waiting_for_its_close_action() {
        let mut desired = RuntimeWindowState {
            open: vec!["main".into(), "alarms".into()],
            focused: "alarms".into(),
            revision: 5,
        };
        assert!(hold_closed_view(Some(5), &desired, "alarms"));
        desired.revision = 6;
        desired.focused = "main".into();
        assert!(hold_closed_view(Some(5), &desired, "alarms"));
        desired.focused = "alarms".into();
        assert!(!hold_closed_view(Some(5), &desired, "alarms"));
    }
}
