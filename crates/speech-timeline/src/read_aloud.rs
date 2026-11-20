//! Prefix-aware source-frame pacing; synthesis and playback adapters stay outside.
use crate::{Clock, Pace, Text};

/// Timing state for a TTS utterance, including a separately synthesized spoken prefix.
pub struct ReadAloud {
    /// Full spoken text including any announcement prefix.
    pub spoken: String,
    /// Prefix boundary in UTF-8 bytes for separate synthesis calls.
    pub prefix_bytes: usize,
    /// Prefix boundary in UTF-16 units for display projection.
    pub prefix_utf16: usize,
    /// First audible response frame, after the prefix and response leading silence.
    /// The synthesis adapter sets this without moving the display cursor.
    pub response_start: Option<usize>,
    /// Measured final generation length, independent of queued/delivered/played PCM.
    /// Publishing this value never acknowledges playback.
    pub generated_samples: Option<usize>,
    text: Text,
    clock: Clock,
}

impl Default for ReadAloud {
    fn default() -> Self {
        Self {
            spoken: String::new(),
            prefix_bytes: 0,
            prefix_utf16: 0,
            response_start: Some(0),
            generated_samples: None,
            text: Text::default(),
            clock: Clock::new(Pace::default()),
        }
    }
}
impl ReadAloud {
    /// Reset for a new utterance. An invalid prefix offset (including one inside
    /// a surrogate pair) falls back to no prefix, matching Whip's native API.
    /// The host must invalidate the old utterance's callbacks before reusing it.
    pub fn start(&mut self, spoken: &str, prefix_utf16: usize) {
        let mut units = 0;
        let prefix_bytes = spoken
            .char_indices()
            .chain(std::iter::once((spoken.len(), '\0')))
            .find_map(|(byte, character)| {
                let matches = units == prefix_utf16;
                units += character.len_utf16();
                matches.then_some(byte)
            })
            .unwrap_or(0);
        self.spoken = spoken.into();
        self.prefix_bytes = prefix_bytes;
        self.prefix_utf16 = spoken[..prefix_bytes].encode_utf16().count();
        self.response_start = (prefix_bytes == 0).then_some(0);
        self.generated_samples = None;
        self.text.update(&spoken[prefix_bytes..]);
        self.clock = Clock::new(Pace::default());
    }

    /// Advance from device acknowledgments. `samples` is delivered PCM; bound
    /// `played <= samples` in the adapter. `complete` supplies final duration when
    /// synthesis did not already publish one. Returns a full-spoken UTF-16 offset;
    /// subtract `prefix_utf16` only after playback has crossed `response_start`.
    pub fn progress(&mut self, played: usize, samples: usize, complete: bool) -> usize {
        let Some(start) = self.response_start else {
            return 0;
        };
        // The exact prefix duration includes its trailing pause. Even synthesis
        // completion cannot advance captions until native playback crosses it.
        if self.prefix_utf16 > 0 && played <= start {
            return 0;
        }
        if let Some(duration) = self.generated_samples.or(complete.then_some(samples)) {
            return self.prefix_utf16
                + self.clock.advance_measured(
                    &self.text,
                    played.saturating_sub(start),
                    duration.saturating_sub(start),
                );
        }
        self.prefix_utf16
            + self.clock.advance(
                &self.text,
                played.min(samples).saturating_sub(start),
                samples.saturating_sub(start),
                complete,
            )
    }
}
