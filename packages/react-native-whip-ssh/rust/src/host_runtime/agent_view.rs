//! Follow the endpoint's server-computed agent order without rendering a shell.
//!
//! The generation-1 shell snapshot already applies Herdr's view and default sort.
//! Consuming its pane IDs avoids duplicating the agent-view query language.

use super::*;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;
use tokio::sync::oneshot;

use crate::herdr_codec::{self, ServerMessage};
use crate::herdr_connection::{HerdrStream, HerdrStreamFraming, HerdrStreamKind};
use crate::herdr_events::HerdrEventError;

const HELLO: &str = "endpoint.hello.v1";
const WELCOME: &str = "endpoint.welcome.v1";
const SNAPSHOT: &str = "shell.snapshot.v1";
const READY_TIMEOUT: Duration = Duration::from_secs(3);
static NEXT_FOLLOWER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
struct Welcome {
    generation: u32,
    snapshot_codec: String,
    capabilities: Vec<String>,
    error: Option<HandshakeError>,
}

#[derive(Debug, Deserialize)]
struct HandshakeError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct ShellSnapshot {
    boot_id: String,
    revision: u64,
    agent_order: Vec<String>,
}

pub(super) struct Follower {
    id: u64,
    runtime: Weak<RuntimeInner>,
    epoch: u64,
    generation: u64,
    stream: Mutex<Option<Arc<HerdrStream>>>,
    welcomed: AtomicBool,
    closed: AtomicBool,
    revision: Mutex<Option<(String, u64)>>,
    ready: Mutex<Option<oneshot::Sender<Result<(), HerdrEventError>>>>,
}

impl Follower {
    fn complete_ready(&self, result: Result<(), HerdrEventError>) {
        if let Some(sender) = self.ready.lock().take() {
            let _ = sender.send(result);
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.complete_ready(Err(unavailable("endpoint observer stopped".into())));
        if let Some(stream) = self.stream.lock().take() {
            let _ = stream.close();
        }
    }

    fn frame(&self, bytes: &[u8]) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let result = herdr_codec::decode(bytes, 22)
            .map_err(|error| error.to_string())
            .and_then(|message| self.message(message));
        if let Err(reason) = result {
            self.failed(reason);
        }
    }

    fn message(&self, message: ServerMessage) -> Result<(), String> {
        match message {
            ServerMessage::EndpointControl { kind, data } if kind == WELCOME => {
                let welcome: Welcome =
                    serde_json::from_str(&data).map_err(|error| error.to_string())?;
                if let Some(error) = welcome.error {
                    return Err(error.message);
                }
                if welcome.generation != 1
                    || welcome.snapshot_codec != SNAPSHOT
                    || !welcome
                        .capabilities
                        .iter()
                        .any(|capability| capability == "surface_interest")
                {
                    return Err(
                        "Herdr endpoint does not support non-rendering agent-view observation"
                            .into(),
                    );
                }
                self.welcomed.store(true, Ordering::Release);
                Ok(())
            }
            ServerMessage::EndpointControl { kind, data } if kind == SNAPSHOT => {
                if !self.welcomed.load(Ordering::Acquire) {
                    return Err("Herdr endpoint snapshot arrived before its welcome".into());
                }
                let snapshot: ShellSnapshot =
                    serde_json::from_str(&data).map_err(|error| error.to_string())?;
                if snapshot.boot_id.is_empty() {
                    return Err("Herdr endpoint snapshot has no boot identity".into());
                }
                if self.publish(snapshot) {
                    self.complete_ready(Ok(()));
                }
                Ok(())
            }
            ServerMessage::EndpointControl { kind, .. } if kind.starts_with("shell.snapshot.") => {
                Err(format!("unsupported Herdr endpoint snapshot codec {kind}"))
            }
            ServerMessage::Closed { reason } => {
                Err(reason.unwrap_or_else(|| "Herdr endpoint closed".into()))
            }
            ServerMessage::Welcome { error, .. } => Err(error.unwrap_or_else(|| {
                "Herdr returned a terminal welcome instead of an endpoint welcome".into()
            })),
            // Named view/completion controls and other shell presentation are not
            // needed: the server's agent_order is the complete filtered projection.
            _ => Ok(()),
        }
    }

    fn publish(&self, snapshot: ShellSnapshot) -> bool {
        let Some(inner) = self.runtime.upgrade() else {
            return false;
        };
        let follower = inner.agent_view.lock();
        if follower
            .as_ref()
            .is_none_or(|current| current.id != self.id)
        {
            return false;
        }
        let mut revision = self.revision.lock();
        if revision.as_ref().is_some_and(|(boot, previous)| {
            *boot == snapshot.boot_id && *previous >= snapshot.revision
        }) {
            return false;
        }
        let mut state = inner.state.lock();
        if state.epoch != self.epoch
            || state.generation != self.generation
            || state.connection != HostConnectionState::Connected
            || state.event.is_none()
        {
            return false;
        }
        let changed = state.agent_order.as_ref() != Some(&snapshot.agent_order);
        state.agent_order = Some(snapshot.agent_order);
        if changed {
            state.host_state.agent_view_changed();
        }
        *revision = Some((snapshot.boot_id, snapshot.revision));
        drop(state);
        drop(revision);
        drop(follower);
        if changed {
            emit_host_state(&inner);
        }
        true
    }

    fn failed(&self, reason: String) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.complete_ready(Err(unavailable(reason.clone())));
        if let Some(stream) = self.stream.lock().take() {
            let _ = stream.close();
        }
        let Some(inner) = self.runtime.upgrade() else {
            return;
        };
        let current = inner
            .agent_view
            .lock()
            .as_ref()
            .is_some_and(|current| current.id == self.id);
        let state = inner.state.lock();
        let active = current
            && state.epoch == self.epoch
            && state.generation == self.generation
            && state.connection == HostConnectionState::Connected
            && state.event.is_some();
        drop(state);
        if active {
            event_subscription_start_failed(inner, format!("agent view: {reason}"));
        }
    }
}

pub(super) async fn start(inner: Arc<RuntimeInner>, epoch: u64) -> Result<(), HerdrEventError> {
    let _start = inner.agent_view_start.lock().await;
    let (protocol, generation) = {
        let state = inner.state.lock();
        if state.epoch != epoch
            || state.connection != HostConnectionState::Connected
            || state.event.is_none()
        {
            return Err(unavailable("host subscription was replaced".into()));
        }
        (
            state
                .protocol
                .ok_or_else(|| unavailable("Herdr protocol is unknown".into()))?,
            state.generation,
        )
    };
    if protocol < 22 {
        stop(&inner);
        let changed = {
            let mut state = inner.state.lock();
            let changed = state.agent_order.take().is_some();
            if changed {
                state.host_state.agent_view_changed();
            }
            changed
        };
        if changed {
            emit_host_state(&inner);
        }
        return Ok(());
    }
    if inner.agent_view.lock().as_ref().is_some_and(|follower| {
        follower.epoch == epoch
            && follower.generation == generation
            && !follower.closed.load(Ordering::Acquire)
    }) {
        return Ok(());
    }
    stop(&inner);
    let (sender, ready) = oneshot::channel();
    let follower = Arc::new(Follower {
        id: NEXT_FOLLOWER_ID.fetch_add(1, Ordering::Relaxed),
        runtime: Arc::downgrade(&inner),
        epoch,
        generation,
        stream: Mutex::new(None),
        welcomed: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        revision: Mutex::new(None),
        ready: Mutex::new(Some(sender)),
    });
    *inner.agent_view.lock() = Some(follower.clone());
    let on_frame = Arc::downgrade(&follower);
    let on_close = Arc::downgrade(&follower);
    let opened = inner
        .herdr
        .open_stream(
            HerdrStreamKind::AgentView,
            HerdrStreamFraming::LengthPrefixed,
            herdr_codec::MAX_FRAME_BYTES,
            Arc::new(move |bytes| {
                if let Some(follower) = on_frame.upgrade() {
                    follower.frame(&bytes);
                }
            }),
            Arc::new(move |reason| {
                if let Some(follower) = on_close.upgrade() {
                    follower.failed(reason);
                }
            }),
        )
        .await;
    let stream = match opened {
        Ok(stream) => stream,
        Err(error) => {
            follower.close();
            return Err(unavailable(error.to_string()));
        }
    };
    {
        let mut installed = follower.stream.lock();
        if follower.closed.load(Ordering::Acquire) {
            drop(installed);
            let _ = stream.close();
            return Err(unavailable(
                "endpoint observer stopped during channel opening".into(),
            ));
        }
        *installed = Some(stream.clone());
    }
    if let Err(error) = stream.write(hello()) {
        follower.close();
        return Err(unavailable(error.to_string()));
    }
    let result = tokio::time::timeout(READY_TIMEOUT, stream.wait_current(ready)).await;
    let result = match result {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(error))) => Err(unavailable(error.to_string())),
        Ok(Err(error)) => Err(unavailable(error.to_string())),
        Err(_) => Err(unavailable("initial endpoint snapshot timed out".into())),
    };
    let result = result.and_then(|()| {
        let state = inner.state.lock();
        if state.epoch == epoch && state.generation == generation && state.event.is_some() {
            Ok(())
        } else {
            Err(unavailable(
                "host subscription was replaced during endpoint startup".into(),
            ))
        }
    });
    if result.is_err() {
        follower.close();
    }
    result
}

fn unavailable(reason: String) -> HerdrEventError {
    HerdrEventError::SubscriptionUnavailable(format!("Herdr agent view unavailable: {reason}"))
}

pub(super) fn stop(inner: &RuntimeInner) {
    let follower = inner.agent_view.lock().take();
    if let Some(follower) = follower {
        follower.close();
    }
}

fn hello() -> Vec<u8> {
    let data = serde_json::json!({
        "generation": 1,
        "cell_width_px": 0,
        "cell_height_px": 0,
        "surface_size": { "cols": 80, "rows": 24 },
        "pixel_mouse": false,
        "direct_graphics": false,
        "endpoint_keybindings": false,
        "mouse_capture": false,
        "surface_active": false,
        "snapshot_codecs": [SNAPSHOT],
        "surface_codecs": ["shell.surface.v1"],
        "input_codecs": ["shell.input.semantic.v1"],
        "blob_codecs": ["shell.blob.v1"]
    });
    herdr_codec::endpoint_control(HELLO, &data.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_is_non_rendering_and_uses_only_the_stable_named_control() {
        let ServerMessage::EndpointControl { kind, data } =
            herdr_codec::decode(&hello(), 22).unwrap()
        else {
            panic!("endpoint control")
        };
        assert_eq!(kind, HELLO);
        let data: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(data["surface_active"], false);
        assert_eq!(data["direct_graphics"], false);
        assert_eq!(data["mouse_capture"], false);
        assert_eq!(data["endpoint_keybindings"], false);
        assert_eq!(data["snapshot_codecs"][0], SNAPSHOT);
        assert_eq!(hello()[0], 20);
    }

    #[test]
    fn welcome_must_negotiate_a_non_rendering_snapshot_before_readiness() {
        let (inner, _) = super::super::tests::agent_view_test_core();
        let (follower, mut ready) = test_follower(&inner);
        let snapshot = control(
            SNAPSHOT,
            serde_json::json!({"boot_id":"boot", "revision":1, "agent_order":[]}),
        );
        assert!(follower.message(snapshot.clone()).is_err());
        assert!(ready.try_recv().is_err());
        assert!(follower.message(control(WELCOME, serde_json::json!({"generation":1, "snapshot_codec":SNAPSHOT, "capabilities":[], "error":null}))).is_err());
        assert!(!follower.welcomed.load(Ordering::Acquire));
        follower.message(welcome()).unwrap();
        assert!(ready.try_recv().is_err());
        follower.message(snapshot).unwrap();
        assert!(ready.try_recv().unwrap().is_ok());
        assert_eq!(inner.state.lock().agent_order, Some(Vec::new()));
    }

    #[test]
    fn live_orders_invalidate_herd_without_changing_agent_lifecycle() {
        let (inner, core) = super::super::tests::agent_view_test_core();
        let (follower, _) = test_follower(&inner);
        follower.message(welcome()).unwrap();
        let before = core.view().revision;
        let transitions = inner
            .state
            .lock()
            .host_state
            .take_agent_status_transitions();
        assert!(transitions.is_empty());
        follower.frame(&herdr_codec::endpoint_control(
            SNAPSHOT,
            &serde_json::json!({"boot_id":"boot", "revision":1, "agent_order":["pane-3","pane-2"]})
                .to_string(),
        ));
        let herd = core.herd_view(Vec::new(), None, None);
        assert_eq!(
            herd.agents
                .iter()
                .map(|item| item.agent.pane_id.as_str())
                .collect::<Vec<_>>(),
            ["pane-3", "pane-2"]
        );
        assert!(herd.revision > before);
        assert!(
            inner
                .state
                .lock()
                .host_state
                .take_agent_status_transitions()
                .is_empty()
        );
        follower
            .message(control(
                SNAPSHOT,
                serde_json::json!({"boot_id":"boot", "revision":2, "agent_order":[]}),
            ))
            .unwrap();
        assert!(core.herd_view(Vec::new(), None, None).agents.is_empty());
        assert_eq!(
            core.view().sessions[0]
                .host_state
                .as_ref()
                .unwrap()
                .snapshot
                .as_ref()
                .unwrap()
                .agents
                .len(),
            3
        );
    }

    #[test]
    fn older_revisions_cannot_replace_the_current_view_but_new_boots_can() {
        let (inner, _) = super::super::tests::agent_view_test_core();
        let (follower, _) = test_follower(&inner);
        follower.message(welcome()).unwrap();
        for (boot, revision, pane) in [
            ("first", 5, "pane-2"),
            ("first", 4, "pane-1"),
            ("first", 5, "pane-3"),
        ] {
            follower
                .message(control(
                    SNAPSHOT,
                    serde_json::json!({"boot_id":boot, "revision":revision, "agent_order":[pane]}),
                ))
                .unwrap();
            assert_eq!(inner.state.lock().agent_order, Some(vec!["pane-2".into()]));
        }
        follower
            .message(control(
                SNAPSHOT,
                serde_json::json!({"boot_id":"second", "revision":1, "agent_order":["pane-3"]}),
            ))
            .unwrap();
        assert_eq!(inner.state.lock().agent_order, Some(vec!["pane-3".into()]));
    }

    #[test]
    fn replaced_followers_and_connection_generations_cannot_publish() {
        let (inner, _) = super::super::tests::agent_view_test_core();
        let (old, _) = test_follower(&inner);
        old.message(welcome()).unwrap();
        let (current, _) = test_follower(&inner);
        current.message(welcome()).unwrap();
        let snapshot = control(
            SNAPSHOT,
            serde_json::json!({"boot_id":"boot", "revision":1, "agent_order":["pane-2"]}),
        );
        old.message(snapshot.clone()).unwrap();
        assert_eq!(inner.state.lock().agent_order, None);
        inner.state.lock().generation += 1;
        current.message(snapshot.clone()).unwrap();
        assert_eq!(inner.state.lock().agent_order, None);
        inner.state.lock().generation -= 1;
        inner.state.lock().epoch += 1;
        current.message(snapshot.clone()).unwrap();
        assert_eq!(inner.state.lock().agent_order, None);
        inner.state.lock().epoch -= 1;
        inner.state.lock().event = None;
        current.message(snapshot).unwrap();
        assert_eq!(inner.state.lock().agent_order, None);
    }

    #[test]
    fn old_protocols_keep_existing_herd_behavior_without_opening_an_endpoint() {
        let (inner, core) = super::super::tests::agent_view_test_core();
        inner.state.lock().protocol = Some(21);
        inner.state.lock().agent_order = Some(Vec::new());
        crate::runtime()
            .unwrap()
            .block_on(start(inner.clone(), 0))
            .unwrap();
        assert!(inner.agent_view.lock().is_none());
        assert_eq!(inner.state.lock().agent_order, None);
        assert_eq!(core.herd_view(Vec::new(), None, None).agents.len(), 3);
    }

    #[test]
    fn stopping_an_observer_cancels_readiness_and_rejects_its_late_snapshot() {
        let (inner, _) = super::super::tests::agent_view_test_core();
        let (follower, mut ready) = test_follower(&inner);
        follower.message(welcome()).unwrap();
        stop(&inner);
        assert!(matches!(
            ready.try_recv(),
            Ok(Err(HerdrEventError::SubscriptionUnavailable(_)))
        ));
        assert!(follower.closed.load(Ordering::Acquire));
        assert!(inner.agent_view.lock().is_none());
        follower
            .message(control(
                SNAPSHOT,
                serde_json::json!({"boot_id":"boot", "revision":1, "agent_order":["pane-2"]}),
            ))
            .unwrap();
        assert_eq!(inner.state.lock().agent_order, None);
    }

    #[test]
    fn unknown_optional_controls_are_ignored_but_unknown_snapshot_codecs_are_not() {
        let (inner, _) = super::super::tests::agent_view_test_core();
        let (follower, _) = test_follower(&inner);
        assert!(
            follower
                .message(control("endpoint.future", serde_json::json!({})))
                .is_ok()
        );
        assert!(
            follower
                .message(control("shell.snapshot.v2", serde_json::json!({})))
                .is_err()
        );
        assert_eq!(inner.state.lock().agent_order, None);
    }

    #[test]
    fn snapshot_reads_an_explicit_empty_order_and_ignores_unrelated_fields() {
        let snapshot: ShellSnapshot = serde_json::from_str(
            r#"{"boot_id":"boot","revision":4,"agent_order":[],"future":true}"#,
        )
        .unwrap();
        assert!(snapshot.agent_order.is_empty());
        assert!(
            serde_json::from_str::<ShellSnapshot>(r#"{"boot_id":"boot","revision":4}"#).is_err()
        );
        assert!(
            serde_json::from_str::<ShellSnapshot>(
                r#"{"boot_id":"boot","revision":4,"agent_order":[1]}"#
            )
            .is_err()
        );
    }

    fn control(kind: &str, data: serde_json::Value) -> ServerMessage {
        ServerMessage::EndpointControl {
            kind: kind.into(),
            data: data.to_string(),
        }
    }

    fn welcome() -> ServerMessage {
        control(
            WELCOME,
            serde_json::json!({"generation":1, "snapshot_codec":SNAPSHOT, "capabilities":["surface_interest"], "error":null}),
        )
    }

    fn test_follower(
        inner: &Arc<RuntimeInner>,
    ) -> (
        Arc<Follower>,
        oneshot::Receiver<Result<(), HerdrEventError>>,
    ) {
        let state = inner.state.lock();
        let (sender, receiver) = oneshot::channel();
        let follower = Arc::new(Follower {
            id: NEXT_FOLLOWER_ID.fetch_add(1, Ordering::Relaxed),
            runtime: Arc::downgrade(inner),
            epoch: state.epoch,
            generation: state.generation,
            stream: Mutex::new(None),
            welcomed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            revision: Mutex::new(None),
            ready: Mutex::new(Some(sender)),
        });
        drop(state);
        *inner.agent_view.lock() = Some(follower.clone());
        (follower, receiver)
    }
}
