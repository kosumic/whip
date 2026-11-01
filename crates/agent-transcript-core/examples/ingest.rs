use agent_transcript_core::{AgentTranscriptKind, SessionCore, SourceRecords};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = br#"{"type":"user","uuid":"user-1","sessionId":"example","message":{"role":"user","content":"Hello"}}
{"type":"assistant","uuid":"assistant-1","parentUuid":"user-1","sessionId":"example","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"stop_reason":"end_turn"}}
"#;
    let mut core = SessionCore::new(AgentTranscriptKind::Claude, "example");
    let source = core.bind_source("memory.jsonl".into(), "source-1".into(), bytes.len() as u64)?;
    // The path and identity are caller-supplied labels; the library opens no files.
    let result = core.ingest(SourceRecords::Jsonl {
        generation: source.source_generation,
        bytes,
    })?;
    assert_eq!(result.malformed_records, 0);
    assert_eq!(core.state().messages.len(), 2);
    println!("{}", serde_json::to_string_pretty(&core.state())?);
    Ok(())
}
