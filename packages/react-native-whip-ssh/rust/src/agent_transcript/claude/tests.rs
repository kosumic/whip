use super::*;
use serde_json::json;

const SESSION: &str = "11111111-1111-4111-8111-111111111111";
const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/claude/main.jsonl");

fn line(value: Value) -> Vec<u8> {
    format!("{value}\n").into_bytes()
}
fn user(id: &str, parent: Option<&str>, content: Value) -> Value {
    json!({"type":"user", "uuid":id, "parentUuid":parent, "sessionId":SESSION, "timestamp":"2026-09-29T12:00:00Z", "message":{"role":"user","content":content}})
}
fn assistant(id: &str, parent: &str, content: Value) -> Value {
    json!({"type":"assistant", "uuid":id, "parentUuid":parent, "sessionId":SESSION, "timestamp":"2026-09-29T12:00:01Z", "message":{"role":"assistant","content":content,"stop_reason":null}})
}
fn parse(bytes: &[u8]) -> ClaudeSessionCore {
    let mut core = ClaudeSessionCore::new(SESSION);
    let binding = core.bind_source("/transcript".into(), "1:2".into(), bytes.len() as u64);
    core.ingest(binding.source_generation, bytes).unwrap();
    core
}
fn tools(state: &AgentTranscriptState) -> Vec<(&str, &AgentToolState)> {
    state
        .messages
        .iter()
        .flat_map(|message| &message.parts)
        .filter_map(|part| match part {
            AgentTranscriptPart::Tool { call_id, state, .. } => Some((call_id.as_str(), state)),
            _ => None,
        })
        .collect()
}
fn ids(state: &AgentTranscriptState) -> Vec<&str> {
    state.messages.iter().map(|m| m.id.as_str()).collect()
}
fn tool_prefix() -> Vec<u8> {
    [line(user("u",None,json!("Run checks"))), line(assistant("a","u",json!([
        {"type":"text","text":"Checking now."},
        {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cargo test","timeout":1000,"background":false}}
    ])))].concat()
}
fn result(content: Value, error: bool) -> Value {
    user(
        "r",
        Some("a"),
        json!([{"type":"tool_result","tool_use_id":"toolu_1","content":content,"is_error":error}]),
    )
}

#[test]
fn uploaded_image_survives_claude_history_and_checkpoint_restore() {
    let bytes = line(user(
        "u",
        None,
        json!("Describe /home/me/.whip/uploads/cat.png"),
    ));
    let core = parse(&bytes);
    let parts = &core.state().messages[0].parts;
    assert!(matches!(&parts[0], AgentTranscriptPart::Text { text, .. } if text == "Describe"));
    assert!(
        matches!(&parts[1], AgentTranscriptPart::Image { source, .. } if source.ends_with("cat.png"))
    );
    let mut restored = ClaudeSessionCore::new(SESSION);
    restored.restore_cache(&core.cache_blob().unwrap()).unwrap();
    assert_eq!(restored.state().messages, core.state().messages);
}

#[test]
fn realistic_history_projects_one_turn_and_reconciles_tools() {
    let state = parse(FIXTURE).state();
    assert_eq!(state.agent, AgentTranscriptKind::Claude);
    assert_eq!(state.status, AgentTranscriptStatus::Live);
    assert_eq!(
        ids(&state),
        [
            "user-1",
            "thinking-1",
            "assistant-1",
            "assistant-2",
            "assistant-3"
        ]
    );
    assert_eq!(state.turns.len(), 1);
    assert_eq!(state.turns[0].assistant_message_ids.len(), 4);
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
    assert_eq!(
        state.info.as_ref().unwrap().title.as_deref(),
        Some("Greeting build check")
    );
    assert_eq!(
        state.info.as_ref().unwrap().directory.as_deref(),
        Some("/work/whip")
    );
    let tools = tools(&state);
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].1.output.as_deref(), Some("All tests passed"));
    assert_eq!(tools[0].1.exit_code, Some(0));
    assert_eq!(tools[0].1.status, AgentToolStatus::Completed);
    assert!(tools[0].1.completed_at_ms.is_some());
    assert_eq!(tools[1].1.output.as_deref(), Some("Updated greeting."));
    assert_eq!(tools[1].1.files[0].additions, 1);
    assert_eq!(tools[1].1.files[0].deletions, 1);
    assert_eq!(state.turns[0].diffs.len(), 1);
    assert_eq!(state.messages[1].parts.len(), 1);
    assert!(
        matches!(&state.messages[1].parts[0],AgentTranscriptPart::Reasoning {text,..} if text == "I will inspect the build output.")
    );
    assert_eq!(state.messages[3].parts.len(), 3);
}

#[test]
fn user_and_assistant_strings_and_text_arrays() {
    for content in [
        json!("Hello"),
        json!([{"type":"text","text":"Hello"}]),
        json!(["Hello"]),
    ] {
        let state = parse(
            &[
                line(user("u", None, content)),
                line(assistant(
                    "a",
                    "u",
                    json!([{"type":"text","text":"Hi"},{"type":"text","text":"there"}]),
                )),
            ]
            .concat(),
        )
        .state();
        assert_eq!(ids(&state), ["u", "a"]);
        assert_eq!(state.messages[0].role, AgentMessageRole::User);
        assert_eq!(state.messages[1].role, AgentMessageRole::Assistant);
        assert_eq!(state.messages[1].parts.len(), 2);
        assert!(state.messages[1].completed_at_ms.is_some());
    }
}

#[test]
fn cached_question_tools_gain_a_read_only_summary_from_their_recorded_input() {
    let core = parse(&[
        line(user("u", None, json!("Choose a database"))),
        line(assistant("a", "u", json!([{
            "type":"tool_use", "id":"question", "name":"AskUserQuestion", "input":{
                "questions":[{"question":"Which database?", "options":[{"label":"SQLite", "description":"Local storage"}]}]
            }
        }]))),
    ].concat());
    let mut cached: ClaudeCheckpoint = serde_json::from_slice(&core.cache_blob().unwrap()).unwrap();
    for node in &mut cached.adapter.nodes {
        if let Some(message) = &mut node.message {
            for part in &mut message.parts {
                if let AgentTranscriptPart::Tool { state, .. } = part {
                    state.input.retain(|field| field.key != "question_summary");
                    state.questions.clear();
                }
            }
        }
    }
    let mut restored = ClaudeSessionCore::new(SESSION);
    let state = restored
        .restore_cache(&serde_json::to_vec(&cached).unwrap())
        .unwrap();
    assert!(tools(&state)[0].1.input.contains(&AgentField {
        key: "question_summary".into(),
        value: AgentScalarValue::String {
            value: "Which database?\n• SQLite: Local storage".into()
        },
    }));
    assert_eq!(tools(&state)[0].1.questions[0].options[0].label, "SQLite");
}

#[test]
fn tool_use_is_running_with_stable_identity_and_input() {
    let state = parse(&tool_prefix()).state();
    let part = &state.messages[1].parts[1];
    let AgentTranscriptPart::Tool {
        id,
        call_id,
        tool,
        state: tool_state,
        ..
    } = part
    else {
        panic!("expected tool");
    };
    assert_eq!(id, "claude-tool:toolu_1");
    assert_eq!(call_id, "toolu_1");
    assert_eq!(tool, "Bash");
    assert_eq!(tool_state.status, AgentToolStatus::Running);
    assert!(tool_state.input.iter().any(|field| field.key == "command"
        && field.value
            == AgentScalarValue::String {
                value: "cargo test".into()
            }));
    assert_eq!(state.turns[0].status, AgentTurnStatus::Working);
}

#[test]
fn string_array_and_structured_results_never_create_user_bubbles() {
    for content in [
        json!("done"),
        json!([{"type":"text","text":"done"},{"type":"image","source":{"data":"secret-base64"}}]),
        json!({"content":[{"type":"text","text":"done"}],"source":{"data":"secret-base64"}}),
    ] {
        let state = parse(&[tool_prefix(), line(result(content, false))].concat()).state();
        assert_eq!(ids(&state), ["u", "a"]);
        assert_eq!(tools(&state)[0].1.output.as_deref(), Some("done"));
        assert_eq!(tools(&state)[0].1.status, AgentToolStatus::Completed);
    }
}

#[test]
fn tool_errors_exit_status_and_interruption() {
    for (rich, is_error, expected) in [
        (json!(null), true, AgentTurnStatus::Error),
        (
            json!({"stdout":"failed","stderr":"bad command","exitCode":2}),
            false,
            AgentTurnStatus::Error,
        ),
        (
            json!({"interrupted":true}),
            false,
            AgentTurnStatus::Interrupted,
        ),
    ] {
        let mut record = result(json!("failure"), is_error);
        record["toolUseResult"] = rich;
        let state = parse(&[tool_prefix(), line(record)].concat()).state();
        assert_eq!(tools(&state)[0].1.status, AgentToolStatus::Error);
        assert!(tools(&state)[0].1.error.is_some());
        assert_eq!(state.turns[0].status, expected);
    }
}

#[test]
fn unknown_records_and_content_and_meta_prompts_are_not_bubbles() {
    let mut meta = user("meta", Some("u"), json!("internal prompt"));
    meta["isMeta"] = json!(true);
    let bytes=[line(user("u",None,json!("Hi"))),line(meta),line(json!({"type":"future-event","uuid":"bridge","parentUuid":"meta","payload":"do not display"})),line(assistant("a","bridge",json!([{"type":"future-block","text":"ignore"},{"type":"redacted_thinking","data":"secret"},{"type":"text","text":"Hello"}])))].concat();
    let state = parse(&bytes).state();
    assert_eq!(ids(&state), ["u", "a"]);
    assert_eq!(state.messages[1].parts.len(), 1);
}

#[test]
fn ancestry_orders_late_parents_and_selects_latest_branch() {
    let bytes = [
        line(assistant(
            "child",
            "parent",
            json!([{"type":"text","text":"child"}]),
        )),
        line(user("u", None, json!("Hi"))),
        line(assistant(
            "parent",
            "u",
            json!([{"type":"text","text":"parent"}]),
        )),
    ]
    .concat();
    assert_eq!(ids(&parse(&bytes).state()), ["u", "parent", "child"]);
    let bytes = [
        bytes,
        line(user("replacement", Some("u"), json!("Try again"))),
        line(assistant(
            "new",
            "replacement",
            json!([{"type":"text","text":"new branch"}]),
        )),
    ]
    .concat();
    assert_eq!(ids(&parse(&bytes).state()), ["u", "replacement", "new"]);
    let bytes = [
        bytes,
        line(json!({"type":"progress", "uuid":"tail-progress", "parentUuid":"new"})),
    ]
    .concat();
    assert_eq!(ids(&parse(&bytes).state()), ["u", "replacement", "new"]);
}

#[test]
fn broken_missing_and_cyclic_parents_fall_back_without_losing_chat() {
    for parent in [json!("missing"), json!(42), json!("a")] {
        let mut a = assistant("a", "u", json!([{"type":"text","text":"answer"}]));
        a["parentUuid"] = parent;
        assert_eq!(
            ids(&parse(&[line(user("u", None, json!("Hi"))), line(a)].concat()).state()),
            ["u", "a"]
        );
    }
}

#[test]
fn sidechain_nodes_preserve_links_without_exposing_subagent_content() {
    let mut side = assistant("side", "u", json!([{"type":"text","text":"private"}]));
    side["isSidechain"] = json!(true);
    let bytes = [
        line(user("u", None, json!("Hi"))),
        line(side),
        line(assistant(
            "a",
            "side",
            json!([{"type":"text","text":"main"}]),
        )),
    ]
    .concat();
    assert_eq!(ids(&parse(&bytes).state()), ["u", "a"]);
}

#[test]
fn last_prompt_can_select_a_known_branch_but_unknown_leaf_is_ignored() {
    let bytes = [
        line(user("u", None, json!("Hi"))),
        line(assistant("a", "u", json!("first"))),
        line(assistant("b", "u", json!("second"))),
    ]
    .concat();
    for (leaf, expected) in [("a", "a"), ("unknown", "b")] {
        let all = [
            bytes.clone(),
            line(json!({"type":"last-prompt","sessionId":SESSION,"leafUuid":leaf})),
        ]
        .concat();
        assert_eq!(ids(&parse(&all).state()), ["u", expected]);
    }
}

#[test]
fn mismatched_session_and_sidechain_title_cannot_poison_main_state() {
    let mut wrong = user("wrong", None, json!("wrong"));
    wrong["sessionId"] = json!("another-session");
    let state = parse(
        &[
            FIXTURE.to_vec(),
            line(wrong),
            line(json!({"type":"custom-title","customTitle":"wrong","isSidechain":true})),
        ]
        .concat(),
    )
    .state();
    assert_eq!(state.messages.len(), 5);
    assert_eq!(
        state.info.unwrap().title.as_deref(),
        Some("Greeting build check")
    );
}

#[test]
fn chunk_boundaries_partial_utf8_and_append_are_semantically_irrelevant() {
    let expected = parse(FIXTURE).state();
    for chunk_size in [1, 7, 97, 1024] {
        let mut core = ClaudeSessionCore::new(SESSION);
        let b = core.bind_source("/transcript".into(), "1:2".into(), FIXTURE.len() as u64);
        for chunk in FIXTURE.chunks(chunk_size) {
            core.ingest(b.source_generation, chunk).unwrap();
        }
        assert_eq!(core.state().messages, expected.messages);
        assert_eq!(core.state().turns, expected.turns);
    }
    let mut core = parse(&tool_prefix());
    let generation = core.source_generation();
    let record = line(result(json!("done ✓"), false));
    let before = core.committable_offset();
    core.ingest(generation, &record[..record.len() - 1])
        .unwrap();
    assert_eq!(core.committable_offset(), before);
    let update = core.ingest(generation, b"\n").unwrap().update.unwrap();
    assert!(
        update
            .deltas
            .iter()
            .any(|d| matches!(d, AgentTranscriptDelta::MessageUpserted { index: 1, .. }))
    );
    assert!(
        !update
            .deltas
            .iter()
            .any(|d| matches!(d, AgentTranscriptDelta::Reset { .. }))
    );
    assert_eq!(tools(&core.state())[0].1.status, AgentToolStatus::Completed);
}

#[test]
fn cache_restores_byte_offset_and_unfinished_tools_without_historical_replay() {
    let prefix = tool_prefix();
    let suffix = line(result(json!("done"), false));
    let mut core = parse(&prefix);
    core.ingest(core.source_generation(), &suffix[..13])
        .unwrap();
    let blob = core.cache_blob().unwrap();
    assert_eq!(core.committed_offset(), 0);
    assert!(core.confirm_cache(core.source_generation(), prefix.len() as u64));
    let mut restored = ClaudeSessionCore::new(SESSION);
    assert_eq!(
        restored.restore_cache(&blob).unwrap().status,
        AgentTranscriptStatus::Loading
    );
    let b = restored.bind_source(
        "/transcript".into(),
        "1:2".into(),
        (prefix.len() + suffix.len()) as u64,
    );
    assert_eq!(b.start_offset, prefix.len() as u64);
    assert!(!b.rebuilt);
    restored.ingest(b.source_generation, &suffix).unwrap();
    let all = parse(&[prefix, suffix].concat()).state();
    assert_eq!(restored.state().messages, all.messages);
    assert_eq!(restored.state().turns, all.turns);
    assert!(
        ClaudeSessionCore::new("other")
            .restore_cache(&blob)
            .is_err()
    );
    let mut corrupt: Value = serde_json::from_slice(&blob).unwrap();
    corrupt["offset"] = json!(1);
    assert!(
        ClaudeSessionCore::new(SESSION)
            .restore_cache(&serde_json::to_vec(&corrupt).unwrap())
            .is_err()
    );
}

#[test]
fn reconnect_drops_partial_tail_and_rejects_old_generation_and_confirmation() {
    let mut core = parse(&tool_prefix());
    let old = core.source_generation();
    let offset = core.committable_offset();
    core.ingest(old, b"{\"type\":").unwrap();
    core.mark_stale_update("offline");
    assert_eq!(core.state().status, AgentTranscriptStatus::Stale);
    let b = core.bind_source("/transcript".into(), "1:2".into(), offset);
    assert_eq!(b.start_offset, offset);
    assert!(core.mark_live_update().is_some());
    assert!(!core.ingest(old, b"garbage\n").unwrap().changed);
    assert!(!core.confirm_cache(old, offset));
    assert!(core.confirm_cache(b.source_generation, offset));
    assert_eq!(ids(&core.state()), ["u", "a"]);
}

#[test]
fn truncation_and_replacement_reset_projection_and_cursor() {
    for (path, file_id, size) in [
        ("/transcript", "1:2", 0),
        ("/transcript", "1:3", FIXTURE.len() as u64),
        ("/other", "1:2", FIXTURE.len() as u64),
    ] {
        let mut core = parse(FIXTURE);
        let old = core.source_generation();
        let b = core.bind_source(path.into(), file_id.into(), size);
        assert!(b.rebuilt);
        assert_eq!(b.start_offset, 0);
        assert!(core.state().messages.is_empty());
        assert_eq!(core.committed_offset(), 0);
        assert!(core.ingest(old, FIXTURE).unwrap().update.is_none());
        core.ingest(b.source_generation, FIXTURE).unwrap();
        assert_eq!(core.state().messages.len(), 5);
    }
}

#[test]
fn malformed_complete_records_advance_safe_cursor_but_partial_tail_does_not() {
    let mut core = parse(&[tool_prefix(), b"not json\n\xff\n".to_vec()].concat());
    assert_eq!(core.committable_offset(), core.received_offset());
    let offset = core.committable_offset();
    let generation = core.source_generation();
    core.ingest(generation, b"{\"partial\":").unwrap();
    assert_eq!(core.committable_offset(), offset);
    let cached = core.cache_blob().unwrap();
    let mut restored = ClaudeSessionCore::new(SESSION);
    restored.restore_cache(&cached).unwrap();
    assert_eq!(restored.committed_offset(), offset);
    assert_eq!(ids(&restored.state()), ["u", "a"]);
}

#[test]
fn giant_rich_output_is_bounded_in_projection_and_checkpoint() {
    let record = result(
        json!([{"type":"image","source":{"type":"base64","data":"A".repeat(1_000_000)}},{"type":"text","text":"✓".repeat(100_000)}]),
        false,
    );
    let core = parse(&[tool_prefix(), line(record)].concat());
    let state = core.state();
    assert!(tools(&state)[0].1.output.as_ref().unwrap().len() <= MAX_TEXT_BYTES);
    let blob = core.cache_blob().unwrap();
    assert!(blob.len() < MAX_TEXT_BYTES + 10_000);
    assert!(!String::from_utf8(blob).unwrap().contains(&"A".repeat(100)));
}

#[test]
fn oversized_record_is_discarded_and_following_record_recovers() {
    let mut core = parse(&tool_prefix());
    let generation = core.source_generation();
    core.ingest(generation, &vec![b'x'; MAX_TRANSCRIPT_LINE_BYTES + 1])
        .unwrap();
    let r = core
        .ingest(
            generation,
            &[b"\n".to_vec(), line(result(json!("done"), false))].concat(),
        )
        .unwrap();
    assert_eq!(r.malformed_records, 1);
    assert_eq!(tools(&core.state())[0].1.status, AgentToolStatus::Completed);
}

#[test]
fn malformed_or_unmatched_tool_results_do_not_become_user_prompts() {
    for block in [
        json!({"type":"tool_result","content":"missing call id"}),
        json!({"type":"tool_result","tool_use_id":"missing","content":"unknown call"}),
    ] {
        let result = user(
            "r",
            Some("a"),
            json!([block,{"type":"text","text":"injected tool annotation"}]),
        );
        let state = parse(&[tool_prefix(), line(result)].concat()).state();
        assert_eq!(ids(&state), ["u", "a"]);
    }
}

#[test]
fn branch_updates_truncate_before_inserting_different_ids() {
    let mut core = parse(
        &[
            line(user("u", None, json!("Hi"))),
            line(assistant("old", "u", json!("old branch"))),
        ]
        .concat(),
    );
    let mut replay = core.state();
    let update = core
        .ingest(
            core.source_generation(),
            &line(assistant("new", "u", json!("new branch"))),
        )
        .unwrap()
        .update
        .unwrap();
    for delta in update.deltas {
        match delta {
            AgentTranscriptDelta::MessagesTruncated { length } => {
                replay.messages.truncate(length as usize);
            }
            AgentTranscriptDelta::TurnsTruncated { length } => {
                replay.turns.truncate(length as usize);
            }
            AgentTranscriptDelta::MessageUpserted { index, message } => {
                let index = index as usize;
                if index == replay.messages.len() {
                    replay.messages.push(message);
                } else {
                    assert_eq!(replay.messages[index].id, message.id);
                    replay.messages[index] = message;
                }
            }
            AgentTranscriptDelta::TurnUpserted { index, turn } => {
                let index = index as usize;
                if index == replay.turns.len() {
                    replay.turns.push(turn);
                } else {
                    assert_eq!(replay.turns[index].id, turn.id);
                    replay.turns[index] = turn;
                }
            }
            _ => {}
        }
    }
    assert_eq!(replay.messages, core.state().messages);
    assert_eq!(replay.turns, core.state().turns);
}

/// Download/checksum verification is handled by scripts/test-claude-transcript.mjs.
/// The normal suite stays offline; this explicit integration check uses the
/// unmodified public capture, including its original whitespace and metadata.
#[test]
#[ignore = "run nix develop -c node scripts/test-claude-transcript.mjs"]
fn downloaded_claude_capture() {
    let path = std::env::var("WHIP_CLAUDE_CAPTURE").unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let session = "11ca4767-8961-4e8e-a05f-758f26bd2edc";
    let records = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 43);
    let load = |chunk_size| {
        let mut core = ClaudeSessionCore::new(session);
        let binding = core.bind_source(path.clone(), "public:fixture".into(), bytes.len() as u64);
        for chunk in bytes.chunks(chunk_size) {
            assert_eq!(
                core.ingest(binding.source_generation, chunk)
                    .unwrap()
                    .malformed_records,
                0
            );
        }
        core
    };
    let whole = load(bytes.len());
    let state = whole.state();
    println!(
        "Public capture: {} records -> {} messages, {} turns, {} tools",
        records.len(),
        state.messages.len(),
        state.turns.len(),
        tools(&state).len()
    );
    assert_eq!(state.status, AgentTranscriptStatus::Live);
    assert_eq!(state.messages.len(), 26);
    assert_eq!(state.turns.len(), 9);
    for chunk_size in [1, 97, 4096] {
        let chunked = load(chunk_size).state();
        assert_eq!(chunked.messages, state.messages);
        assert_eq!(chunked.turns, state.turns);
        assert_eq!(chunked.info, state.info);
    }
    // Resume at every complete physical boundary with an unfinished suffix in
    // flight. This exercises cached ancestry, open tools, and durable offsets.
    for (offset, _) in bytes.iter().enumerate().filter(|(_, byte)| **byte == b'\n') {
        let offset = offset + 1;
        let mut prefix = ClaudeSessionCore::new(session);
        let binding = prefix.bind_source(path.clone(), "public:fixture".into(), bytes.len() as u64);
        prefix
            .ingest(binding.source_generation, &bytes[..offset])
            .unwrap();
        prefix
            .ingest(
                binding.source_generation,
                &bytes[offset..(offset + 7).min(bytes.len())],
            )
            .unwrap();
        let blob = prefix.cache_blob().unwrap();
        let mut restored = ClaudeSessionCore::new(session);
        restored.restore_cache(&blob).unwrap();
        let binding =
            restored.bind_source(path.clone(), "public:fixture".into(), bytes.len() as u64);
        assert_eq!(binding.start_offset, offset as u64);
        restored
            .ingest(binding.source_generation, &bytes[offset..])
            .unwrap();
        restored.mark_live_update();
        assert_eq!(
            restored.state().messages,
            state.messages,
            "resume at {offset}"
        );
        assert_eq!(restored.state().turns, state.turns, "resume at {offset}");
    }
    let projected_tools = tools(&state);
    assert_eq!(projected_tools.len(), 3);
    assert!(
        projected_tools
            .iter()
            .all(|(_, tool)| tool.status == AgentToolStatus::Error)
    );
    let result_ids = records
        .iter()
        .filter(|record| {
            record["message"]["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
        })
        .filter_map(|record| record["uuid"].as_str());
    for id in result_ids {
        assert!(!state.messages.iter().any(|message| message.id == id));
    }
    let blank = state
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .filter(
            |part| matches!(part, AgentTranscriptPart::Text {text,..} if text.trim().is_empty()),
        )
        .count();
    assert_eq!(
        blank, 0,
        "real persisted whitespace blocks must not create empty bubbles"
    );
    assert_eq!(
        state.turns.last().unwrap().status,
        AgentTurnStatus::Error,
        "isApiErrorMessage must mark the final turn as failed"
    );
    assert!(
        state
            .turns
            .iter()
            .any(|turn| turn.status == AgentTurnStatus::Interrupted)
    );
}

#[test]
fn persisted_blank_interruption_and_api_error_records_keep_their_turns() {
    let interruption = user(
        "stop",
        Some("blank"),
        json!([{"type":"text","text":"[Request interrupted by user]"}]),
    );
    let mut error = assistant(
        "error",
        "next",
        json!([{"type":"text","text":"API Error: 400 invalid_request_error"}]),
    );
    error["isApiErrorMessage"] = json!(true);
    let bytes = [
        line(user("u", None, json!("hello"))),
        line(assistant(
            "blank",
            "u",
            json!([{"type":"text","text":"\n\n"}]),
        )),
        line(interruption),
        line(user("next", Some("stop"), json!("test"))),
        line(error),
    ]
    .concat();
    let state = parse(&bytes).state();
    assert_eq!(ids(&state), ["u", "stop", "next", "error"]);
    assert_eq!(state.turns.len(), 2);
    assert_eq!(state.turns[0].status, AgentTurnStatus::Interrupted);
    assert_eq!(state.turns[1].status, AgentTurnStatus::Error);
    assert_eq!(state.messages[1].role, AgentMessageRole::Assistant);
    assert!(matches!(
        &state.messages[1].parts[0],
        AgentTranscriptPart::Notice {
            level: AgentNoticeLevel::Warning,
            ..
        }
    ));
    assert!(matches!(
        &state.messages[3].parts[0],
        AgentTranscriptPart::Notice {
            level: AgentNoticeLevel::Error,
            ..
        }
    ));
    // Only Claude's exact structured marker is a control record. Ordinary user
    // prose containing the same words is still a user message.
    let literal = parse(&line(user(
        "literal",
        None,
        json!("[Request interrupted by user]"),
    )))
    .state();
    assert_eq!(literal.messages[0].role, AgentMessageRole::User);
}
