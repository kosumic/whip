#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::*;

const REQUEST: &str = "like how many exercises does it have";
const ID: &str = "27862c16-5d20-4564-97b8-56cdc592125c";

fn source_for(request: &str) -> String {
    let preamble = crate::realtime_voice::handoff_context::PREAMBLE;
    format!(
        "{PREFIX}{ID}{SUFFIX}{preamble}{}",
        serde_json::json!({
            "request":request,"voice_context":{"messages":[
                {"role":"user","text":"Tell me about the Fit3D dataset"},
                {"role":"assistant","text":"Fit3D contains exercise recordings"}
            ]}
        })
    )
}

fn source() -> String {
    source_for(REQUEST)
}

#[test]
fn exact_request_is_preserved_without_changing_remote_context() {
    let source = source();
    let text = format(source.clone(), REQUEST);
    assert!(text.starts_with(&source));
    assert_eq!(super::request(&text).as_deref(), Some(REQUEST));
    for request in [
        "  keep whitespace\n日本語 👋  ",
        "",
        "<input>literal</input>",
        FOOTER,
    ] {
        let text = format(source_for(request), request);
        assert_eq!(super::request(&text).as_deref(), Some(request));
    }
}

#[test]
fn lookalikes_legacy_truncation_and_mismatched_identity_or_input_stay_raw() {
    let text = format(source(), REQUEST);
    for invalid in [
        REQUEST.to_owned(),
        source(),
        format!("Please explain {text}"),
        text.replacen(REQUEST, "do something else", 1),
        text.replacen(ID, "3e2958e6-2f9c-4653-8534-b7bc6cf877b4", 1),
        text.replace("\"voice_context\":", "\"unexpected\":"),
        text.replace("\"role\":\"assistant\"", "\"role\":\"tool\""),
        format!("{text}\nextra user instructions"),
    ] {
        assert!(super::request(&invalid).is_none());
    }
    for (end, _) in text.char_indices() {
        assert!(super::request(&text[..end]).is_none());
    }
}

#[test]
fn live_display_matches_spoken_input_with_or_without_background_context() {
    let input = format!("{LIVE_PREFIX}{REQUEST}{LIVE_SUFFIX}");
    for source in [format!("{PREFIX}{ID}{SUFFIX}{input}"), source_for(&input)] {
        assert_eq!(
            super::request(&format(source, REQUEST)).as_deref(),
            Some(REQUEST)
        );
    }
    let text = format(
        format!("{PREFIX}{ID}{SUFFIX}ordinary request"),
        "different request",
    );
    assert!(super::request(&text).is_none());
}

#[test]
fn every_provider_and_saved_replay_preserve_source_and_project_the_request() {
    use agent_transcript_core::{AgentTranscriptKind, AgentTranscriptPart, SessionCore};
    use serde_json::json;
    let text = format(source(), REQUEST);
    let session = "11111111-1111-4111-8111-111111111111";
    for kind in [
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::OpenCode,
        AgentTranscriptKind::Pi,
    ] {
        let mut core = SessionCore::new(kind, session);
        if let SessionCore::OpenCode(core) = &mut core {
            core.bootstrap(
                1,
                &json!({"info":{"id":session},"messages":[{
                    "info":{"id":"user","role":"user"},
                    "parts":[{"id":"prompt","type":"text","text":text}]
                }]})
                .to_string(),
            )
            .unwrap();
        } else {
            let records = match kind {
                AgentTranscriptKind::Claude => vec![
                    json!({"type":"user", "uuid":"user", "sessionId":session, "message":{"role":"user","content":text}}),
                ],
                AgentTranscriptKind::Pi => vec![
                    json!({"type":"session","version":3,"id":session,"cwd":"/project"}),
                    json!({"type":"message","id":"user","message":{"role":"user","content":text}}),
                ],
                AgentTranscriptKind::Codex => vec![
                    json!({"type":"session_meta","payload":{"id":session}}),
                    json!({"type":"event_msg","payload":{"type":"user_message","message":text}}),
                ],
                AgentTranscriptKind::OpenCode => unreachable!(),
            };
            let mut bytes = Vec::new();
            for record in records {
                serde_json::to_writer(&mut bytes, &record).unwrap();
                bytes.push(b'\n');
            }
            let file = core.file().unwrap();
            let binding = file.bind_source("/transcript".into(), "1:2".into(), bytes.len() as u64);
            file.ingest(binding.source_generation, &bytes).unwrap();
        }
        let live = core.state();
        let saved = agent_transcript_core::decode_cached_transcript(
            kind,
            session,
            &core.cache_blob().unwrap(),
        )
        .unwrap();
        for state in [live, saved] {
            let user = state
                .messages
                .iter()
                .find(|message| message.role == agent_transcript_core::AgentMessageRole::User)
                .unwrap();
            assert!(user.parts.iter().any(|part| matches!(part, AgentTranscriptPart::Text { text: raw, .. } if raw == &text)), "{kind:?}");
            let documents = agent_transcript_view::search::transcript::documents_with_user_text(
                &state,
                |raw| super::request(raw).unwrap_or_else(|| raw.into()),
            );
            assert!(
                documents.iter().any(|document| document.text == REQUEST),
                "{kind:?}"
            );
            assert!(
                !documents
                    .iter()
                    .any(|document| document.text.contains("tracking metadata")),
                "{kind:?}"
            );
        }
    }
}
