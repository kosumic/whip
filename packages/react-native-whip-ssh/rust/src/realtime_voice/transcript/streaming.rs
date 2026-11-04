//! Learn rate from text/audio progress windows, never from one early text burst.
use super::pacing::Pace;
use crate::realtime_voice::RATE;

struct Anchor {
    units: u32,
    samples: usize,
}

pub(super) struct StreamPace {
    pace: Pace,
    anchor: Option<Anchor>,
}

impl StreamPace {
    pub fn new(pace: Pace) -> Self {
        Self { pace, anchor: None }
    }

    pub fn observe(&mut self, units: u32, samples: usize) -> Option<Pace> {
        if units == 0 || samples < RATE / 2 {
            return None;
        }
        let next = Anchor { units, samples };
        let Some(previous) = self.anchor.as_ref() else {
            self.anchor = Some(next);
            return None;
        };
        if samples < previous.samples || units < previous.units {
            self.anchor = Some(next);
            return None;
        }
        let elapsed = samples - previous.samples;
        if elapsed < RATE || units == previous.units {
            return None;
        }
        let spoken = units - previous.units;
        self.anchor = Some(next);
        self.pace
            .observe_streaming(spoken, elapsed)
            .then_some(self.pace)
    }
}

#[cfg(test)]
mod tests {
    use super::super::pacing::{Clock, Pace, Text};
    use super::StreamPace;
    use crate::realtime_voice::RATE;

    #[test]
    fn faster_streaming_speech_does_not_accumulate_display_lag() {
        let full = "aaaa ".repeat(110);
        let mut text = Text::default();
        let mut learning = StreamPace::new(Pace::default());
        let mut clock = Clock::new(Pace::default());
        let mut previous = 0;
        for step in 1..=200 {
            let played = step * RATE / 10;
            let generated = played + RATE / 5;
            // Metadata stays ahead, with a fixed offset independent of rate.
            let available = (step * 5 / 2 + 10).min(full.len());
            text.update(&full[..available]);
            if let Some(pace) = learning.observe(text.units, generated) {
                clock.set_pace(pace);
            }
            let position = clock.advance(&text, played, generated, false);
            assert!(position >= previous);
            if step >= 80 {
                assert!(position.abs_diff(step * 5 / 2) <= 6);
            }
            previous = position;
        }
    }

    #[test]
    fn one_early_text_burst_cannot_speed_the_cursor() {
        let mut text = Text::default();
        text.update(&"aaaa ".repeat(100));
        let mut learning = StreamPace::new(Pace::default());
        assert!(learning.observe(text.units, 0).is_none());
        let mut clock = Clock::new(Pace::default());
        assert_eq!(clock.advance(&text, 0, RATE * 10, false), 0);
        assert!(clock.advance(&text, RATE, RATE * 10, false) <= 14);
    }

    #[test]
    fn rate_corrections_need_playback_and_remain_bounded() {
        let mut text = Text::default();
        text.update(&"aaaa ".repeat(100));
        let mut clock = Clock::new(Pace::default());
        let before = clock.advance(&text, RATE, RATE * 4, false);
        let mut pace = Pace::default();
        assert!(pace.observe_streaming(28, RATE));
        clock.set_pace(pace);
        assert_eq!(clock.advance(&text, RATE, RATE * 4, false), before);
        let after = clock.advance(&text, RATE + RATE / 50, RATE * 4, false);
        assert!(after >= before && after <= before + 1);
        assert!(!pace.observe_streaming(500, RATE));
    }
}
