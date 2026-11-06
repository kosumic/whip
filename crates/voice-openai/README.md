# voice-openai

Reusable OpenAI Realtime and GPT-Live provider support for native Rust hosts.
`voice-openai → voice-call-media → audio-ingress` is a one-way dependency chain.
Neither voice crate imports Whip, React Native, app storage, agents or UI state.
The crate retains AGPL-3.0-or-later and the adapted Codex Apache-2.0 notices.

The provider owns HTTP SDP signaling, WebSocket/sideband framing, ordered audio
identity, response scheduling, tool-call admission, effective settings validation,
GPT-Live session/mute/interruption gates, and bounded final-usage collection.
It reuses `oai-rt-rs` wire types and the existing native media engine. It creates
no runtime, recorder, platform audio session, JS PCM bridge or persistence layer.

## Host integration

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
let (mut events, media) = voice_openai::connect_realtime(
    app_attempt, &credential, session_update, &model,
).await?;
// Or: connect_live(app_attempt, &credential, serde_json::to_value(config)?).
```

Consume the bounded `Socket` with `StreamExt::next` and `receive_text`. Use
`oai-rt-rs` to decode provider events and send commands through `send` or
`live::send`. `Socket::Direct`, `connect_raw` and `authorized_request` support
WebSocket PCM sessions without a second orchestration/runtime layer. The same
socket API supports mock signaling through `Socket::relay`.

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
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
```

The executable supplies mock native-audio/credential adapters, cancelled startup,
bounded signaling, host tool results, Live mute acknowledgements and cumulative
usage. It requires no credential, microphone or billable provider call. The
media crate's `mocked` executable separately exercises bidirectional PCM with a
stock WebRTC peer over real local transport.

## Migration for GymAmi and other apps

Add `voice-openai` and `voice-call-media` as path dependencies from `crates/`.
Use the existing runtime and device callbacks, and wrap the app's credential
store, capture queue, playback sink, tool executor, event/history sink and usage
sink in the interfaces above. Build session context in that app; never import
Whip's pinned-agent, terminal, database, UI or FFI modules. Do not copy provider
or media workers. Whip's adapters in `realtime_voice/webrtc/host.rs` demonstrate
how application state stays outside these crates; the mock example provides a
smaller independent adapter.
