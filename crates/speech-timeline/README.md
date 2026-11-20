# speech-timeline

Whip's playback-driven speech and caption timing, extracted under
AGPL-3.0-or-later. Whip is the behavioral source of truth. This crate has no
dependencies, global state, FFI, UI, provider protocol, audio device or model runtime.
See `NOTICE` for provenance.

```toml
[dependencies]
speech-timeline = "0.1.0"
```

Run the standalone consumer without mobile SDKs:

```sh
cargo run --manifest-path crates/speech-timeline/Cargo.toml --example native_shell
cargo test --manifest-path crates/speech-timeline/Cargo.toml
```

Versioned registry releases use `speech-timeline-v<version>` tags and the shared
standalone-library publishing workflow. See [crate releases](../../docs/crate-releases.md).

All frame counts are **24 kHz mono source PCM**, independent of native output rate
or playback speed. Adapters must translate native counters into that space.

| Primitive | Contract |
| --- | --- |
| `Text`, `Pace`, `Clock` | Whip's weighted pacing, bounded streaming corrections, adaptive rate, final-duration word lead and UTF-16 scalar boundaries |
| `StreamPace` | Learn from sustained text/audio windows; a text burst cannot supply playback time |
| `ReadAloud` | Separately synthesized spoken prefix, first audible response frame and measured final duration |
| `word_ranges`, `word_at`, `word_after` | Whip presentation rules; containing word and next-word selection remain distinct |
| `byte_offset`, `utf16_offset` | Convert native UTF-8 and UI UTF-16 offsets without splitting surrogate pairs/scalars |
| `SourceClock` | Map 48 kHz source timestamps onto consumed 24 kHz PCM, including gaps and wrapping timestamps |

Generated audio, audio waiting in a queue, audio delivered to a player, and audio
acknowledged as played are different facts. `ReadAloud::generated_samples` supplies
a duration. The `samples` argument supplies delivered/available PCM. Only `played`
supplies playback evidence. Publishing text, duration, or completion with unchanged
playback cannot reconcile pacing; the next consumed frame does. For `Clock::advance`,
the adapter bounds `played <= samples`; `complete` means text and duration are final.
At the final acknowledged frame, the full text is exposed. Whip's existing word lead
and interruption word freeze are display rules, not exact phoneme alignment.

Keep one timing state per utterance/response item. Hosts own response IDs, playback
leases and generations: reject stale callbacks before advancing, stop interrupted
clocks, preserve their frozen display position, and use fresh state after a flush
or resumed chunk. A continuation's original text offset remains in the host.
Whip's existing generation fencing stays in `mobile-speech`, native playback, and
the read-aloud/Realtime adapters; this crate does not create a second owner.

Live captions retain provider interval semantics. Use `SourceClock::sample` to
locate speech onset, and `played` only with monotonically acknowledged PCM. A
queued source gap becomes visible only when audio after the gap begins playing.
Reset the source clock on flush; do not use packet arrival time as a playback mark.
Provider transcript parsing, token-to-duration estimates, interval interpolation,
serialization and Markdown projection stay in Whip's adapters.

The `native_shell` example demonstrates the API shape for GymAmi: keep a
`ReadAloud` per native utterance, report consumed source frames, subtract the spoken
prefix only after its audible boundary, then project UTF-16 words into UTF-8 slices.
GymAmi migration is separate work. Its simpler adaptation does not replace Whip's
weighted algorithm or its distinct Live adapter. Pacing and presentation retain
their original, intentionally different Unicode rules rather than introducing a
new tokenizer during this extraction.

GymAmi's current `played(played_ms, duration_ms, complete)` callback can convert
acknowledged milliseconds into source frames (`ms * 24` with checked arithmetic).
Its `SpeechCursor::parts` can use `word_after` and `byte_offset`; Whip's presentation
uses `word_at` when whitespace should keep the previous bright word. Keep Live's
`played_interval` path separate, using `SourceClock` for timestamp gaps.
