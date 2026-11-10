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

RTP packet/byte/audio permits remain held through jitter buffering and decoding.
Ingress and jitter **together** retain at most 1,024 packets, 2 MiB of encoded
storage (charged for both raw RTP and the parsed payload copy), and eight seconds
of Opus packet samples, whichever fills first. At 20 ms per packet the duration
budget supports 400 retained packets, including bursts while the consumer is
paused. Tiny frames can hit the packet limit first; padded packets can hit the
byte limit first. Queue slots, lease metadata, decoder scratch, and the separately
bounded network/str0m and host PCM buffers add fixed overhead outside those 2 MiB.
Pending capture is bounded to one native batch plus a partial 20 ms packet, and
sends to 100 ms. The 60 ms reorder window is a
playout deadline, not a limit on queued speech duration: all admitted burst
packets remain queued for decoding. The host's bounded PCM queue retains unread
speech across pauses and reports overflow instead of overwriting it with silence.
Native devices pace consumption; partial reads advance only by samples delivered.
Flushes retire the playback epoch, so old acknowledgements cannot advance a new
queue. The synchronous host adapter does not wait for speaker queue space.
Mirrored control events cannot fill an application queue or block RTP. Provider
identifiers in `Tag` are opaque to this engine. Provider session, tool, billing
and retirement policy stay outside.

Admission never waits for space on the shared RTC driver. UDP exhaustion drops
the newest packet and records which budget filled. Reliable exhaustion makes
incoming media fail explicitly with `Reliable incoming audio exceeded its bounded
backlog.` Subsequent packets are counted as rejected after failure; the consumer
cannot silently resume a fragmented reliable stream. This failure is sticky for
the transport: the owner retires the call rather than retrying the missing packet.
RTC timers, ICE, DTLS, SCTP and outgoing commands continue until the owner closes
the transport. Closing the consumer and invalid media also have explicit failure
reasons. No additional pressure worker, blocking send, or wait under the admission
lock is used, so cancellation and teardown do not wait for backlog space.

UDP packets already over one second old **at admission** are counted and dropped.
Reliable arrival delay does not imply obsolete speech. Once admitted, neither
transport expires packets by wall-clock age: speech survives a stalled consumer
and a normal stop's sealed drain. The existing 160 ms actual-packet/decode quiet
period and one-second tail-admission cap are unchanged; after sealing, completion
requires both raw ingress and jitter to drain. Cancellation immediately retires
both queues and releases their leases. The continuous decoder and response
snapshot checks are preserved. Each media tick admits/decodes at most 64 packets
per stage, independently of retention capacity.

`Statistics::ingress` and `Incoming::take_statistics()` report accepted packets,
packet/byte/audio limit drops, stale UDP, invalid media, closed consumers,
reliable failures, subsequent failed packets, suppression, and epoch retirement
separately. Whip accumulates these under `media.ingress` in its voice diagnostics;
jitter late/concealed/overflow statistics retain their previous meanings.

These are finite backlog limits, not lossless arbitrary-burst guarantees. Eight
seconds bounds retained packet audio, not total call latency: consumer stalls,
RTP timestamp gaps, and host PCM buffering add delay. During normal sealed drain,
each timestamp gap is still bounded by the existing 120 ms concealment/rebase
policy. Arbitrarily long consumer pauses have no wall-clock playback guarantee;
if more speech fills a budget, reliable media fails explicitly and UDP drops are
observable. Applications requiring fresher audio can cancel the playback epoch.

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
