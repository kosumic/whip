# voice-call-media

Native 24 kHz mono PCM, WebRTC/Opus/RTP transport, bounded capture scheduling,
clocked jitter-buffer playout, resampling, noise suppression and AEC3 extracted
from Whip. The crate has no app, provider, React Native, credentials or recorder
dependency. `audio-ingress` supplies generation-fenced native PCM storage.

```toml
[dependencies]
voice-call-media = "0.1.0"
```

The caller supplies its Tokio runtime and implements `Capture`/`Host` around its
existing device ingress and playback sink. `Transport::configured` creates a
fresh peer and SDP offer; the caller sends that offer through its own signaling
adapter and passes the answer to `apply_answer`. Data-channel identity and the
optional first retained event are configuration, not provider protocol policy.

After negotiation, run `voice_call_media::run` on the same runtime. Keep native
capture callbacks feeding the existing bounded queue. Implement capture mute by
changing its generation atomically; pending processed PCM and the encoder reset
before another packet is sent. An already committed packet can finish in flight.
Playback cancellation advances the host's playback epoch. `render` must check
that epoch under the cancellation lock before committing PCM. AEC render
references must describe samples actually submitted to the device.

Send `true` on the stop watch channel, await the media future, close capture,
then await `Transport::close`. `Drop` signals stop and schedules bounded driver
cleanup on the runtime captured at creation; explicit close reports failures.
Do not shut down that runtime before cleanup finishes. No extra per-call runtime,
second recorder, or JavaScript PCM bridge is created.

RTP packet/byte permits remain held through jitter buffering and decoding.
Ingress is bounded to 64 packets/2 MiB, pending capture to one native batch plus
a partial 20 ms packet, and sends to 100 ms. The 60 ms reorder window is a
playout deadline, not a limit on queued speech duration: all admitted burst
packets remain queued for decoding. The host's bounded PCM queue retains unread
speech across pauses and reports overflow instead of overwriting it with silence.
Native devices pace consumption; partial reads advance only by samples delivered.
Flushes retire the playback epoch, so old acknowledgements cannot advance a new
queue. The synchronous host adapter does not wait for speaker queue space.
Mirrored control events cannot fill an application queue or block RTP. Provider
identifiers in `Tag` are opaque to this engine. Provider session, tool, billing
and retirement policy stay outside.

Run the executable local signaling/PCM example (no API key or audio device):

```sh
cargo run --locked --example mocked
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
```

Tests include stock-peer UDP/TCP interoperability, cancellation/clock behavior,
packet validation, burst/backpressure limits and echo-processing regressions.
Whip retains its device/cue fixtures and uses this same engine in Realtime and
GPT-Live calls. This crate retains AGPL-3.0-or-later; adapted Codex components
retain their Apache-2.0 notices.
