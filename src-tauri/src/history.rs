use crate::{begin_work, project_work, session, HostState};
use quickgui_engine::{HistoryStore, Project, RuntimeSnapshot};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};

enum Message {
    Snapshot(
        Arc<Project>,
        RuntimeSnapshot,
        Option<oneshot::Sender<Result<(), String>>>,
    ),
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct Recorder {
    store: Arc<Mutex<HistoryStore>>,
    queue: mpsc::Sender<Message>,
    on_error: Arc<dyn Fn(String) + Send + Sync>,
    last_values: Arc<Mutex<Vec<u8>>>,
}

impl Recorder {
    pub async fn open(
        path: PathBuf,
        on_error: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let store = tauri::async_runtime::spawn_blocking(move || HistoryStore::open(path))
            .await
            .map_err(|e| e.to_string())??;
        let store = Arc::new(Mutex::new(store));
        let (queue, mut receiver) = mpsc::channel::<Message>(1024);
        let worker_store = store.clone();
        let report = on_error.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(message) = receiver.recv().await {
                match message {
                    Message::Snapshot(project, snapshot, completed) => {
                        let store = worker_store.clone();
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            store
                                .lock()
                                .map_err(|e| e.to_string())?
                                .record_snapshot(&project, &snapshot)
                        })
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|result| result);
                        if let Err(error) = &result {
                            report(error.clone());
                        }
                        if let Some(completed) = completed {
                            let _ = completed.send(result);
                        }
                    }
                    Message::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Ok(Self {
            store,
            queue,
            on_error,
            last_values: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn record(&self, project: Arc<Project>, snapshot: RuntimeSnapshot) {
        let fingerprint =
            serde_json::to_vec(&(project.revision, &snapshot.values, snapshot.logs.last()))
                .unwrap_or_default();
        let Ok(mut previous) = self.last_values.lock() else {
            return;
        };
        if *previous == fingerprint {
            return;
        }
        if let Err(error) = self
            .queue
            .try_send(Message::Snapshot(project, snapshot, None))
        {
            (self.on_error)(format!("History sample could not be queued: {error}"));
        } else {
            *previous = fingerprint;
        }
    }

    pub async fn record_and_flush(
        &self,
        project: Arc<Project>,
        snapshot: RuntimeSnapshot,
    ) -> Result<(), String> {
        let (completed, result) = oneshot::channel();
        self.queue
            .send(Message::Snapshot(project, snapshot, Some(completed)))
            .await
            .map_err(|e| e.to_string())?;
        // This acknowledgment is sent after the SQLite transaction actually succeeds or fails.
        result.await.map_err(|e| e.to_string())?
    }

    pub async fn flush(&self) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        self.queue
            .send(Message::Flush(sender))
            .await
            .map_err(|e| e.to_string())?;
        receiver.await.map_err(|e| e.to_string())
    }

    pub async fn restore(
        &self,
        project: Project,
    ) -> Result<std::collections::BTreeMap<String, Value>, String> {
        let store = self.store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            store
                .lock()
                .map_err(|e| e.to_string())?
                .restore_values(&project)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

fn recorder(state: &HostState, label: &str) -> Result<Recorder, String> {
    session(state, label)?
        .history
        .ok_or_else(|| "History storage has not been initialized".into())
}

#[tauri::command]
pub async fn query_history(
    window: WebviewWindow,
    state: State<'_, HostState>,
    variable_id: String,
    limit: Option<usize>,
    generation: Option<u64>,
) -> Result<Value, String> {
    project_work(&state, window.label(), generation, false)?;
    let _work = begin_work(&state, window.label(), generation)?;
    let recorder = recorder(&state, window.label())?;
    recorder.flush().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = recorder
            .store
            .lock()
            .map_err(|e| e.to_string())?
            .query_history(&variable_id, limit.unwrap_or(1000).clamp(1, 10000))?;
        serde_json::to_value(result).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn query_alarms(
    window: WebviewWindow,
    state: State<'_, HostState>,
    limit: Option<usize>,
    generation: Option<u64>,
) -> Result<Value, String> {
    project_work(&state, window.label(), generation, false)?;
    let _work = begin_work(&state, window.label(), generation)?;
    let recorder = recorder(&state, window.label())?;
    recorder.flush().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = recorder
            .store
            .lock()
            .map_err(|e| e.to_string())?
            .query_alarms(limit.unwrap_or(1000).clamp(1, 10000))?;
        serde_json::to_value(result).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ack_alarm(
    window: WebviewWindow,
    state: State<'_, HostState>,
    id: i64,
    generation: Option<u64>,
) -> Result<(), String> {
    project_work(&state, window.label(), generation, false)?;
    let _work = begin_work(&state, window.label(), generation)?;
    let recorder = recorder(&state, window.label())?;
    recorder.flush().await?;
    tauri::async_runtime::spawn_blocking(move || {
        recorder
            .store
            .lock()
            .map_err(|e| e.to_string())?
            .ack_alarm(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use quickgui_engine::Engine;
    use serde_json::json;

    #[tokio::test]
    async fn queued_snapshots_are_durable_before_restore_or_alarm_queries() {
        let project: Project = serde_json::from_value(json!({"schemaVersion":1,"id":"recording","name":"Recording","revision":1,"locale":"en","theme":{},"publish":{},"window":{"title":"Recording","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"v","name":"value","type":"number","initial":1,"persistent":true,"alarm":{"max":5}}]})).unwrap();
        let failures = Arc::new(Mutex::new(Vec::new()));
        let report = failures.clone();
        let recorder = Recorder::open(
            ":memory:".into(),
            Arc::new(move |error| {
                report.lock().unwrap().push(error);
            }),
        )
        .await
        .unwrap();
        let mut engine = Engine::new(project.clone()).unwrap();
        recorder.record(Arc::new(project.clone()), engine.snapshot());
        engine.set_variable("v", json!(10)).unwrap();
        recorder
            .record_and_flush(Arc::new(project.clone()), engine.snapshot())
            .await
            .unwrap();
        assert_eq!(recorder.restore(project).await.unwrap()["v"], json!(10));
        let alarms = recorder.store.lock().unwrap().query_alarms(10).unwrap();
        assert_eq!(alarms.len(), 1);
        assert!(alarms[0].active);
        assert!(failures.lock().unwrap().is_empty());
    }
}
