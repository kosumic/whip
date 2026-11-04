//! Whip transcript selection and policy over the portable mobile-speech queue.
use crate::{
    AgentTranscriptKind, ChatSpeechMessage, ChatSpeechQueue, chat_speech::speech_chunks_with_limit,
};
use mobile_speech::{Playback, PlaybackQueue, QueueConfig, QueueItem, WaitingLimits};
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc};

const MAX_PENDING: usize = 4;
const MAX_PENDING_UNITS: usize = 800;
const MAX_CONTENT_UNITS: usize = 300;
const MAX_AGE_MS: u64 = 15_000;

#[derive(uniffi::Record)]
pub struct ChatSpeechUtterance {
    pub key: String,
    pub text: String,
}

struct State {
    transcripts: HashMap<String, Arc<ChatSpeechQueue>>,
    queue: PlaybackQueue,
}
impl Default for State {
    fn default() -> Self {
        Self {
            transcripts: HashMap::new(),
            queue: PlaybackQueue::new(QueueConfig {
                max_waiting_chunks: MAX_PENDING,
                max_waiting_utf16_units: MAX_PENDING_UNITS,
                max_wait_ms: MAX_AGE_MS,
                limits: WaitingLimits::WhenCompeting,
            }),
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
        reason = "Compatibility boundary for the existing UniFFI API"
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
        if !live || baseline {
            state.queue.remove(&key);
        }
        let selector = state.transcripts.entry(key.clone()).or_default().clone();
        if baseline {
            selector.update(agent, false, Vec::new());
        }
        selector.update(agent, live, messages);
        while let Some(chunk) = selector.next_content() {
            let group = format!(
                "{}:{}{}",
                chunk.message_id.len(),
                chunk.message_id,
                chunk.part_id
            );
            let mut offset = 0;
            for text in speech_chunks_with_limit(&chunk.text, MAX_CONTENT_UNITS) {
                let start = offset + chunk.text[offset..].find(&text).unwrap_or(0);
                offset = start + text.len();
                let context = serde_json::json!({
                    "messageId": chunk.message_id, "partId": chunk.part_id,
                    "startUtf16": chunk.start_utf16 + chunk.text[..start].encode_utf16().count(),
                    "text": text,
                })
                .to_string();
                state.queue.enqueue(
                    QueueItem {
                        source: key.clone(),
                        group: group.clone(),
                        text,
                        prefix: chat_speech_prefix(&tab_name),
                        context,
                    },
                    now_ms,
                );
            }
        }
        drop(state);
    }
    /// Compatibility for callers that await completion before asking for next.
    pub fn next(&self, now_ms: u64) -> Option<ChatSpeechUtterance> {
        let mut state = self.state.lock();
        if let Some(id) = state.queue.active().map(|active| active.id) {
            state.queue.complete(id);
        }
        state
            .queue
            .take(now_ms)
            .map(|playback| ChatSpeechUtterance {
                key: playback.item.source,
                text: playback.item.text,
            })
    }
    pub fn dismiss_current(&self) {
        self.state.lock().queue.dismiss_current();
    }
    pub fn remove(&self, key: String) {
        let mut state = self.state.lock();
        state.transcripts.remove(&key);
        state.queue.remove(&key);
    }
    pub fn reset(&self) {
        let mut state = self.state.lock();
        state.transcripts.clear();
        state.queue.clear();
    }
}
impl AutomaticChatSpeechQueue {
    pub(crate) fn has_source(&self, key: &str) -> bool {
        self.state.lock().transcripts.contains_key(key)
    }
    pub(crate) fn clear_source_pending(&self, key: &str) {
        self.state.lock().queue.remove(key);
    }
    pub(crate) fn clear_pending(&self) {
        self.state.lock().queue.clear();
    }
    pub(crate) fn take_native(&self, now_ms: u64) -> Option<Playback> {
        self.state.lock().queue.take(now_ms)
    }
    pub(crate) fn complete_native(&self, id: u64) -> bool {
        self.state.lock().queue.complete(id)
    }
    pub(crate) fn active_id(&self) -> Option<u64> {
        self.state.lock().queue.active().map(|active| active.id)
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
    fn automatic_chunks_keep_source_offsets_across_tab_prefixes_and_competing_chats() {
        let queue = AutomaticChatSpeechQueue::new();
        update(&queue, "one", "history", 0);
        update(&queue, "two", "history", 0);
        let prose = "Hello 你好 👋 world. ".repeat(30);
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            messages("reply", &prose),
            1,
        );
        update(&queue, "two", "competing", 2);
        let mut count = 0;
        while let Some(playback) = queue.take_native(2) {
            let source: serde_json::Value =
                serde_json::from_str(&playback.item.context).unwrap_or_default();
            if playback.item.source == "one" {
                assert_eq!(source["messageId"], "reply");
                assert_eq!(source["partId"], "reply");
                let start = usize::try_from(source["startUtf16"].as_u64().unwrap_or_default())
                    .expect("speech offset fits usize");
                let text = source["text"].as_str().unwrap_or_default();
                assert!(playback.item.text.ends_with(text));
                let original = String::from_utf16(
                    &prose
                        .encode_utf16()
                        .skip(start)
                        .take(text.encode_utf16().count())
                        .collect::<Vec<_>>(),
                );
                assert_eq!(original.ok().as_deref(), Some(text));
                count += 1;
            }
            assert!(queue.complete_native(playback.id));
        }
        assert!(count >= 2);
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
    fn a_started_response_keeps_its_ending_when_another_chat_is_waiting() {
        for (response, ending, competing_at) in [
            (
                "The code doesn’t document why. Likely it’s to keep phrases together: commas can create very short chunks, giving TTS less context for natural intonation and potentially adding gaps. But commas could reduce the delay before speech starts. A reasonable compromise is to allow comma boundaries once enough words have accumulated.",
                "A reasonable compromise is to allow comma boundaries once enough words have accumulated.",
                2,
            ),
            (
                "That narrows it down: the automatic reader splits my reply exactly before “enough words have accumulated.” Its queue can expire that second chunk after 15 seconds when other chats have pending speech—even while it’s reading the first chunk. I’ll protect the remainder of a reply once reading has started, and add a regression using that exact response.",
                "I’ll protect the remainder of a reply once reading has started, and add a regression using that exact response.",
                MAX_AGE_MS + 2,
            ),
        ] {
            let queue = AutomaticChatSpeechQueue::new();
            for key in ["one", "two"] {
                update(&queue, key, "history", 0);
            }
            queue.update(
                "one".into(),
                AgentTranscriptKind::Codex,
                "Debug".into(),
                true,
                false,
                messages("response", response),
                1,
            );
            let first = take(&queue, 1);
            update(&queue, "two", "Other chat", competing_at);

            // The first chunk takes longer to speak than the waiting expiry.
            let tail = take(&queue, MAX_AGE_MS + 3);
            assert_eq!(tail.text, ending);
            assert_eq!(
                format!(
                    "{} {}",
                    first.text.trim_start_matches("Debug tab: "),
                    tail.text
                ),
                response
            );
            if competing_at > MAX_AGE_MS {
                assert_eq!(take(&queue, MAX_AGE_MS + 3).key, "two");
            }
            assert!(queue.next(MAX_AGE_MS + 3).is_none());
        }
    }

    #[test]
    fn another_speaking_chat_bounds_and_expires_an_unstarted_solo_backlog() {
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
        update(&queue, "two", "Recent update", MAX_AGE_MS + 2);
        let next = take(&queue, MAX_AGE_MS + 2);
        assert_eq!(next.key, "two");
        assert_eq!(next.text, "Debug tab: Recent update");
        assert!(queue.next(MAX_AGE_MS + 2).is_none());
    }

    #[test]
    fn overload_preserves_started_speech_and_prioritizes_its_streamed_continuation() {
        let queue = AutomaticChatSpeechQueue::new();
        for key in ["one", "two"] {
            update(&queue, key, "history", 0);
        }
        let response = |length| {
            let mut messages = messages("response", &"a".repeat(length));
            messages[0].completed = false;
            messages
        };
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            response(MAX_CONTENT_UNITS * 6),
            1,
        );
        assert_eq!(take(&queue, 1).key, "one");
        for index in 2..12 {
            update(&queue, "two", &format!("Waiting update {index}"), index);
        }
        queue.update(
            "one".into(),
            AgentTranscriptKind::Codex,
            "Debug".into(),
            true,
            false,
            response(MAX_CONTENT_UNITS * 7),
            12,
        );
        // All six remaining chunks finish, including the continuation that
        // arrived after the other tab. Only unstarted updates are trimmed.
        for _ in 0..6 {
            let next = take(&queue, 12);
            assert_eq!(next.key, "one");
            assert_eq!(next.text, "a".repeat(MAX_CONTENT_UNITS));
        }
        for index in 8..12 {
            assert_eq!(
                take(&queue, 12).text,
                format!(
                    "{}Waiting update {index}",
                    if index == 8 { "Debug tab: " } else { "" }
                )
            );
        }
        assert!(queue.next(12).is_none());
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
