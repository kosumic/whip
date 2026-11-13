//! Generation-scoped microphone authority. Expo events have no identity: an end
//! must be followed by two native idle observations before releasing or restarting.
mod state;

use parking_lot::Mutex;
use serde_json::json;
use state::{Command, State};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant};

#[uniffi::export(with_foreign)]
pub trait DictationLifecycleObserver: Send + Sync {
    fn changed(&self);
}

#[derive(uniffi::Object)]
pub struct DictationLifecycle {
    state: Mutex<State>,
    origin: Instant,
    observer: Mutex<Option<Arc<dyn DictationLifecycleObserver>>>,
    timer: Mutex<Option<tokio::task::AbortHandle>>,
}

impl Default for DictationLifecycle {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            origin: Instant::now(),
            observer: Mutex::default(),
            timer: Mutex::default(),
        }
    }
}

static LIFECYCLE: LazyLock<Arc<DictationLifecycle>> =
    LazyLock::new(|| Arc::new(DictationLifecycle::default()));

#[uniffi::export]
pub fn dictation_lifecycle() -> Arc<DictationLifecycle> {
    LIFECYCLE.clone()
}

#[uniffi::export]
impl DictationLifecycle {
    pub fn set_observer(&self, observer: Arc<dyn DictationLifecycleObserver>) {
        *self.observer.lock() = Some(observer);
    }

    /// Malformed input fails closed. IDs are strings across JS/FFI to avoid
    /// losing integer precision. Acknowledgements include session and cycle.
    pub fn dispatch(self: Arc<Self>, command: String) -> bool {
        let Ok(command) = serde_json::from_str::<Command>(&command) else {
            return false;
        };
        let accepted = self.state.lock().apply(command, self.now());
        self.arm();
        accepted
    }

    /// Drains effects exactly once, together with their authoritative view.
    pub fn take_update(&self) -> String {
        let mut state = self.state.lock();
        json!({ "view": state.view(), "effects": state.take_effects() }).to_string()
    }
}

impl DictationLifecycle {
    fn now(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn arm(self: &Arc<Self>) {
        let mut timer = self.timer.lock();
        if let Some(previous) = timer.take() {
            previous.abort();
        }
        let Some(deadline) = self.state.lock().deadline() else {
            return;
        };
        let Ok(runtime) = crate::runtime() else {
            return;
        };
        let weak: Weak<Self> = Arc::downgrade(self);
        let delay = Duration::from_millis(deadline.saturating_sub(self.now()));
        *timer = Some(
            runtime
                .spawn(async move {
                    tokio::time::sleep(delay).await;
                    if let Some(core) = weak.upgrade() {
                        core.state.lock().advance(core.now());
                        // Re-arm before notifying. Callbacks never run under state locks.
                        core.arm();
                        let observer = core.observer.lock().clone();
                        if let Some(observer) = observer {
                            let _ = tokio::task::spawn_blocking(move || observer.changed()).await;
                        }
                    }
                })
                .abort_handle(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Observer(mpsc::Sender<()>);
    impl DictationLifecycleObserver for Observer {
        fn changed(&self) {
            let _ = self.0.send(());
        }
    }

    #[test]
    fn native_deadline_notifies_adapter_without_js_polling() {
        let core = Arc::new(DictationLifecycle::default());
        let (sender, receiver) = mpsc::channel();
        core.set_observer(Arc::new(Observer(sender)));
        assert!(
            core.clone().dispatch(
                json!({ "kind": "begin", "config": {
            "owner": "composer", "draft": "", "android": true, "api": 36,
            "provider": "default", "localOnly": false, "managedCall": false,
            "duringPlayback": false, "nativeIngress": false
        } })
                .to_string()
            )
        );
        assert!(receiver.recv_timeout(Duration::from_secs(4)).is_ok());
        assert!(core.state.lock().deadline().is_some());
        assert!(
            core.clone()
                .dispatch(json!({ "kind": "cancel", "owner": "composer" }).to_string())
        );
        assert!(core.state.lock().deadline().is_none());
    }

    #[test]
    fn invalid_wire_commands_fail_closed() {
        let core = Arc::new(DictationLifecycle::default());
        assert!(!core.clone().dispatch("{}".into()));
        assert!(!core.clone().dispatch(r#"{"kind":"ack","id":"1"}"#.into()));
        assert!(core.state.lock().deadline().is_none());
    }
}
