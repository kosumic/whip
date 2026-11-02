//! Bounded, recent speech from every live transcript, independent of presentation.

use crate::{
    AgentTranscriptKind, ChatSpeechMessage, ChatSpeechQueue, chat_speech::speech_chunks_with_limit,
};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

const MAX_PENDING: usize = 4;
const MAX_PENDING_UNITS: usize = 800;
const MAX_CONTENT_UNITS: usize = 300;
const MAX_AGE_MS: u64 = 15_000;

#[derive(uniffi::Record)]
pub struct ChatSpeechUtterance {
    pub key: String,
    pub text: String,
}

struct Pending {
    utterance: ChatSpeechUtterance,
    queued_at: u64,
}

#[derive(Default)]
struct State {
    transcripts: HashMap<String, Arc<ChatSpeechQueue>>,
    pending: VecDeque<Pending>,
    playing_key: Option<String>,
}

impl State {
    fn competing_with(&self, key: &str) -> bool {
        self.playing_key
            .as_deref()
            .is_some_and(|playing| playing != key)
            || self.pending.iter().any(|item| item.utterance.key != key)
    }

    fn trim_competing(&mut self, now_ms: u64) {
        self.pending
            .retain(|item| now_ms.saturating_sub(item.queued_at) <= MAX_AGE_MS);
        while self.pending.len() > MAX_PENDING
            || self
                .pending
                .iter()
                .map(|item| item.utterance.text.encode_utf16().count())
                .sum::<usize>()
                > MAX_PENDING_UNITS
        {
            self.pending.pop_front();
        }
    }
}

#[derive(Default, uniffi::Object)]
pub struct AutomaticChatSpeechQueue {
    state: Mutex<State>,
}

#[uniffi::export]
impl AutomaticChatSpeechQueue {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn update(
        &self,
        key: String,
        agent: AgentTranscriptKind,
        tab_name: String,
        live: bool,
        baseline: bool,
        messages: Vec<ChatSpeechMessage>,
        now_ms: u64,
    ) {
        let mut state = self.state.lock();
        state
            .pending
            .retain(|item| item.utterance.key != key || (live && !baseline));
        let queue = state
            .transcripts
            .entry(key.clone())
            .or_insert_with(ChatSpeechQueue::new)
            .clone();
        if baseline {
            queue.update(agent, false, Vec::new());
        }
        queue.update(agent, live, messages);
        let competing = state.competing_with(&key);
        while let Some(text) = queue.next() {
            for text in speech_chunks_with_limit(&text, MAX_CONTENT_UNITS) {
                state.pending.push_back(Pending {
                    utterance: ChatSpeechUtterance {
                        key: key.clone(),
                        text: chat_speech_announcement(tab_name.clone(), text),
                    },
                    queued_at: now_ms,
                });
                if competing {
                    state.trim_competing(now_ms);
                }
            }
        }
    }

    pub fn next(&self, now_ms: u64) -> Option<ChatSpeechUtterance> {
        let mut state = self.state.lock();
        let competing = state
            .pending
            .front()
            .is_some_and(|first| state.competing_with(&first.utterance.key));
        while let Some(item) = state.pending.pop_front() {
            if !competing || now_ms.saturating_sub(item.queued_at) <= MAX_AGE_MS {
                state.playing_key = Some(item.utterance.key.clone());
                return Some(item.utterance);
            }
        }
        state.playing_key = None;
        None
    }

    pub fn remove(&self, key: String) {
        let mut state = self.state.lock();
        state.transcripts.remove(&key);
        state.pending.retain(|item| item.utterance.key != key);
        if state.playing_key.as_deref() == Some(&key) {
            state.playing_key = None;
        }
    }

    pub fn reset(&self) {
        *self.state.lock() = State::default();
    }
}

#[uniffi::export]
pub fn chat_speech_announcement(tab_name: String, text: String) -> String {
    let name = tab_name.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        return text;
    }
    let suffix = if name.to_ascii_lowercase().ends_with(" tab") {
        ""
    } else {
        " tab"
    };
    format!("{name}{suffix}: {text}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ChatSpeechPart;

    fn messages(id: &str, text: &str) -> Vec<ChatSpeechMessage> {
        vec![ChatSpeechMessage {
            id: id.into(),
            assistant: true,
            completed: true,
            prose: vec![ChatSpeechPart::Text {
                id: id.into(),
                text: text.into(),
            }],
        }]
    }

    fn update(queue: &AutomaticChatSpeechQueue, key: &str, id: &str, now: u64) {
        queue.update(
            key.into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            messages(id, id),
            now,
        );
    }

    fn take(queue: &AutomaticChatSpeechQueue, now: u64) -> ChatSpeechUtterance {
        match queue.next(now) {
            Some(item) => item,
            None => panic!("Expected a queued speech update"),
        }
    }

    #[test]
    fn every_transcript_has_its_own_baseline_and_fifo_speech() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        assert!(queue.next(0).is_none());
        update(&queue, "two", "second agent", 1);
        update(&queue, "one", "first agent", 2);
        let next = take(&queue, 2);
        assert_eq!(next.key, "two");
        assert_eq!(next.text, "Debug tab: second agent");
        assert_eq!(take(&queue, 2).key, "one");
        update(&queue, "one", "first agent", 3);
        assert!(queue.next(3).is_none());
    }

    #[test]
    fn overload_drops_oldest_waiting_updates_and_stale_speech_expires() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        for index in 0..10 {
            update(
                &queue,
                if index % 2 == 0 { "one" } else { "two" },
                &index.to_string(),
                index,
            );
        }
        assert_eq!(take(&queue, 10).text, "Debug tab: 6");
        assert_eq!(take(&queue, 10).text, "Debug tab: 7");
        assert_eq!(take(&queue, 10).text, "Debug tab: 8");
        assert_eq!(take(&queue, 10).text, "Debug tab: 9");
        assert!(queue.next(10).is_none());
        update(&queue, "one", "stale", 10);
        update(&queue, "two", "history", 10);
        update(&queue, "two", "recent", MAX_AGE_MS + 11);
        assert_eq!(take(&queue, MAX_AGE_MS + 11).text, "Debug tab: recent");
        assert!(queue.next(MAX_AGE_MS + 11).is_none());
    }

    #[test]
    fn a_single_speaking_chat_finishes_without_expiry_even_with_other_idle_chats() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        let text = "🦀".repeat(5000);
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            messages("long", &text),
            1,
        );
        let mut count = 0;
        let mut spoken = String::new();
        while let Some(item) = queue.next(MAX_AGE_MS * 10) {
            let size = item.text.encode_utf16().count();
            assert!(size <= MAX_CONTENT_UNITS + "Debug tab: ".len());
            spoken.push_str(item.text.strip_prefix("Debug tab: ").unwrap_or_default());
            count += 1;
        }
        assert!(count > MAX_PENDING);
        assert_eq!(spoken, text);
    }

    #[test]
    fn another_speaking_chat_bounds_and_expires_the_solo_backlog() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            messages("long", &"a".repeat(5000)),
            1,
        );
        assert_eq!(take(&queue, 1).key, "one");
        update(&queue, "two", "Recent update", MAX_AGE_MS + 2);
        let next = take(&queue, MAX_AGE_MS + 2);
        assert_eq!(next.key, "two");
        assert_eq!(next.text, "Debug tab: Recent update");
        assert!(queue.next(MAX_AGE_MS + 2).is_none());
    }

    #[test]
    fn stale_or_removed_transcripts_drop_only_their_own_waiting_speech() {
        let queue = AutomaticChatSpeechQueue::new();
        for key in ["one", "two"] {
            update(&queue, key, "history", 0);
            update(&queue, key, "new", 1);
        }
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            false,
            false,
            vec![],
            2,
        );
        assert_eq!(take(&queue, 2).key, "two");
        assert!(queue.next(2).is_none());
        update(&queue, "two", "another", 3);
        queue.remove("two".into());
        assert!(queue.next(3).is_none());
    }

    #[test]
    fn tab_prefix_handles_existing_suffix_and_missing_name() {
        assert_eq!(
            chat_speech_announcement("debug tab".into(), "Hello".into()),
            "debug tab: Hello"
        );
        assert_eq!(
            chat_speech_announcement("  ".into(), "Hello".into()),
            "Hello"
        );
    }
}
