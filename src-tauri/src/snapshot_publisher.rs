//! Bounded publication of UI snapshots, independent of runtime event delivery.
use crate::{session, HostState};
use quickgui_engine::RuntimeSnapshot;
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;

pub(crate) struct Publisher<T> {
    sender: watch::Sender<Option<Arc<T>>>,
}

impl<T: Send + Sync + 'static> Publisher<T> {
    pub(crate) fn new(period: Duration, publish: impl Fn(Arc<T>) + Send + Sync + 'static) -> Self {
        let (sender, mut receiver) = watch::channel::<Option<Arc<T>>>(None);
        let publish = Arc::new(publish);
        tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                let latest = receiver.borrow_and_update().clone();
                if let Some(latest) = latest {
                    let publish = publish.clone();
                    // WebView serialization/emission can block. Neither the Engine
                    // mutex nor an async IO worker should execute that work.
                    if tokio::task::spawn_blocking(move || publish(latest))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // One in flight plus one latest snapshot; a busy or slow WebView
                // cannot create an unbounded backlog. The final value still drains
                // when the producer closes, even if no further update arrives.
                tokio::time::sleep(period).await;
            }
        });
        Self { sender }
    }

    pub(crate) fn submit(&self, value: T) {
        self.sender.send_replace(Some(Arc::new(value)));
    }
}

pub(crate) fn current(
    state: &HostState,
    owner: &str,
    epoch: u64,
    generation: u64,
    snapshot: &RuntimeSnapshot,
) -> bool {
    session(state, owner).is_ok_and(|s| {
        s.epoch == epoch && s.revision == snapshot.revision && s.project_id == snapshot.project_id
    }) && state
        .projects
        .lock()
        .ok()
        .and_then(|p| p.get(owner).cloned())
        .is_some_and(|p| p.generation == generation && !p.closed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    struct Sample {
        sequence: usize,
        alive: Arc<AtomicUsize>,
    }
    impl Drop for Sample {
        fn drop(&mut self) {
            self.alive.fetch_sub(1, Ordering::AcqRel);
        }
    }

    #[tokio::test]
    async fn slow_publication_keeps_producers_running_bounds_memory_and_drains_the_final_value() {
        let (started, mut received) = tokio::sync::mpsc::unbounded_channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let blocked = Mutex::new(blocked);
        let publisher = Publisher::new(Duration::from_millis(16), move |sample: Arc<Sample>| {
            started.send(sample.sequence).unwrap();
            if sample.sequence == 0 {
                let _ = blocked.lock().unwrap().recv();
            }
        });
        let alive = Arc::new(AtomicUsize::new(0));
        let sample = |sequence| {
            alive.fetch_add(1, Ordering::AcqRel);
            Sample {
                sequence,
                alive: alive.clone(),
            }
        };
        publisher.submit(sample(0));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap(),
            Some(0)
        );
        // The first callback is blocked on another thread. This current-thread
        // Tokio runtime and all 1,000 submissions must remain able to progress.
        for sequence in 1..=1000 {
            publisher.submit(sample(sequence));
        }
        assert_eq!(alive.load(Ordering::Acquire), 2);
        drop(publisher);
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap(),
            Some(1000)
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap(),
            None
        );
        assert_eq!(alive.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn publication_checks_project_revision_epoch_and_generation_and_accepts_final_stop() {
        let state = HostState::default();
        state
            .projects
            .lock()
            .unwrap()
            .insert("main".into(), Default::default());
        let active = crate::close_project_tests::install_session(
            &state,
            "main",
            crate::close_project_tests::project("publication"),
            None,
        );
        let mut snapshot = active.engine.lock().await.snapshot();
        assert!(current(&state, "main", active.epoch, 0, &snapshot));
        assert!(!current(&state, "main", active.epoch + 1, 0, &snapshot));
        assert!(!current(&state, "main", active.epoch, 1, &snapshot));
        snapshot.revision += 1;
        assert!(!current(&state, "main", active.epoch, 0, &snapshot));
        snapshot.revision -= 1;
        snapshot.project_id = "another-project".into();
        assert!(!current(&state, "main", active.epoch, 0, &snapshot));
        snapshot.project_id = active.project_id.clone();
        active.cancellation.cancel();
        active.engine.lock().await.stop();
        snapshot = active.engine.lock().await.snapshot();
        assert!(!snapshot.running);
        assert!(current(&state, "main", active.epoch, 0, &snapshot));
        state
            .projects
            .lock()
            .unwrap()
            .get_mut("main")
            .unwrap()
            .closed = true;
        assert!(!current(&state, "main", active.epoch, 0, &snapshot));
    }
}
