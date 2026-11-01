use super::*;
use crate::agent_transcript::AgentTranscriptDelta;
use serde_json::{Value, json};

const SESSION: &str = "pi-session";
pub(crate) const FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/pi/main.jsonl");

fn line(value: Value) -> Vec<u8> {
    format!("{value}\n").into_bytes()
}

fn loaded() -> PiSessionCore {
    let mut core = PiSessionCore::new(SESSION);
    let source = core.bind_source("/session.jsonl".into(), "1:2".into(), FIXTURE.len() as u64);
    core.ingest(source.source_generation, FIXTURE).unwrap();
    core
}

#[test]
fn projects_text_reasoning_tool_results_metadata_and_usage() {
    let state = loaded().state();
    assert_eq!(state.agent, AgentTranscriptKind::Pi);
    assert_eq!(state.status, AgentTranscriptStatus::Live);
    let info = state.info.unwrap();
    assert_eq!(info.title.as_deref(), Some("Greeting fix"));
    assert_eq!(info.directory.as_deref(), Some("/project"));
    assert_eq!(
        state
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "a1", "a2"]
    );
    assert_eq!(state.turns.len(), 1);
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
    let assistant = &state.messages[1];
    assert_eq!(assistant.parts.len(), 3);
    assert!(
        matches!(&assistant.parts[0], AgentTranscriptPart::Reasoning { text, .. } if text == "Check the greeting.")
    );
    let usage = assistant.details.as_ref().unwrap().usage.as_ref().unwrap();
    assert_eq!(usage.input, Some(33));
    assert_eq!(usage.output, Some(5));
    assert_eq!(usage.total, Some(38));
    let AgentTranscriptPart::Tool { state, call_id, .. } = &assistant.parts[2] else {
        panic!("tool")
    };
    assert_eq!(call_id, "edit-call");
    assert_eq!(state.status, AgentToolStatus::Completed);
    assert_eq!(state.output.as_deref(), Some("Updated hello.ts"));
    assert_eq!(state.duration_ms, Some(1000));
    assert_eq!(state.files[0].file, "hello.ts");
    assert_eq!((state.files[0].additions, state.files[0].deletions), (1, 1));
}

#[test]
fn branches_follow_metadata_ancestry_and_truncate_abandoned_messages() {
    let mut core = loaded();
    let generation = core.source_generation();
    let branch = [
        line(json!({"type":"branch_summary","id":"branch","parentId":"u1","summary":"Different approach"})),
        line(json!({"type":"message","id":"alternate","parentId":"branch","message":{"role":"assistant","content":[{"type":"text","text":"Another answer"}],"stopReason":"stop","timestamp":10}})),
    ].concat();
    let result = core.ingest(generation, &branch).unwrap();
    assert_eq!(
        core.state()
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "alternate"]
    );
    assert!(
        result
            .update
            .unwrap()
            .deltas
            .iter()
            .any(|delta| matches!(delta, AgentTranscriptDelta::MessagesTruncated { length: 1 }))
    );
    // Unknown entries still advance the persisted leaf and retain the branch.
    core.ingest(
        generation,
        &line(json!({"type":"future","id":"metadata","parentId":"alternate"})),
    )
    .unwrap();
    assert_eq!(core.state().messages.len(), 2);
}

#[test]
fn chunks_partial_records_and_checkpoint_replay_preserve_projection() {
    let whole = loaded().state();
    for size in [1, 97, 4096] {
        let mut core = PiSessionCore::new(SESSION);
        let source = core.bind_source("/session.jsonl".into(), "1:2".into(), FIXTURE.len() as u64);
        for chunk in FIXTURE.chunks(size) {
            core.ingest(source.source_generation, chunk).unwrap();
        }
        assert_eq!(core.state().messages, whole.messages);
        assert_eq!(core.state().turns, whole.turns);
    }
    let split = FIXTURE.len() - 17;
    let mut core = PiSessionCore::new(SESSION);
    let source = core.bind_source("/session.jsonl".into(), "1:2".into(), FIXTURE.len() as u64);
    core.ingest(source.source_generation, &FIXTURE[..split])
        .unwrap();
    let offset = core.committable_offset();
    assert!(offset < split as u64);
    let blob = core.cache_blob().unwrap();
    let mut restored = PiSessionCore::new(SESSION);
    restored.restore_cache(&blob).unwrap();
    assert_eq!(restored.state().status, AgentTranscriptStatus::Loading);
    let rebound = restored.bind_source("/session.jsonl".into(), "1:2".into(), FIXTURE.len() as u64);
    assert!(!rebound.rebuilt);
    assert_eq!(rebound.start_offset, offset);
    restored
        .ingest(
            rebound.source_generation,
            &FIXTURE[usize::try_from(offset).unwrap()..],
        )
        .unwrap();
    assert_eq!(restored.state().messages, whole.messages);
    assert_eq!(restored.state().info, whole.info);
    assert!(restored.confirm_cache(rebound.source_generation, restored.committable_offset()));
    assert!(!restored.confirm_cache(rebound.source_generation + 1, restored.committable_offset()));
    let reset = restored.bind_source("/session.jsonl".into(), "1:3".into(), 0);
    assert!(reset.rebuilt);
    assert!(restored.state().messages.is_empty());
    assert!(PiSessionCore::new("other").restore_cache(&blob).is_err());
    assert!(
        crate::agent_transcript::ClaudeSessionCore::new(SESSION)
            .restore_cache(&blob)
            .is_err()
    );
}

#[test]
fn rejects_other_session_headers_and_supports_authoritative_paths() {
    let mut core = PiSessionCore::new("other");
    let source = core.bind_source("/session.jsonl".into(), "1:2".into(), FIXTURE.len() as u64);
    core.ingest(source.source_generation, FIXTURE).unwrap();
    assert!(core.state().messages.is_empty());
    let mut path = PiSessionCore::new("/custom/session.jsonl");
    let source = path.bind_source(
        "/custom/session.jsonl".into(),
        "1:2".into(),
        FIXTURE.len() as u64,
    );
    path.ingest(source.source_generation, FIXTURE).unwrap();
    assert_eq!(path.state().messages, loaded().state().messages);
}

#[test]
fn errors_interruptions_and_malformed_lines_survive_reconnect() {
    for (stop, expected) in [
        ("error", AgentTurnStatus::Error),
        ("aborted", AgentTurnStatus::Interrupted),
    ] {
        let mut core = loaded();
        let data = [b"not json\n".to_vec(), line(json!({"type":"message","id":"failure","parentId":"name","message":{"role":"assistant","content":[],"stopReason":stop,"errorMessage":"Provider failed","timestamp":20}}))].concat();
        let result = core.ingest(core.source_generation(), &data).unwrap();
        assert_eq!(result.malformed_records, 1);
        assert_eq!(core.state().turns.last().unwrap().status, expected);
        assert!(
            core.state()
                .messages
                .last()
                .unwrap()
                .parts
                .iter()
                .any(|part| matches!(part, AgentTranscriptPart::Notice { .. }))
        );
        let blob = core.cache_blob().unwrap();
        let saved =
            crate::decode_cached_transcript(AgentTranscriptKind::Pi, SESSION, &blob).unwrap();
        assert_eq!(saved.status, AgentTranscriptStatus::Stale);
        assert_eq!(saved.messages, core.state().messages);
    }
}

fn assert_capture_checkpoint_replay(
    path: &std::path::Path,
    bytes: &[u8],
    state: &AgentTranscriptState,
) {
    let file = path.display();
    let session = state.session_id.as_str();
    // A complete checkpoint plus an unfinished next line must replay exactly
    // once, including when calls and results straddle the checkpoint.
    let mut prefix = PiSessionCore::new(session);
    let binding = prefix.bind_source(
        path.to_string_lossy().into_owned(),
        "public:fixture".into(),
        bytes.len() as u64,
    );
    let mut previous = 0;
    for offset in bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index + 1))
    {
        let end = (offset + 7).min(bytes.len());
        prefix
            .ingest(binding.source_generation, &bytes[previous..end])
            .unwrap();
        previous = end;
        let mut restored = PiSessionCore::new(session);
        restored
            .restore_cache(&prefix.cache_blob().unwrap())
            .unwrap();
        let rebound = restored.bind_source(
            path.to_string_lossy().into_owned(),
            "public:fixture".into(),
            bytes.len() as u64,
        );
        // Seven bytes cannot include a complete session record.
        assert_eq!(rebound.start_offset, offset as u64);
        restored
            .ingest(rebound.source_generation, &bytes[offset..])
            .unwrap();
        assert_eq!(
            restored.state().messages,
            state.messages,
            "{file} resume at {offset}"
        );
        assert_eq!(
            restored.state().turns,
            state.turns,
            "{file} resume at {offset}"
        );
        assert_eq!(
            restored.state().info,
            state.info,
            "{file} resume at {offset}"
        );
    }
}

/// The runner pins/checksums public captures; normal tests remain offline.
#[test]
#[ignore = "run nix develop -c node scripts/test-pi-transcript.ts"]
fn downloaded_pi_captures() {
    let directory = std::env::var("WHIP_PI_CAPTURES").unwrap();
    for (file, record_count, user_count, assistant_count, tool_count, error_count) in [
        ("reproduction.jsonl", 19, 1, 6, 8, 1),
        ("format-session.jsonl", 117, 7, 52, 55, 0),
    ] {
        let path = std::path::Path::new(&directory).join(file);
        let bytes = std::fs::read(&path).unwrap();
        let records = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), record_count, "{file}");
        let session = records[0]["id"].as_str().unwrap();
        let load = |chunk_size| {
            let mut core = PiSessionCore::new(session);
            let binding = core.bind_source(
                path.to_string_lossy().into_owned(),
                "public:fixture".into(),
                bytes.len() as u64,
            );
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
        assert_eq!(state.status, AgentTranscriptStatus::Live);
        assert_eq!(
            state
                .messages
                .iter()
                .filter(|message| message.role == AgentMessageRole::User)
                .count(),
            user_count
        );
        assert_eq!(
            state
                .messages
                .iter()
                .filter(|message| message.role == AgentMessageRole::Assistant)
                .count(),
            assistant_count
        );
        assert_eq!(state.turns.len(), user_count);
        let tools = state
            .messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(|part| {
                if let AgentTranscriptPart::Tool { call_id, state, .. } = part {
                    Some((call_id.as_str(), state))
                } else {
                    None
                }
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(tools.len(), tool_count);
        assert_eq!(
            tools
                .values()
                .filter(|tool| tool.status == AgentToolStatus::Error)
                .count(),
            error_count
        );
        assert!(tools.values().all(|tool| matches!(
            tool.status,
            AgentToolStatus::Completed | AgentToolStatus::Error
        )));

        // Check native values against raw records, independently of the adapter.
        for record in &records {
            let raw = &record["message"];
            if raw["role"] == "toolResult" {
                let id = record["id"].as_str().unwrap();
                assert!(!state.messages.iter().any(|message| message.id == id));
                let tool = tools[raw["toolCallId"].as_str().unwrap()];
                assert_eq!(
                    tool.status == AgentToolStatus::Error,
                    raw["isError"] == true
                );
                let output = raw["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !output.is_empty() {
                    let actual = tool.output.as_deref().unwrap();
                    if let Some(prefix) = actual.strip_suffix("\n[truncated]") {
                        assert!(output.starts_with(prefix));
                    } else {
                        assert_eq!(actual, output);
                    }
                }
            }
            if raw["role"] == "assistant" {
                let message = state
                    .messages
                    .iter()
                    .find(|message| Some(message.id.as_str()) == record["id"].as_str())
                    .unwrap();
                let details = message.details.as_ref().unwrap();
                let usage = details.usage.as_ref().unwrap();
                assert_eq!(details.model.as_deref(), raw["model"].as_str());
                assert_eq!(details.provider.as_deref(), raw["provider"].as_str());
                assert_eq!(
                    usage.input,
                    Some(
                        raw["usage"]["input"].as_u64().unwrap()
                            + raw["usage"]["cacheRead"].as_u64().unwrap()
                            + raw["usage"]["cacheWrite"].as_u64().unwrap()
                    )
                );
                assert_eq!(usage.output, raw["usage"]["output"].as_u64());
                assert_eq!(usage.total, raw["usage"]["totalTokens"].as_u64());
                for block in raw["content"].as_array().unwrap() {
                    if let Some(thinking) = block["thinking"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                    {
                        assert!(message.parts.iter().any(|part| matches!(part, AgentTranscriptPart::Reasoning { text, .. } if text == thinking)));
                    }
                    if let Some(expected) = block["text"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                    {
                        assert!(message.parts.iter().any(|part| matches!(part, AgentTranscriptPart::Text { text, .. } if text == expected)));
                    }
                }
            }
        }
        assert!(
            state
                .messages
                .iter()
                .flat_map(|message| &message.parts)
                .all(|part| {
                    match part {
                        AgentTranscriptPart::Text { text, .. }
                        | AgentTranscriptPart::Reasoning { text, .. } => !text.trim().is_empty(),
                        _ => true,
                    }
                })
        );
        if error_count > 0 {
            assert_eq!(state.turns.last().unwrap().status, AgentTurnStatus::Error);
            assert!(state.messages.last().unwrap().error.is_some());
        }
        for chunk_size in [97, 4096] {
            let chunked = load(chunk_size).state();
            assert_eq!(chunked.messages, state.messages);
            assert_eq!(chunked.turns, state.turns);
            assert_eq!(chunked.info, state.info);
        }
        assert_capture_checkpoint_replay(&path, &bytes, &state);
        println!(
            "{file}: {} bytes, {} records -> {} messages, {} turns, {} matched tools ({error_count} failed); chunking and checkpoint replay passed",
            bytes.len(),
            records.len(),
            state.messages.len(),
            state.turns.len(),
            tools.len()
        );
    }
}
