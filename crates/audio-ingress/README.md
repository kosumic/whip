# audio-ingress

Bounded, owned PCM16 delivery for native audio consumers. The safe Rust core uses
Crossbeam's bounded queues and owns no recorder, OS recognizer, executor, model,
or provider transport.
It is distributed under Whip's AGPL-3.0-or-later license.

```toml
[dependencies]
audio-ingress = "0.1.0"
```

Create an `Ingress` with an explicit mono sample rate, packet count, maximum
samples per packet, and maximum packet age. Admission validates the entire format,
sequence ordering, sample alignment, timestamp, session and input generation.
PCM16LE bytes decode directly into Rust-owned preallocated slots; borrowed native
pointers never survive admission. Queue storage is bounded by
`(packets + 1) * samples_per_packet * size_of::<i16>()` plus metadata, with a hard ceiling
of 1,048,576 samples. Packet size and packet count are independent limits.

`push` and `push_le` do not allocate or wait for capacity. Capture and dequeue use
separate bounded ready/free queues; the consumer never holds the producer's
ordering lock. Concurrent producers or lifecycle controls can return `Busy`;
full capacity returns `Overflow`. Neither overwrites accepted audio. A spare slot
keeps capture independent of the consumer's packet copy. Applications must handle
these outcomes explicitly: local VAD treats lost PCM as a terminal input failure,
while Realtime discards backlog and resets DSP and partial codec state before
resuming fresh capture. `discard` exposes that bounded recovery operation.

Allocate one `Packet` per consumer and reuse it with `pop_into`. Processing occurs
outside the queue lock, away from native capture callbacks. Recheck the returned
ticket under the application's lifecycle lock before consuming it. A queue cannot
revoke audio that an application has already handed to another subsystem.

Mute transitions invalidate generations and clear pending packets; repeated mute
controls preserve the current generation. Close invalidates tickets, clears and
zeros queue storage, and rejects reads. New streams get fresh process-local IDs.
The embedding application must serialize close/replacement with its final sample
admission, stop OS capture, wake a waiting consumer, and drain outstanding work.

Run `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings`.
The tests cover PCM ownership, LE decoding, variable packet lengths, ring wrap,
ordering, bounded overload, invalid formats, timing, mute and replacement. Device
capture, echo cancellation, recognition and provider integration require separate
backend tests and physical-device validation.
