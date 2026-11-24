use serde_json::json;

use super::*;
use agent_transcript_core::{AgentFileDiff, AgentTranscriptKind};

#[path = "fixtures.rs"]
mod fixtures;
use fixtures::*;
fn tool(id: &str, name: &str, status: &str) -> serde_json::Value {
    json!({ "Tool": { "id": id, "call_id": id, "tool": name, "timestamp_ms": null,
        "state": { "status": status, "input": [], "output": null, "error": null, "title": null,
            "started_at_ms": null, "completed_at_ms": null, "exit_code": null } } })
}

fn rows(state: &AgentTranscriptState, working: bool) -> Vec<AgentChatRow> {
    let mut projection = RowProjection::default();
    projection.restore(state);
    projection.poll(0, working, vec![]);
    projection.snapshot()
}

fn streaming(rows: &[AgentChatRow]) -> Vec<&str> {
    rows.iter()
        .filter_map(|row| match &row.content {
            AgentChatRowContent::Part {
                part_id,
                streaming: true,
                ..
            } => Some(part_id.as_str()),
            _ => None,
        })
        .collect()
}

fn apply(rows: &mut Vec<AgentChatRow>, update: &AgentChatRowUpdate) {
    for patch in &update.patches {
        match patch {
            AgentChatRowPatch::Reset { rows: next } => rows.clone_from(next),
            AgentChatRowPatch::Splice {
                index,
                delete_count,
                rows: next,
            } => {
                rows.splice(
                    *index as usize..(*index + *delete_count) as usize,
                    next.iter().cloned(),
                );
            }
        }
    }
}

#[test]
fn initial_projection_spacing_and_stable_metadata() {
    let state = fixture(2);
    let rows = rows(&state, true);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].id, r#"["t0","part","m0","text"]"#);
    assert_eq!(rows[0].spacing, AgentChatRowSpacing::None);
    assert_eq!(rows[1].content, AgentChatRowContent::Meta);
    assert_eq!(rows[1].spacing, AgentChatRowSpacing::None);
    assert_eq!(rows[2].spacing, AgentChatRowSpacing::Turn);
    assert_eq!(streaming(&rows), ["text"]);
    assert_eq!(rows[3].id, r#"["t1","meta"]"#);
    let empty = fixture(0);
    assert!(rows_for_empty(&empty).is_empty());
}

fn rows_for_empty(state: &AgentTranscriptState) -> Vec<AgentChatRow> {
    rows(state, true)
}

fn next_prompt(state: &mut AgentTranscriptState) {
    let index = state.turns.len();
    let id = format!("u{index}");
    state
        .messages
        .push(message(&id, "User", json!([text("prompt", "Next")])));
    let mut turn = state.turns[0].clone();
    turn.id = format!("t{index}");
    turn.user_message_id = Some(id.clone());
    turn.assistant_message_ids.clear();
    turn.message_ids = vec![id];
    turn.diffs.clear();
    state.turns.push(turn);
}

fn group_ids(rows: &[AgentChatRow]) -> Vec<String> {
    rows.iter()
        .filter(|row| matches!(row.content, AgentChatRowContent::ToolGroup { .. }))
        .map(|row| row.id.clone())
        .collect()
}

#[test]
fn host_activity_keeps_tools_visible_across_assistant_turns_until_idle_or_a_new_prompt() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("read", "Read", "Completed"),
            tool("shell", "functions.exec_command", "Completed")
        ]),
    );
    // A provider can append an assistant-only turn. It is not a new user turn.
    let mut assistant = state.turns[0].clone();
    assistant.id = "assistant-only".into();
    assistant.message_ids.clear();
    assistant.assistant_message_ids.clear();
    state.turns.push(assistant);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let initial = projection.poll(0, true, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &initial);
    assert!(group_ids(&client).is_empty());
    let idle = projection.poll(initial.revision, false, vec![]);
    apply(&mut client, &idle);
    assert!(
        matches!(&client[0].content, AgentChatRowContent::ToolGroup { count: 2, tools }
        if tools == &["Read", "Shell"])
    );
    assert_eq!(client, rows(&state, false));
    let idle_group = client[0].clone();
    let resumed = projection.poll(idle.revision, true, vec![]);
    apply(&mut client, &resumed);
    assert!(group_ids(&client).is_empty());
    next_prompt(&mut state);
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![
            AgentTranscriptDelta::MessageUpserted {
                index: 1,
                message: state.messages[1].clone(),
            },
            AgentTranscriptDelta::TurnUpserted {
                index: 2,
                turn: state.turns[2].clone(),
            },
        ],
    });
    let collapsed = projection.poll(resumed.revision, true, vec![]);
    assert!(
        collapsed
            .patches
            .iter()
            .all(|patch| matches!(patch, AgentChatRowPatch::Splice { .. }))
    );
    apply(&mut client, &collapsed);
    assert_eq!(group_ids(&client).len(), 1);
    assert_eq!(client[0], idle_group);
    assert_eq!(client, rows(&state, true));
}

#[test]
fn groups_respect_visible_boundaries_and_expansion_restores_original_rows_for_all_agents() {
    for agent in [
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::Pi,
        AgentTranscriptKind::OpenCode,
    ] {
        let mut state = fixture(1);
        state.agent = agent;
        state.messages[0] = message(
            "m0",
            "Assistant",
            json!([
                tool("same", "Read", "Completed"), tool("same", "Bash", "Completed"),
                text("boundary", "Visible explanation"),
                tool("edit", "Edit", "Completed"),
                { "Notice": { "id": "notice", "text": "Confirm", "level": "Warning" } },
                tool("tail", "Read", "Completed")
            ]),
        );
        // Consecutive tools can span assistant messages in the same turn.
        state.messages.push(message(
            "more",
            "Assistant",
            json!([tool("last", "Read", "Completed")]),
        ));
        state.turns[0].assistant_message_ids.push("more".into());
        let original = rows(&state, true);
        next_prompt(&mut state);
        let mut projection = RowProjection::default();
        projection.restore(&state);
        let initial = projection.poll(0, false, vec![]);
        let mut client = Vec::new();
        apply(&mut client, &initial);
        let groups = group_ids(&client);
        assert_eq!(groups.len(), 2);
        let expanded = projection.poll(initial.revision, false, groups.clone());
        apply(&mut client, &expanded);
        assert_eq!(group_ids(&client), groups);
        let revealed: Vec<_> = client
            .iter()
            .filter(|row| {
                row.turn_id == "t0" && !matches!(row.content, AgentChatRowContent::ToolGroup { .. })
            })
            .collect();
        assert_eq!(
            revealed.iter().map(|row| &row.id).collect::<Vec<_>>(),
            original.iter().map(|row| &row.id).collect::<Vec<_>>()
        );
        for (revealed, original) in revealed.iter().zip(&original) {
            assert_eq!(revealed.content, original.content);
        }
        let collapsed = projection.poll(expanded.revision, false, vec![]);
        apply(&mut client, &collapsed);
        assert_eq!(client, rows(&state, false));
    }
}

#[test]
fn actionable_tools_and_all_failure_signals_remain_visible_in_history() {
    let mut state = fixture(1);
    let mut exit = tool("exit", "shell", "Completed");
    exit["Tool"]["state"]["exit_code"] = json!(1);
    let mut error = tool("error", "Read", "Completed");
    error["Tool"]["state"]["error"] = json!("Denied");
    let mut diagnostic = tool("diagnostic", "Edit", "Completed");
    diagnostic["Tool"]["state"]["diagnostics"] =
        json!([{ "file": "main.rs", "message": "Invalid", "severity": "Error" }]);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("ok", "Read", "Completed"),
            tool("pending", "approval", "Pending"),
            tool("running", "shell", "Running"),
            tool("failed", "shell", "Error"),
            tool("question", "functions.request_user_input", "Completed"),
            exit,
            error,
            diagnostic,
            tool("last", "Edit", "Completed")
        ]),
    );
    state.messages[0].error = Some("Message error".into());
    next_prompt(&mut state);
    let projected = rows(&state, false);
    let visible: Vec<_> = projected
        .iter()
        .filter_map(|row| match &row.content {
            AgentChatRowContent::Part { part_id, .. } => Some(part_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        visible,
        [
            "ok",
            "pending",
            "running",
            "failed",
            "question",
            "exit",
            "error",
            "diagnostic",
            "last"
        ]
    );
    assert!(
        projected
            .iter()
            .any(|row| matches!(row.content, AgentChatRowContent::Error { .. }))
    );
    assert!(group_ids(&projected).is_empty());
}

#[test]
fn historical_live_status_changes_reveal_errors_and_group_successful_completions() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("tool", "shell", "Running"),
            tool("settled", "Read", "Completed")
        ]),
    );
    next_prompt(&mut state);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let mut client = Vec::new();
    let first = projection.poll(0, false, vec![]);
    apply(&mut client, &first);
    let mut after = first.revision;
    for (revision, status) in [
        (1, "Completed"),
        (2, "Error"),
        (3, "Running"),
        (4, "Completed"),
    ] {
        state.messages[0].parts[0] = serde_json::from_value(tool("tool", "shell", status)).unwrap();
        projection.accept(&AgentTranscriptUpdate {
            revision,
            deltas: vec![AgentTranscriptDelta::MessageUpserted {
                index: 0,
                message: state.messages[0].clone(),
            }],
        });
        let update = projection.poll(after, false, vec![]);
        apply(&mut client, &update);
        assert_eq!(client, rows(&state, false));
        assert_eq!(group_ids(&client).len(), usize::from(status == "Completed"));
        after = update.revision;
    }
}

#[test]
fn pagination_and_live_extensions_preserve_group_identity_expansion_and_search_reveal() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("retained", "Read", "Completed"),
            tool("second", "Read", "Completed")
        ]),
    );
    next_prompt(&mut state);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, false, vec![]);
    let group = group_ids(&projection.snapshot())[0].clone();
    let expanded = projection.poll(first.revision, false, vec![group.clone()]);
    state.messages[0].parts.insert(
        0,
        serde_json::from_value(tool("older", "Bash", "Completed")).unwrap(),
    );
    state.messages[0]
        .parts
        .push(serde_json::from_value(tool("newer", "Edit", "Completed")).unwrap());
    // An authoritative history reload can also prepend whole turns.
    let mut older = fixture(1);
    older.turns[0].id = "older-turn".into();
    older.turns[0].assistant_message_ids = vec!["older-message".into()];
    older.messages[0].id = "older-message".into();
    state.turns.insert(0, older.turns.remove(0));
    state.messages.insert(0, older.messages.remove(0));
    projection.reconcile_reset(&state, 1);
    let mut client = Vec::new();
    let restored = projection.poll(expanded.revision, false, vec![group.clone()]);
    apply(&mut client, &restored);
    assert_eq!(group_ids(&client), std::slice::from_ref(&group));
    assert!(
        client
            .iter()
            .any(|row| row.id == part_row_id("t0", "m0", "retained", 0))
    );
    assert!(
        client
            .iter()
            .any(|row| row.id == part_row_id("t0", "m0", "older", 0))
    );
    let docs = crate::search::transcript::documents(&state);
    let retained = docs
        .iter()
        .find(|doc| doc.id == part_row_id("t0", "m0", "retained", 0))
        .unwrap();
    assert_eq!(retained.reveal, [group, retained.id.clone()]);
}

#[test]
fn tools_after_the_latest_prompt_collapse_when_the_transcript_turn_finishes() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("older", "Read", "Completed"),
            tool("earlier", "Read", "Completed")
        ]),
    );
    state
        .messages
        .push(message("user", "User", json!([text("prompt", "Next")])));
    state.messages.push(message(
        "new",
        "Assistant",
        json!([
            tool("current", "Bash", "Completed"),
            tool("current2", "Read", "Completed")
        ]),
    ));
    state.turns[0].message_ids = vec!["m0".into(), "user".into(), "new".into()];
    state.turns[0].assistant_message_ids.push("new".into());
    state.turns[0].status = AgentTurnStatus::Working;
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let mut projected = Vec::new();
    let initial = projection.poll(0, false, vec![]);
    apply(&mut projected, &initial);
    assert_eq!(group_ids(&projected).len(), 1);
    assert!(
        !projected
            .iter()
            .any(|row| row.id == part_row_id("t0", "m0", "older", 0))
    );
    assert!(
        projected
            .iter()
            .any(|row| row.id == part_row_id("t0", "new", "current", 0))
    );
    assert!(
        projected
            .iter()
            .any(|row| row.id == part_row_id("t0", "new", "current2", 0))
    );
    state.turns[0].status = AgentTurnStatus::Idle;
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![AgentTranscriptDelta::TurnUpserted {
            index: 0,
            turn: state.turns[0].clone(),
        }],
    });
    apply(
        &mut projected,
        &projection.poll(initial.revision, false, vec![]),
    );
    assert_eq!(group_ids(&projected).len(), 2);
    assert_eq!(projected, rows(&state, false));
}

#[test]
fn isolated_historical_tools_never_get_a_group_header_or_search_parent() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            tool("read", "Read", "Completed"),
            text("text", "Explanation"),
            tool("shell", "Bash", "Completed")
        ]),
    );
    let original = rows(&state, false);
    next_prompt(&mut state);
    let historical = rows(&state, false);
    assert!(group_ids(&historical).is_empty());
    assert_eq!(&historical[..original.len()], original.as_slice());
    for doc in crate::search::transcript::documents(&state) {
        assert_eq!(doc.reveal, [doc.id]);
    }
}

#[test]
fn long_history_expands_as_virtualized_sibling_rows_and_retains_choices_on_live_updates() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!(
            (0..500)
                .map(|index| tool(&index.to_string(), "Read", "Completed"))
                .collect::<Vec<_>>()
        ),
    );
    next_prompt(&mut state);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let initial = projection.poll(0, false, vec![]);
    assert_eq!(projection.snapshot().len(), 4);
    let group = group_ids(&projection.snapshot())[0].clone();
    let expanded = projection.poll(initial.revision, false, vec![group.clone()]);
    assert_eq!(projection.snapshot().len(), 504);
    state.messages[0]
        .parts
        .push(serde_json::from_value(tool("extra", "Edit", "Completed")).unwrap());
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![AgentTranscriptDelta::MessageUpserted {
            index: 0,
            message: state.messages[0].clone(),
        }],
    });
    let update = projection.poll(expanded.revision, false, vec![group.clone()]);
    assert_eq!(projection.snapshot().len(), 505);
    assert_eq!(group_ids(&projection.snapshot()), [group]);
    assert!(
        update
            .patches
            .iter()
            .all(|patch| matches!(patch, AgentChatRowPatch::Splice { .. }))
    );
}

#[test]
fn long_turn_keeps_five_hundred_tools_in_order_for_every_provider() {
    for (agent, names) in [
        (
            AgentTranscriptKind::Claude,
            ["Bash", "Edit", "Agent", "AskUserQuestion", "Read"],
        ),
        (
            AgentTranscriptKind::Codex,
            [
                "shell",
                "patch",
                "spawn_agent",
                "request_user_input",
                "read",
            ],
        ),
        (
            AgentTranscriptKind::OpenCode,
            ["shell", "patch", "subagent", "question", "read"],
        ),
    ] {
        let mut state = fixture(1);
        state.agent = agent;
        let parts: Vec<_> = (0..501)
            .map(|index| tool(&index.to_string(), names[index % names.len()], "Completed"))
            .collect();
        state.messages[0] = message("m0", "Assistant", json!(parts));
        let rows = rows(&state, true);
        assert_eq!(rows.len(), 502);
        assert_eq!(
            rows.iter().map(|row| &row.id).collect::<HashSet<_>>().len(),
            rows.len()
        );
        assert!(streaming(&rows).is_empty());
        for (index, row) in rows[..501].iter().enumerate() {
            assert!(
                matches!(&row.content, AgentChatRowContent::Part { part_index, .. } if *part_index as usize == index)
            );
        }
    }
}

#[test]
fn filtering_retains_claude_todo_failures_questions_plans_notices_and_errors() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            text("empty", "  \n"),
            { "Reasoning": { "id": "reasoning", "text": "Think", "timestamp_ms": null } },
            tool("claude", "TodoWrite", "Completed"), tool("hidden", "todowrite", "Completed"),
            tool("failed", "todowrite", "Error"), tool("raw-tool:exec", "exec", "Running"),
            tool("raw-tool:wait", "wait", "Pending"), tool("raw-tool:command", "shell", "Completed"),
            tool("direct", "exec", "Completed"), tool("question", "functions.request_user_input", "Running"),
            { "Plan": { "id": "plan", "text": "", "timestamp_ms": null } },
            { "Notice": { "id": "notice", "text": "", "timestamp_ms": null, "level": "Warning" } }
        ]),
    );
    state.messages[0].error = Some("Failure".into());
    let rows = rows(&state, true);
    let ids: Vec<_> = rows
        .iter()
        .filter_map(|row| match &row.content {
            AgentChatRowContent::Part { part_id, .. } => Some(part_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        ids,
        [
            "reasoning",
            "claude",
            "failed",
            "raw-tool:command",
            "direct",
            "question",
            "plan",
            "notice"
        ]
    );
    assert!(matches!(
        rows[0].content,
        AgentChatRowContent::Part {
            first: true,
            part_index: 1,
            ..
        }
    ));
    assert!(matches!(rows[8].content, AgentChatRowContent::Error { .. }));
    assert_eq!(rows[8].spacing, AgentChatRowSpacing::Part);
    assert!(streaming(&rows).is_empty());
}

#[test]
fn final_eligible_unfinished_part_and_host_working_status() {
    let mut state = fixture(1);
    assert!(streaming(&rows(&state, false)).is_empty());
    assert_eq!(streaming(&rows(&state, true)), ["text"]);
    state.turns[0].status = AgentTurnStatus::Working;
    assert_eq!(streaming(&rows(&state, false)), ["text"]);
    state.messages[0].completed_at_ms = Some(1);
    assert!(streaming(&rows(&state, true)).is_empty());
    state.messages.push(message(
        "m1",
        "Assistant",
        json!([text("new", "More"), text("empty", " ")]),
    ));
    state.turns[0].assistant_message_ids.push("m1".into());
    assert_eq!(streaming(&rows(&state, true)), ["new"]);
    state.messages.push(message(
        "user",
        "User",
        json!([text("prompt", "Follow up")]),
    ));
    state.turns[0].message_ids = vec!["m0".into(), "m1".into(), "user".into()];
    assert!(streaming(&rows(&state, true)).is_empty());
    state.turns[0].message_ids = vec!["user".into(), "m0".into(), "user".into(), "m1".into()];
    assert_eq!(streaming(&rows(&state, true)), ["new"]);
    state.messages[1]
        .parts
        .push(serde_json::from_value(tool("tool", "shell", "Running")).unwrap());
    assert!(streaming(&rows(&state, true)).is_empty());
}

#[test]
fn thousand_turn_stream_updates_visit_only_the_affected_turn_and_send_no_text() {
    let mut state = fixture(1_001);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let mut client = Vec::new();
    let first = projection.poll(0, true, vec![]);
    assert!(projection.journal.is_empty());
    apply(&mut client, &first);
    let historical = client[..2_000].to_vec();
    let mut after = first.revision;
    projection.projected_turns = 0;
    for revision in 1..101 {
        state.messages[1_000].parts[0] = serde_json::from_value(text(
            "text",
            &"streaming".repeat(usize::try_from(revision).unwrap()),
        ))
        .unwrap();
        projection.accept(&AgentTranscriptUpdate {
            revision,
            deltas: vec![AgentTranscriptDelta::MessageUpserted {
                index: 1_000,
                message: state.messages[1_000].clone(),
            }],
        });
        let update = projection.poll(after, true, vec![]);
        assert!(update.patches.is_empty());
        after = update.revision;
        apply(&mut client, &update);
    }
    assert_eq!(projection.projected_turns, 0);
    assert_eq!(client[..2_000], historical);
}

#[test]
fn tail_changes_tools_complete_and_turn_append_use_local_splices() {
    let mut state = fixture(2);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, true, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &first);
    state.messages[1]
        .parts
        .push(serde_json::from_value(tool("shell", "shell", "Running")).unwrap());
    state.messages[1]
        .parts
        .push(serde_json::from_value(text("tail", "More")).unwrap());
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![AgentTranscriptDelta::MessageUpserted {
            index: 1,
            message: state.messages[1].clone(),
        }],
    });
    let update = projection.poll(first.revision, true, vec![]);
    assert!(matches!(
        update.patches[0],
        AgentChatRowPatch::Splice { index: 2, .. }
    ));
    apply(&mut client, &update);
    assert_eq!(streaming(&client), ["tail"]);
    for (revision, status) in [(2, "Completed"), (3, "Error")] {
        state.messages[1].parts[1] =
            serde_json::from_value(tool("shell", "shell", status)).unwrap();
        projection.accept(&AgentTranscriptUpdate {
            revision,
            deltas: vec![AgentTranscriptDelta::MessageUpserted {
                index: 1,
                message: state.messages[1].clone(),
            }],
        });
    }
    assert!(
        projection
            .poll(update.revision, true, vec![])
            .patches
            .is_empty()
    );
    let mut next = fixture(3);
    next.messages[2].role = AgentMessageRole::User;
    projection.accept(&AgentTranscriptUpdate {
        revision: 4,
        deltas: vec![
            AgentTranscriptDelta::MessageUpserted {
                index: 2,
                message: next.messages[2].clone(),
            },
            AgentTranscriptDelta::TurnUpserted {
                index: 2,
                turn: next.turns[2].clone(),
            },
        ],
    });
    let update = projection.poll(update.revision, true, vec![]);
    apply(&mut client, &update);
    assert!(streaming(&client).is_empty());
    assert!(matches!(
        client[client.len() - 2].content,
        AgentChatRowContent::User { .. }
    ));
    assert_eq!(client.last().unwrap().id, row_id(&["t2", "meta"]));
}

#[test]
fn expansion_is_viewport_local_and_ids_escape_duplicate_filenames() {
    let mut state = fixture(2);
    state.turns[1].id = "turn\"\\\n雪🦀".into();
    let file = AgentFileDiff::normalized(
        "same\"\\雪.rs".into(),
        Some("+needle".into()),
        None,
        None,
        None,
        None,
    );
    state.turns[1].diffs = vec![file.clone(), file];
    let section = row_id(&[&state.turns[1].id, "changes"]);
    let mut first = RowProjection::default();
    first.restore(&state);
    let mut second = RowProjection::default();
    second.restore(&state);
    let initial = first.poll(0, false, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &initial);
    let expanded = first.poll(initial.revision, false, vec![section]);
    assert!(
        matches!(&expanded.patches[..], [AgentChatRowPatch::Splice { index: 4, delete_count: 0, rows }] if rows.len() == 2)
    );
    apply(&mut client, &expanded);
    assert_eq!(
        client
            .iter()
            .map(|row| &row.id)
            .collect::<HashSet<_>>()
            .len(),
        client.len()
    );
    assert_eq!(client[3].spacing, AgentChatRowSpacing::None);
    assert_eq!(client[4].spacing, AgentChatRowSpacing::Part);
    assert_eq!(second.snapshot().len(), 5);
    let collapsed = first.poll(expanded.revision, false, vec![]);
    apply(&mut client, &collapsed);
    assert_eq!(client, second.snapshot());
    // Tool detail toggles never affect the native row list.
    assert!(
        first
            .poll(collapsed.revision, false, vec!["tool-detail".into()])
            .patches
            .is_empty()
    );
}

#[test]
fn stale_events_gaps_reset_and_bounded_journal_recovery() {
    let state = fixture(2);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let initial = projection.poll(0, false, vec![]);
    projection.accept(&AgentTranscriptUpdate {
        revision: 0,
        deltas: vec![],
    });
    assert_eq!(projection.revision, initial.revision);
    projection.accept(&AgentTranscriptUpdate {
        revision: 2,
        deltas: vec![],
    });
    assert!(projection.needs_reset);
    projection.restore(&AgentTranscriptState {
        revision: 2,
        ..state.clone()
    });
    assert!(matches!(
        &projection.poll(initial.revision, false, vec![]).patches[..],
        [AgentChatRowPatch::Reset { .. }]
    ));
    for revision in 3..200 {
        projection.accept(&AgentTranscriptUpdate {
            revision,
            deltas: vec![],
        });
    }
    assert!(projection.journal.len() <= JOURNAL_LIMIT);
    assert!(matches!(
        &projection.poll(0, false, vec![]).patches[..],
        [AgentChatRowPatch::Reset { .. }]
    ));
    let reset = AgentTranscriptState {
        revision: 200,
        ..fixture(1)
    };
    projection.accept(&AgentTranscriptUpdate::reset(reset));
    assert_eq!(projection.snapshot().len(), 2);
    assert_eq!(projection.transcript_revision, 200);
}

#[test]
fn legacy_authoritative_snapshots_also_preserve_historical_rows_and_send_no_streaming_rows() {
    let mut state = fixture(1_001);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, true, vec![]);
    projection.projected_turns = 0;
    state.revision = 1;
    state.messages[1_000].parts[0] = serde_json::from_value(text("text", "New content")).unwrap();
    projection.accept(&AgentTranscriptUpdate::reset(state));
    assert!(
        projection
            .poll(first.revision, true, vec![])
            .patches
            .is_empty()
    );
    assert_eq!(projection.projected_turns, 0);
}

#[test]
fn removal_truncation_and_empty_working_turn_keep_metadata_anchor() {
    let state = fixture(3);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let initial = projection.poll(0, true, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &initial);
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![
            AgentTranscriptDelta::MessagesTruncated { length: 1 },
            AgentTranscriptDelta::TurnsTruncated { length: 1 },
        ],
    });
    let update = projection.poll(initial.revision, true, vec![]);
    apply(&mut client, &update);
    assert_eq!(client, rows(&fixture(1), true));
    projection.accept(&AgentTranscriptUpdate {
        revision: 2,
        deltas: vec![AgentTranscriptDelta::MessageRemoved {
            index: 0,
            message_id: "m0".into(),
        }],
    });
    let update = projection.poll(update.revision, true, vec![]);
    apply(&mut client, &update);
    assert_eq!(client.len(), 1);
    assert_eq!(client[0].id, row_id(&["t0", "meta"]));
    projection.disposed = true;
    projection.accept(&AgentTranscriptUpdate::reset(fixture(4)));
    assert_eq!(projection.snapshot(), client);
}

#[test]
fn search_uses_identical_ids_and_reveals_hidden_diffs_without_private_ids() {
    let mut state = fixture(1);
    state.turns[0].diffs.push(AgentFileDiff::normalized(
        "雪.rs".into(),
        Some("+needle".into()),
        None,
        None,
        None,
        None,
    ));
    let documents = crate::search::transcript::documents(&state);
    let hit = documents
        .iter()
        .find(|document| document.text.contains("needle"))
        .unwrap();
    assert_eq!(hit.reveal[0], row_id(&["t0", "changes"]));
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let expanded = projection.poll(0, false, hit.reveal.clone());
    let mut client = Vec::new();
    apply(&mut client, &expanded);
    assert!(client.iter().any(|row| row.id == hit.id));
    assert!(
        documents
            .iter()
            .all(|document| !document.text.contains("m0") && !document.text.contains("t0"))
    );
}

#[test]
fn repeated_part_ids_in_messages_and_turns_remain_unique_and_searchable() {
    let mut state = fixture(2);
    let duplicate = state.messages[0].parts[0].clone();
    state.messages[0].parts.push(duplicate);
    state.messages.push(message(
        "m\"雪",
        "Assistant",
        json!([text("text", "Repeated")]),
    ));
    state.turns[0].assistant_message_ids.push("m\"雪".into());
    let projected = rows(&state, true);
    assert_eq!(
        projected
            .iter()
            .map(|row| &row.id)
            .collect::<HashSet<_>>()
            .len(),
        projected.len()
    );
    assert_eq!(projected[0].id, row_id(&["t0", "part", "m0", "text"]));
    assert_eq!(projected[1].id, row_id(&["t0", "part", "m0", "text", "1"]));
    let documents = crate::search::transcript::documents(&state);
    assert_eq!(
        documents
            .iter()
            .map(|doc| &doc.id)
            .collect::<HashSet<_>>()
            .len(),
        documents.len()
    );
    assert!(
        documents
            .iter()
            .all(|doc| projected.iter().any(|row| row.id == doc.id))
    );
}

#[test]
fn new_assistant_messages_and_empty_parts_reassign_first_timestamp_and_streaming_tail() {
    let mut state = fixture(2);
    state.turns[0].assistant_message_ids.clear();
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let initial = projection.poll(0, true, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &initial);
    assert_eq!(client[0].content, AgentChatRowContent::Meta);
    assert_eq!(client[1].spacing, AgentChatRowSpacing::Turn);
    let mut assistant = message(
        "a2",
        "Assistant",
        json!([text("empty", " "), text("next", "Content")]),
    );
    assistant.created_at_ms = Some(42);
    state.messages.push(assistant.clone());
    state.turns[1]
        .assistant_message_ids
        .push(assistant.id.clone());
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![
            AgentTranscriptDelta::MessageUpserted {
                index: 2,
                message: assistant.clone(),
            },
            AgentTranscriptDelta::TurnUpserted {
                index: 1,
                turn: state.turns[1].clone(),
            },
        ],
    });
    let update = projection.poll(initial.revision, true, vec![]);
    apply(&mut client, &update);
    assert_eq!(streaming(&client), ["next"]);
    assert!(matches!(
        client[2].content,
        AgentChatRowContent::Part {
            first: true,
            part_index: 1,
            ..
        }
    ));
    assistant.parts[0] = serde_json::from_value(text("empty", "Now visible")).unwrap();
    projection.accept(&AgentTranscriptUpdate {
        revision: 2,
        deltas: vec![AgentTranscriptDelta::MessageUpserted {
            index: 2,
            message: assistant,
        }],
    });
    let update = projection.poll(update.revision, true, vec![]);
    apply(&mut client, &update);
    assert!(matches!(
        client[2].content,
        AgentChatRowContent::Part {
            first: true,
            part_index: 0,
            ..
        }
    ));
    assert!(matches!(
        client[3].content,
        AgentChatRowContent::Part {
            first: false,
            streaming: true,
            ..
        }
    ));
    assert_eq!(client.last().unwrap().id, row_id(&["t1", "meta"]));
}

#[test]
fn unicode_empty_filter_matches_javascript_trim_including_bom_and_nel() {
    let mut state = fixture(1);
    state.messages[0] = message(
        "m0",
        "Assistant",
        json!([
            text("bom", "\u{feff}"),
            text("nel", "\u{0085}"),
            text("separators", "\u{2028}\u{2029}"),
        ]),
    );
    let projected = rows(&state, true);
    assert_eq!(projected.len(), 2);
    assert!(
        matches!(&projected[0].content, AgentChatRowContent::Part { part_id, first: true, streaming: true, .. } if part_id == "nel")
    );
}

#[test]
fn a_backlog_of_text_updates_cannot_overflow_the_row_journal() {
    let state = fixture(2_500);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, true, vec![]);
    for revision in 1..=1_000 {
        projection.accept(&AgentTranscriptUpdate {
            revision,
            deltas: vec![AgentTranscriptDelta::MessageUpserted {
                index: 2_499,
                message: state.messages[2_499].clone(),
            }],
        });
    }
    let resumed = projection.poll(first.revision, true, vec![]);
    assert_eq!(resumed.revision, first.revision);
    assert_eq!(resumed.transcript_revision, 1_000);
    assert!(resumed.patches.is_empty());
    assert!(projection.journal.is_empty());
}

#[test]
fn a_structural_backlog_beyond_the_bound_recovers_with_a_snapshot() {
    let mut state = fixture(1);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, false, vec![]);
    for index in 0..JOURNAL_LIMIT + 2 {
        state.messages[0].parts.push(
            serde_json::from_value(tool(&format!("tool-{index}"), "shell", "Completed")).unwrap(),
        );
        projection.accept(&AgentTranscriptUpdate {
            revision: u64::try_from(index + 1).unwrap(),
            deltas: vec![AgentTranscriptDelta::MessageUpserted {
                index: 0,
                message: state.messages[0].clone(),
            }],
        });
    }
    assert_eq!(projection.journal.len(), JOURNAL_LIMIT);
    let resumed = projection.poll(first.revision, false, vec![]);
    let expected = rows(&state, false);
    assert!(
        matches!(&resumed.patches[..], [AgentChatRowPatch::Reset { rows }] if rows == &expected)
    );
    assert!(projection.journal.is_empty());
}

#[test]
fn removing_the_last_assistant_does_not_stream_text_before_the_last_user() {
    let mut state = fixture(1);
    state
        .messages
        .push(message("u", "User", json!([text("prompt", "Follow up")])));
    state
        .messages
        .push(message("a", "Assistant", json!([text("tail", "Answer")])));
    state.turns[0].message_ids = vec!["m0".into(), "u".into(), "a".into()];
    state.turns[0].assistant_message_ids.push("a".into());
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let first = projection.poll(0, true, vec![]);
    let mut client = Vec::new();
    apply(&mut client, &first);
    assert_eq!(streaming(&client), ["tail"]);
    projection.accept(&AgentTranscriptUpdate {
        revision: 1,
        deltas: vec![AgentTranscriptDelta::MessageRemoved {
            index: 2,
            message_id: "a".into(),
        }],
    });
    apply(&mut client, &projection.poll(first.revision, true, vec![]));
    assert!(streaming(&client).is_empty());
    assert_eq!(client.last().unwrap().id, row_id(&["t0", "meta"]));
}
