# OpenAI Realtime calls (Stage 2, #324)

Select **OpenAI API → Realtime API** in conversation settings, save an OpenAI
Platform API key, then open a connected coding-agent chat and start its call.
The existing Local provider remains the default. GPT-Live and Global calls
remain unavailable. The selected voice and Realtime VAD configuration are
snapshotted when the app-wide owner starts the call; edits affect the next call.

**Preview voice** becomes available after saving an API key in Realtime mode.
It plays one short AI-generated sample in the selected Realtime voice using
`gpt-realtime`; API charges apply. Preview opens no microphone and sends no agent
target, tools, chat history or transcription request. Stop, changing voices or
providers, leaving settings, backgrounding and audio interruption cancel it.
GPT-Live previews remain unavailable.

This is an experimental WebSocket implementation. It has not completed live
OpenAI or physical-device audio qualification. Do not treat the compile checks
below as evidence that acoustic echo cancellation or Bluetooth works on devices.

## Client and architectural references

Evaluated [lukacf/oai-rt-rs](https://github.com/lukacf/oai-rt-rs) at
`0f92886b64e632da4cc28d123ec7912f2a61fe50` (0.5.1). The adapter uses its typed
public `ClientEvent`/`ServerEvent` protocol. Whip owns the WebSocket loop rather
than using its high-level session/transport: this permits explicit queue and
message limits, cancellation during connection/sends, and avoids the client's
trace logging of wire payloads. No Live/private protocol feature is enabled.
The `log` facade is capped at INFO at compile time: tungstenite's raw handshake
and frame diagnostics are TRACE, and its close-frame contents are DEBUG. The
authorization header is also marked sensitive. Whip's explicit diagnostics and
fixed UI errors do not depend on those wire logs.
The fixed destination is `wss://api.openai.com/v1/realtime?model=gpt-realtime`;
credentials are never part of agent requests or host configuration.

Ported the public-API-compatible audio processing and response lifecycle from
[openai/codex](https://github.com/openai/codex) at
`f2b94ef8b52196f127d162c6db71e390b9bb265c`:

- `codex-rs/core/src/realtime_conversation.rs`: queued response creation,
  deferred continuation after an active-response race, and cancellation tied
  to the conversation owner. Whip correlates asynchronous public API errors
  through generated client event IDs rather than Codex's writer future.
- `codex-rs/voice-host/src/processing.rs`: Rubato sinc resampling, 48-kHz/10-ms
  Sonora AEC3/noise/gain processing, measured render/capture delay, and resets
  after mute changes or capture gaps. Android device timestamps replace CPAL
  callback timestamps. Processed audio returns to PCM24 for the WebSocket API.
- `codex-rs/voice-host/src/device_buffers.rs` and `capture_worker.rs`: capture
  generations, stale-frame rejection, and discarded pre-unmute callbacks.
- `codex-rs/realtime-webrtc/src/session.rs`: transport/session ownership.

The adapted modules retain their Apache-2.0 attribution and bundled license.
Whip keeps native mobile device ownership and the public Realtime WebSocket
protocol. Codex's desktop helper, CPAL/GStreamer packaging, WebRTC/Opus transport,
subscription credentials, and private wire events are not included in this port.

Public API references:
[WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets),
[conversation lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations),
[VAD](https://developers.openai.com/api/docs/guides/realtime-vad), and
[client events](https://developers.openai.com/api/reference/resources/realtime/client-events).

## Ownership and media

`VoiceSessionManager` serializes Local and Realtime adapters. Realtime reserves
the shared speech-input owner and uses the existing native audio-owner token,
Android foreground/headless task and host-monitoring lifetime. Navigating or
backgrounding the presentation does not replace the call. App locking,
host/session replacement, native interruption, and hangup stop it. Native owners
stop PCM and Rust transport directly even when JS is suspended.

Android uses `AudioRecord(VOICE_RECOGNITION)` with explicit software AEC3 and a
media `AudioTrack`. Every submitted output sample, including silence between
replies, feeds the render reference. Actual device timestamps determine delay;
bounded queue timing supplies the estimate while device timestamps initialize.
The native playback clock excludes synthetic silence from heard-audio counts.
Volume buttons control media volume;
the foreground microphone/media service owns media audio focus without Telecom
registration or changing communication mode. Android does not depend on a
vendor echo effect that may be ineffective on a media route. iOS uses
`AVAudioEngine` voice-processing I/O, an `AVAudioConverter`
for the microphone's hardware format, and `AVAudioPlayerNode` playback. The
existing iOS CallKit owner retains call audio routing and focus.

Output-only previews share the bounded Rust actor and native players, but skip
recorders, microphone permission and CallKit/foreground call startup. They use
media focus/playback sessions and the shared Rust speech lease, so local speech
cannot overlap them. Every Realtime session uses `server_vad`; preview disables
automatic responses and interruptions and exposes no tools.
One `response.create` uses `conversation: "none"`, an empty input list and a
256-token limit. The actor caps preview audio at 12 seconds and session work at
30 seconds (plus connection timeout), and closes only after played audio drains.

The public API format is mono PCM16 little-endian at 24 kHz. Session confirmation
must accept the selected voice and both PCM formats before capture is uploaded.
Native workers pass borrowed sample buffers through C/JNI directly to Rust;
only controls, bounded captions, meters and token totals cross the JS bridge.
Token totals cover completed Realtime responses, not a currency estimate or
separate transcription usage.
There is no local STT/TTS conversation pipeline. Optional user transcription is
performed by OpenAI alongside direct speech-to-speech audio.

Capture is bounded to 32 frames (normally 640 ms), control to eight commands,
playback to 30 seconds in Rust and roughly 80 ms in native scheduling, and wire
messages to 512 KiB. Overflow fails the call instead of dropping or reordering
audible data. Socket operations and configuration confirmation have ten-second
deadlines; ping/pong detects a dead connection. Calls stop before the provider's
session-duration limit. Hangup drops the socket and aborts call-owned tool tasks.
There is no automatic reconnect or prompt replay.

Server speech-start and Skip invalidate the playback generation. Native players
flush on that change, stale frames/acknowledgements are ignored, and
`conversation.item.truncate` uses acknowledged playback samples. iOS completion
callbacks count fully played buffers, so a partially played final buffer is
conservatively omitted. Realtime always uses `server_vad`; saved semantic VAD
preferences migrate to server VAD. Local VAD/Smart Turn preferences never configure Realtime. In this prototype,
server VAD owns turn commits, so the listening orb does not manually finish a turn.

## Bound tools

The provider receives only `agent_prompt`, `agent_status`, and `agent_read`.
Rust captures the original runtime incarnation, connection/recovery generation,
terminal, pane, binding generation/token, agent kind and agent session. Each
tool refreshes the remote snapshot, verifies that identity, and uses Herdr's
existing validated lifecycle request path with checks before and after each
transport step. Foreground focus is irrelevant. Disconnect/recovery/replacement
ends the call; late results cannot enter a replacement call.

Prompts are limited to 8 KiB, reads to 120 lines, results to 24 KiB, and calls to
128 tool IDs. At most two tools and one mutating prompt run concurrently.
Duplicate IDs never execute again. Busy agents reject a new prompt. Blocked
agents require the existing Whip approval UI; the provider has no approval,
send-keys or shell tool. Prompt lifecycle results retain their initiating call
ID; status/read tools supply progress and final output. An ambiguous timeout or
transport result permanently disables further prompts for that call.

The current Herdr API does not accept an atomic expected-session precondition
on `agent.prompt`. Snapshot and local generation checks cannot eliminate a
server-side occupant change between verification and dispatch. This is a
remaining qualification limitation, not a guarantee of atomic remote pinning.

## Validation and remaining qualification

The Codex port passes the full Rust suite (1,062 passed, 13 ignored), strict
Clippy, formatting, TypeScript, changed-file lint, 176 affected JavaScript tests,
and three license tests. The delayed-echo test disables noise suppression and
gain control in both processors: providing the playback reference must reduce
echo energy by at least 10 dB against the otherwise identical control. Separate
tests preserve independent microphone speech, reject pre-unmute/stale capture,
exclude synthetic playback silence from truncation, and serialize interrupted
and competing responses. These synthetic checks do not establish physical
loudspeaker performance; build/device results are recorded in the PR.

Automated coverage includes ordered PCM, played-audio truncation, overflow,
stale acknowledgements, server VAD configuration, tool deduplication/uncertainty,
foreground focus changes, disconnect/reconnect/recovery and session replacement,
pending-start cancellation, background ownership, system hangup, credentials,
and native-error redaction. Existing local-call/security/settings tests remain
in the affected regression set.

Validation on 2026-11-03:

- TypeScript, ESLint for all changed files and bundled-license verification
  pass under `nix develop`; 111 affected voice/security Jest tests and three
  license tests pass.
- The serial Rust suite passed 1,050 tests with 13 ignored; all 12 focused
  Realtime tests pass on the final source, with strict Clippy and formatting checks.
- Native iOS media source compiled against the real iOS arm64 SDK and cached
  React headers on mini in `build/realtime-stage2-validation` inside the reused
  persistent worktree. No source or app data was replaced there.
- Android arm64 release Kotlin compilation passes. Final Rust release,
  APK/native linking and signing results are recorded in the PR.
- No Android device was connected. mini's paired iPad was discovered, but its
  persistent worktree contains extensive unrelated changes and lacks Stage 1;
  no full app sync/install or microphone capture was performed.
- No paid API conversation has been performed. Quota/access errors, actual
  tool execution and speech quality still need a saved key and a live call.

Before shipping, validate bidirectional speech and interruption on physical
Android and iOS, loudspeaker echo, headset/Bluetooth route changes, mute before
media startup, system-call interruption, background/locked-screen operation,
hangup during connection/tools/playback, and reconnect with no duplicate prompt.
Verify correlated progress/final output and use the existing approval controls
when blocked. Measure end-to-end latency, underruns, playback-flush delay and
token usage. Errors contain only fixed application messages, never raw provider
bodies, prompts or API keys.

Evaluate native WebRTC media as the shipping transport: `oai-rt-rs` provides SDP
signaling, not a mobile media/AEC implementation. No native WebRTC engine has
been integrated or device-validated in this change. WebSocket TCP head-of-line
blocking, conservative truncation, fail-closed route reconfiguration, remote
session preconditions, and physical-device qualification remain open for #324.
