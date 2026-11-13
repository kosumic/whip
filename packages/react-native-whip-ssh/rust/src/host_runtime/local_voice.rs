//! Local calls pin a native terminal/session, independently of mounted chat UI.
use super::{HostConnectionState, HostRuntime};
use crate::voice_chat::{VoiceChat, coordinator::Connection, transcript::Source};
use std::{sync::Arc, time::Duration};

impl HostRuntime {
    pub(crate) fn observe_local_voice(&self, call: &Arc<VoiceChat>, connection: &Connection) {
        if self.runtime_incarnation() != connection.incarnation {
            call.state
                .lock()
                .coordinator
                .fail("The voice agent connection was replaced. Reopen voice chat.");
            return;
        }
        if self.status().state != HostConnectionState::Connected {
            call.state.lock().coordinator.binding(false, call.now());
            return;
        }
        let binding = self
            .inner
            .agents
            .terminal_binding_metadata(&connection.terminal_id);
        let binding = binding.or_else(|| {
            self.open_agent_chat(connection.terminal_id.clone()).ok()?;
            self.inner
                .agents
                .terminal_binding_metadata(&connection.terminal_id)
        });
        let Some(binding) = binding else {
            call.state.lock().coordinator.binding(false, call.now());
            return;
        };
        if binding.pane_id.as_str() != connection.pane_id || binding.agent != connection.agent {
            call.state
                .lock()
                .coordinator
                .fail("The pinned voice agent changed. Reopen voice chat.");
            return;
        }
        let mut state = call.state.lock();
        if state.source.as_ref().is_some_and(|source| {
            source.session != binding.session_id.as_str()
                || source.key != binding.transcript_key.as_str()
        }) {
            state
                .coordinator
                .fail("The agent conversation was replaced. Reopen voice chat.");
            return;
        }
        let start = state
            .source
            .as_ref()
            .is_none_or(|s| s.binding != binding.binding_token);
        if state.source.is_none() {
            state.source = Some(Source {
                runtime_id: connection.runtime_id.clone(),
                incarnation: connection.incarnation,
                key: binding.transcript_key.as_str().into(),
                session: binding.session_id.as_str().into(),
                binding: binding.binding_token.clone(),
                agent: binding.agent,
                epoch: 0,
                revision: None,
                seen_revision: None,
                live: false,
            });
        } else if let Some(source) = &mut state.source {
            source.binding.clone_from(&binding.binding_token);
        }
        drop(state);
        self.inner
            .agents
            .observe_local_voice(&binding.transcript_key, |epoch, status, view| {
                call.accept_window(&mut call.state.lock(), epoch, status, &view);
            });
        if !start {
            return;
        }
        let Ok(executor) = crate::runtime() else {
            return;
        };
        let runtime = Arc::new(Self {
            inner: self.inner.clone(),
        });
        let weak = Arc::downgrade(call);
        let expected_binding = binding.binding_token.clone();
        executor.spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                runtime.start_agent_chat(binding.binding_token),
            )
            .await;
            if matches!(result, Ok(Ok(crate::AgentChatStartResult::Started { .. }))) {
                return;
            }
            let Some(call) = weak.upgrade() else {
                return;
            };
            let mut state = call.state.lock();
            if state
                .source
                .as_ref()
                .is_some_and(|source| source.binding == expected_binding)
            {
                state.coordinator.binding(false, call.now());
            }
        });
    }
}

/// Composer permits for a Local call retain the agent session, not just its
/// terminal. Re-check before dispatch and each part of a native write.
pub(crate) fn voice_submission_current(
    target: &crate::TerminalSubmissionTarget,
    binding: &crate::terminal_submissions::VoiceSubmissionBinding,
) -> bool {
    let Some(runtime) = super::get_host_runtime(target.runtime_id.clone()) else {
        return false;
    };
    if runtime.runtime_incarnation() != target.runtime_incarnation {
        return false;
    }
    let state = runtime.inner.state.lock();
    if state.connection != HostConnectionState::Connected
        || state
            .host_state
            .begin_agent_session_read(&target.terminal_id)
            .is_none()
    {
        return false;
    }
    let projection = state.host_state.projection();
    drop(state);
    projection
        .snapshot
        .as_ref()
        .and_then(|snapshot| {
            snapshot.panes.iter().find(|pane| {
                pane.terminal_id == target.terminal_id && pane.pane_id == target.pane_id
            })
        })
        .and_then(super::authoritative_agent_chat_identity)
        .is_some_and(|identity| {
            identity.agent == binding.agent && identity.session_id.as_str() == binding.session_id
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct HeldPlatform(parking_lot::Mutex<Option<Arc<crate::TerminalSubmissionPermit>>>);

    #[async_trait::async_trait]
    impl crate::TerminalSubmissionPlatform for HeldPlatform {
        async fn submit(
            &self,
            permit: Arc<crate::TerminalSubmissionPermit>,
            _key: String,
            _parts: Vec<String>,
            _first: bool,
        ) -> Result<(), crate::TerminalSubmissionPlatformError> {
            *self.0.lock() = Some(permit);
            std::future::pending().await
        }
        fn changed(&self, _key: String) {}
    }

    #[test]
    fn queued_voice_writes_are_revoked_when_the_agent_session_changes_in_the_same_terminal() {
        let _guard = crate::host_runtime::terminal_delivery_test_guard();
        let runtime =
            crate::host_runtime::register_connected_test_runtime("local-voice-send-fence");
        let mut snapshot = crate::host_runtime::tests::agent_chat_snapshot(
            Some(("codex", "11111111-1111-4111-8111-111111111111")),
            Some("codex"),
        );
        let install = |snapshot| {
            let mut state = runtime.inner.state.lock();
            let generation = state.generation;
            let token = state.host_state.begin_sync(generation);
            state.host_state.complete_sync(token, snapshot, 1);
        };
        install(snapshot.clone());
        let target = crate::TerminalSubmissionTarget {
            key: "key".into(),
            runtime_id: "local-voice-send-fence".into(),
            runtime_incarnation: runtime.runtime_incarnation(),
            terminal_id: "terminal-pane-1".into(),
            pane_id: "pane-1".into(),
            ssh: false,
            online: true,
        };
        let mut binding = crate::terminal_submissions::VoiceSubmissionBinding {
            agent: crate::AgentTranscriptKind::Codex,
            session_id: "11111111-1111-4111-8111-111111111111".into(),
            admission: None,
        };
        assert!(voice_submission_current(&target, &binding));
        // Admission is checked again when a stalled platform finally dispatches,
        // before any terminal write. Revocation need not wait for queue cleanup.
        let admitted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let guard = admitted.clone();
        binding.admission = Some(Arc::new(move || {
            guard.load(std::sync::atomic::Ordering::Acquire)
        }));
        crate::runtime().unwrap().block_on(async {
            let queue = crate::TerminalSubmissionQueue::new();
            let platform = Arc::new(HeldPlatform::default());
            queue.clone().attach(platform.clone());
            queue.clone().update_targets(vec![target.clone()]);
            let message = queue
                .clone()
                .enqueue_voice(
                    target.key.clone(),
                    "Queued voice input".into(),
                    &target,
                    binding.clone(),
                )
                .unwrap();
            queue.clone().start();
            tokio::time::timeout(Duration::from_secs(2), async {
                while platform.0.lock().is_none() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            let permit = platform.0.lock().as_ref().unwrap().clone();
            assert!(permit.check_active().is_ok());
            admitted.store(false, std::sync::atomic::Ordering::Release);
            assert!(permit.check_active().is_err());
            queue.cancel_voice(&target.key, &message.id);
        });
        snapshot.panes[0].agent_session.as_mut().unwrap().value =
            "22222222-2222-4222-8222-222222222222".into();
        install(snapshot);
        assert!(!voice_submission_current(&target, &binding));
    }
}
