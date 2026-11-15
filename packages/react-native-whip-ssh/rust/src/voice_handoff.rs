//! Strict presentation parsing for Whip's versioned voice handoff wrapper.
use serde::{Deserialize, Serialize};

const FOOTER: &str = "\n[Whip voice presentation v1; ";
const PREFIX: &str = "[Whip voice handoff ";
const SUFFIX: &str = "; tracking metadata]\n";
pub(crate) const LIVE_PREFIX: &str =
    "New spoken request from this agent-bound voice call (transcription can contain mistakes):\n";
pub(crate) const LIVE_SUFFIX: &str = "\n\nUse the existing agent conversation/workspace. Keep approvals in Whip. The call may end while you work. Return a concise public answer; do not include private reasoning or secrets.";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation {
    id: String,
    request: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextualRequest {
    request: String,
    voice_context: VoiceContext,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VoiceContext {
    messages: Vec<serde_json::Value>,
}

pub(crate) fn marker() -> String {
    format!("{PREFIX}{}{SUFFIX}", uuid::Uuid::new_v4())
}

fn marked_input(text: &str) -> Option<(&str, &str)> {
    let (marker, input) = text.strip_prefix(PREFIX)?.split_once(SUFFIX)?;
    let id = uuid::Uuid::parse_str(marker).ok()?;
    (id.get_version_num() == 4 && id.to_string() == marker).then_some((marker, input))
}

pub(crate) fn format(source: String, request: &str) -> String {
    let Some((id, _)) = marked_input(&source) else {
        return source;
    };
    let presentation = Presentation {
        id: id.into(),
        request: request.into(),
    };
    match serde_json::to_string(&presentation) {
        Ok(data) => format!("{source}{FOOTER}{data}]"),
        Err(_) => source,
    }
}

/// Extract only a complete versioned wrapper whose nonce and task input agree.
/// Marker-like text and malformed or truncated wrappers retain their full source.
#[uniffi::export]
pub fn voice_handoff_request(text: String) -> Option<String> {
    request(&text)
}

pub(crate) fn request(text: &str) -> Option<String> {
    let (source, footer) = text.rsplit_once(FOOTER)?;
    let (id, input) = marked_input(source)?;
    let presentation: Presentation = serde_json::from_str(footer.strip_suffix(']')?).ok()?;
    if id != presentation.id {
        return None;
    }
    let contextual = input
        .strip_prefix(crate::realtime_voice::handoff_context::PREAMBLE)
        .map(serde_json::from_str::<ContextualRequest>)
        .transpose()
        .ok()?;
    if let Some(context) = &contextual
        && context.voice_context.messages.iter().any(|caption| {
            !matches!(caption["role"].as_str(), Some("user" | "assistant"))
                || !caption["text"].is_string()
        })
    {
        return None;
    }
    let input = contextual
        .as_ref()
        .map_or(input, |context| context.request.as_str());
    let spoken = input
        .strip_prefix(LIVE_PREFIX)
        .and_then(|input| input.strip_suffix(LIVE_SUFFIX));
    (input == presentation.request || spoken == Some(presentation.request.as_str()))
        .then_some(presentation.request)
}

#[cfg(test)]
mod tests;
