//! A causal display clock: packets supply text, acknowledged PCM supplies time.
//! Final duration refines the target; it never moves the cursor by itself.
const INITIAL_UNITS_PER_SECOND: f64 = 14.0;
const MIN_UNITS_PER_SECOND: f64 = 4.0;
const MAX_UNITS_PER_SECOND: f64 = 32.0;
const MAX_CORRECTION_UNITS_PER_SECOND: f64 = 40.0;

#[derive(Clone, Copy)]
/// Adaptive weighted text units per second, learned from 24 kHz source PCM.
pub struct Pace(f64);
impl Default for Pace {
    fn default() -> Self {
        Self(INITIAL_UNITS_PER_SECOND)
    }
}
impl Pace {
    /// Learn a sustained streaming window. Reject implausible rates and empty PCM.
    pub fn observe_streaming(&mut self, units: u32, samples: usize) -> bool {
        if samples == 0 {
            return false;
        }
        let rate = f64::from(units) / seconds(samples);
        if !(MIN_UNITS_PER_SECOND..=MAX_UNITS_PER_SECOND).contains(&rate) {
            return false;
        }
        self.observe(units, samples);
        true
    }
    /// Blend an observed decoded duration with the previous estimate.
    pub fn observe(&mut self, units: u32, samples: usize) {
        let previous = self.0;
        self.observe_measured(units, samples);
        self.0 = f64::midpoint(previous, self.0);
    }

    /// Completed generation describes the voice, without transport padding.
    pub fn observe_measured(&mut self, units: u32, samples: usize) {
        if units > 0 && samples > 0 {
            self.0 = (f64::from(units) / seconds(samples))
                .clamp(MIN_UNITS_PER_SECOND, MAX_UNITS_PER_SECOND);
        }
    }
}

fn seconds(samples: usize) -> f64 {
    f64::from(u32::try_from(samples).unwrap_or(u32::MAX)) / f64::from(crate::SAMPLE_RATE)
}

#[derive(Clone, Copy)]
struct Point {
    units: u32,
    utf16: usize,
}

#[derive(Default)]
/// Weighted text mapping. Positions are UTF-16 offsets at scalar boundaries.
pub struct Text {
    points: Vec<Point>,
    words: Vec<Point>,
    /// Total weighted speech units, including punctuation pauses.
    pub units: u32,
}

fn cjk(character: char) -> bool {
    character.is_alphabetic()
        && matches!(u32::from(character),
        0x2e80..=0x9fff | 0xac00..=0xd7ff | 0xf900..=0xfaff |
        0xff66..=0xff9f | 0x2_0000..=0x3_134f)
}

fn combining(character: char) -> bool {
    matches!(u32::from(character), 0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0xfe00..=0xfe0f)
}

impl Text {
    /// Rebuild mappings for the current accumulated text, including unfinished
    /// streaming words. This supplies no playback evidence and advances no clock.
    pub fn update(&mut self, text: &str) {
        self.points.clear();
        self.words.clear();
        self.units = 0;
        let mut utf16 = 0;
        let mut in_word = false;
        for character in text.chars() {
            let cjk = cjk(character);
            let mark = combining(character);
            let lexical = character.is_alphanumeric();
            if lexical && (!in_word || cjk) {
                self.words.push(Point {
                    units: self.units,
                    utf16: utf16 + character.len_utf16(),
                });
            } else if (lexical || mark || in_word && matches!(character, '\'' | '’'))
                && let Some(word) = self.words.last_mut()
            {
                word.utf16 = utf16 + character.len_utf16();
            }
            if !mark {
                in_word = !cjk && (lexical || in_word && matches!(character, '\'' | '’'));
            }
            self.units += if mark {
                0
            } else if cjk {
                3
            } else if character.is_numeric() || matches!(character, '.' | '!' | '?' | ';' | ':') {
                2
            } else {
                1
            };
            utf16 += character.len_utf16();
            self.points.push(Point {
                units: self.units,
                utf16,
            });
        }
    }

    fn position(&self, units: f64) -> usize {
        self.points
            .iter()
            .take_while(|point| f64::from(point.units) <= units)
            .last()
            .map_or(0, |point| point.utf16)
    }

    fn with_word_lead(&self, units: f64) -> f64 {
        let next = self
            .words
            .partition_point(|point| f64::from(point.units) <= units);
        self.words
            .get(next)
            .map_or(units, |point| f64::from(point.units))
    }

    /// Preserve the bright prefix through the current word after interruption.
    /// Zero stays zero; this is a display boundary, not additional heard audio.
    pub fn freeze(&self, utf16: usize) -> usize {
        if utf16 == 0 {
            return 0;
        }
        self.words
            .iter()
            .find(|word| word.utf16 > utf16)
            .map_or(utf16, |word| word.utf16)
    }
}

/// Monotonic display clock for one utterance. Only acknowledged PCM supplies time.
pub struct Clock {
    pace: Pace,
    progress: f64,
    played: usize,
}
impl Clock {
    /// Start an independent utterance at zero played frames and display units.
    pub fn new(pace: Pace) -> Self {
        Self {
            pace,
            progress: 0.0,
            played: 0,
        }
    }

    /// Refine the estimate. The cursor changes only on subsequent played frames.
    pub fn set_pace(&mut self, pace: Pace) {
        self.pace = pace;
    }

    /// Generated PCM has a measured duration. Reconcile on the next consumed
    /// frame, without the streaming estimate's catch-up speed limit or word lead.
    /// `played` is acknowledged source PCM, `samples` is the measured full length.
    pub fn advance_measured(&mut self, text: &Text, played: usize, samples: usize) -> usize {
        let played = played.min(samples);
        if samples > 0 && played > self.played {
            self.played = played;
            self.progress = self
                .progress
                .max(f64::from(text.units) * seconds(played) / seconds(samples));
        }
        text.position(self.progress)
    }

    /// Return the paced UTF-16 position for acknowledged source PCM.
    ///
    /// `samples` is the available/final audio length; it is not a playback mark.
    /// The adapter must bound `played <= samples`. `complete` means the text and
    /// duration are final, not that the audio was heard. Whip's existing word lead
    /// applies to known durations. At `played == samples && complete`, the device
    /// has acknowledged all final audio, so the full text is exposed.
    pub fn advance(&mut self, text: &Text, played: usize, samples: usize, complete: bool) -> usize {
        let elapsed = seconds(played.saturating_sub(self.played));
        self.played = self.played.max(played);
        if complete && samples > 0 && played == samples {
            self.progress = f64::from(text.units);
        } else if elapsed > 0.0 {
            if complete && samples > 0 {
                let fraction = seconds(played) / seconds(samples);
                let target = text.with_word_lead(f64::from(text.units) * fraction);
                self.progress = self.progress.max(target);
            } else {
                // A better rate estimate also catches earlier drift, but only
                // over newly acknowledged audio and at a bounded display speed.
                let target = seconds(played) * self.pace.0;
                self.progress = self
                    .progress
                    .max(target.min(self.progress + elapsed * MAX_CORRECTION_UNITS_PER_SECOND));
            }
        }
        text.position(self.progress)
    }
}

#[cfg(test)]
mod tests;
