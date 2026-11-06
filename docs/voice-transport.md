# Voice transport ownership

Whip uses one native WebRTC media implementation for Realtime API and GPT-Live
calls. Each API retains its own session configuration, signaling, delegation,
and usage protocol.

The ownership below follows the inspected Codex
[voice-host transport](https://github.com/openai/codex/blob/021fccb046508938c4754982efccfb51d6e8356e/codex-rs/voice-host/src/transport.rs)
and its current
[WebSocket reader](https://github.com/openai/codex/blob/86ac0916597244a2e67a197822a5483924660ff1/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs).
Whip's media backend remains str0m, native Opus, and Android AudioTrack.

- The HTTP session request includes the SDP offer and initial configuration.
  Applying the answer and attaching the control sideband happen in parallel.
- RTP carries audio. Native ingress, decoding, playback, microphone capture,
  and echo cancellation run independently of the application event consumer.
  Packet/byte permits follow retained packets through decoding. A full reorder
  queue preserves its existing speech instead of replacing it with a newer burst.
  Playout reanchors unheard sequences when the whole arrival timeline shifts;
  concealment follows Opus packet durations and known RTP gaps, including 10ms
  packets. These follow the clock-slaved, retained-buffer behavior in Codex's
  [playout pipeline](https://github.com/openai/codex/blob/021fccb046508938c4754982efccfb51d6e8356e/codex-rs/voice-host/src/playout.rs).
- Raw socket readers apply bounded backpressure instead of silently discarding
  frames when their queue fills. This matters for TCP: dropping an already
  received frame defeats its reliable delivery before DTLS/SRTP can process it.
  TCP is preferred, with UDP candidates retained as fallback. This is a Whip
  network policy based on API measurements, not a claim about Codex's preference.
  Reliable-stream playout waits for the next packet during a transport stall;
  advancing concealment through that stall would make its retransmitted words
  appear late and discard them. UDP keeps bounded reordering and concealment.
- Live delivers the continuous decoded track, including quiet phonemes and
  pauses. Audibility controls the speaking indicator independently; it never
  removes PCM from playback.
- The WebSocket sideband owns application events and commands, including
  captions, tool calls, and usage. Mirrored data-channel messages are discarded.
  Data-channel lifecycle failures report readiness loss to the call owner.
  As in Codex's observer, closing that channel does not itself destroy the peer;
  the owner retains it while draining final session events, then retires it.
  During Live hangup, hardware capture stops and the primary sender clocks
  silence until the sideband confirms `session.closed`. Keeping only DTLS open
  while stopping RTP reproduced final-usage timeouts in minute-long API tests.
- Reflected PCM events are filtered before the bounded application queue.
  Playback comes from RTP, so those copies cannot consume queue capacity or
  produce duplicate playback. WebSocket backpressure never blocks the RTP driver.
- The sideband reader answers server pings and consumes pongs itself. There is
  no application-level requirement for a pong within 45 seconds. Read/write
  errors and media transport failures retain their normal cleanup paths.
  A WebSocket close frame is forwarded once and terminates its reader normally;
  the conversation owner decides whether that closure was expected.
- ICE `Disconnected` gets a bounded recovery window on the existing peer.
  Recovery does not create another billable session or replay commands.

The earlier implementation forwarded both event streams through small queues
and terminated the entire transport when the data-channel queue filled. Its
application heartbeat also ended an otherwise audible Live call. A synthetic
test through the full production Live actor reproduced that timeout; the earlier
short API tests did not run long enough to exercise it.

Regression coverage includes independent UDP/TCP peers flooding the data
channel while RTP continues, a WebSocket peer sending reflected audio and
control frames, and explicitly authorized API tests for a minute-long Live call
and Realtime playback identified exclusively by sideband events. The API tests
are ignored by default because they require credentials and incur usage.

Phone diagnostics contain numeric playout counters and separate startup timing
for queued transitions, microphone permission, speech suspension, call-service
activation, HTTP client construction, session creation, negotiation, and device
startup. Shutdown logs separate device release from final transport cleanup.
The Android ready cue is a bounded PCM16 mono WAV mixed by Rust into the same
AudioTrack buffers as assistant speech. JNI supplies silence when no provider
audio is available, mixes the cue, and retains the provider's original sample
count. Before mixing, Rust retains the provider PCM in a bounded reference FIFO.
The device's actual write sizes and output delay clock that unmixed reference
into AEC3, including partial writes. Local cue samples stay audible but cannot
trigger echo suppression of the user's opening word; provider speech still
supplies the echo reference.
Microphone capture stays live: there is no cue mute, capture-generation reset,
or acoustic-tail timer. Cue-only samples do not advance assistant captions or
the played-audio cursor. Generation checks cancel late cue loads and prevent
an old request from stopping a replacement cue. Decode/file I/O runs off the
UI and audio workers. The closed cue retains normal MediaPlayer playback.

Live captions use approximate provider fragment intervals and advance from
acknowledged native playback. Text delivery alone cannot advance highlighting;
interrupted ranges remain frozen when a later reply plays. The first caption
anchors the fragment clock to current playback, so this estimates progress
within fragments rather than claiming exact provider word boundaries. See the
[Live transcript timing contract](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas).

Normal Realtime response boundaries preserve the device and decoder clock.
Audio items share a bounded FIFO, with per-item offsets for captions and
interruption truncation. A following reply may arrive while the previous reply
still has samples in Rust or AudioTrack; this queues speech in order instead of
pausing the call or discarding the previous tail. Actual interruptions still
invalidate old playback epochs. Android diagnostics also report AudioTrack
underruns and queued device audio to distinguish playback starvation from
missing RTP packets.

Android playback is paced by AudioTrack's bounded buffer and blocking writes.
It must be allowed to fill the platform's streaming start threshold, including
after a route change. A fixed 80 ms producer limit previously deadlocked a
Bluetooth track with an 8,228-frame buffer at 24 kHz: only 1,920 frames were
queued, the device playback position remained zero, and captions could not
advance. Diagnostics include both platform buffer size and start threshold.
This matches the playback ownership in the
[OpenAI Agents SDK WebRTC transport](https://github.com/openai/openai-agents-js/blob/628f6c6e1d475db53ceab27e91ff0d5c2a28b155/packages/agents-realtime/src/openaiRealtimeWebRtc.ts#L502):
it attaches the remote media stream directly to an autoplaying audio element,
allowing the platform player to manage buffering. Its browser implementation
does not supply Android device-routing code.

Android calls acquire and drain the microphone as soon as the native call
starts, overlapping device setup with the session POST and media negotiation.
This follows early microphone acquisition in
[Expo GPT-Live](https://github.com/davidmokos/expo-gpt-live/blob/9e83073ef5b3a986124d9141271c09443cbe8d5b/src/live/transport.ts#L8)
and the
[Agents SDK React Native example](https://github.com/openai/openai-agents-js/blob/628f6c6e1d475db53ceab27e91ff0d5c2a28b155/examples/realtime-react-native/src/ReactNativeWebRTCTransport.ts#L163).
Those examples acquire the microphone before creating the SDP offer. Whip's
Rust transport can create its offer independently of Android's recorder, so
it runs both preparations concurrently. iOS already starts its audio engine
without waiting for negotiation. Output-only Android previews still defer
device startup and never acquire a microphone.

Both Live and Realtime use the same two-way readiness handshake: the devices
may start before or after negotiation. Rust discards pre-connection microphone
frames rather than queueing them for later replay. Input remains muted when
requested, and Listening/the ready cue still wait for the first microphone
packet to reach the media sender. Early acquisition removes device setup from
the end of the startup path; it does not shorten the session POST or network
negotiation themselves.

GPT-Live's Listening state and ready cue wait for validated `session.started`
from the primary WebRTC data channel, native device startup and the first fresh
microphone packet uploaded over WebRTC.
An accepted session POST and negotiated media transport do not alone establish
application readiness. The media worker keeps the transport clock running with
muted silence until confirmation, while early microphone acquisition continues.
The actor also waits for confirmation before sending queued application commands.
The peer retains only the first bounded primary start event, independently of
the sideband attachment. Mirrored transcripts, audio and tools remain on sideband
so they cannot create duplicate actions or backpressure the media driver.

Live captions pair the first transcript timestamp with the first audible provider
PCM sample, then advance from hardware playback acknowledgements. A late caption
catches up to audio already heard rather than starting a new clock at text arrival.
Leading provider silence, local ready tones and queued but unplayed audio do not
advance highlighting. Provider fragment timestamps remain approximate.

API verification on 2026-11-06 reproduced loss of an immediate opening
“Tangerine” with the mixed cue reference. Bypassing either the cue or DSP
preserved it. Keeping both enabled with the unmixed provider reference passed
two 65-second calls: ordinary synthetic speech and a microphone fixture with
simulated cue echo followed by speech after the chime. Both recognized and
repeated the opening word, produced audible output and caption progress,
finalized usage, and recorded no capture gaps, processing drops or late packets.
The native suite passed 157 tests. Host API tests require optimized DSP
dependencies (or a release test build); debug DSP can miss real-time deadlines.
These synthetic checks do not replace a physical speaker/headphone check.

### Optional local client warmth

Settings → OpenAI → Conversation → **Keep voice client warm** defaults to On.
Existing saved Off choices remain Off; preferences without this field use On.
When enabled, unlocked foreground Whip retains the shared HTTP client, a crypto
provider, and one unused DTLS certificate. Consumed certificates are replenished;
unused certificates are periodically refreshed. No API key, provider request,
API session, microphone, audio device, tool authority, peer, SDP or network
socket is retained by preparation. Disabling or backgrounding releases the
spare material; the ordinary shared HTTP client stays reusable as before.

Every actual call creates new sockets using current network interfaces and a
fresh RTC with a new clock, ICE credentials, SDP offer, and data-channel state.
It can consume the prepared certificate and provider. This follows the fresh
peer setup in the OpenAI Agents SDK React Native example. Only an explicit Call
or Preview action creates a provider session. Local warming cannot remove
server session-creation or network negotiation latency.

The [phone measurements](voice-local-warm-profile.md) include all 14 startup
trials and the paired idle-memory comparison for the corrected local-only cache.

The unshipped paid-session draft was removed because the requested trade is
local memory for startup work, without idle API charges. A later whole-peer
prototype was installed and measured, but a Realtime negotiation failure after
idle made that cache unsuitable. Fresh-peer controls worked. Its preliminary
0.7 MiB allocation and 4–5 ms offer observations belong to that rejected APK
(db110cff…), not to the factory-only implementation. They must not be presented
as final results for the replacement.

See the official [WebRTC connection flow](https://developers.openai.com/api/docs/guides/voice-webrtc)
and [session billing](https://developers.openai.com/api/docs/guides/voice-latency-cost).

## Reusable media engine

`crates/voice-call-media` owns WebRTC/Opus/RTP, native capture scheduling,
bounded packet ingress, jitter playout, resampling and echo processing. It uses
`audio-ingress` for PCM and accepts host capture/playback callbacks; it imports
no Whip state or provider code. Both Realtime and GPT-Live use this engine on
Whip's existing runtime and native audio path. Platform audio sessions and device
callbacks remain in the Android/iOS host adapters.

The host owns signaling and audio identity. Data-channel labels and the optional
first retained control-event kind are injected through `TransportConfig`.
Playback callbacks recheck cancellation epochs before committing samples. See
`crates/voice-call-media/README.md` for adapter contracts, shutdown ordering and
the credential-free bidirectional PCM/signaling example.
