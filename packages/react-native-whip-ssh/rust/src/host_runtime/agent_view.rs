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
    stopped: Notify,
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
        self.stopped.notify_one();
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
        self.stopped.notify_one();
        if let Some(inner) = self.runtime.upgrade() {
            log_lifecycle(format_args!(
                "agent-view observer closed: {} generation={} reason={reason}",
                inner.id, self.generation
            ));
        }
    }
}

pub(super) fn ensure_started(inner: Arc<RuntimeInner>, epoch: u64) {
    let generation = inner.state.lock().generation;
    let mut task = inner.agent_view_task.lock();
    if task.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    *task = Some(tokio::spawn(follow(Arc::downgrade(&inner), epoch, generation)).abort_handle());
}

async fn follow(runtime: Weak<RuntimeInner>, epoch: u64, generation: u64) {
    let mut failures = 0;
    loop {
        let Some(inner) = runtime.upgrade() else {
            return;
        };
        let current = {
            let state = inner.state.lock();
            state.epoch == epoch
                && state.generation == generation
                && state.connection == HostConnectionState::Connected
                && state.event.is_some()
        };
        if !current {
            return;
        }
        let result = start(inner.clone(), epoch).await;
        if let Err(error) = &result {
            log_lifecycle(format_args!(
                "agent-view observer startup failed: {} generation={generation} error={error}",
                inner.id
            ));
        }
        drop(inner);
        match result {
            Ok(Some(follower)) => {
                failures = 0;
                follower.stopped.notified().await;
            }
            Ok(None) => return,
            Err(_) => {}
        }
        failures += 1;
        if failures >= MAX_RECONNECT_ATTEMPTS {
            log_lifecycle(format_args!("agent-view observer recovery exhausted"));
            return;
        }
        let Some(inner) = runtime.upgrade() else {
            return;
        };
        let delay = reconnect_delay(failures, runtime_jitter(&inner, failures));
        drop(inner);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

async fn start(
    inner: Arc<RuntimeInner>,
    epoch: u64,
) -> Result<Option<Arc<Follower>>, HerdrEventError> {
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
        stop_follower(&inner);
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
        return Ok(None);
    }
    let existing = inner
        .agent_view
        .lock()
        .as_ref()
        .filter(|follower| {
            follower.epoch == epoch
                && follower.generation == generation
                && !follower.closed.load(Ordering::Acquire)
        })
        .cloned();
    if let Some(follower) = existing {
        return Ok(Some(follower));
    }
    stop_follower(&inner);
    let (sender, ready) = oneshot::channel();
    let follower = Arc::new(Follower {
        id: NEXT_FOLLOWER_ID.fetch_add(1, Ordering::Relaxed),
        runtime: Arc::downgrade(&inner),
        epoch,
        generation,
        stream: Mutex::new(None),
        welcomed: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        stopped: Notify::new(),
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
    result.map(|()| Some(follower))
}

fn unavailable(reason: String) -> HerdrEventError {
    HerdrEventError::SubscriptionUnavailable(format!("Herdr agent view unavailable: {reason}"))
}

pub(super) fn stop(inner: &RuntimeInner) {
    if let Some(task) = inner.agent_view_task.lock().take() {
        task.abort();
    }
    stop_follower(inner);
}

fn stop_follower(inner: &RuntimeInner) {
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

    #[test]
    fn observer_failure_keeps_primary_events_and_notifications_live() {
        let _sink_lock = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let (inner, core) = super::super::tests::agent_view_test_core();
            inner.state.lock().protocol = Some(22);
            let registration = RuntimeRegistration::new(inner.clone());
            let events = crate::herdr_events::tests::EventStreamFixture::new(inner.id.clone());
            let (follower, _) = test_follower(&inner);
            follower.message(welcome()).unwrap();
            follower
                .message(control(
                    SNAPSHOT,
                    serde_json::json!({
                        "boot_id":"boot", "revision":1, "agent_order":["pane-1","pane-2","pane-3"]
                    }),
                ))
                .unwrap();
            let mut observer = Box::pin(follow(Arc::downgrade(&inner), 0, 1));
            // Poll to the live follower's close wait before simulating its failure.
            assert!(futures::poll!(observer.as_mut()).is_pending());
            *inner.agent_view_task.lock() = Some(tokio::spawn(observer).abort_handle());
            let before = inner.state.lock().host_state.projection().sync_status;

            follower.failed("observer channel closed".into());

            assert!(!inner.state.lock().event.as_ref().unwrap().retry_running);
            assert_eq!(
                inner.state.lock().host_state.projection().sync_status,
                before
            );
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if inner
                        .agent_view
                        .lock()
                        .as_ref()
                        .is_some_and(|current| current.id != follower.id)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(events.is_active());
            send_done_event(&events);
            assert_eq!(
                core.herd_view(Vec::new(), None, None).agents[0]
                    .agent
                    .agent_status,
                crate::herdr_api::HerdrAgentStatus::Done
            );
            let transitions = registration.transitions();
            assert_eq!(transitions.len(), 1);
            assert_eq!(
                transitions[0].current,
                Some(crate::herdr_api::HerdrAgentStatus::Done)
            );
            assert_eq!(
                inner.state.lock().event.as_ref().unwrap().operation_epoch,
                1
            );
            stop(&inner);
        });
    }

    #[test]
    fn observer_start_failure_does_not_fail_primary_event_subscription() {
        let _sink_lock = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let (inner, core) = super::super::tests::agent_view_test_core();
            inner.state.lock().protocol = Some(22);
            let registration = RuntimeRegistration::new(inner.clone());
            let events = crate::herdr_events::tests::EventStreamFixture::new(inner.id.clone());
            // The event subscription is acknowledged; only observer opening fails.
            let result = start_desired_events(inner.clone(), 0).await;
            assert!(result.is_ok(), "observer must not fail events: {result:?}");
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    if inner
                        .agent_view
                        .lock()
                        .as_ref()
                        .is_some_and(|follower| follower.closed.load(Ordering::Acquire))
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(events.is_active());
            send_done_event(&events);
            assert_eq!(
                core.herd_view(Vec::new(), None, None).agents[0]
                    .agent
                    .agent_status,
                crate::herdr_api::HerdrAgentStatus::Done
            );
            assert!(!inner.state.lock().event.as_ref().unwrap().retry_running);
            assert_eq!(registration.transitions().len(), 1);
            stop(&inner);
        });
    }

    #[test]
    fn observer_worker_is_single_and_canceled_while_starting() {
        crate::runtime().unwrap().block_on(async {
            let (inner, _) = super::super::tests::agent_view_test_core();
            inner.state.lock().protocol = Some(22);
            let opening = inner.agent_view_start.lock().await;
            ensure_started(inner.clone(), 0);
            let task = inner.agent_view_task.lock().as_ref().unwrap().clone();
            ensure_started(inner.clone(), 0);
            assert_eq!(
                inner.agent_view_task.lock().as_ref().unwrap().id(),
                task.id()
            );
            stop(&inner);
            assert!(inner.agent_view_task.lock().is_none());
            drop(opening);
            tokio::time::timeout(Duration::from_secs(1), async {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(inner.agent_view.lock().is_none());
            assert!(!inner.state.lock().event.as_ref().unwrap().retry_running);
        });
    }

    #[test]
    fn observer_worker_does_not_retry_a_replaced_runtime_epoch() {
        assert_retired_worker_stops(|state| state.epoch += 1);
    }

    #[test]
    fn observer_worker_does_not_retry_a_replaced_connection_generation() {
        assert_retired_worker_stops(|state| state.generation += 1);
    }

    #[test]
    fn waiting_observer_worker_does_not_keep_runtime_alive() {
        crate::runtime().unwrap().block_on(async {
            let (inner, core) = super::super::tests::agent_view_test_core();
            inner.state.lock().protocol = Some(22);
            let weak = Arc::downgrade(&inner);
            let (follower, _) = test_follower(&inner);
            let mut observer = Box::pin(follow(weak.clone(), 0, 1));
            assert!(futures::poll!(observer.as_mut()).is_pending());
            drop(core);
            drop(inner);
            assert!(weak.upgrade().is_none());
            assert!(follower.closed.load(Ordering::Acquire));
            observer.await;
        });
    }

    fn assert_retired_worker_stops(replace: impl FnOnce(&mut RuntimeState)) {
        crate::runtime().unwrap().block_on(async {
            let (inner, _) = super::super::tests::agent_view_test_core();
            inner.state.lock().protocol = Some(22);
            let (follower, _) = test_follower(&inner);
            let mut observer = Box::pin(follow(Arc::downgrade(&inner), 0, 1));
            assert!(futures::poll!(observer.as_mut()).is_pending());
            replace(&mut inner.state.lock());
            follower.failed("old observer channel closed".into());
            tokio::time::timeout(Duration::from_secs(2), observer)
                .await
                .unwrap();
            assert_eq!(inner.agent_view.lock().as_ref().unwrap().id, follower.id);
            stop(&inner);
        });
    }

    struct RuntimeRegistration {
        inner: Arc<RuntimeInner>,
        sink: Arc<super::super::tests::RecordingRuntimeSink>,
        previous_sink: Option<Arc<dyn HostRuntimeEventSink>>,
    }

    impl RuntimeRegistration {
        fn new(inner: Arc<RuntimeInner>) -> Self {
            assert!(
                runtimes()
                    .write()
                    .insert(inner.id.clone(), inner.clone())
                    .is_none()
            );
            let sink = Arc::new(super::super::tests::RecordingRuntimeSink::default());
            let previous_sink = event_sink().write().replace(sink.clone());
            Self {
                inner,
                sink,
                previous_sink,
            }
        }

        fn transitions(&self) -> Vec<crate::host_state::AgentStatusTransition> {
            self.sink
                .events
                .lock()
                .iter()
                .filter_map(|event| {
                    if let HostRuntimeEvent::HostStateChanged {
                        runtime_id,
                        agent_status_transitions,
                        ..
                    } = event
                    {
                        (runtime_id == &self.inner.id).then_some(agent_status_transitions.clone())
                    } else {
                        None
                    }
                })
                .flatten()
                .collect()
        }
    }

    impl Drop for RuntimeRegistration {
        fn drop(&mut self) {
            stop(&self.inner);
            unregister_runtime(&self.inner);
            *event_sink().write() = self.previous_sink.take();
        }
    }

    fn send_done_event(events: &crate::herdr_events::tests::EventStreamFixture) {
        events.send(b"{\"event\":\"pane.agent_status_changed\",\"data\":{\"workspace_id\":\"workspace\",\"pane_id\":\"pane-1\",\"agent_status\":\"done\"}}\n".to_vec());
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
            stopped: Notify::new(),
            revision: Mutex::new(None),
            ready: Mutex::new(Some(sender)),
        });
        drop(state);
        *inner.agent_view.lock() = Some(follower.clone());
        (follower, receiver)
    }
}
