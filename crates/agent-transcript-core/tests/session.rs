use agent_transcript_core::{
    AgentCacheError, AgentMessageRole, AgentTranscriptKind, AgentTranscriptStatus,
    OpenCodeV2Snapshot, OpenCodeV2Sync, SessionCore, SourceRecords, TranscriptIngestError,
    decode_cached_transcript,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn neutral_ingestion_preserves_file_provider_history_across_chunks_and_checkpoints() -> TestResult {
    for (kind, session, bytes) in [
        (
            AgentTranscriptKind::Claude,
            "11111111-1111-4111-8111-111111111111",
            include_bytes!("fixtures/claude/main.jsonl").as_slice(),
        ),
        (
            AgentTranscriptKind::Codex,
            "thread-current",
            include_bytes!("fixtures/codex/paginated-rollout.jsonl").as_slice(),
        ),
        (
            AgentTranscriptKind::Pi,
            "pi-session",
            include_bytes!("fixtures/pi/main.jsonl").as_slice(),
        ),
    ] {
        let mut complete = SessionCore::new(kind, session);
        let source =
            complete.bind_source("/transcript.jsonl".into(), "1:2".into(), bytes.len() as u64)?;
        let result = complete.ingest(SourceRecords::Jsonl {
            generation: source.source_generation,
            bytes,
        })?;
        assert_eq!(result.malformed_records, 0);
        assert_eq!(
            result
                .file_progress
                .ok_or("missing file progress")?
                .committable_offset,
            bytes.len() as u64
        );
        assert_eq!(complete.status(), AgentTranscriptStatus::Live);
        assert!(
            complete
                .state()
                .messages
                .iter()
                .any(|message| message.role == AgentMessageRole::User)
        );
        assert!(
            complete
                .state()
                .messages
                .iter()
                .any(|message| message.role == AgentMessageRole::Assistant)
        );
        let expected = complete.state();

        let mut chunked = SessionCore::new(kind, session);
        let source =
            chunked.bind_source("/transcript.jsonl".into(), "1:2".into(), bytes.len() as u64)?;
        for chunk in bytes.chunks(37) {
            let result = chunked.ingest(SourceRecords::Jsonl {
                generation: source.source_generation,
                bytes: chunk,
            })?;
            assert_eq!(result.malformed_records, 0);
        }
        assert_eq!(chunked.state().messages, expected.messages);
        assert_eq!(chunked.state().turns, expected.turns);
        assert_eq!(chunked.state().info, expected.info);

        let cache = chunked.cache_blob()?;
        let saved = decode_cached_transcript(kind, session, &cache)?;
        assert_eq!(saved.status, AgentTranscriptStatus::Stale);
        assert_eq!(saved.messages, expected.messages);
        assert_eq!(saved.turns, expected.turns);
        assert!(matches!(
            decode_cached_transcript(kind, "other-session", &cache),
            Err(AgentCacheError::SessionMismatch)
        ));
    }
    Ok(())
}

#[test]
fn neutral_ingestion_supports_both_database_formats_and_rejects_the_wrong_source() -> TestResult {
    let mut core = SessionCore::new(AgentTranscriptKind::OpenCode, "example");
    let export = json!({"info":{"id":"example"},"messages":[{"info":{"id":"user","role":"user"},"parts":[{"id":"text","type":"text","text":"Hello"}]}]}).to_string();
    let result = core.ingest(SourceRecords::Export {
        cursor: 10,
        json: &export,
    })?;
    assert!(result.update.is_some());
    assert!(result.file_progress.is_none());
    assert_eq!(core.state().messages[0].id, "user");
    assert!(
        core.ingest(SourceRecords::Events {
            cursor: 10,
            json: "[]"
        })?
        .update
        .is_none()
    );
    let before = core.state();
    assert!(matches!(
        core.ingest(SourceRecords::Jsonl {
            generation: 1,
            bytes: b"{}\n"
        }),
        Err(TranscriptIngestError::WrongSource(
            AgentTranscriptKind::OpenCode
        ))
    ));
    assert_eq!(core.state(), before);

    let mut fixture: Value =
        serde_json::from_str(include_str!("fixtures/opencode/v2-session.json"))?;
    let mut projected = SessionCore::new(AgentTranscriptKind::OpenCode, "ses_v2");
    let result = projected.ingest(SourceRecords::Projected(OpenCodeV2Sync::Full {
        snapshot: OpenCodeV2Snapshot {
            info: fixture["info"].take(),
            messages: std::mem::take(
                fixture["messages"]
                    .as_array_mut()
                    .ok_or("fixture messages")?,
            ),
        },
        sequence: None,
    }))?;
    assert!(result.update.is_some());
    assert!(!projected.state().messages.is_empty());
    assert!(
        SessionCore::new(AgentTranscriptKind::Claude, "example")
            .ingest(SourceRecords::Export {
                cursor: 10,
                json: &export
            })
            .is_err()
    );
    Ok(())
}
