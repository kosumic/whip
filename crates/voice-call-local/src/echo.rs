//! Recognition backstop for residual speaker echo after platform AEC.
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const TAIL: Duration = Duration::from_secs(2);
const MAX_CHUNKS: usize = 4;

#[derive(Default)]
pub struct EchoGuard {
    chunks: VecDeque<(Vec<String>, Option<Instant>)>,
}

fn words(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

impl EchoGuard {
    /// Observe actual native playback, including fillers, rather than queued prose.
    pub fn observe(&mut self, text: &str, active: bool, now: Instant) {
        self.chunks
            .retain(|(_, until)| until.is_none_or(|until| now < until));
        let tokens = words(text);
        if !active && tokens.is_empty() {
            self.finish(now);
            return;
        }
        if active {
            if self
                .chunks
                .back()
                .is_some_and(|(last, until)| *last == tokens && until.is_none())
            {
                return;
            }
            self.finish(now);
            if !tokens.is_empty() {
                self.chunks.push_back((tokens, None));
                if self.chunks.len() > MAX_CHUNKS {
                    self.chunks.pop_front();
                }
            }
        } else {
            for (chunk, until) in &mut self.chunks {
                if *chunk == tokens && until.is_none() {
                    *until = Some(now + TAIL);
                }
            }
        }
    }

    pub fn finish(&mut self, now: Instant) {
        for (_, until) in &mut self.chunks {
            if until.is_none() {
                *until = Some(now + TAIL);
            }
        }
    }

    /// A matching first word or phrase cannot interrupt playback or become a prompt.
    /// Different speech is preserved in full, including a user's repeated prefix.
    #[must_use]
    pub fn filter(&self, text: String, now: Instant) -> String {
        let tokens = words(&text);
        if !tokens.is_empty()
            && self.chunks.iter().any(|(chunk, until)| {
                until.is_none_or(|until| now < until)
                    && chunk.windows(tokens.len()).any(|window| window == tokens)
            })
        {
            String::new()
        } else {
            text
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_word_and_partial_reply_echo_are_rejected_during_playback_and_its_tail() {
        let mut guard = EchoGuard::default();
        let now = Instant::now();
        guard.observe("Hello, I received your message.", true, now);
        for text in [
            "Hello",
            "hello I",
            "received your message",
            "Hello, I received your message!",
        ] {
            assert_eq!(guard.filter(text.into(), now), "");
        }
        guard.observe("Hello, I received your message.", false, now);
        assert_eq!(guard.filter("Hello".into(), now + TAIL / 2), "");
        assert_eq!(guard.filter("Hello".into(), now + TAIL), "Hello");
    }

    #[test]
    fn real_interruption_and_later_repetition_remain_available() {
        let mut guard = EchoGuard::default();
        let now = Instant::now();
        guard.observe("One moment.", true, now);
        for text in [
            "Stop",
            "One more thing",
            "someone",
            "Actually change the plan",
        ] {
            assert_eq!(guard.filter(text.into(), now), text);
        }
        guard.finish(now);
        assert_eq!(guard.filter("One moment".into(), now + TAIL), "One moment");
    }

    #[test]
    fn next_chunk_does_not_erase_previous_echo_tail() {
        let mut guard = EchoGuard::default();
        let now = Instant::now();
        guard.observe("First sentence.", true, now);
        guard.observe("Second sentence.", true, now);
        assert_eq!(guard.filter("First".into(), now), "");
        assert_eq!(guard.filter("Second".into(), now + TAIL), "");
        assert_eq!(guard.filter("First".into(), now + TAIL), "First");
    }
}
