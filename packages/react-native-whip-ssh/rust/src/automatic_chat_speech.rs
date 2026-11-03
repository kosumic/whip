//! Bounded, recent speech from every live transcript, independent of presentation.

use crate::{
    AgentTranscriptKind, ChatSpeechMessage, ChatSpeechQueue, chat_speech::speech_chunks_with_limit,
};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    tab_prefix: String,
    message_id: String,
    part_id: String,
    queued_at: u64,
}

type SpeechIdentity = (String, String, String);

#[derive(Default)]
struct State {
    transcripts: HashMap<String, Arc<ChatSpeechQueue>>,
    pending: VecDeque<Pending>,
    playing_key: Option<String>,
    playing_part: Option<SpeechIdentity>,
    // Prefix history survives idle gaps and dismissal, independently of playback.
    last_spoken_source: Option<(String, String)>,
    dismissed: HashSet<SpeechIdentity>,
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
                .map(|item| {
                    item.utterance.text.encode_utf16().count()
                        + item.tab_prefix.encode_utf16().count()
                })
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

    #[allow(
        clippy::too_many_arguments,
        reason = "UniFFI update accepts transcript identity, state, content, and timestamp independently"
    )]
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
        let queue = state.transcripts.entry(key.clone()).or_default().clone();
        if baseline {
            queue.update(agent, false, Vec::new());
        }
        queue.update(agent, live, messages);
        let competing = state.competing_with(&key);
        while let Some(chunk) = queue.next_content() {
            if state.dismissed.contains(&(
                key.clone(),
                chunk.message_id.clone(),
                chunk.part_id.clone(),
            )) {
                continue;
            }
            for text in speech_chunks_with_limit(&chunk.text, MAX_CONTENT_UNITS) {
                state.pending.push_back(Pending {
                    utterance: ChatSpeechUtterance {
                        key: key.clone(),
                        text,
                    },
                    tab_prefix: chat_speech_prefix(&tab_name),
                    message_id: chunk.message_id.clone(),
                    part_id: chunk.part_id.clone(),
                    queued_at: now_ms,
                });
                if competing {
                    state.trim_competing(now_ms);
                }
            }
        }
        drop(state);
    }

    pub fn next(&self, now_ms: u64) -> Option<ChatSpeechUtterance> {
        let mut state = self.state.lock();
        let competing = state
            .pending
            .front()
            .is_some_and(|first| state.competing_with(&first.utterance.key));
        while let Some(mut item) = state.pending.pop_front() {
            if !competing || now_ms.saturating_sub(item.queued_at) <= MAX_AGE_MS {
                let same_source = state
                    .last_spoken_source
                    .as_ref()
                    .is_some_and(|(key, prefix)| {
                        key == &item.utterance.key && prefix == &item.tab_prefix
                    });
                if !same_source {
                    item.utterance.text.insert_str(0, &item.tab_prefix);
                }
                state.last_spoken_source = Some((item.utterance.key.clone(), item.tab_prefix));
                state.playing_key = Some(item.utterance.key.clone());
                state.playing_part =
                    Some((item.utterance.key.clone(), item.message_id, item.part_id));
                return Some(item.utterance);
            }
        }
        state.playing_key = None;
        state.playing_part = None;
        None
    }

    /// Dismiss the whole currently spoken update, including its remaining chunks.
    /// Other queued updates and transcript history baselines remain intact.
    pub fn dismiss_current(&self) {
        let mut state = self.state.lock();
        let Some(identity) = state.playing_part.take() else {
            return;
        };
        state.pending.retain(|item| {
            item.utterance.key != identity.0
                || item.message_id != identity.1
                || item.part_id != identity.2
        });
        state.playing_key = None;
        state.dismissed.insert(identity);
    }

    pub fn remove(&self, key: String) {
        let mut state = self.state.lock();
        state.transcripts.remove(&key);
        state.pending.retain(|item| item.utterance.key != key);
        state.dismissed.retain(|identity| identity.0 != key);
        if state.playing_key.as_deref() == Some(&key) {
            state.playing_key = None;
            state.playing_part = None;
        }
    }

    pub fn reset(&self) {
        *self.state.lock() = State::default();
    }
}

#[uniffi::export]
pub fn chat_speech_announcement(tab_name: String, text: String) -> String {
    format!("{}{text}", chat_speech_prefix(&tab_name))
}

fn chat_speech_prefix(tab_name: &str) -> String {
    let name = tab_name.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        return String::new();
    }
    let suffix = if name.to_ascii_lowercase().ends_with(" tab") {
        ""
    } else {
        " tab"
    };
    format!("{name}{suffix}: ")
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
    fn tab_prefix_follows_spoken_source_across_chunks_idle_gaps_and_switches() {
        let queue = AutomaticChatSpeechQueue::new();
        for key in ["one", "two"] {
            update(&queue, key, "history", 0);
        }
        update(&queue, "one", "First update", 1);
        update(&queue, "one", "Second update", 2);
        assert_eq!(take(&queue, 2).text, "Debug tab: First update");
        assert_eq!(take(&queue, 2).text, "Second update");
        assert!(queue.next(2).is_none());

        update(&queue, "one", "After idle", 3);
        assert_eq!(take(&queue, 3).text, "After idle");
        // Different sources still announce themselves when their labels match.
        update(&queue, "two", "Other tab", 4);
        update(&queue, "one", "Back again", 5);
        assert_eq!(take(&queue, 5).text, "Debug tab: Other tab");
        assert_eq!(take(&queue, 5).text, "Debug tab: Back again");

        queue.reset();
        update(&queue, "one", "history", 6);
        update(&queue, "one", "After reset", 7);
        assert_eq!(take(&queue, 7).text, "Debug tab: After reset");
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Build".into(),
            true,
            false,
            messages("renamed", "Renamed tab"),
            8,
        );
        assert_eq!(take(&queue, 8).text, "Build tab: Renamed tab");
    }

    #[test]
    fn expired_updates_do_not_change_the_previous_spoken_source() {
        let queue = AutomaticChatSpeechQueue::new();
        for key in ["one", "two"] {
            update(&queue, key, "history", 0);
        }
        update(&queue, "one", "First update", 1);
        assert_eq!(take(&queue, 1).text, "Debug tab: First update");
        update(&queue, "two", "Expired other tab", 2);
        update(&queue, "one", "Expired same tab", 3);
        assert!(queue.next(MAX_AGE_MS + 4).is_none());

        update(&queue, "one", "Fresh update", MAX_AGE_MS + 5);
        assert_eq!(take(&queue, MAX_AGE_MS + 5).text, "Fresh update");
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
        assert_eq!(take(&queue, MAX_AGE_MS + 11).text, "recent");
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
            if count == 0 {
                assert!(item.text.starts_with("Debug tab: "));
            } else {
                assert!(!item.text.starts_with("Debug tab: "));
            }
            spoken.push_str(item.text.strip_prefix("Debug tab: ").unwrap_or(&item.text));
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
    fn dismissing_an_update_drops_only_its_remaining_chunks_and_continuations() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        let current = |length| {
            let mut response = messages("current", &"a".repeat(length));
            response[0].completed = false;
            response
        };
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            current(600),
            1,
        );
        let first = take(&queue, 1);
        assert_eq!(
            first.text,
            format!("Debug tab: {}", "a".repeat(MAX_CONTENT_UNITS))
        );
        update(&queue, "one", "Later update", 2);
        update(&queue, "two", "Other chat", 2);
        queue.dismiss_current();
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            current(900),
            3,
        );
        assert_eq!(take(&queue, 3).text, "Later update");
        assert_eq!(take(&queue, 3).text, "Debug tab: Other chat");
        assert!(queue.next(3).is_none());
        update(&queue, "one", "Future update", 4);
        assert_eq!(take(&queue, 4).text, "Debug tab: Future update");
        assert!(queue.next(4).is_none());
    }

    #[test]
    fn dismissal_preserves_later_parts_in_the_same_response() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        let mut response = messages("response", &"a".repeat(600));
        response[0].prose.push(ChatSpeechPart::Text {
            id: "later-part".into(),
            text: "Next part.".into(),
        });
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            response,
            1,
        );
        let _ = take(&queue, 1);
        queue.dismiss_current();
        assert_eq!(take(&queue, 1).text, "Next part.");
        assert!(queue.next(1).is_none());
    }

    #[test]
    fn dismissing_without_a_current_utterance_preserves_waiting_updates() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "one", "Waiting update", 1);
        queue.dismiss_current();
        assert_eq!(take(&queue, 1).text, "Debug tab: Waiting update");
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
