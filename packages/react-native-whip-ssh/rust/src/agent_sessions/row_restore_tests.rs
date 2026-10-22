use super::tests::{SESSION, test_manager};
use super::*;
use crate::AgentChatRows;
use crate::chat_rows::{RowProjection, row_id};
use crate::test_allocations::measured;
use serde_json::json;

const OPENCODE_SESSION: &str = "ses_rows";

fn materialized_cores(text: &str) -> [AgentSessionCore; 2] {
    let records = [
        json!({"type":"session_meta", "payload":{"id":SESSION, "history_mode":"paginated"}}),
        json!({"type":"event_msg", "payload":{"type":"task_started", "turn_id":"turn"}}),
        json!({"type":"event_msg", "payload":{"type":"item_completed", "thread_id":SESSION, "turn_id":"turn", "item":{
            "type":"UserMessage", "id":"user", "content":[{"type":"text", "text":"Inspect /.whip/uploads/a.png"}]
        }}}),
        json!({"type":"event_msg", "payload":{"type":"item_completed", "thread_id":SESSION, "turn_id":"turn", "item":{
            "type":"AgentMessage", "id":"answer", "content":[{"type":"Text", "text":text}]
        }}}),
        json!({"type":"event_msg", "payload":{"type":"task_complete", "turn_id":"turn"}}),
    ];
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, &record).unwrap();
        bytes.push(b'\n');
    }
    let mut codex = CodexSessionCore::new(SESSION);
    let binding = codex.bind_source("/rollout".into(), "1:2".into(), bytes.len() as u64);
    codex.ingest(binding.source_generation, &bytes).unwrap();

    let export = json!({
        "info": { "id": OPENCODE_SESSION },
        "messages": [
            {
                "info": { "id": "user", "role": "user" },
                "parts": [{ "id": "prompt", "type": "text", "text": "Inspect /.whip/uploads/a.png" }]
            },
            {
                "info": { "id": "answer", "role": "assistant", "parentID": "user" },
                "parts": [
                    { "id": "text", "type": "text", "text": text },
                    { "id": "tool", "type": "tool", "callID": "call", "tool": "bash", "state": {
                        "status": "completed", "input": {}, "output": text,
                        "metadata": { "files": [{ "relativePath": "a.rs", "diff": "+content" }] }
                    } }
                ]
            }
        ]
    });
    let mut opencode = OpenCodeSessionCore::new(OPENCODE_SESSION);
    opencode.bootstrap(1, &export.to_string()).unwrap();
    opencode.mark_live_update();
    [
        AgentSessionCore::Codex(Box::new(codex)),
        AgentSessionCore::OpenCode(Box::new(opencode)),
    ]
}

fn manager_with_core(core: AgentSessionCore) -> (AgentSessionManager, BoundAgentChat) {
    let manager = test_manager("row-restore-test");
    let binding = manager
        .bind_authoritative(AuthoritativeAgentChatIdentity {
            terminal_id: "terminal".into(),
            pane_id: "pane".into(),
            agent: core.kind(),
            session_id: match core.kind() {
                AgentTranscriptKind::Claude | AgentTranscriptKind::Codex => SESSION.into(),
                AgentTranscriptKind::OpenCode => core.state().session_id.into(),
            },
        })
        .unwrap();
    manager
        .inner
        .state
        .lock()
        .sessions
        .get_mut(&binding.transcript_key)
        .unwrap()
        .core = core;
    (manager, binding)
}

#[test]
fn row_restoration_matches_snapshots_for_materialized_and_reconstructed_history() {
    let mut cores = materialized_cores("Answer").into_iter().collect::<Vec<_>>();
    for (mut core, fixture) in [
        (
            AgentSessionCore::Claude(Box::new(ClaudeSessionCore::new(SESSION))),
            &include_bytes!("../../test-fixtures/claude/main.jsonl")[..],
        ),
        (
            AgentSessionCore::Codex(Box::new(CodexSessionCore::new(SESSION))),
            &b"{\"type\":\"session_meta\",\"payload\":{}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Hello\"}}\n"[..],
        ),
        (
            AgentSessionCore::Codex(Box::new(CodexSessionCore::new("thread-current"))),
            &include_bytes!("../../test-fixtures/codex/paginated-rollout.jsonl")[..],
        ),
    ] {
        let file = core.file().unwrap();
        let binding = file.bind_source("/transcript".into(), "1:2".into(), fixture.len() as u64);
        file.ingest(binding.source_generation, fixture).unwrap();
        file.mark_live_update();
        cores.push(core);
    }
    let mut fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test-fixtures/opencode/v2-session.json")).unwrap();
    let mut opencode = OpenCodeSessionCore::new("ses_v2");
    opencode
        .apply_v2_snapshot(OpenCodeV2Snapshot {
            info: fixture["info"].take(),
            messages: std::mem::take(fixture["messages"].as_array_mut().unwrap()),
        })
        .unwrap();
    cores.push(AgentSessionCore::OpenCode(Box::new(opencode)));

    for core in cores {
        let snapshot = core.state();
        assert!(!snapshot.messages.is_empty());
        let expanded = snapshot
            .turns
            .iter()
            .filter(|turn| !turn.diffs.is_empty())
            .map(|turn| row_id(&[&turn.id, "changes"]))
            .collect::<Vec<_>>();
        let (manager, binding) = manager_with_core(core);
        let owner = AgentChatRows::for_live(manager.clone(), binding.transcript_key.clone());
        let mut expected = RowProjection::default();
        for working in [false, true] {
            for expanded in [vec![], expanded.clone()] {
                expected.restore(&snapshot);
                manager
                    .restore_rows(&binding.transcript_key, &owner)
                    .unwrap();
                let actual = owner.projection.lock().poll(0, working, expanded.clone());
                assert_eq!(
                    actual,
                    expected.poll(0, working, expanded),
                    "{:?}",
                    snapshot.agent
                );
            }
        }
        owner.dispose();
    }
}

#[test]
fn row_restoration_allocations_do_not_grow_with_transcript_contents() {
    fn allocations(core: AgentSessionCore) -> (u64, u64) {
        let (manager, binding) = manager_with_core(core);
        let owner = AgentChatRows::for_live(manager.clone(), binding.transcript_key.clone());
        let (result, _, count, bytes) =
            measured(|| manager.restore_rows(&binding.transcript_key, &owner));
        result.unwrap();
        owner.dispose();
        (count, bytes)
    }

    for (small, large) in materialized_cores(&"x".repeat(1_024))
        .into_iter()
        .zip(materialized_cores(&"x".repeat(65_536)))
    {
        let kind = small.kind();
        assert_eq!(allocations(small), allocations(large), "{kind:?}");
    }
}

#[test]
fn borrowed_opencode_rows_accept_normalized_image_updates_without_row_changes() {
    let [_, core] = materialized_cores("Answer");
    let (manager, binding) = manager_with_core(core);
    let owner = AgentChatRows::for_live(manager.clone(), binding.transcript_key.clone());
    let initial = futures::executor::block_on(owner.clone().poll(0, 0, false, vec![])).unwrap();
    let (epoch, update) = {
        let mut state = manager.inner.state.lock();
        let session = state.sessions.get_mut(&binding.transcript_key).unwrap();
        let AgentSessionCore::OpenCode(core) = &mut session.core else {
            panic!("OpenCode fixture");
        };
        let events = json!([{
            "seq": 2,
            "type": "message.part.updated.1",
            "data": { "part": {
                "id": "prompt", "messageID": "user", "type": "text",
                "text": "Updated /.whip/uploads/b.png with more text"
            } }
        }]);
        let update = core
            .apply_events_incremental(2, &events.to_string())
            .unwrap()
            .unwrap();
        let emission = (session.operation_epoch, update);
        drop(state);
        emission
    };
    let revision = update.revision;
    emit(&manager.inner, binding.transcript_key, epoch, update);
    let updated = futures::executor::block_on(owner.clone().poll(
        initial.revision,
        revision,
        false,
        vec![],
    ))
    .unwrap();
    assert_eq!(updated.transcript_revision, revision);
    assert_eq!(updated.revision, initial.revision);
    assert!(updated.patches.is_empty());
    owner.dispose();
}

#[test]
fn borrowed_row_recovery_uses_latest_revision_and_cannot_revive_a_disposed_viewport() {
    for core in materialized_cores("Answer") {
        let (manager, binding) = manager_with_core(core);
        let owner = AgentChatRows::for_live(manager.clone(), binding.transcript_key.clone());
        let initial = futures::executor::block_on(owner.clone().poll(0, 0, false, vec![])).unwrap();
        let (epoch, update) = {
            let mut state = manager.inner.state.lock();
            let session = state.sessions.get_mut(&binding.transcript_key).unwrap();
            session.core.mark_stale_update("missed update");
            let update = session.core.mark_restarting_update("retrying");
            let emission = (session.operation_epoch, update);
            drop(state);
            emission
        };
        let revision = update.revision;
        emit(
            &manager.inner,
            binding.transcript_key.clone(),
            epoch,
            update,
        );
        assert!(owner.projection.lock().needs_reset);
        let recovered = futures::executor::block_on(owner.clone().poll(
            initial.revision,
            revision,
            false,
            vec![],
        ))
        .unwrap();
        assert_eq!(recovered.transcript_revision, revision);
        assert_eq!(recovered.patches, initial.patches);

        let state = manager.inner.state.lock();
        let restore_manager = manager.clone();
        let restore_owner = Arc::clone(&owner);
        let key = binding.transcript_key;
        let restoring =
            std::thread::spawn(move || restore_manager.restore_rows(&key, &restore_owner));
        owner.dispose();
        drop(state);
        restoring.join().unwrap().unwrap();
        assert!(owner.projection.lock().disposed);
        assert!(futures::executor::block_on(owner.poll(0, revision, false, vec![])).is_err());
    }
}
