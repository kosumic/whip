use super::row_restore_tests::{manager_with_core, materialized_cores};
use super::tests::SESSION;
use super::*;
use serde_json::{Value, json};
use std::ffi::{CStr, CString};

fn speech(command: Value) -> Value {
    let command = CString::new(command.to_string()).unwrap();
    // SAFETY: The NUL-terminated input remains alive for the call.
    let result =
        unsafe { crate::automatic_speech::whip_automatic_speech_command(command.as_ptr()) };
    assert!(!result.is_null());
    // SAFETY: The native API returned a live NUL-terminated allocation.
    let value = serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap();
    // SAFETY: Free the returned allocation once with the matching native API.
    unsafe { crate::speech_playback::whip_alert_speech_free(result) };
    value
}

struct RestoreAnnouncements(bool);
impl Drop for RestoreAnnouncements {
    fn drop(&mut self) {
        speech(json!({"action":"enable", "enabled":false}));
        speech(json!({"action":"enable", "enabled":self.0}));
    }
}

fn cores() -> Vec<AgentSessionCore> {
    let mut cores = materialized_cores("Historical answer.")
        .into_iter()
        .collect::<Vec<_>>();
    for (mut core, fixture) in [
        (
            AgentSessionCore::Claude(Box::new(ClaudeSessionCore::new(SESSION))),
            &include_bytes!(
                "../../../../../crates/agent-transcript-core/tests/fixtures/claude/main.jsonl"
            )[..],
        ),
        (
            AgentSessionCore::Pi(Box::new(PiSessionCore::new("pi-session"))),
            &include_bytes!(
                "../../../../../crates/agent-transcript-core/tests/fixtures/pi/main.jsonl"
            )[..],
        ),
    ] {
        let file = core.file().unwrap();
        let binding = file.bind_source("/transcript".into(), "1:2".into(), fixture.len() as u64);
        file.ingest(binding.source_generation, fixture).unwrap();
        file.mark_live_update();
        cores.push(core);
    }
    cores
}

fn append(manager: &AgentSessionManager, key: &TranscriptKey, index: u64, text: &str) {
    let (epoch, update) = {
        let mut state = manager.inner.state.lock();
        let session = state.sessions.get_mut(key).unwrap();
        let id = format!("live-{index}");
        let update = match &mut session.core {
            AgentSessionCore::OpenCode(core) => {
                let sequence = core.cursor().unwrap() + 1;
                let events = json!([
                    {"seq":sequence, "type":"message.updated.1", "data":{"info":{
                        "id":id, "role":"assistant", "parentID":"user", "time":{"completed":index}
                    }}},
                    {"seq":sequence+1, "type":"message.part.updated.1", "data":{"part":{
                        "id":format!("part-{index}"), "messageID":id, "type":"text", "text":text
                    }}}
                ]);
                core.apply_events_incremental(sequence + 1, &events.to_string())
                    .unwrap()
                    .unwrap()
            }
            core => {
                let record = match core.kind() {
                    AgentTranscriptKind::Codex => json!({"type":"event_msg", "payload":{
                        "type":"item_completed", "thread_id":SESSION, "turn_id":"turn", "item":{
                            "type":"AgentMessage", "id":id, "content":[{"type":"Text", "text":text}]
                        }
                    }}),
                    AgentTranscriptKind::Claude => json!({"type":"assistant", "uuid":id,
                        "sessionId":SESSION,
                        "timestamp":format!("2026-09-29T12:01:{index:02}.000Z"),
                        "parentUuid":if index==1 { "assistant-3".into() } else { format!("live-{}", index-1) },
                        "message":{
                            "role":"assistant", "id":id, "stop_reason":"end_turn",
                            "content":[{"type":"text", "text":text}]
                        }
                    }),
                    AgentTranscriptKind::Pi => json!({"type":"message", "id":id,
                        "parentId":if index==1 { "name".into() } else { format!("live-{}", index-1) },
                        "timestamp":format!("2026-10-27T12:01:{index:02}Z"),
                        "message":{"role":"assistant", "stopReason":"stop",
                            "timestamp":1_793_102_460_000_u64 + index * 1_000,
                            "content":[{"type":"text", "text":text}]
                        }
                    }),
                    AgentTranscriptKind::OpenCode => unreachable!(),
                };
                let file = core.file().unwrap();
                file.ingest(file.source_generation(), format!("{record}\n").as_bytes())
                    .unwrap()
                    .update
                    .unwrap()
            }
        };
        let epoch = session.operation_epoch;
        drop(state);
        (epoch, update)
    };
    emit(&manager.inner, key.clone(), epoch, update);
}

fn bind(core: AgentSessionCore) -> (AgentSessionManager, BoundAgentChat, u64) {
    let (manager, binding) = manager_with_core(core);
    let key = &binding.transcript_key;
    let (epoch, baseline) = {
        let mut state = manager.inner.state.lock();
        state.connected = true;
        let session = state.sessions.get_mut(key).unwrap();
        session.started = true;
        let result = (
            session.operation_epoch,
            AgentTranscriptUpdate::reset(session.core.state()),
        );
        drop(state);
        result
    };
    emit(&manager.inner, key.clone(), epoch, baseline);
    (manager, binding, epoch)
}

fn recover(manager: &AgentSessionManager, binding: &BoundAgentChat, epoch: u64) {
    let key = &binding.transcript_key;
    if binding.agent != AgentTranscriptKind::OpenCode {
        let size = manager
            .inner
            .state
            .lock()
            .sessions
            .get_mut(key)
            .unwrap()
            .core
            .file()
            .unwrap()
            .received_offset();
        let path = if binding.agent == AgentTranscriptKind::Codex {
            "/rollout"
        } else {
            "/transcript"
        };
        let opened = manager
            .bind_discovered_file(key, epoch, path, "1:2", size)
            .unwrap();
        assert!(opened.2.is_none(), "same file must not rebuild");
    }
    let live = {
        let mut state = manager.inner.state.lock();
        let session = state.sessions.get_mut(key).unwrap();
        let update = if let AgentSessionCore::OpenCode(core) = &mut session.core {
            core.mark_live_update()
        } else {
            session.core.file().unwrap().mark_live_update()
        };
        drop(state);
        update
    };
    if let Some(live) = live {
        emit(&manager.inner, key.clone(), epoch, live);
    }
    assert_eq!(
        manager.state(key).unwrap().status,
        AgentTranscriptStatus::Live
    );
}

#[test]
fn live_admitted_speech_survives_manager_failures_and_same_identity_rebinds() {
    let _restore = RestoreAnnouncements(crate::automatic_speech::tracking_enabled());
    speech(json!({"action":"enable", "enabled":false}));
    speech(json!({"action":"enable", "enabled":true}));
    for start_before_failure in [true, false] {
        for core in cores() {
            let (manager, binding, epoch) = bind(core);
            let key = &binding.transcript_key;
            assert_eq!(
                manager.state(key).unwrap().status,
                AgentTranscriptStatus::Live,
                "{:?}",
                binding.agent
            );
            assert!(speech(json!({"action":"take"})).is_null());
            append(&manager, key, 1, "First live reply.");
            append(&manager, key, 2, "Second live reply.");
            let first = start_before_failure.then(|| speech(json!({"action":"take"})));
            if let Some(first) = &first {
                assert_eq!(
                    first["text"], "First live reply.",
                    "{:?}: live admission",
                    binding.agent
                );
            }
            manager.fail_session(
                key.clone(),
                epoch,
                "SSH read failed".into(),
                SessionFailureKind::Transient,
            );
            let (retry_epoch, _, update, _) = manager
                .prepare_restart(key, "Rebinding".into(), Some(epoch))
                .unwrap();
            emit(&manager.inner, key.clone(), retry_epoch, update);
            manager
                .inner
                .state
                .lock()
                .sessions
                .get_mut(key)
                .unwrap()
                .retry_running = false;
            manager.fail_session(
                key.clone(),
                retry_epoch,
                "Discovery failed".into(),
                SessionFailureKind::SourceUnavailable,
            );
            let first = first.unwrap_or_else(|| speech(json!({"action":"take"})));
            assert_eq!(
                first["text"], "First live reply.",
                "{:?}: start_before_failure={start_before_failure}",
                binding.agent
            );
            assert_eq!(speech(json!({"action":"valid", "id":first["id"]})), true);
            assert_eq!(
                speech(json!({"action":"completed", "id":first["id"]})),
                true
            );
            let second = speech(json!({"action":"take"}));
            assert_eq!(second["text"], "Second live reply.");
            recover(&manager, &binding, retry_epoch);
            // Explicitly binding the retained authoritative session is idempotent.
            manager
                .bind_authoritative(AuthoritativeAgentChatIdentity {
                    terminal_id: binding.terminal_id.clone(),
                    pane_id: binding.pane_id.clone(),
                    agent: binding.agent,
                    session_id: binding.session_id.clone(),
                })
                .unwrap();
            assert_eq!(speech(json!({"action":"valid", "id":second["id"]})), true);
            assert_eq!(
                speech(json!({"action":"completed", "id":second["id"]})),
                true
            );
            assert!(speech(json!({"action":"take"})).is_null());
            append(&manager, key, 3, "Reply after recovery.");
            let fresh = speech(json!({"action":"take"}));
            assert_eq!(fresh["text"], "Reply after recovery.");
            if !start_before_failure {
                if binding.agent == AgentTranscriptKind::OpenCode {
                    manager
                        .bind_opencode(binding.terminal_id.to_string(), "ses_replacement".into())
                        .unwrap();
                } else {
                    let path = if binding.agent == AgentTranscriptKind::Codex {
                        "/rollout"
                    } else {
                        "/transcript"
                    };
                    let opened = manager
                        .bind_discovered_file(key, retry_epoch, path, "2:3", 0)
                        .unwrap();
                    assert!(opened.2.is_some(), "changed file must rebuild");
                }
                assert_eq!(speech(json!({"action":"valid", "id":fresh["id"]})), false);
            }
            // A genuine unbind removes the locally admitted queue and lease.
            manager.close_terminal(&binding.terminal_id);
            assert_eq!(speech(json!({"action":"valid", "id":fresh["id"]})), false);
            assert_eq!(
                speech(json!({"action":"completed", "id":fresh["id"]})),
                false
            );
            assert!(speech(json!({"action":"take"})).is_null());
        }
    }
}

#[test]
fn restored_provider_caches_remain_silent_when_binding_fails() {
    let _restore = RestoreAnnouncements(crate::automatic_speech::tracking_enabled());
    speech(json!({"action":"enable", "enabled":false}));
    speech(json!({"action":"enable", "enabled":true}));
    for core in cores() {
        let cache = core.cache_blob().unwrap();
        let mut restored = AgentSessionCore::new(core.kind(), core.state().session_id);
        restored.restore_cache(&cache).unwrap();
        let (manager, binding, epoch) = bind(restored);
        manager.fail_session(
            binding.transcript_key.clone(),
            epoch,
            "Offline".into(),
            SessionFailureKind::Transient,
        );
        assert!(
            !manager
                .state(&binding.transcript_key)
                .unwrap()
                .messages
                .is_empty()
        );
        assert!(speech(json!({"action":"take"})).is_null());
        manager.close_terminal(&binding.terminal_id);
    }
}
