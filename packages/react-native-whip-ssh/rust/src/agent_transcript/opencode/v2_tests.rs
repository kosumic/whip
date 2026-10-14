use super::*;

fn snapshot() -> OpenCodeV2Snapshot {
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/opencode/v2-session.json"
    ))
    .unwrap();
    OpenCodeV2Snapshot {
        info: fixture["info"].take(),
        messages: std::mem::take(fixture["messages"].as_array_mut().unwrap()),
    }
}

#[test]
fn v2_metadata_only_updates_and_idle_outcomes_survive_cache_and_old_cache_refresh() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(snapshot()).unwrap();
    let mut next = snapshot();
    next.messages[2]["tokens"] =
        serde_json::json!({"input":10,"output":20,"reasoning":5,"cache":{"read":30,"write":2}});
    next.messages[2]["content"][1]["state"]["input"]["options"] =
        serde_json::json!({"paths":["src","tests"]});
    next.messages[3]["outcome"] = Value::String("interrupted".into());
    let update = core.apply_v2_snapshot(next).unwrap().unwrap();
    assert!(update.deltas.iter().any(|delta| matches!(delta, AgentTranscriptDelta::TurnUpserted { turn, .. } if turn.details.as_ref().and_then(|details| details.usage.as_ref()).and_then(|usage| usage.total) == Some(67))));
    let state = core.state();
    let details = state.turns[0].details.as_ref().unwrap();
    assert_eq!(details.model.as_deref(), Some("fixture"));
    assert_eq!(details.provider.as_deref(), Some("fixture"));
    assert_eq!(details.outcome, Some(AgentTurnOutcome::Interrupted));
    assert_eq!(state.turns[0].status, AgentTurnStatus::Interrupted);
    let AgentTranscriptPart::Tool { state: tool, .. } = &state.messages[1].parts[1] else {
        panic!("missing tool")
    };
    assert_eq!(tool.duration_ms, Some(800));
    assert_eq!(
        serde_json::from_str::<Value>(tool.input_json.as_ref().unwrap()).unwrap()["options"]["paths"],
        serde_json::json!(["src", "tests"])
    );
    let mut restored = OpenCodeSessionCore::new("ses_v2");
    restored.restore_cache(&core.cache_blob().unwrap()).unwrap();
    assert_eq!(restored.state().turns, state.turns);
    let mut old: Value = serde_json::from_slice(&core.cache_blob().unwrap()).unwrap();
    old["schema_version"] = serde_json::json!(3);
    restored
        .restore_cache(&serde_json::to_vec(&old).unwrap())
        .unwrap();
    assert_eq!(restored.state().messages, state.messages);
    assert!(restored.v2_read_state().is_none());
    assert_eq!(restored.cursor(), None);
}

#[test]
fn v2_cache_persists_validated_log_position_and_all_message_ids() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_sync(OpenCodeV2Sync::Full {
        snapshot: snapshot(),
        sequence: Some(42),
    })
    .unwrap();
    let blob = core.cache_blob().unwrap();
    let mut restored = OpenCodeSessionCore::new("ses_v2");
    restored.restore_cache(&blob).unwrap();
    assert_eq!(
        restored.v2_read_state().unwrap().history,
        core.v2_read_state().unwrap().history
    );
    assert_eq!(
        restored.v2_read_state().unwrap().history.message_ids,
        ["msg_user", "msg_context", "msg_assistant", "msg_idle"]
    );
    assert_eq!(restored.state().messages, core.state().messages);

    let mut legacy: Value = serde_json::from_slice(&blob).unwrap();
    legacy.as_object_mut().unwrap().remove("v2_history");
    restored
        .restore_cache(&serde_json::to_vec(&legacy).unwrap())
        .unwrap();
    assert!(restored.v2_read_state().is_none());
    assert_eq!(restored.state().messages, core.state().messages);
}

#[test]
fn v2_cache_rejects_inconsistent_raw_message_order_before_mutation() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_sync(OpenCodeV2Sync::Full {
        snapshot: snapshot(),
        sequence: Some(42),
    })
    .unwrap();
    let valid: Value = serde_json::from_slice(&core.cache_blob().unwrap()).unwrap();
    for ids in [
        serde_json::json!(["msg_user", "msg_user", "msg_assistant"]),
        serde_json::json!(["msg_assistant", "msg_user"]),
        serde_json::json!(["msg_user"]),
        serde_json::json!(["msg_user", "", "msg_assistant"]),
    ] {
        let before = core.state();
        let mut invalid = valid.clone();
        invalid["v2_history"]["message_ids"] = ids;
        assert!(
            core.restore_cache(&serde_json::to_vec(&invalid).unwrap())
                .is_err()
        );
        assert_eq!(core.state(), before);
        assert_eq!(core.v2_read_state().unwrap().history.sequence, 42);
    }
    core.set_protocol(OpenCodeProtocol::V1);
    assert!(core.v2_read_state().is_none());
}

#[test]
fn v2_sparse_changes_validate_transactionally_and_checkpoint_log_only_progress() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_sync(OpenCodeV2Sync::Full {
        snapshot: snapshot(),
        sequence: Some(42),
    })
    .unwrap();
    let before = core.state();
    let history = core.v2_read_state().unwrap().history;
    for (sequence, messages, ids) in [
        (41, vec![], history.message_ids.clone()),
        (43, vec![], vec!["msg_new".into()]),
        (
            43,
            vec![serde_json::json!({"id":"msg_assistant", "type":"assistant", "content":"bad"})],
            history.message_ids.clone(),
        ),
    ] {
        assert!(
            core.apply_v2_sync(OpenCodeV2Sync::Changes {
                info: snapshot().info,
                history: OpenCodeV2History {
                    sequence,
                    message_ids: ids
                },
                messages,
            })
            .is_err()
        );
        assert_eq!(core.state(), before);
        assert_eq!(core.v2_read_state().unwrap().history, history);
    }
    let cursor = core.cursor().unwrap();
    assert!(
        core.apply_v2_sync(OpenCodeV2Sync::Changes {
            info: snapshot().info,
            history: OpenCodeV2History {
                sequence: 43,
                ..history
            },
            messages: vec![],
        })
        .unwrap()
        .is_none()
    );
    assert_eq!(core.state(), before);
    assert_eq!(core.cursor(), Some(cursor + 1));
    assert_eq!(core.v2_read_state().unwrap().history.sequence, 43);
}

#[test]
fn v2_history_projects_text_reasoning_tools_and_hides_model_context() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(snapshot()).unwrap();
    let state = core.state();
    assert_eq!(state.info.unwrap().directory.as_deref(), Some("/repo"));
    assert_eq!(state.messages.len(), 3);
    let assistant = &state.messages[1];
    assert_eq!(assistant.completed_at_ms, Some(5000));
    assert!(
        matches!(&assistant.parts[0], AgentTranscriptPart::Reasoning { text, timestamp_ms: Some(2000), .. } if text == "Checking the build")
    );
    let AgentTranscriptPart::Tool {
        call_id,
        state: tool,
        ..
    } = &assistant.parts[1]
    else {
        panic!("tool missing")
    };
    assert_eq!(call_id, "call_build");
    assert_eq!(tool.status, AgentToolStatus::Completed);
    assert_eq!(
        tool.output.as_deref(),
        Some("Build succeeded\n\nNo warnings")
    );
    assert_eq!(tool.started_at_ms, Some(2700));
    assert_eq!(tool.completed_at_ms, Some(3500));
    assert_eq!(tool.exit_code, Some(0));
    assert_eq!(
        state.turns[0].assistant_message_ids,
        ["msg_assistant", "msg_idle"]
    );
    assert!(state.messages[2].parts.is_empty());
    assert_eq!(
        state.turns[0].details.as_ref().unwrap().outcome,
        Some(AgentTurnOutcome::Completed)
    );
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
}

#[test]
fn v2_polling_replaces_changed_content_without_resetting_history() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    let mut running = snapshot();
    running.messages[2]["time"]
        .as_object_mut()
        .unwrap()
        .remove("completed");
    running.messages[2]["content"][1]["state"] = serde_json::json!({ "status": "running", "input": { "command": "cargo check" }, "metadata": {} });
    running.messages[2]["content"]
        .as_array_mut()
        .unwrap()
        .truncate(2);
    core.apply_v2_snapshot(running).unwrap();
    assert_eq!(core.state().turns[0].status, AgentTurnStatus::Working);
    let previous_cursor = core.cursor().unwrap();
    let update = core.apply_v2_snapshot(snapshot()).unwrap().unwrap();
    assert!(
        update
            .deltas
            .iter()
            .all(|delta| !matches!(delta, AgentTranscriptDelta::Reset { .. }))
    );
    let changed: Vec<_> = update
        .deltas
        .iter()
        .filter_map(|delta| match delta {
            AgentTranscriptDelta::MessageUpserted { message, .. } => Some(message.id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(changed, ["msg_assistant"]);
    assert_eq!(core.cursor(), Some(previous_cursor + 1));
    assert_eq!(core.state().messages[1].parts.len(), 3);
    let state = core.state();
    assert!(core.apply_v2_snapshot(snapshot()).unwrap().is_none());
    assert_eq!(core.state(), state);
}

#[test]
fn v2_removed_content_messages_and_reordered_history_are_authoritative() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(snapshot()).unwrap();
    let mut shorter = snapshot();
    shorter.messages[2]["content"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    core.apply_v2_snapshot(shorter).unwrap();
    assert_eq!(core.state().messages[1].parts.len(), 2);
    let mut reordered = snapshot();
    reordered.messages.insert(
        0,
        serde_json::json!({ "id": "msg_older", "type": "user", "text": "Earlier question" }),
    );
    let update = core.apply_v2_snapshot(reordered).unwrap().unwrap();
    assert!(matches!(
        &update.deltas[0],
        AgentTranscriptDelta::Reset { .. }
    ));
    let mut removed = snapshot();
    removed.messages.truncate(1);
    core.apply_v2_snapshot(removed).unwrap();
    assert_eq!(core.state().messages.len(), 1);
    assert_eq!(core.state().turns.len(), 1);
    assert!(core.state().turns[0].assistant_message_ids.is_empty());
}

#[test]
fn v2_invalid_snapshot_preserves_history_and_cursor() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(snapshot()).unwrap();
    let before = core.state();
    let cursor = core.cursor();
    let mut wrong_session = snapshot();
    wrong_session.info["id"] = Value::String("ses_other".into());
    let mut malformed = snapshot();
    malformed.messages[2]["content"] = Value::Null;
    let mut duplicate = snapshot();
    duplicate.messages.push(duplicate.messages[0].clone());
    for invalid in [wrong_session, malformed, duplicate] {
        assert_eq!(
            core.apply_v2_snapshot(invalid),
            Err(OpenCodeTranscriptError::InvalidSnapshot)
        );
        assert_eq!(core.state(), before);
        assert_eq!(core.cursor(), cursor);
    }
}

#[test]
fn v2_cache_restores_and_protocol_changes_require_remote_validation() {
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(snapshot()).unwrap();
    core.mark_live();
    let mut restored = OpenCodeSessionCore::new("ses_v2");
    restored.restore_cache(&core.cache_blob().unwrap()).unwrap();
    assert_eq!(restored.protocol, OpenCodeProtocol::V2);
    assert_eq!(restored.state().messages, core.state().messages);
    assert_ne!(restored.state().status, AgentTranscriptStatus::Live);
    let update = restored.apply_v2_snapshot(snapshot()).unwrap();
    restored.finish_live_update(update);
    assert_eq!(restored.state().status, AgentTranscriptStatus::Live);
    restored.set_protocol(OpenCodeProtocol::V1);
    assert_eq!(restored.cursor(), None);
    assert_eq!(restored.committed_cursor(), None);
    assert_eq!(restored.state().messages, core.state().messages);

    // Caches written before protocol detection have no protocol field.
    let mut legacy: Value = serde_json::from_slice(&core.cache_blob().unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("protocol");
    restored
        .restore_cache(&serde_json::to_vec(&legacy).unwrap())
        .unwrap();
    assert_eq!(restored.protocol, OpenCodeProtocol::V1);
    restored.set_protocol(OpenCodeProtocol::V2);
    assert_eq!(restored.cursor(), None);
}

#[test]
fn v2_streaming_tool_errors_plans_and_shell_output_use_existing_chat_parts() {
    let mut input = snapshot();
    input.messages[2]["content"] = serde_json::json!([
        { "type": "tool", "id": "call_stream", "name": "bash", "state": { "status": "streaming", "input": "{\"command\":" }, "time": { "created": 2000 } },
        { "type": "tool", "id": "call_error", "name": "bash", "state": { "status": "error", "input": { "command": "false" }, "error": { "message": "Exit 1" }, "content": [{ "type": "text", "text": "Failed" }] }, "time": { "created": 2100, "completed": 2200 } },
        { "type": "tool", "id": "call_todo", "name": "todowrite", "state": { "status": "completed", "input": { "todos": [{ "content": "Fix build", "status": "completed", "priority": "high" }] }, "content": [{ "type": "text", "text": "Saved" }] }, "time": { "created": 2300, "completed": 2400 } }
    ]);
    input.messages.push(serde_json::json!({ "id": "msg_shell", "type": "shell", "shellID": "sh_one", "command": "false", "status": "exited", "exit": 1, "output": { "output": "shell output", "cursor": 12, "size": 12, "truncated": false }, "time": { "created": 6100, "completed": 6200 } }));
    let mut core = OpenCodeSessionCore::new("ses_v2");
    core.apply_v2_snapshot(input).unwrap();
    let state = core.state();
    assert!(
        matches!(&state.messages[1].parts[0], AgentTranscriptPart::Tool { state, .. } if state.status == AgentToolStatus::Pending)
    );
    assert!(
        matches!(&state.messages[1].parts[1], AgentTranscriptPart::Tool { state, .. } if state.status == AgentToolStatus::Error && state.output.as_deref() == Some("Failed") && state.error.as_deref().unwrap().contains("Exit 1"))
    );
    assert!(
        matches!(&state.messages[1].parts[2], AgentTranscriptPart::Plan { text, .. } if text.contains("Fix build"))
    );
    assert!(
        matches!(&state.messages[3].parts[0], AgentTranscriptPart::Tool { state, .. } if state.exit_code == Some(1) && state.output.as_deref() == Some("shell output"))
    );
    assert_eq!(state.turns[0].status, AgentTurnStatus::Error);
}
