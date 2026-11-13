# voice-call-local

Portable synchronous policy extracted from Whip's local voice conversation.
Licensed AGPL-3.0-or-later, as is the original implementation. Earshot 1.2.2
remains the VAD implementation and retains its upstream attribution/license.

```toml
[dependencies]
voice-call-local = { path = "../whip/crates/voice-call-local" }
```

`Call` owns local turn boundaries, sensitivity/hysteresis, mute, recognized
barge-in, finish/skip/close, and generation versus playback-drain gating.
`view()` borrows read-only state. Mono 16 kHz `audio()` borrows the host's
existing float buffer; it does not introduce a PCM queue or another worker.
Default sensitivity is 50, onset/continuation thresholds are 0.60/0.35,
post-speech silence is 800 ms, and the utterance limit is 60 seconds after onset.
Interruption requires 256 ms of stronger VAD evidence plus recognized words;
recognition may confirm that evidence within two seconds.

The host owns devices, STT, TTS, an executor (if needed), and synchronization.
Use `audio-ingress` for bounded native PCM delivery and `mobile-speech` for
speech arbitration/queueing; neither responsibility is reimplemented here.
This crate depends only on Earshot and the Rust standard library. It needs no
Whip, SSH, React Native, `UniFFI`, provider, network, or platform SDK.

Call `prepared(false)` to begin, feed PCM and `recognition(input_id, text)`,
then stop STT when the phase becomes `Finishing`. `recognition_ended()` commits
a nonempty `UserTurn`; `take_prompt()` dispatches it once. `submit_text()`
instead follows a text turn already dispatched by the host. Keep the returned
`Generation` with assistant work, adapt incoming text to your speech queue,
and report `assistant_progress(generation, completed, pending_speech)`.
After the native player's last buffer, acknowledge
`playback_ended(generation, pending_speech)`. Generation completion alone
does not release a speaking turn. Stale input/generation events are ignored;
on a true return from `audio` or `recognition`, cancel host playback.
Whenever `input_id` changes, close/replace the native capture under the same
coordinator lock. Preserve capture when the ID stays the same.

`coordinator::Coordinator` runs alongside `Call` under that same lock. Feed it
binding availability, submission/dispatch/observed-turn events, segmented reply
chunks, provider completion and a monotonic millisecond clock. It emits explicit
`Start`, `Speak`, `Stop` and `Drained` effects. Each playback lease carries a
call-local generation and serial; each chunk carries a separate acknowledgment ID.
Report startup and actual audio drain separately. Revocation immediately releases
ownership without waiting for a platform stop acknowledgment. Filler scheduling,
initial/recovery/dispatch/correlation deadlines and playback timeouts are portable
policy. Hosts select filler phrases and report playback capacity (one or two).

Provider/session correlation, assistant text segmentation, filler phrase selection,
history, remote dispatch, platform lifecycle and error presentation stay in
adapters. A skipped response still waits for assistant generation completion.
The optional `smart-turn` feature only buffers an eight-second inference window
and exposes `begin_probe`/`complete_probe`. Inference, models, downloads, ONNX
and runtime dependencies stay with the host and are absent from default builds.

Run the independent example with `cargo run --example local` and validate with
`cargo test`, `cargo test --features smart-turn`, and
`cargo clippy --all-targets --all-features -- -D warnings`.
