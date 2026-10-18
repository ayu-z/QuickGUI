use crate::Session;
use quickgui_engine::{Project, ScriptHost};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub struct EventSource {
    flow: String,
    node: String,
    interval: Option<Duration>,
}

pub fn sources(project: &Project) -> Result<Vec<EventSource>, String> {
    let mut result = Vec::new();
    for flow in project.flows.iter().filter(|flow| flow.enabled) {
        for node in flow.nodes.iter().filter(|node| node.kind == "event") {
            let trigger = node
                .config
                .get("trigger")
                .and_then(Value::as_str)
                .unwrap_or("manual");
            let interval = match trigger {
                "startup" => None,
                "interval" => {
                    let ms = node
                        .config
                        .get("intervalMs")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| format!("{}: intervalMs must be an integer", node.label))?;
                    if !(100..=86_400_000).contains(&ms) {
                        return Err(format!(
                            "{}: intervalMs must be between 100 and 86400000",
                            node.label
                        ));
                    }
                    Some(Duration::from_millis(ms))
                }
                _ => continue,
            };
            result.push(EventSource {
                flow: flow.id.clone(),
                node: node.id.clone(),
                interval,
            });
        }
    }
    Ok(result)
}

pub fn start(session: Session, sources: Vec<EventSource>, runner: Option<PathBuf>) {
    for source in sources {
        let session = session.clone();
        let runner = runner.clone();
        tauri::async_runtime::spawn(async move {
            let host = runner.map(ScriptHost::new);
            match source.interval {
                None => {
                    let mut engine = tokio::select! {
                        _ = session.cancellation.cancelled() => return,
                        engine = session.engine.lock() => engine,
                    };
                    if session.cancellation.is_cancelled() {
                        return;
                    }
                    if !session
                        .booted
                        .lock()
                        .map(|mut set| set.insert((source.flow.clone(), source.node.clone())))
                        .unwrap_or(false)
                    {
                        return;
                    }
                    // Errors are recorded by Engine and delivered through the snapshot observer.
                    let _ = engine
                        .run_event(
                            &source.flow,
                            &source.node,
                            Value::Null,
                            session.cancellation.child_token(),
                            host.as_ref(),
                        )
                        .await;
                }
                Some(period) => {
                    let mut interval =
                        tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        tokio::select! {
                            _ = session.cancellation.cancelled() => break,
                            _ = interval.tick() => {
                                // A busy runtime skips this sample instead of accumulating an unbounded backlog.
                                if let Ok(mut engine) = session.engine.try_lock() {
                                    let _ = engine.run_event(&source.flow, &source.node, Value::Null, session.cancellation.child_token(), host.as_ref()).await;
                                }
                            }
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quickgui_engine::{CancellationToken, Engine};
    use serde_json::json;
    use std::sync::Arc;

    fn project(trigger: &str, period: u64) -> Project {
        serde_json::from_value(json!({
            "schemaVersion":1,"id":"timers","name":"Timers","revision":1,"locale":"en",
            "theme":{},"window":{"title":"Timers","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"publish":{},
            "variables":[{"id":"v","name":"count","type":"number","initial":0}],
            "flows":[{"id":"f","name":"Counter","enabled":true,"nodes":[
                {"id":"start","kind":"event","label":"Clock","config":{"trigger":trigger,"intervalMs":period}},
                {"id":"read","kind":"read","label":"Read","config":{"variable":"v"}},
                {"id":"add","kind":"math","label":"Increment","config":{"operation":"add","operand":1}},
                {"id":"write","kind":"write","label":"Write","config":{"variable":"v"}}
            ],"edges":[{"id":"a","source":"start","target":"read"},{"id":"b","source":"read","target":"add"},{"id":"c","source":"add","target":"write"}]}]
        })).unwrap()
    }

    #[tokio::test]
    async fn interval_sources_run_without_a_webview_and_stop_on_cancellation() {
        let project = project("interval", 100);
        let sources = sources(&project).unwrap();
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(Engine::new(project).unwrap())),
            cancellation: CancellationToken::new(),
            booted: Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new())),
            project_id: "timers".into(),
            history: None,
            epoch: 0,
            revision: 1,
        };
        start(session.clone(), sources, None);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if session.engine.lock().await.snapshot().values["v"]
                    .value
                    .as_f64()
                    .unwrap()
                    >= 2.0
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("native timer should produce events");
        session.cancellation.cancel();
        let value = session.engine.lock().await.snapshot().values["v"]
            .value
            .clone();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            session.engine.lock().await.snapshot().values["v"].value,
            value
        );
    }

    #[test]
    fn invalid_intervals_are_rejected_before_replacing_a_session() {
        assert!(sources(&project("interval", 99)).is_err());
        assert!(sources(&project("interval", 100)).is_ok());
        assert_eq!(sources(&project("manual", 0)).unwrap().len(), 0);
        assert!(sources(&project("startup", 0)).unwrap()[0]
            .interval
            .is_none());
    }

    #[tokio::test]
    async fn startup_is_not_repeated_when_a_project_revision_reuses_the_session() {
        let mut project = project("startup", 0);
        let session = Session {
            engine: Arc::new(tokio::sync::Mutex::new(
                Engine::new(project.clone()).unwrap(),
            )),
            cancellation: CancellationToken::new(),
            booted: Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new())),
            project_id: "timers".into(),
            history: None,
            epoch: 0,
            revision: 1,
        };
        start(session.clone(), sources(&project).unwrap(), None);
        tokio::time::timeout(Duration::from_secs(3), async {
            while session.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64()
                .unwrap()
                < 1.0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        session.cancellation.cancel();
        project.revision += 1;
        session
            .engine
            .lock()
            .await
            .apply_project(project.clone())
            .unwrap();
        let next = Session {
            engine: session.engine.clone(),
            cancellation: CancellationToken::new(),
            booted: session.booted.clone(),
            project_id: "timers".into(),
            history: None,
            epoch: 1,
            revision: 2,
        };
        start(next.clone(), sources(&project).unwrap(), None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            next.engine.lock().await.snapshot().values["v"]
                .value
                .as_f64(),
            Some(1.0)
        );
        next.cancellation.cancel();
    }
}
