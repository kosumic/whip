//! Whip's causal speech display timeline, independent of native devices and providers.
//!
//! Text and generated/delivered audio describe what *could* play. Only device
//! acknowledgments passed to [`Clock`] or [`ReadAloud`] describe what was heard.
//! All sample positions use 24 kHz mono source frames, regardless of playback
//! speed. Resampling and device counters belong to the embedding adapter.
//!
//! Keep one clock per response/utterance and playback generation. Hosts must
//! fence stale callbacks before calling it, stop advancing interrupted clocks,
//! and create a fresh clock on flush/restart. Whip keeps these identities in its
//! existing playback leases, transcript items and native audio adapters.
//!
//! [`SourceClock`] maps source timestamp gaps for Live/provider intervals;
//! those intervals must not be replaced by ordinary TTS's weighted pacing.

mod pacing;
mod read_aloud;
mod source_clock;
mod streaming;
mod text;

pub use pacing::{Clock, Pace, Text};
pub use read_aloud::ReadAloud;
pub use source_clock::SourceClock;
pub use streaming::StreamPace;
pub use text::{byte_offset, utf16_offset, word_after, word_at, word_ranges};

/// Source PCM frame rate used by Whip's pacing and source-clock algorithms.
pub const SAMPLE_RATE: u32 = 24_000;
