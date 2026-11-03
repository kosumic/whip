use std::time::{Duration, Instant};

pub(super) const INITIAL_DELAY: Duration = Duration::from_secs(2);
const REPEAT_DELAY: Duration = Duration::from_secs(20);
const PHRASES: [&str; 5] = ["Hmm.", "Uh.", "One moment.", "Let me think.", "Just a sec."];

/// Local reassurance only; never enters the agent transcript or reply queue.
pub(super) struct WaitingFiller {
    next_at: Instant,
    previous: Option<usize>,
}

impl WaitingFiller {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            next_at: now + INITIAL_DELAY,
            previous: None,
        }
    }

    pub(super) fn next(&mut self, now: Instant) -> Option<&'static str> {
        if now < self.next_at {
            return None;
        }
        // Use the existing OS-backed UUID randomness without another dependency.
        let random = usize::from(uuid::Uuid::new_v4().as_bytes()[0]);
        let index = if let Some(previous) = self.previous {
            (previous + 1 + random % (PHRASES.len() - 1)) % PHRASES.len()
        } else {
            random % PHRASES.len()
        };
        self.previous = Some(index);
        // A delayed timer emits one phrase, without catching up missed intervals.
        self.next_at = now + REPEAT_DELAY;
        Some(PHRASES[index])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_waits_get_spaced_phrases_without_consecutive_repeats() {
        let start = Instant::now();
        let mut filler = WaitingFiller::new(start);
        let first_due = start + Duration::from_secs(2);
        let before_due = first_due.checked_sub(Duration::from_millis(1)).unwrap();
        assert!(filler.next(before_due).is_none());
        let mut now = first_due;
        let mut previous = filler.next(now).unwrap();
        assert!(PHRASES.contains(&previous));
        for _ in 0..20 {
            let before_due = (now + REPEAT_DELAY)
                .checked_sub(Duration::from_millis(1))
                .unwrap();
            assert!(filler.next(before_due).is_none());
            now += REPEAT_DELAY;
            let phrase = filler.next(now).unwrap();
            assert!(PHRASES.contains(&phrase));
            assert_ne!(phrase, previous);
            previous = phrase;
        }
    }

    #[test]
    fn resuming_a_delayed_timer_never_bursts_old_fillers() {
        let start = Instant::now();
        let mut filler = WaitingFiller::new(start);
        let resumed = start + Duration::from_secs(300);
        assert!(filler.next(resumed).is_some());
        assert!(filler.next(resumed).is_none());
        assert!(filler.next(resumed + REPEAT_DELAY).is_some());
    }
}
