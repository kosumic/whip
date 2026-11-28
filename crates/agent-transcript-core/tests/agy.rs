use agent_transcript_core::{
    AgentToolStatus, AgentTranscriptKind, AgentTranscriptPart, AgentTurnStatus, AgyLog,
    AgySessionCore, decode_cached_transcript,
};
use serde_json::{Value, json};
use std::{error::Error, fs, path::PathBuf};

#[test]
fn parallel_calls_preserve_missing_results_and_project_successful_tools()
-> Result<(), Box<dyn Error>> {
    let calls = [
        json!({"name":"edit_file","args":{"Path":"lost","Target":"x","Replacement":"y"}}),
        json!({"name":"ask_question","args":{"questions":[{"question":"Which?","options":["A","B"],"is_multi_select":true}]}}),
        json!({"name":"view_file","args":{"AbsolutePath":"/tmp/image.png"}}),
        json!({"name":"write_to_file","args":{"TargetFile":"/session/implementation_plan.md","CodeContent":"Do it","IsArtifact":true}}),
        json!({"name":"edit_file","args":{"Path":"file","Target":"old","Replacement":"new"}}),
    ];
    let records = [
        json!({"step_index":0,"type":"USER_INPUT","content":"go"}),
        json!({"step_index":1,"type":"PLANNER_RESPONSE","source":"MODEL","tool_calls":calls}),
        json!({"step_index":3,"type":"ASK_QUESTION","status":"DONE","content":"A and B"}),
        json!({"step_index":4,"type":"VIEW_FILE","status":"DONE"}),
        json!({"step_index":5,"type":"GENERIC","status":"DONE"}),
        json!({"step_index":6,"type":"GENERIC","status":"DONE"}),
        json!({"step_index":7,"type":"PLANNER_RESPONSE","source":"MODEL","content":"Done","status":"DONE"}),
    ];
    let mut log = AgyLog::default();
    for record in records {
        log.ingest(format!("{record}\n").as_bytes())?;
    }
    let mut core = AgySessionCore::new("session");
    core.publish_logs(&AgyLog::default(), &log, false);
    let state = core.state();
    let m = &state.messages[1];
    assert!(
        matches!(&m.parts[0],AgentTranscriptPart::Notice{text,..} if text.contains("no result recorded"))
    );
    assert!(
        matches!(&m.parts[1],AgentTranscriptPart::Tool{state,..} if state.questions[0].multiple && state.questions[0].options.len()==2 && state.output.as_deref()==Some("A and B"))
    );
    assert!(
        matches!(&m.parts[2],AgentTranscriptPart::Tool{state,..} if state.viewed_images[0].source.as_deref()==Some("/tmp/image.png"))
    );
    assert!(matches!(&m.parts[5],AgentTranscriptPart::Plan{text,..} if text=="Do it"));
    assert_eq!(m.diffs.len(), 2);
    assert_eq!(m.diffs[1].patch.as_deref(), Some("-old\n+new"));
    assert_eq!(state.turns[0].diffs, m.diffs);
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
    Ok(())
}

#[test]
fn late_background_report_finishes_the_original_turn() -> Result<(), Box<dyn Error>> {
    let records = [
        json!({"step_index":0,"type":"USER_INPUT","content":"run"}),
        json!({"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command"}]}),
        json!({"step_index":2,"type":"GENERIC","status":"RUNNING","content":"Tool is running as a background task with task id: session/task-2"}),
        json!({"step_index":3,"type":"USER_INPUT","content":"next"}),
        json!({"step_index":4,"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] sender=session/task-2 priority=HIGH content=Task id \"session/task-2\" finished with result:\nsuccess\n</SYSTEM_MESSAGE>"}),
    ];
    let mut log = AgyLog::default();
    for record in records {
        log.ingest(format!("{record}\n").as_bytes())?;
    }
    let mut core = AgySessionCore::new("session");
    core.publish_logs(&log, &AgyLog::default(), false);
    let state = core.state();
    assert!(
        matches!(&state.messages[1].parts[0],AgentTranscriptPart::Tool{state,..} if state.output.as_deref()==Some("success") && state.status==AgentToolStatus::Completed)
    );
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
    assert_eq!(state.turns[1].status, AgentTurnStatus::Working);
    Ok(())
}

#[test]
#[ignore = "requires the pinned public Antigravity CLI captures in WHIP_AGY_CAPTURES"]
fn downloaded_agy_captures() -> Result<(), Box<dyn Error>> {
    let dir = PathBuf::from(std::env::var("WHIP_AGY_CAPTURES")?);
    for (name, count) in [
        ("transcript-record", 2),
        ("transcript-full-record", 2),
        ("transcript-record-denied", 4),
        ("transcript-record-tools", 8),
        ("transcript-record-lifecycle", 2),
    ] {
        let bytes = fs::read(dir.join(format!("{name}.jsonl")))?;
        let rows = std::str::from_utf8(&bytes)?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<Vec<Value>, _>>()?;
        assert_eq!(rows.len(), count);
        let mut log = AgyLog::default();
        for chunk in bytes.chunks(17) {
            log.ingest(chunk)?;
        }
        let mut core = AgySessionCore::new(name);
        core.publish_logs(&AgyLog::default(), &log, false);
        let state = core.state();
        assert_eq!(state.turns.len(), 1);
        let offline =
            decode_cached_transcript(AgentTranscriptKind::Agy, name, &core.cache_blob()?)?;
        assert_eq!(offline.messages, state.messages);
        assert_eq!(offline.turns, state.turns);
        for row in rows.iter().filter(|r| r["type"] == "PLANNER_RESPONSE") {
            let id = format!("agy:{}", row["step_index"]);
            let m = state
                .messages
                .iter()
                .find(|m| m.id == id)
                .ok_or("missing assistant message")?;
            if let Some(reply) = row["content"].as_str() {
                assert!(
                    m.parts
                        .iter()
                        .any(|p| matches!(p,AgentTranscriptPart::Text {text,..} if text==reply))
                );
            }
            for (i, call) in row["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let tool = m
                    .parts
                    .iter()
                    .find_map(|p| match p {
                        AgentTranscriptPart::Tool { tool, state, .. }
                            if Some(tool.as_str()) == call["name"].as_str() =>
                        {
                            Some(state)
                        }
                        _ => None,
                    })
                    .ok_or("missing tool")?;
                if let Some(result) = rows.get(
                    usize::try_from(row["step_index"].as_u64().ok_or("missing index")?)? + 1 + i,
                ) {
                    assert_eq!(tool.output.as_deref(), result["content"].as_str());
                    assert_eq!(tool.error.as_deref(), result["error"].as_str());
                    if tool.error.is_some() {
                        assert!(tool.files.is_empty());
                    }
                } else {
                    assert_eq!(tool.status, AgentToolStatus::Running);
                }
            }
        }
        if name == "transcript-record-tools" {
            let edits = &state.turns[0].diffs;
            assert_eq!(edits.len(), 1);
            assert!(edits[0].file.ends_with("/tool-probe.txt"));
            assert_eq!((edits[0].additions, edits[0].deletions), (1, 1));
            assert!(
                state
                    .messages
                    .iter()
                    .flat_map(|m| &m.parts)
                    .any(|p| matches!(p,
                AgentTranscriptPart::Tool { tool, state, .. }
                    if tool == "edit_file" && state.duration_ms == Some(20_000)))
            );
            assert_eq!(
                edits[0].patch.as_deref(),
                Some("-FIRST-VALUE\n+SECOND-VALUE")
            );
            core.publish_logs(&AgyLog::default(), &log, true);
            let settled = core.state();
            assert!(settled.messages.last().is_some_and(|m| m.parts.iter().any(|p|
                matches!(p, AgentTranscriptPart::Notice { text, .. } if text == "run_command: no result recorded"))));
            log.ingest(b"{\"step_index\":8,\"type\":\"GENERIC\",\"status\":\"DONE\",\"content\":\"late output\"}\n")?;
            core.publish_logs(&AgyLog::default(), &log, true);
            assert!(core.state().messages.last().is_some_and(|m| m.parts.iter().any(|p|
                matches!(p, AgentTranscriptPart::Tool { state, .. } if state.output.as_deref()==Some("late output")))));
        }
    }
    Ok(())
}

#[test]
fn large_compacted_history_reconciles_replayed_steps_and_keeps_partial_lines_separate()
-> Result<(), Box<dyn Error>> {
    let mut compact = AgyLog::default();
    let mut full = AgyLog::default();
    let mut core = AgySessionCore::new("large");
    let text = "context ".repeat(40);
    let mut bytes = Vec::new();
    for index in 0..3000 {
        let row = json!({"step_index":index, "type":"PLANNER_RESPONSE","source":"MODEL","content":format!("{index} {text}")});
        bytes.extend_from_slice(format!("{row}\n").as_bytes());
    }
    bytes.extend_from_slice(br#"{"step_index":3000,"type":"CHECKPOINT","content":"#);
    assert!(bytes.len() > 1024 * 1024);
    for chunk in bytes.chunks(32768) {
        compact.ingest(chunk)?;
    }
    full.ingest(b"{\"step_index\":2999,\"type\":\"PLANNER_RESPONSE\",\"source\":\"MODEL\",\"content\":\"updated\"}\n")?;
    core.publish_logs(&compact, &full, false);
    assert_eq!(core.state().messages.len(), 3000);
    compact
        .ingest(b"\"summary\",\"input_tokens\":7,\"cache_read_tokens\":3,\"output_tokens\":1}\n")?;
    core.publish_logs(&compact, &full, false);
    let state = core.state();
    assert_eq!(state.messages.len(), 3001);
    assert!(
        matches!(&state.messages[2999].parts[0],AgentTranscriptPart::Text{text,..} if text=="updated")
    );
    assert!(
        matches!(&state.messages[3000].parts[0],AgentTranscriptPart::Notice{summary,..} if summary.as_deref()==Some("summary"))
    );
    let usage = state.messages[3000]
        .details
        .as_ref()
        .and_then(|d| d.usage.as_ref())
        .ok_or("missing compaction usage")?;
    assert_eq!(
        (usage.input, usage.cache_read, usage.total),
        (Some(10), Some(3), Some(11))
    );
    assert!(core.publish_logs(&compact, &full, false).is_none());
    Ok(())
}

#[test]
fn interrupted_turn_recovers_when_the_recorded_reply_arrives() -> Result<(), Box<dyn Error>> {
    let mut full = AgyLog::default();
    let mut core = AgySessionCore::new("session");
    let prompt = json!({"step_index":0,"type":"USER_INPUT","content":"continue"});
    let error = json!({"step_index":1,"type":"ERROR_MESSAGE","source":"SYSTEM","status":"DONE","error":"The stream was interrupted. Please continue the task you were working on."});
    full.ingest(format!("{prompt}\n{error}\n").as_bytes())?;
    core.publish_logs(&AgyLog::default(), &full, false);
    assert_eq!(core.state().turns[0].status, AgentTurnStatus::Interrupted);
    let reply = json!({"step_index":2,"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","content":"Finished"});
    full.ingest(format!("{reply}\n").as_bytes())?;
    core.publish_logs(&AgyLog::default(), &full, false);
    let state = core.state();
    assert_eq!(state.turns.len(), 1);
    assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
    Ok(())
}
