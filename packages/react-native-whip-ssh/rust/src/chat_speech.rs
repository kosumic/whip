//! Speech selection and ordering for one explicitly selected chat binding.

use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
};

use crate::AgentTranscriptKind;
use parking_lot::Mutex;

#[derive(uniffi::Record)]
pub struct ChatSpeechPart {
    pub id: String,
    pub text: String,
}

/// The platform adapter projects only prose parts, never tools or reasoning.
#[derive(uniffi::Record)]
pub struct ChatSpeechMessage {
    pub id: String,
    pub assistant: bool,
    pub completed: bool,
    pub prose: Vec<ChatSpeechPart>,
}

#[derive(Default)]
struct SpeechState {
    live: bool,
    seen: HashSet<(String, String)>,
    pending: VecDeque<String>,
}

#[derive(Default, uniffi::Object)]
pub struct ChatSpeechQueue {
    state: Mutex<SpeechState>,
}

#[uniffi::export]
impl ChatSpeechQueue {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every initial load/reconnect establishes a baseline before accepting new
    /// completions. An unfinished message at the baseline may finish later.
    pub fn update(&self, agent: AgentTranscriptKind, live: bool, messages: Vec<ChatSpeechMessage>) {
        let mut state = self.state.lock();
        if !live {
            state.live = false;
            state.pending.clear();
            return;
        }
        for message in messages {
            // Codex publishes completed response items as parts of one growing
            // turn message. OpenCode streams parts until message completion.
            if !message.assistant || (agent == AgentTranscriptKind::OpenCode && !message.completed)
            {
                continue;
            }
            for part in message.prose {
                if state.seen.insert((message.id.clone(), part.id)) && state.live {
                    state
                        .pending
                        .extend(speech_chunks(&spoken_prose(&part.text)));
                }
            }
        }
        state.live = true;
    }

    pub fn next(&self) -> Option<String> {
        self.state.lock().pending.pop_front()
    }
}

// Keep each utterance below Android's 4,000 UTF-16-unit limit, including emoji.
const MAX_CHUNK_UNITS: usize = 3_000;

fn speech_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut units = 0;
    for word in text.split_whitespace() {
        let word_units = word.encode_utf16().count();
        if !chunk.is_empty() && units + 1 + word_units > MAX_CHUNK_UNITS {
            chunks.push(std::mem::take(&mut chunk));
            units = 0;
        }
        if !chunk.is_empty() {
            chunk.push(' ');
            units += 1;
        }
        for character in word.chars() {
            if units + character.len_utf16() > MAX_CHUNK_UNITS {
                chunks.push(std::mem::take(&mut chunk).trim().to_owned());
                units = 0;
            }
            chunk.push(character);
            units += character.len_utf16();
        }
        if units >= MAX_CHUNK_UNITS {
            chunks.push(std::mem::take(&mut chunk));
            units = 0;
        }
    }
    if !chunk.trim().is_empty() {
        chunks.push(chunk.trim().to_owned());
    }
    chunks
}

/// Lightweight speech formatting: omit fenced/indented code and links' URLs,
/// preserving their human-readable labels and inline code words.
fn spoken_prose(markdown: &str) -> String {
    let mut prose = String::new();
    let mut fence: Option<(char, usize)> = None;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().unwrap_or(' ');
        let count = trimmed.chars().take_while(|&c| c == marker).count();
        if let Some((opening, length)) = fence {
            if marker == opening && count >= length {
                fence = None;
            }
            continue;
        }
        if matches!(marker, '`' | '~') && count >= 3 {
            fence = Some((marker, count));
            continue;
        }
        if line.starts_with("    ") || line.starts_with('\t') {
            continue;
        }
        let trimmed = trimmed.trim_start_matches(['#', '>', '-', '+', '*', ' ']);
        let mut chars = trimmed.chars().peekable();
        while let Some(character) = chars.next() {
            match character {
                ']' if chars.peek() == Some(&'(') => {
                    chars.next();
                    let mut depth = 1;
                    for c in chars.by_ref() {
                        match c {
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            _ => {}
                        }
                        if depth == 0 {
                            break;
                        }
                    }
                }
                '!' if chars.peek() == Some(&'[') => {}
                '[' | ']' | '*' | '_' | '`' | '~' => {}
                _ => prose.push(character),
            }
        }
        prose.push(' ');
    }
    prose.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, completed: bool, text: &str) -> ChatSpeechMessage {
        ChatSpeechMessage {
            id: id.into(),
            assistant: true,
            completed,
            prose: vec![ChatSpeechPart {
                id: id.into(),
                text: text.into(),
            }],
        }
    }

    #[test]
    fn speaks_new_completions_once_without_replaying_history() {
        let queue = ChatSpeechQueue::new();
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![
                message("old", true, "History"),
                message("stream", false, "Hel"),
            ],
        );
        assert_eq!(queue.next(), None);
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![
                message("old", true, "History"),
                message("stream", false, "Hello"),
            ],
        );
        assert_eq!(queue.next(), None);
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![
                message("stream", true, "Hello"),
                message("next", true, "World"),
            ],
        );
        assert_eq!(queue.next().as_deref(), Some("Hello"));
        assert_eq!(queue.next().as_deref(), Some("World"));
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![message("stream", true, "Hello again")],
        );
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn reconnect_discards_queue_and_baselines_catchup() {
        let queue = ChatSpeechQueue::new();
        queue.update(
            AgentTranscriptKind::OpenCode,
            false,
            vec![message("cache", true, "Cached")],
        );
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![message("history", true, "History")],
        );
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![message("new", true, "Queued")],
        );
        queue.update(AgentTranscriptKind::OpenCode, false, vec![]);
        assert_eq!(queue.next(), None);
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![message("catchup", true, "Missed while disconnected")],
        );
        assert_eq!(queue.next(), None);
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![message("live", true, "Live again")],
        );
        assert_eq!(queue.next().as_deref(), Some("Live again"));
    }

    #[test]
    fn ignores_user_and_non_prose_messages() {
        let queue = ChatSpeechQueue::new();
        queue.update(AgentTranscriptKind::OpenCode, true, vec![]);
        let mut user = message("user", true, "Do this");
        user.assistant = false;
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![user, message("tool", true, "")],
        );
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn codex_reads_new_parts_in_the_same_turn_once() {
        let queue = ChatSpeechQueue::new();
        queue.update(
            AgentTranscriptKind::Codex,
            true,
            vec![message("turn", false, "Old progress")],
        );
        let mut turn = message("turn", false, "Old progress");
        turn.prose.push(ChatSpeechPart {
            id: "final".into(),
            text: "Finished".into(),
        });
        queue.update(AgentTranscriptKind::Codex, true, vec![turn]);
        assert_eq!(queue.next().as_deref(), Some("Finished"));
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn strips_markdown_and_code_but_keeps_link_labels() {
        assert_eq!(
            spoken_prose(
                "## Done\n**Read** [the guide](https://example.com/a(b)) and `retry`.\n```rust\nsecret();\n```\n    code();\n- Finished."
            ),
            "Done Read the guide and retry. Finished."
        );
    }

    #[test]
    fn chunks_long_unicode_replies_without_losing_text() {
        let text = "🦀".repeat(4_001);
        let chunks = speech_chunks(&text);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.encode_utf16().count() <= MAX_CHUNK_UNITS)
        );
        assert_eq!(chunks.concat(), text);
    }
}
