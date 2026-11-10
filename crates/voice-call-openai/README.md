# voice-call-openai

Reusable OpenAI Realtime and GPT-Live provider support for native Rust hosts.
`voice-call-openai → voice-call-media → audio-ingress` is a one-way dependency chain.
Neither voice crate imports Whip, React Native, app storage, agents or UI state.
The crate retains AGPL-3.0-or-later and the adapted Codex Apache-2.0 notices.

The provider owns the serialized Realtime and GPT-Live session driver, HTTP SDP
signaling, WebSocket/sideband framing, PCM capture pacing, ordered audio identity,
response scheduling, tool-call admission, effective settings validation, GPT-Live
session/mute/interruption gates, and bounded final-usage collection.
It reuses `oai-rt-rs` wire types and the existing native media engine. It creates
no runtime, recorder, platform audio session, JS PCM bridge or persistence layer.

Hosts may call `prepared::configure(true)` inside their existing Tokio runtime
to prepare the HTTP pool for both voice backends. It sends an anonymous HEAD to
the models endpoint immediately and every 30 seconds after completion, with a
five-second timeout. It reads no credentials and creates no voice session.
Call `prepared::clear()` on background, lock, credential changes or opt-out.
Preparation is optional; call startup never waits for it. Idle connections can
expire and reconnect normally. Local DTLS preparation remains separately owned
by `voice_call_media::prepared`.

## Make a call from another app

Use `Call` for an owned connection and lifecycle. It supports native WebRTC and
WebSocket PCM for both protocols:

```rust,ignore
use voice_call_openai::{Call, CallConfig, CallTransport};

// native implements Host + session::Audio over this app's devices/PCM queue.
// application implements session::Delegate over this app's commands and tools.
let call = Call::connect(
    native.clone(), &credential,
    CallConfig::Realtime { settings, update },
    CallTransport::WebRtc,
).await?;
call.run(&*native, &mut application).await?;
// GPT-Live: CallConfig::Live { session: oai_rt_rs::live::SessionConfig { .. } }
// WebSocket PCM: CallTransport::WebSocket
```

`RealtimeConfig` supplies the expected model and `settings::AudioSettings`; the
typed `session.update` supplies instructions, tool schemas and requested audio
settings. Live configuration uses `oai-rt-rs` directly and accepts a custom model,
voice and optional Responses backend. No Whip catalog or agent is required.

Implement `session::Audio` for native capture policy, mute generations, bounded
PCM playback and played-position truncation. `Call` supplies the media handle:
the app does not need to recreate WebRTC, Opus, sideband or PCM workers. Capture
remains gated until effective settings arrive, and queued startup PCM is discarded
before the microphone opens. The app still owns device startup, permissions,
platform audio sessions and the bounded ingress queue.

Implement `session::Delegate` for application work:

- `next_work`: wait on app controls, cancellation or already-spawned tool tasks.
  This future must be cancellation safe; channel receive and `JoinSet::join_next`
  are suitable. Return `None`, or `Flow::Stop` from a callback, to hang up.
- `work`: apply controls through `Session::mute`, `interrupt`, `send_text` or
  `append_context`. Realtime host tools return results with `tool_result`;
  GPT-Live delegation/context and Responses commands remain distinct typed APIs.
- `event`: receive typed transcript, tool/delegation, session and usage events.
  Authorize tools against the host's catalog with `tools::Ledger`. Spawn slow
  execution on the app's existing runtime so capture and controls keep running.
- `tick`: optional app liveness/feedback work. The default schedules pending
  Realtime continuations after the active response and user speech finish.
- `usage` / `live_usage`: accounting-only callbacks after hangup. Finalization
  never runs tools, opens the microphone or replays a conversation.

`send_text` creates a Realtime user turn. For Live it appends session-wide factual
context using `session.thinking.append`, following the
[Live context API](https://developers.openai.com/api/docs/guides/live-conversations#add-context-during-the-conversation).
Inputs for a Responses backend use explicit typed Live commands and the host's
backend scheduler; a client-delegation session never receives Responses commands.

Keep `run` alive through cleanup instead of aborting it. It stops capture and
audio, collects final usage with credential-revocation checks, closes signaling,
and awaits bounded media retirement. `Audio::credentials_current` must reflect
credential replacement/revocation. `Call::connect` returns `recovery::Failure`,
including whether retirement made an initial failure safe to retry; the crate
never automatically replays established calls or uncertain commands.

Run the complete independent-app example (no credentials or microphone):

```sh
cargo run --locked --example call
```

It uses `Call::from_realtime` and `from_live` with mock provider transports, opens
both sessions successfully, transfers PCM, supplies a host tool result, checks
mute acknowledgements and interruption, and collects final usage on hangup.
The executable and integration tests exercise the same `Session::drive` used by
Whip, rather than a separate implementation or cancelled startup alone.

## Existing host integration

1. Implement `Credential::authorization` with a temporary `Zeroizing<Vec<u8>>`.
   `native_credentials::NativeCredential` already implements this interface.
2. Implement `voice_call_media::Capture` over the existing bounded PCM ingress.
   Mute must invalidate capture generations, including a rapid mute/unmute.
   Run DSP on the consumer; provide device-submitted render references to
   `MediaEchoCanceller`. Keep AudioTrack/AVAudioEngine/CallKit/services in the host.
3. Implement `Host` for a call-attempt owner. Supply revision/cancellation checks,
   activation/failure callbacks, timings, a bounded PCM sink and usage/audio
   observations. Callbacks must not block or hold locks across awaits. The
   provider checks playback epochs while committing to the host sink.
4. Construct session instructions/context and the tool catalog in the host.
   Realtime uses `oai_rt_rs::ClientEvent`; Live uses
   `oai_rt_rs::live::SessionConfig`. Model, voice and server VAD are caller
   choices. The catalog is optional; signaling also accepts custom model IDs.
5. Connect on the host's existing Tokio runtime:

```rust,ignore
let (mut events, media) = voice_call_openai::connect_realtime(
    app_attempt, &credential, session_update, &model,
).await?;
// Or: connect_live(app_attempt, &credential, serde_json::to_value(config)?).
```

For apps which already own connection attempts and accounting, construct a
borrowed `session::Session::realtime` / `live` over the returned bounded `Socket`
and call `Session::drive`. Whip uses this integration to retain its existing
attempt policy and native device lifetime. Both entry points share the provider
driver; apps no longer need to decode the socket or copy a session receive loop.
`Socket::Direct`, `connect_raw` and `authorized_request` remain available for
custom signaling, and `Socket::relay` supplies mock signaling.

Realtime `settings::Settings` validates only effective `session.updated`, using
`AudioSettings` for voice, PCM, VAD, caption language and preview policy. Keep
capture disabled until effective settings and native devices are ready. Live
uses `live::Control`/`Selection` to pin model, voice, session and optional backend
selection. Primary WebRTC `session.started` establishes Live readiness; its
sideband mirror cannot open the microphone early.

Tool execution belongs to the host. Authorize against its catalog, admit calls
through `tools::Ledger`, execute through the host's existing cancellation and
approval policy, then send `tools::function_output`. Unknown/duplicate calls,
bounded arguments and uncertain mutations cannot silently replay work. Live
client delegation remains distinct from Realtime function calls. Hosts receive
those typed events and supply context/results with Live commands; `live::chunks`
preserves UTF-8 within the public context bound.

Provider events carry transcripts and token usage for the host's event/history
and usage sinks. `live::usage::DurationUsage` retains monotonic cumulative seconds
and validates final reports. Pricing and persistence belong to the host.

## Interruption, recovery and stop

Realtime WebRTC sideband liveness is checked with matching WebSocket ping/pong
frames every ten seconds, with a ten-second reply deadline. Unrelated events
and stale pongs cannot satisfy that check. These control frames remain outside
the application event queue. Media independently monitors remote RTP receiver
progress, so local send completion and healthy ICE keepalives do not hide a
one-way audio failure. Both explicit failures are recognized by the existing
`continuity::connection_lost` allowlist; the host still owns acknowledged
retirement and any replacement, with no replay of speech or tool work.
An application event consumer that cannot accept a queued event within the
existing ten-second I/O budget fails explicitly instead of blocking the relay
and its health checks indefinitely. This application failure is not classified
as a retryable network outage.

Transport receipt and speech recognition are separate. The app can correlate
local speech evidence with the documented
[`input_audio_buffer.speech_started` event](https://developers.openai.com/api/reference/resources/realtime/server-events#input_audio_buffer-speech_started).
Whip warns after sustained high-confidence processed local speech receives no
speech acknowledgement within eight seconds. Local activity alone never causes
a paid replacement, a forced buffer commit, or response creation. Ordinary
silence, brief activity, mute, and assistant playback do not arm that warning;
server speech progress clears it. The embedded diagnostic detector is separate
from the provider's configured server VAD and never gates microphone samples.

`Handle::cancel_audio` advances the playback epoch; `resume_live_audio` reopens a
new Live epoch after fresh input. Mute must also close the host's ingress gate
and send the matching typed provider command. The host owns native device stop.

Keep the provider socket alive briefly after cancellation for final accounting.
For Realtime, `shutdown::collect` accepts a host `UsageSink` and a current-
credential predicate. It disables automatic responses, cancels pending work,
collects billing events and never runs tools. For Live, send `session.close`,
consume final `session.closed` usage, and call `Handle::confirm_live_closed`.
Then await `Handle::close`, close the socket, and release device resources.
All workers have bounded cleanup deadlines; keep the host runtime alive until
cleanup completes. A Live call's fallback retirement reattaches only to close
that known session and never replays application commands.

`recovery::Failure::retryable` is set only when a failed attempt was safely
retired. A host may start a fresh attempt under its own bounded retry policy
(Whip permits one startup retry). Never replay an established conversation or
an uncertain call-creation/tool request. `Host::current` must reject superseded
attempts; credential replacement must invalidate the host's call ownership.

## Examples and checks

```sh
cargo run --locked --example mocked
cargo run --locked --example call
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
```

The executable supplies mock native-audio/credential adapters, cancelled startup,
bounded signaling, host tool results, Live mute acknowledgements and cumulative
usage. It requires no credential, microphone or billable provider call. The
media crate's `mocked` executable separately exercises bidirectional PCM with a
stock WebRTC peer over real local transport.

## Migration for GymAmi and other apps

Add the provider and media crates to your Cargo dependencies:

```toml
voice-call-openai = "0.1.0"
voice-call-media = "0.1.0"
```

Add `native-credentials = "0.1.0"` to use its portable `NativeCredential`
adapter, or implement `voice_call_openai::Credential` for your own credential
type. For development inside this repository, keep using path dependencies
from `crates/`.

Use the existing runtime and device callbacks, and wrap the app's credential
store, capture queue, playback sink, tool executor, event/history sink and usage
sink in the interfaces above. Build session context in that app; never import
Whip's pinned-agent, terminal, database, UI or FFI modules. Do not copy provider
or media workers. Whip's adapters in `realtime_voice/{session_host,session_audio}.rs`,
`realtime_voice/live/session_host.rs` and `realtime_voice/webrtc/host.rs` demonstrate
how application state stays outside these crates; the mock example provides a
smaller independent adapter.
