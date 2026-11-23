use agent_transcript_core::{
    AgentMessageRole, AgentToolState, AgentToolStatus, AgentTranscriptKind, AgentTranscriptPart,
    AgentTranscriptState, OpenCodeV2Snapshot, OpenCodeV2Sync, SessionCore, SourceRecords,
    decode_cached_transcript,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;
const SESSION: &str = "images";
const INLINE_IMAGE: &str = "data:image/png;base64,aW1hZ2U=";
const FILE_FIXTURES: &[(AgentTranscriptKind, &[u8])] = &[
    (
        AgentTranscriptKind::Codex,
        include_bytes!("fixtures/codex/image-views-legacy.jsonl"),
    ),
    (
        AgentTranscriptKind::Codex,
        include_bytes!("fixtures/codex/image-views-paginated.jsonl"),
    ),
    (
        AgentTranscriptKind::Claude,
        include_bytes!("fixtures/claude/image-reads.jsonl"),
    ),
    (
        AgentTranscriptKind::Pi,
        include_bytes!("fixtures/pi/image-reads.jsonl"),
    ),
];

fn tools(state: &AgentTranscriptState) -> Vec<(&str, &AgentToolState)> {
    state
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
        .collect()
}

fn ingest_file(
    kind: AgentTranscriptKind,
    bytes: &[u8],
) -> Result<SessionCore, Box<dyn std::error::Error>> {
    let mut core = SessionCore::new(kind, SESSION);
    let binding = core.bind_source("/session.jsonl".into(), "source".into(), bytes.len() as u64)?;
    let result = core.ingest(SourceRecords::Jsonl {
        generation: binding.source_generation,
        bytes,
    })?;
    assert_eq!(result.malformed_records, 0);
    Ok(core)
}

#[test]
fn image_reads_survive_chunking_mid_operation_checkpoints_and_offline_replay() -> TestResult {
    for &(kind, bytes) in FILE_FIXTURES {
        let expected = ingest_file(kind, bytes)?.state();
        let tool_states = tools(&expected);
        let viewed = tool_states
            .iter()
            .filter(|(_, state)| !state.viewed_images.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(
            viewed.len(),
            if kind == AgentTranscriptKind::Codex {
                2
            } else {
                1
            }
        );
        assert_eq!(
            tool_states.iter().filter(|(id, _)| *id == "view").count(),
            1
        );
        let image = &viewed[0].1.viewed_images[0];
        assert!(image.label.ends_with("screenshot.png"));
        assert_eq!(viewed[0].1.status, AgentToolStatus::Completed);
        if kind != AgentTranscriptKind::Codex {
            assert_eq!(image.source.as_deref(), Some(INLINE_IMAGE));
            for id in ["text", "generator"] {
                assert!(
                    tool_states
                        .iter()
                        .find(|(call, _)| *call == id)
                        .ok_or("missing tool")?
                        .1
                        .viewed_images
                        .is_empty()
                );
            }
            assert_eq!(
                expected
                    .messages
                    .iter()
                    .filter(|message| message.role == AgentMessageRole::User)
                    .count(),
                1
            );
        } else {
            assert_eq!(viewed[1].1.viewed_images[0].source, None);
        }

        let mut chunked = SessionCore::new(kind, SESSION);
        let binding =
            chunked.bind_source("/session.jsonl".into(), "source".into(), bytes.len() as u64)?;
        for chunk in bytes.chunks(37) {
            chunked.ingest(SourceRecords::Jsonl {
                generation: binding.source_generation,
                bytes: chunk,
            })?;
        }
        assert_eq!(chunked.state().messages, expected.messages);
        let cached = decode_cached_transcript(kind, SESSION, &chunked.cache_blob()?)?;
        assert_eq!(cached.messages, expected.messages);
        assert_eq!(cached.turns, expected.turns);

        let split = bytes
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'\n')
            .nth(3)
            .ok_or("short fixture")?
            .0
            + 1;
        let mut partial = SessionCore::new(kind, SESSION);
        let binding =
            partial.bind_source("/session.jsonl".into(), "source".into(), bytes.len() as u64)?;
        partial.ingest(SourceRecords::Jsonl {
            generation: binding.source_generation,
            bytes: &bytes[..split],
        })?;
        let mut restored = SessionCore::new(kind, SESSION);
        restored.restore_cache(&partial.cache_blob()?)?;
        let binding =
            restored.bind_source("/session.jsonl".into(), "source".into(), bytes.len() as u64)?;
        assert_eq!(binding.start_offset, split as u64);
        restored.ingest(SourceRecords::Jsonl {
            generation: binding.source_generation,
            bytes: &bytes[split..],
        })?;
        assert_eq!(restored.state().messages, expected.messages);
        assert_eq!(restored.state().turns, expected.turns);
    }
    Ok(())
}

#[test]
fn codex_repeated_item_or_event_keeps_one_activity_in_its_original_position() -> TestResult {
    for &(_, bytes) in &FILE_FIXTURES[..2] {
        let mut core = ingest_file(AgentTranscriptKind::Codex, bytes)?;
        let before = core.state().messages;
        let duplicate = b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"view_image_tool_call\",\"call_id\":\"view\",\"path\":\"/repo/screenshot.png\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"view_image_tool_call\",\"call_id\":\"view\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"thread_id\":\"images\",\"turn_id\":\"turn\",\"item\":{\"type\":\"ImageView\",\"id\":\"view\"}}}\n";
        let binding = core.bind_source(
            "/session.jsonl".into(),
            "source".into(),
            (bytes.len() + duplicate.len()) as u64,
        )?;
        core.ingest(SourceRecords::Jsonl {
            generation: binding.source_generation,
            bytes: duplicate,
        })?;
        let after = core.state();
        assert_eq!(
            before.iter().map(|message| &message.id).collect::<Vec<_>>(),
            after
                .messages
                .iter()
                .map(|message| &message.id)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            before
                .iter()
                .flat_map(|message| message.parts.iter().map(AgentTranscriptPart::id))
                .collect::<Vec<_>>(),
            after
                .messages
                .iter()
                .flat_map(|message| message.parts.iter().map(AgentTranscriptPart::id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            tools(&after).iter().filter(|(id, _)| *id == "view").count(),
            1
        );
        assert_eq!(
            tools(&after)[0].1.viewed_images[0].source.as_deref(),
            Some("/repo/screenshot.png")
        );
    }
    Ok(())
}

#[test]
fn opencode_user_attachments_assistant_files_and_read_results_stay_distinct() -> TestResult {
    let mut core = SessionCore::new(AgentTranscriptKind::OpenCode, SESSION);
    core.ingest(SourceRecords::Export {
        cursor: 1,
        json: include_str!("fixtures/opencode/image-reads.json"),
    })?;
    let expected = core.state();
    assert!(matches!(
        &expected.messages[0].parts[..],
        [AgentTranscriptPart::Image { .. }]
    ));
    let tool_states = tools(&expected);
    assert_eq!(
        tool_states
            .iter()
            .filter(|(_, state)| !state.viewed_images.is_empty())
            .count(),
        2
    );
    assert_eq!(
        tool_states[0].1.viewed_images[0].source.as_deref(),
        Some(INLINE_IMAGE)
    );
    assert_eq!(
        tool_states[2].1.viewed_images[0].source.as_deref(),
        Some("https://example.test/inspected.png")
    );
    assert!(tool_states[1].1.viewed_images.is_empty());
    assert!(tool_states[3].1.viewed_images.is_empty());
    assert_eq!(
        decode_cached_transcript(AgentTranscriptKind::OpenCode, SESSION, &core.cache_blob()?)?
            .messages,
        expected.messages
    );
    let update = json!([{"seq":2,"type":"message.part.updated","data":{"part":{"id":"assistant-image","messageID":"reply","type":"file","mime":"image/png","url":"file:///repo/new.png"}}}]);
    core.ingest(SourceRecords::Events {
        cursor: 2,
        json: &update.to_string(),
    })?;
    assert_eq!(
        tools(&core.state())[2].1.viewed_images[0].source.as_deref(),
        Some("file:///repo/new.png")
    );
    Ok(())
}

#[test]
fn opencode_v2_preserves_image_files_without_copying_them_into_text_output() -> TestResult {
    let mut fixture: Value =
        serde_json::from_str(include_str!("fixtures/opencode/v2-session.json"))?;
    fixture["info"]["id"] = json!(SESSION);
    let read = &mut fixture["messages"][2]["content"][1];
    read["name"] = json!("read");
    read["state"]["input"] = json!({"path":"screenshot.png"});
    read["state"]["attachments"] = json!([]);
    read["state"]["content"] = json!([
        {"type":"text","text":"Image read successfully"},
        {"type":"file","uri":INLINE_IMAGE,"mime":"image/png","name":"screenshot.png"}
    ]);
    fixture["messages"][2]["content"]
        .as_array_mut()
        .ok_or("missing content")?
        .push(json!({"type":"file","uri":"https://example.test/inspected.png","mime":"image/png"}));
    let mut core = SessionCore::new(AgentTranscriptKind::OpenCode, SESSION);
    core.ingest(SourceRecords::Projected(OpenCodeV2Sync::Full {
        snapshot: OpenCodeV2Snapshot {
            info: fixture["info"].clone(),
            messages: fixture["messages"]
                .as_array()
                .ok_or("missing messages")?
                .clone(),
        },
        sequence: Some(1),
    }))?;
    let expected = core.state();
    let tool_states = tools(&expected);
    assert_eq!(
        tool_states[0].1.output.as_deref(),
        Some("Image read successfully")
    );
    assert_eq!(
        tool_states[0].1.viewed_images[0].source.as_deref(),
        Some(INLINE_IMAGE)
    );
    assert_eq!(
        tool_states[1].1.viewed_images[0].source.as_deref(),
        Some("https://example.test/inspected.png")
    );
    assert_eq!(
        decode_cached_transcript(AgentTranscriptKind::OpenCode, SESSION, &core.cache_blob()?)?
            .messages,
        expected.messages
    );
    Ok(())
}

#[test]
fn oversized_images_keep_activity_and_path_fallback_without_bloating_checkpoints() -> TestResult {
    let large_data = "A".repeat(512 * 1024);
    for &(kind, fixture) in &FILE_FIXTURES[2..] {
        let mut records = std::str::from_utf8(fixture)?
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        let content = if kind == AgentTranscriptKind::Claude {
            &mut records[2]["message"]["content"][0]["content"][0]["source"]["data"]
        } else {
            &mut records[3]["message"]["content"][0]["data"]
        };
        *content = json!(large_data);
        // Large rich results must not become a second retained copy either.
        if kind == AgentTranscriptKind::Claude {
            records[2]["toolUseResult"]["file"]["base64"] = json!(large_data);
        }
        let mut bytes = Vec::new();
        for record in &records {
            serde_json::to_writer(&mut bytes, record)?;
            bytes.push(b'\n');
        }
        let core = ingest_file(kind, &bytes)?;
        let state = core.state();
        let image = &tools(&state)[0].1.viewed_images[0];
        assert_eq!(image.label, "screenshot.png");
        assert_eq!(image.source.as_deref(), Some("/repo/screenshot.png"));
        assert!(serde_json::to_vec(&state)?.len() < 16 * 1024);
        let cache = core.cache_blob()?;
        assert!(cache.len() < 24 * 1024);
        assert_eq!(
            decode_cached_transcript(kind, SESSION, &cache)?.messages,
            state.messages
        );
    }
    Ok(())
}

#[test]
fn rich_only_claude_images_and_metadata_only_reads_remain_useful() -> TestResult {
    let bytes = std::str::from_utf8(FILE_FIXTURES[2].1)?
        .replace("\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"aW1hZ2U=\"}}]", "\"content\":\"Image read\"");
    let state = ingest_file(AgentTranscriptKind::Claude, bytes.as_bytes())?.state();
    assert_eq!(
        tools(&state)[0].1.viewed_images[0].source.as_deref(),
        Some(INLINE_IMAGE)
    );

    let mut records = std::str::from_utf8(FILE_FIXTURES[3].1)?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    records[2]["message"]["content"][0]["arguments"] = json!({});
    records[3]["message"]["content"] = json!([{"type":"image"}]);
    let mut bytes = Vec::new();
    for record in &records {
        serde_json::to_writer(&mut bytes, record)?;
        bytes.push(b'\n');
    }
    let core = ingest_file(AgentTranscriptKind::Pi, &bytes)?;
    let state = core.state();
    assert_eq!(tools(&state)[0].1.viewed_images[0].label, "Image");
    assert_eq!(tools(&state)[0].1.viewed_images[0].source, None);
    Ok(())
}

#[test]
fn read_attachment_count_and_total_inline_bytes_are_bounded() -> TestResult {
    let mut fixture: Value =
        serde_json::from_str(include_str!("fixtures/opencode/image-reads.json"))?;
    fixture["messages"][1]["parts"][0]["state"]["attachments"] = json!((0..20).map(|index| json!({"type":"file","mime":"image/png","filename":format!("image-{index}.png"),"url":format!("data:image/png;base64,{}", "A".repeat(20 * 1024))})).collect::<Vec<_>>());
    fixture["messages"][1]["parts"][2]["url"] =
        json!(format!("data:image/png;base64,{}", "A".repeat(512 * 1024)));
    let mut core = SessionCore::new(AgentTranscriptKind::OpenCode, SESSION);
    core.ingest(SourceRecords::Export {
        cursor: 1,
        json: &fixture.to_string(),
    })?;
    let state = core.state();
    let images = &tools(&state)[0].1.viewed_images;
    assert_eq!(images.len(), 8);
    assert_eq!(tools(&state)[2].1.viewed_images[0].source, None);
    assert!(
        images
            .iter()
            .filter_map(|image| image.source.as_ref())
            .map(String::len)
            .sum::<usize>()
            <= 64 * 1024
    );
    assert!(core.cache_blob()?.len() < 80 * 1024);
    Ok(())
}

#[test]
fn failed_reads_and_abandoned_pi_branches_do_not_claim_image_inspection() -> TestResult {
    let fixture = std::str::from_utf8(FILE_FIXTURES[3].1)?;
    let failed = fixture.replace("\"isError\":false", "\"isError\":true");
    let state = ingest_file(AgentTranscriptKind::Pi, failed.as_bytes())?.state();
    assert!(
        tools(&state)
            .iter()
            .all(|(_, state)| state.viewed_images.is_empty())
    );
    let mut core = ingest_file(AgentTranscriptKind::Pi, FILE_FIXTURES[3].1)?;
    let branch = b"{\"type\":\"message\",\"id\":\"alternative\",\"parentId\":\"prompt\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Changed direction\"}],\"stopReason\":\"stop\"}}\n";
    let binding = core.bind_source(
        "/session.jsonl".into(),
        "source".into(),
        (FILE_FIXTURES[3].1.len() + branch.len()) as u64,
    )?;
    core.ingest(SourceRecords::Jsonl {
        generation: binding.source_generation,
        bytes: branch,
    })?;
    assert!(tools(&core.state()).is_empty());
    Ok(())
}
