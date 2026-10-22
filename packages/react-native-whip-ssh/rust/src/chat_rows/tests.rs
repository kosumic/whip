use serde_json::json;

use super::*;
use crate::{AgentFileDiff, AgentTranscriptKind};

fn message(id: &str, role: &str, parts: serde_json::Value) -> AgentTranscriptMessage {
    serde_json::from_value(json!({ "id": id, "role": role, "parts": parts, "diffs": [] })).unwrap()
}

fn text(id: &str, value: &str) -> serde_json::Value {
    json!({ "Text": { "id": id, "text": value, "timestamp_ms": null } })
}

fn tool(id: &str, name: &str, status: &str) -> serde_json::Value {
    json!({ "Tool": { "id": id, "call_id": id, "tool": name, "timestamp_ms": null,
        "state": { "status": status, "input": [], "output": null, "error": null, "title": null,
            "started_at_ms": null, "completed_at_ms": null, "exit_code": null } } })
}

pub(super) fn fixture(count: usize) -> AgentTranscriptState {
    let mut state = AgentTranscriptState::empty("session".into(), AgentTranscriptKind::Codex);
    for index in 0..count {
        let id = format!("m{index}");
        state
            .messages
            .push(message(&id, "Assistant", json!([text("text", "Hello")])));
        state.turns.push(AgentTranscriptTurn {
            id: format!("t{index}"),
            user_message_id: None,
            assistant_message_ids: vec![id],
            message_ids: vec![],
            status: AgentTurnStatus::Idle,
            started_at_ms: None,
            completed_at_ms: None,
            diffs: vec![],
            details: None,
        });
    }
    state
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
    let documents = crate::chat_search::transcript::documents(&state);
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
    let documents = crate::chat_search::transcript::documents(&state);
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
    assert!(
        matches!(&resumed.patches[..], [AgentChatRowPatch::Reset { rows }] if rows.len() == JOURNAL_LIMIT + 4)
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
