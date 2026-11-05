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
count. The device feeds the exact mixed samples and output delay to AEC3.
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
