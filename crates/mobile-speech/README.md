# mobile-speech

App-independent speech playback ownership and completion-driven queueing for
Android, iOS, and other native backends. The Rust core has **no dependencies**:
no application globals, executor, bindings, transcript parsers, model downloads,
or platform SDK is required to build it. It is currently a local path crate.

The application supplies plain text and its existing native speech backend.
`Arbiter` provides generation-fenced ownership; `PlaybackQueue` orders utterances
and waits for native audio completion. These are ordinary Rust values, so the
embedding application controls lifetime, synchronization, and the number of
players. Use one arbiter for every user of a shared player.

```rust
use mobile_speech::{PlaybackQueue, QueueConfig, QueueItem, WaitingLimits};

let mut queue = PlaybackQueue::new(QueueConfig {
    max_waiting_chunks: 8,
    max_waiting_utf16_units: 2_000,
    max_wait_ms: 10_000,
    limits: WaitingLimits::Always,
});
queue.enqueue(QueueItem {
    source: "navigation".into(),
    group: "route-1".into(),
    text: "Turn left at the next street.".into(),
    prefix: String::new(),
    context: String::new(),
}, 0);
let playback = queue.take(0).unwrap();
assert!(queue.take(1).is_none()); // audio is still in flight
assert!(queue.complete(playback.id)); // native audio-drained callback
```

Run the SDK-free example with `cargo run --locked --example plain_text`.
Requests may come from navigation, accessibility, messaging, or any other app;
coding-agent transcript handling belongs in a separate integration layer.

## Backend contract

1. Configure admission with opaque class IDs, replacement rules, and whether a
   completed utterance reserves ownership between chunks. `claim` returns a
   `LeaseId`; denied claims return `None`. Class IDs have no built-in priorities.
2. Enqueue plain text with opaque source/group IDs and a monotonic timestamp in
   milliseconds. Check the queue only when the native player can accept work.
3. Call `take` under the application coordinator lock, release that lock, and
   dispatch playback to the platform thread. Check the ownership lease before
   native initialization, synthesis, output, and cancellation. Retain both the
   lease and `Playback.id` in asynchronous callbacks.
4. On Android system TTS completion, iOS `AVSpeechSynthesizer` completion, or the
   final consumed PCM frame from a custom backend, call `complete` with that
   utterance's ID. Synthesis finishing or buffers being scheduled is too early.
   Once completion is accepted, wake the coordinator to select the next item.
5. Stop/flush the native backend when `clear` or `remove` returns active playback.
   Clearing never resets the ID counter. Late callbacks cannot complete a new
   utterance. `dismiss_current` drops the started group and suppresses its future
   continuations; cancel its native audio as part of the same application action.

The core deliberately contains no `TextToSpeech`/`AVSpeechSynthesizer` wrapper or
FFI singleton. Applications adapt their native player and OS lifetime using these
contracts. Whip's first integration uses its existing Android/iOS system and
Phonon players, with native wake/completion callbacks and a single Rust runtime.
Other consumers can use their own engine without React Native or Whip bindings.

## Queue and lifecycle policy

Waiting limits count UTF-16 units including prefixes, matching mobile text APIs.
Overload drops oldest waiting chunks. Started-group continuations finish before
other waiting groups and are exempt from waiting limits/expiry. Prefixes repeat
when the source or prefix changes. Removing a source forgets its prefix history.
`WhenCompeting` permits a single source's full backlog; choose `Always` when
waiting work must be bounded even for one source.

Applications own text chunking, streaming/history baselines, focus, preferences,
interruptions, route changes, deadlines, pause/resume, and background policy.
They must wake the coordinator when work or playback availability changes. No
polling thread or second synthesis engine is created by this crate. A native
boundary handoff validates the observed lease atomically with replacement.

## Validation and license

`cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings`
run without Android/iOS tooling. Tests exercise plain-text consumers, native
completion fencing, owner-scoped cancellation, handoff, streaming continuation
ordering, expiry, and configured overload limits. Physical device tests belong
to each backend's integration; the core cannot guarantee OS background execution.

Extracted from Whip under its existing **AGPL-3.0-or-later** license. Extraction
does not change the license. Independent distribution or a different license
requires a separate explicit decision.
