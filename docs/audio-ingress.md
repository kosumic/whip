# Native microphone ingress (#351)

Local voice uses one microphone stream owned by the existing Expo speech
recognizer. Its Android recorder and iOS audio-engine tap call the Whip-owned
`whip_audio_ingress_push_v1` C ABI directly with PCM16LE mono at 16 kHz.
Normal local voice does not register an `audiochunk` listener or send PCM through
Hermes, base64, or UniFFI. Composer dictation retains its existing recognizer path.

The `crates/audio-ingress` crate owns format validation, session
and generation tickets, sequence/timestamp checks, owned bounded PCM storage and
admission outcomes. Android's JNI adapter copies a bounded byte array into a
stack buffer. The C entrypoint validates the handle and byte count before reading
the borrowed pointer; the queue copies/decodes directly into preallocated Rust
slots before returning. iOS calls the same entrypoint from its existing tap after
the existing 16 kHz conversion. No additional recorder, recognizer or tap is created.

Each local recognizer cycle opens a fresh process-local handle tied to its Rust
`VoiceChat` input ID. Restart closes the old handle before opening another. Stop
and cancellation close PCM admission before asking the OS recognizer to drain or
abort. Final transcription events still drain through the existing coordinator.
Rust input replacement, mute and hangup close the handle under the same state lock
used by the VAD consumer, fencing both queued and already-dequeued samples. The
worker holds a weak conversation reference and wakes on close; dropping the Rust
conversation also closes its ingress. Late callbacks cannot revive a stream.

The local worker converts owned PCM to floats and runs the existing Earshot and
optional Smart Turn policy. Native capture does not run inference or network work.
TypeScript polls Rust state every 50 ms for turn transitions and UI metering; it
continues to coordinate consent, recognition text, prompt submission, final-result
draining, and speech playback through the stage-1 call owner.

Realtime uses the same crate at its existing 24 kHz source format. Its previous
transport-specific input channels converge on one bounded queue consumed by the
selected WebSocket or WebRTC transport. Software echo processing runs after
dequeue on the consumer, with the existing playback-reference path. Format
conversion, provider framing and transport remain provider-adapter responsibilities.
Realtime and local capture remain mutually exclusive call modes.

Realtime capture waits for `session.updated` to confirm the requested audio and
caption settings. The initial `session.created` may contain provider defaults
with transcription disabled and does not authorize microphone capture. WebRTC
sends an explicit settings update after connecting to obtain that confirmation.

## Bounds and failure policy

Local capture reserves eight slots of at most 8192 samples; Realtime reserves
32 slots of at most four existing 480-sample frames. Both reject audio more than
500 ms past their reported timestamp. Local adapters timestamp delivery to the
native sink; hardware capture-to-callback delay still needs device profiling.
Storage is allocated before capture begins; native PCM queue admission
does not allocate. Producers return immediately on queue contention or full capacity.
Whip reports these as input failures and closes through its existing call/input
owner for local VAD, rather than silently changing its sample clock. Realtime
instead discards its bounded backlog, resets echo processing and partial Opus
state, and resumes fresh capture, matching Codex's voice worker recovery policy.
The reference is Codex's [capture worker](https://github.com/openai/codex/blob/48524f337a/codex-rs/voice-host/src/capture_worker.rs)
and [device buffers](https://github.com/openai/codex/blob/48524f337a/codex-rs/voice-host/src/device_buffers.rs).
The ready/free queues are lock-free; dequeue does not contend with capture's
ordering lock. One extra preallocated slot covers an in-flight consumer copy.
Invalid format, packet alignment and ordering also fail visibly. Stale/closed
callbacks are harmless.

The version-1 status codes are declared in `WhipAudioIngress.h`. The ingress handle
is a decimal string only in coarse recognition setup, preserving all 64 bits
across Expo's options bridge. Samples never enter these setup options. The legacy
base64 Rust `audio()` API and optional Expo `audiochunk` support remain available
for existing non-native callers and fixture tests; the normal local mobile path
requires native-ingress capability and fails on an older native build.

Permissions, OS speech recognition, on-device-only STT, Android echo cancellation,
iOS voice processing/CallKit, background ownership, routing, headset changes and
composer arbitration retain their current owners. The crate makes no OS calls and
cannot establish those guarantees independently.

## Validation status

Portable queue and native ABI tests cover PCM integrity, ownership, packet bounds,
ordering, overload, format validation, cancellation and stale handles. Coordinator
tests cover restart rotation, cancellation fencing and final-result draining.
The arm64 Android debug and optimized release APKs build, and the JNI declaration
matches the exported capture entry point. Nine portable queue tests, five native
ABI tests and 34 local voice tests pass; one existing recording-dependent test is
skipped. Realtime and shared pacing regressions cover local UDP/TCP event and
Opus exchange, early transcript bursts, long streaming captions, sparse RTP,
loss concealment and delayed render-reference processing.
The focused TypeScript tests, type check and focused JS lint checks
pass, including 34 Realtime adapter and voice screen tests. The Expo patch also
applies to clean dependency sources through
`patch-package`.
Sink startup failure releases microphone ownership before a recognizer is started.

Typed composer submissions enter the active Realtime session as user text marked
as already submitted to the coding agent. They add voice context without another
agent-tool invocation or an automatic voice response. Native admission is bounded,
startup retains a bounded ordered text queue, and hangup discards pending context.
Settings confirmation runs on the sideband alongside ICE/DTLS negotiation.
Device diagnostics include numeric capture-packet, gap, caption-event and visible
message counts; they never include caption text or provider payloads.

Codex's startup was compared at `ede589336e`: its
[call client](https://github.com/openai/codex/blob/ede589336e/codex-rs/codex-api/src/endpoint/realtime_call.rs)
sends initial settings with the SDP, its
[conversation owner](https://github.com/openai/codex/blob/ede589336e/codex-rs/core/src/realtime_conversation.rs)
starts the sideband independently of applying the answer, and its
[HTTP pool](https://github.com/openai/codex/blob/ede589336e/codex-rs/http-client/src/route_aware_client_pool.rs)
reuses transport connections. Whip uses the same startup ordering and a shared
HTTP client. The follow-up sideband update repeats only audio settings; the
authoritative `session.updated` still confirms caption configuration. Codex's
ChatGPT backend and newer event protocol use different request shapes, so this
comparison does not establish equal server latency.

A physical Android call reached microphone startup in 5.7 seconds: call creation
took 2.0 seconds and WebRTC negotiation 3.1 seconds. Its trace contained 64 caption
events, three messages and zero capture gaps. This confirms working input and
captions in that trial, but is not a controlled before/after latency comparison.
The subsequent optimization uses secure peer connectivity as the media readiness
gate, without waiting for the mirrored data channel. A later phone trace reached
microphone startup in 2.51 seconds, but the user still reported caption drift and
missed opening questions. That trace did not establish their cause.

A direct desktop probe used Whip's transport and public API call client, with
duration-only tracing. The old gate reached secure media in 1.67–1.93 seconds but
waited another 649–692 ms for the data channel, becoming ready in 2.36–2.58 seconds.
The secure-media gate became ready in 1.82–1.96 seconds in two separate calls.
Both paths received caption events and RTP audio for a typed request. These small
samples isolate the unnecessary channel wait; they do not establish mobile
startup latency or measure microphone capture.

The follow-up comparison at Codex `ba057e4375` found two additional differences.
Its [capture worker](https://github.com/openai/codex/blob/ba057e4375/codex-rs/voice-host/src/capture_worker.rs)
services queued speaker references immediately before microphone processing.
Whip now uses that ordering too, measuring reference delay on the consumer rather
than the playback thread. Codex's
[playout pipeline](https://github.com/openai/codex/blob/ba057e4375/codex-rs/voice-host/src/playout.rs)
uses an RTP-aware jitter buffer and Opus loss concealment. Whip's source clock now
continues through empty packet intervals, conceals missing frames at their
deadline, discards already-concealed late audio, and bounds each decoding pass.
Concealed intervals count toward acknowledged assistant playback, preserving
the caption timeline through silence and packet loss.

A transcript may arrive in full before most audio has played, so a rate estimate
cannot always learn from successive text deltas. For a finalized response with
one audio part, Whip uses the provider's audio-token count as a duration estimate
until decoded audio finishes. OpenAI documents approximately
[50 ms per assistant audio token](https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime),
including small special-token variation. A long-reply probe reported 478 tokens
and about 23.88 seconds between output start and stop. The estimate is not a
word alignment signal; captions still move only with acknowledged playback.
Ambiguous multi-part, cancelled and missing-usage responses cannot retime a turn.

Standalone arm64 probes on the phone recognized a generated English opening
question intact with raw input and the optimized production DSP. Those checks
exercise native DSP, Opus and the device's network, but bypass Android microphone
capture. The updated app adds only numeric RMS, processing-drop and playback
clock diagnostics for the remaining physical microphone investigation. Listening
is advertised after the first captured packet reaches the media sender.

The standalone crate passes Clippy. The repository-wide Clippy check still reports
existing Realtime context/transport diagnostics. The ingress implementation adds
no remaining diagnostics. The iOS capture changes have not been compiled here.

No connected device was available in the build environment for a pre-change
baseline. Capture-to-Rust latency, callback frequency, allocations, JS scheduling,
CPU/memory, VAD onset and interruption responsiveness therefore remain unmeasured.
No performance improvement is claimed. Before deployment, compare the prior path
and native path on Android and iOS with the same device, language, audio routes,
speech/noise and foreground/background conditions. Include headset/AEC, rapid
mode switches, app lock, recognition restart, final-result draining and barge-in.

The old source batches at least 4096 bytes before dispatch: 128 ms of mono 16 kHz
PCM16. The direct path removes that extra batching in the callback, but this is a
source-level change, not an end-to-end latency measurement. Physical-device
checks and before/after measurements remain follow-up validation work.
