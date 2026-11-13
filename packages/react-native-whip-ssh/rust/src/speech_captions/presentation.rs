//! Presentation belongs to the playback evidence, never to a Markdown marker.
use super::{CAPTIONS, Caption};
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString, c_char};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Preparing,
    Speaking,
    Buffering,
    Finished,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSource {
    pub token: String,
    pub message_id: String,
    pub start_utf16: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub lease: u64,
    pub local: Option<LocalSource>,
    pub session_id: String,
    pub host_id: String,
    pub pane_id: String,
    pub binding_tokens: Vec<String>,
    pub message_id: String,
    pub part_id: String,
    pub text: String,
    pub start_utf16: usize,
    pub spoken_end_utf16: usize,
    pub current_word_range_utf16: Option<WordRange>,
    pub phase: Phase,
    pub played_frames: usize,
    pub end_reason: Option<String>,
}

impl Snapshot {
    fn same_source(&self, other: &Self) -> bool {
        self.lease == other.lease
            && self.session_id == other.session_id
            && self.host_id == other.host_id
            && self.pane_id == other.pane_id
            && self.message_id == other.message_id
            && self.part_id == other.part_id
            && self.binding_tokens == other.binding_tokens
    }
    fn active(&self) -> bool {
        !matches!(self.phase, Phase::Finished | Phase::Cancelled)
    }
    pub(super) fn advance(&mut self, position: usize, word: Option<WordRange>) {
        if !self.active() || position < self.spoken_end_utf16 {
            return;
        }
        self.spoken_end_utf16 = position;
        if word.is_some() {
            self.current_word_range_utf16 = word;
        }
        self.phase = Phase::Speaking;
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Command {
    Bind {
        id: u64,
        owner: String,
        lease: u64,
        source: serde_json::Value,
    },
    Range {
        id: u64,
        start: usize,
        end: usize,
    },
    Buffer {
        id: u64,
    },
    Clear {
        id: u64,
        reason: String,
    },
}

pub(super) fn word_at(text: &str, cursor: usize) -> Option<WordRange> {
    let mut position = 0;
    let mut begin = None;
    for c in text.chars().chain(std::iter::once(' ')) {
        let end = position + c.len_utf16();
        let cjk = matches!(u32::from(c), 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7ff | 0x2_0000..=0x3_134f);
        let lexical = c.is_alphanumeric() || matches!(c, '\'' | '’' | '\u{0300}'..='\u{036f}');
        if cjk || !lexical {
            if let Some(start) = begin.take()
                && start <= cursor
                && cursor < position
            {
                return Some(WordRange {
                    start,
                    end: position,
                });
            }
            if cjk && position <= cursor && cursor < end {
                return Some(WordRange {
                    start: position,
                    end,
                });
            }
        } else if begin.is_none() {
            begin = Some(position);
        }
        position = end;
    }
    None
}

fn source_snapshot(
    id: u64,
    lease: u64,
    owner: String,
    mut source: serde_json::Value,
) -> Option<Snapshot> {
    // Local call captions use a separate display offset. Normalize to the chat
    // source here so every platform and subscriber sees the same coordinate space.
    let local = source.get("localToken").and_then(|token| {
        Some(LocalSource {
            token: token.as_str()?.into(),
            message_id: source.get("messageId")?.as_str()?.into(),
            start_utf16: usize::try_from(source.get("startUtf16")?.as_u64()?).ok()?,
        })
    });
    if let Some(chat) = source.get("chat").filter(|chat| chat.is_object()).cloned() {
        let text = source.get("text")?.clone();
        source = chat;
        source["text"] = text;
    } else if local.is_some() {
        source["hostId"] = "".into();
        source["paneId"] = "".into();
    }
    Some(Snapshot {
        id,
        lease,
        local,
        session_id: owner,
        host_id: source.get("hostId")?.as_str()?.into(),
        pane_id: source.get("paneId")?.as_str()?.into(),
        binding_tokens: serde_json::from_value(source.get("bindingTokens")?.clone()).ok()?,
        message_id: source.get("messageId")?.as_str()?.into(),
        part_id: source.get("partId")?.as_str()?.into(),
        text: source.get("text")?.as_str()?.into(),
        start_utf16: usize::try_from(source.get("startUtf16")?.as_u64()?).ok()?,
        spoken_end_utf16: 0,
        current_word_range_utf16: None,
        phase: Phase::Preparing,
        played_frames: 0,
        end_reason: None,
    })
}

pub(super) fn command(json: &str) -> String {
    let Ok(command) = serde_json::from_str::<Command>(json) else {
        return "null".into();
    };
    let mut state = CAPTIONS.lock();
    let lease = match &command {
        Command::Bind { lease, .. } => Some(*lease),
        Command::Range { .. } | Command::Buffer { .. } => {
            state.presentation.as_ref().map(|s| s.lease)
        }
        Command::Clear { .. } => None,
    };
    if lease.is_some_and(|lease| !crate::speech_playback::is_current(lease)) {
        return "null".into();
    }
    let result = apply(&mut state, command);
    drop(state);
    result
}

fn apply(state: &mut super::Captions, command: Command) -> String {
    match command {
        Command::Bind {
            id,
            lease,
            owner,
            source,
        } => {
            if !state.pending.iter().any(|c| c.id == id) {
                return "null".into();
            }
            // Caption IDs are monotonic utterance generations, including prefetch.
            if state.presentation.as_ref().is_some_and(|s| id <= s.id) {
                return "null".into();
            }
            let Some(mut next) = source_snapshot(id, lease, owner, source) else {
                return "null".into();
            };
            if let Some(previous) = state
                .presentation
                .as_ref()
                .filter(|s| s.active() && s.same_source(&next))
            {
                next.spoken_end_utf16 = previous.spoken_end_utf16;
                next.current_word_range_utf16
                    .clone_from(&previous.current_word_range_utf16);
            }
            state.presentation = Some(next);
        }
        Command::Range { id, start, end } => {
            let Some(caption) = state.pending.iter().find(|c| c.id == id) else {
                return "null".into();
            };
            let prefix = caption.prefix_utf16;
            let length = caption.spoken.encode_utf16().count();
            if start < prefix || start >= end || end > length {
                return "null".into();
            }
            let Some(snapshot) = state
                .presentation
                .as_mut()
                .filter(|s| s.id == id && s.active())
            else {
                return "null".into();
            };
            let start = snapshot.start_utf16 + start - prefix;
            let end = snapshot.start_utf16 + end - prefix;
            snapshot.advance(start, Some(WordRange { start, end }));
        }
        Command::Buffer { id } => {
            let Some(snapshot) = state
                .presentation
                .as_mut()
                .filter(|s| s.id == id && s.active())
            else {
                return "null".into();
            };
            // This command is sent only after native confirms the audio drained.
            snapshot.spoken_end_utf16 = snapshot
                .spoken_end_utf16
                .max(snapshot.start_utf16 + snapshot.text.encode_utf16().count());
            snapshot.phase = Phase::Buffering;
        }
        Command::Clear { id, reason } => {
            let Some(snapshot) = state
                .presentation
                .as_mut()
                .filter(|s| s.id == id && s.active())
            else {
                return "null".into();
            };
            snapshot.phase = if reason == "completed" {
                Phase::Finished
            } else {
                Phase::Cancelled
            };
            snapshot.current_word_range_utf16 = None;
            snapshot.end_reason = Some(reason);
        }
    }
    if let Some(snapshot) = &state.presentation {
        log::info!(
            "caption id={} lease={} spoken={} word={:?} frames={} phase={:?} end={:?}",
            snapshot.id,
            snapshot.lease,
            snapshot.spoken_end_utf16,
            snapshot.current_word_range_utf16,
            snapshot.played_frames,
            snapshot.phase,
            snapshot.end_reason
        );
    }
    serde_json::to_string(&state.presentation).unwrap_or_else(|_| "null".into())
}

pub(super) fn pcm(
    snapshot: &mut Snapshot,
    caption: &Caption,
    position: usize,
    played: usize,
    samples: usize,
) {
    if !snapshot.active()
        || snapshot.id != caption.id
        || played == 0
        || played > samples
        || played <= snapshot.played_frames
    {
        return;
    }
    snapshot.played_frames = played;
    if position < caption.prefix_utf16 || caption.response_start.is_none_or(|start| played <= start)
    {
        return;
    }
    let cursor = position - caption.prefix_utf16;
    let word = word_at(&snapshot.text, cursor).map(|r| WordRange {
        start: r.start + snapshot.start_utf16,
        end: r.end + snapshot.start_utf16,
    });
    snapshot.advance(snapshot.start_utf16 + cursor, word);
}

/// Immutable process snapshot; subscriptions are only wake-ups, so remounts and
/// delayed bridge events always read the authoritative current generation.
#[uniffi::export]
pub fn speech_caption_snapshot() -> String {
    let state = CAPTIONS.lock();
    if state
        .presentation
        .as_ref()
        .is_some_and(|s| s.active() && !crate::speech_playback::is_current(s.lease))
    {
        return "null".into();
    }
    let result = serde_json::to_string(&state.presentation).unwrap_or_else(|_| "null".into());
    drop(state);
    result
}

/// Ranges returned here refer to the original Markdown's UTF-16 coordinates.
/// Native Markdown parsing projects them into attributed text without == edits.
#[uniffi::export]
pub fn chat_speech_presentation(markdown: String, snapshot: String) -> String {
    let Ok(snapshot) = serde_json::from_str::<Snapshot>(&snapshot) else {
        return "null".into();
    };
    if !snapshot.active() {
        return "null".into();
    }
    let (prose, spans) = crate::chat_speech::mapped_prose(&markdown);
    let units = prose.encode_utf16().collect::<Vec<_>>();
    let expected = snapshot.text.encode_utf16().collect::<Vec<_>>();
    if units.get(snapshot.start_utf16..snapshot.start_utf16.saturating_add(expected.len()))
        != Some(expected.as_slice())
    {
        // A rewritten/temporarily unavailable source is not playback evidence.
        // Keep explicit upcoming styling and never project a word into it.
        return serde_json::json!({ "phase": snapshot.phase, "spokenEnd": 0, "currentWord": null })
            .to_string();
    }
    let byte_end = |end: usize| {
        spans
            .get(end.saturating_sub(1))
            .filter(|_| end > 0)
            .map_or(0, |r| r.end)
    };
    let source_units = |byte: usize| markdown[..byte].encode_utf16().count();
    let word = snapshot.current_word_range_utf16.as_ref().and_then(|r| {
        if r.start >= r.end {
            return None;
        }
        Some(WordRange {
            start: source_units(spans.get(r.start)?.start),
            end: source_units(byte_end(r.end)),
        })
    });
    serde_json::json!({ "phase": snapshot.phase, "spokenEnd": source_units(byte_end(snapshot.spoken_end_utf16)), "currentWord": word }).to_string()
}

/// # Safety
/// `json` must be a live NUL-terminated UTF-8 string. Free the result with
/// `whip_speech_backend_free`, which uses the same CString allocation contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_caption_command(json: *const c_char) -> *mut c_char {
    if json.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller supplies a live NUL-terminated string.
    let json = unsafe { CStr::from_ptr(json) }.to_string_lossy();
    CString::new(command(&json)).map_or(std::ptr::null_mut(), CString::into_raw)
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
