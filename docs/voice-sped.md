# SPED in the shared Rust voice transport

This implements the host-local pass requested in [#379](https://github.com/kosumic/whip/issues/379#issuecomment-6708238004).
Realtime and GPT-Live both use `voice-call-media`, which now offers SPED alongside
DTLS Auto/1.3, SCTP SNAP and the existing pre-negotiated channel ID 4. Signaling,
credentials, retirement, bounded media queues and TCP-first candidate policy
remain owned by their existing components.

## Upstream and wire compatibility

Published `str0m` 0.25.0 and upstream main at
[`8e0067c`](https://github.com/algesten/str0m/commit/8e0067cca6a45ae4ea0532148d08a3d803d29841)
had no SPED implementation. The transport change is submitted as
[algesten/str0m#1132](https://github.com/algesten/str0m/pull/1132).
Whip temporarily pins immutable revision
`51b8a99b1262b249b7f84b2df1ec3cc810b6cc77` of that PR's source fork.
Replace this git pin with an upstream release when the change is available;
there is no vendored transport copy in Whip.
Publishing `voice-call-media` to crates.io must wait for that upstream release:
Cargo publication rewrites git dependencies to registry versions, and published
str0m 0.25.0 does not contain these APIs.

The implementation uses the `sped` SDP ICE option from
[SPED draft -01, published November 2, 2026](https://datatracker.ietf.org/doc/html/draft-hancke-webrtc-sped-01).
The draft still leaves the STUN attribute IDs unassigned. This implementation
uses the experimental DATA `0xc070` and ACK `0xc071` values present in
[libwebrtc's STUN definitions](https://webrtc.googlesource.com/src/+/refs/heads/main/api/transport/stun.h).
A peer must reciprocate the SDP option. Older deployments that only probe with
STUN attributes, without the option, use ordinary ICE/DTLS here. No claim is made
that public OpenAI endpoints currently negotiate this revision.

[OpenAI's WARP guide](https://developers.openai.com/api/docs/guides/realtime-webrtc-warp)
identifies SPED as one transport optimization alongside DTLS 1.3, SNAP and a
pre-negotiated channel. Offering all four does not establish that full WARP was
negotiated. The new diagnostics distinguish negotiation and actual packet use.

## Authentication and fallback

ICE checks authenticate the SPED attributes with MESSAGE-INTEGRITY. Incoming
responses must also match the check transaction, protocol, local destination
and remote source. Attributes after MESSAGE-INTEGRITY cannot inject DTLS.
Pre-answer checks are bounded and deferred until the answer supplies the remote
ufrag, DTLS role and fingerprint. DTLS retains certificate verification, replay
handling and SRTP key export. Wrong fingerprints remain fatal.

The upstream patch stores at most eight flight packets and four ACKs, admits
at most four early packets, embeds on one candidate path, and caps embedding
at eight packets per ICE generation. It schedules no additional ICE checks.
A 256-byte DTLS MTU reservation allows for STUN overhead, and actual STUN
serialization enforces the configured datagram target. Oversized records leave
the original ICE check intact and remain available for ordinary DTLS.

Once ICE selects a path, DTLS drains directly without waiting for another
STUN check. Unsupported or ignored extensions, path changes and budget
exhaustion leave that path available. An early backend failure can reset DTLS
once using the same local certificate and role, then continue without embedding.
ICE restarts clear SPED generation state while preserving established DTLS;
close/disconnect discard early buffers; cancellation before ICE selection also
discards unsendable DTLS flights and closes immediately. Media readiness, channel delivery and
incoming RTP require ICE selection and authenticated DTLS, including with SNAP.

The dependency's wire/credential tracing remains suppressed. Only fixed,
duration-only `Voice transport negotiation timing` events cross that boundary:
`ice_connected`, `dtls_authenticated`, `data_channel_ready`, `transport_ready`,
`first_rtp_sent`, and `first_rtp_received`. Each records milliseconds from SDP
answer application, SDP negotiation, actual embedded sent/received counts and
a bounded fallback enum. Session POST and application Listening remain separate
provider/host stages; these transport clocks include neither.

## Repeat the benchmark

Run from the repository root; no API key, audio device, APK/AAB, Expo/EAS or
phone is involved:

```sh
nix develop -c cargo run --locked --release \
  --manifest-path crates/voice-call-media/Cargo.toml \
  --features sped-benchmark --example handshake_bench -- 30 40 0
nix develop -c cargo run --locked --release \
  --manifest-path crates/voice-call-media/Cargo.toml \
  --features sped-benchmark --example handshake_bench -- 30 180 7
nix develop -c cargo run --locked --release \
  --manifest-path crates/voice-call-media/Cargo.toml \
  --features sped-benchmark --example handshake_bench -- 30 0 0

# Same harness against unmodified published str0m 0.25.0:
nix develop -c bash crates/voice-call-media/benchmarks/stock.sh 30 40 0
nix develop -c bash crates/voice-call-media/benchmarks/stock.sh 30 180 7
nix develop -c bash crates/voice-call-media/benchmarks/stock.sh 30 0 0
```

Arguments are iteration count, simulated RTT in milliseconds, and the interval
between dropped UDP datagrams (`0` disables loss). Both UDP and RFC 4571 cases
run automatically, with SPED disabled/enabled and cold/warm material. TCP is
reliable in this model; the loss argument does not drop TCP frames. The stock
script copies the same harness into `target/stock-handshake`, with its own
checked-in dependency lock, and compiles out the new upstream-only hooks.

Two Rust peers perform real ICE, DTLS authentication, SNAP/SCTP, channel-4
messages and SRTP encryption/decryption. Each verifies the other's channel
message and Opus silence payload. The network scheduler advances a simulated
clock, including DTLS timers; it does not sleep for the stated RTT. TCP cases
exercise RFC 4571 frame encoding/decoding, not TCP congestion or connection
establishment. The existing independent stock-peer media tests also use real
local UDP sockets and TCP streams, proving unsupported-peer fallback.

`construction_wall` measures creation/signaling of both local peers.
Cold generates fresh certificates inside that interval; warm prepares fresh
certificates before it. Neither reuses an established connection or TLS session.
`handshake_wall` measures real CPU/wall time for the two-peer scheduler and
crypto, excluding construction. All other stages use simulated time from
answer application. `dtls_from_first_flight` begins at the first actual outgoing
DTLS packet, either direct or embedded. `data_channel_open` is an event;
`data_channel_authenticated` also requires authenticated transport readiness.
Stock SNAP can open its association before DTLS and must not be mistaken for
an authenticated channel. First RTP means the first successfully decrypted
incoming packet, not the application's microphone callback or Listening state.

CSV percentiles use nearest rank. `negotiated`, `embedded`, `fallbacks` and
`failures` count iterations; `embedded` requires actual DATA attributes on the
wire. Latency samples exclude failed iterations, whose count is always shown.

## Recorded results

Host: Linux 6.18.59, x86_64; Nix development shell; Rust 1.99.0
(`b940084d7`, LLVM 23.1.1), default Cargo release profile. Recorded November 7,
2026. [Raw CSVs](benchmarks/voice-sped/) retain every cold/warm, UDP/TCP result.
The recorded dataset contains 1,080 calls across the three scenarios: 360 stock,
360 patched with SPED disabled, and 360 with SPED enabled. There were 1,079 completions. One
patched/SPED-off cold UDP iteration at 180 ms RTT/loss reached the simulated
15-second data-channel message deadline after both peers had received RTP
([captured stderr](benchmarks/voice-sped/loss-deadline.txt)). That is 1/360
patched/off failures, versus 0/360 stock and 0/360 SPED-on. The failing profile
has 29 successful latency samples, rather than 30. Independent random DTLS
timers and this periodic-loss workload prevent attributing that single
discrepancy to a specific cause; it remains a limitation requiring follow-up.
The enabled calls all negotiated SPED and embedded DTLS; none needed fallback in these compatible-peer
benchmark scenarios. Unsupported/broken-peer fallback is covered separately by
regression tests.

At 40 ms RTT, cold and warm UDP/TCP protocol results match:

| Stage (simulated ms, p50 / p95) | Stock 0.25.0 | Patched, SPED off | SPED negotiated and used |
| --- | --- | --- | --- |
| ICE connected | 40 / 40 | 40 / 40 | 40 / 40 |
| DTLS from first outgoing flight | 40 / 40 | 40 / 40 | 40 / 40 |
| DTLS authenticated since answer | 80 / 80 | 80 / 80 | 40 / 40 |
| Authenticated channel / transport ready | 80 / 80 | 80 / 80 | 40 / 40 |
| First decrypted incoming RTP | 120.001 / 120.001 | 120.001 / 120.001 | 80.001 / 80.001 |

This demonstrates overlapping the first DTLS exchange with ICE, saving one
simulated RTT. It does not accelerate the DTLS exchange itself.

The 180 ms RTT stress case drops every seventh UDP datagram. Cold UDP results:

| Stage (simulated ms, p50 / p95) | Stock 0.25.0 | Patched, SPED off | SPED used |
| --- | --- | --- | --- |
| Transport ready | 360 / 360 | 360 / 360 | 180 / 180 |
| First decrypted incoming RTP | 1220.296 / 2924.573 | 1248.935 / 3167.851 | 360.001 / 360.001 |

The loss schedule interacts with packet ordering and randomized DTLS
retransmission timers, so tail results vary across runs and are not a prediction
for an equivalent production loss percentage. The longer baseline first-RTP
wait can include the remote peer's DTLS retransmission even after the local
peer is ready. Reliable TCP protocol cases show the expected one-RTT saving;
they do not model TCP retransmission or head-of-line blocking.

At zero simulated RTT, readiness is approximately 4 microseconds with SPED off
and 2 microseconds with SPED on, an artifact of the scheduler's minimum clock
step. There is no meaningful network gain to infer from those numbers. Real
cold-UDP handshake CPU/wall p50 at 40 ms simulated RTT was 0.395 ms stock,
0.415 ms patched/off and 0.448 ms SPED; the SPED path adds work. Its construction
p50 was 1.914 ms versus 1.908 ms patched/off. These small, uncontrolled timing
differences are not evidence of a CPU improvement or a universal regression.

## Validation and remaining work

```sh
nix develop -c cargo fmt --manifest-path crates/voice-call-media/Cargo.toml --check
nix develop -c cargo clippy --locked --manifest-path crates/voice-call-media/Cargo.toml \
  --all-targets --features sped-benchmark -- -D warnings
nix develop -c cargo test --locked --manifest-path crates/voice-call-media/Cargo.toml \
  --all-targets --features sped-benchmark
nix develop -c cargo test --locked --manifest-path crates/voice-call-openai/Cargo.toml
```

Whip validation passes 41 media/capture/SPED tests and 38 provider tests,
including its executable native-PCM mock. The upstream PR records its exact
commands: 112 ICE/STUN tests, 879 library tests, six SPED peer/security tests, and existing DTLS fingerprint, retransmit,
close, readiness, ICE restart, MTU, direct-handshake/SNAP and data-channel suites.
Whip adds eight scenario tests covering encrypted UDP/TCP data, absent or
broken support, high RTT/loss, path changes, ICE restart, active-answerer
pre-answer DTLS, fingerprint rejection and cancellation. Existing bounded media,
DSP, capture and real stock-peer UDP/TCP tests remain part of validation.
Upstream development-only `buf_redux`/`multipart` emit existing future-Rust
compatibility notices; the requested lint checks pass.

Both compatible SPED peers here use the new Rust implementation. Independent
libwebrtc/OpenAI SPED interoperability is unverified. TURN, PQC fragmentation,
SDP-less legacy probing, real mobile networks, device power/audio correctness
and end-to-end Listening latency remain follow-up work. No live API call or
session POST was included. No mobile artifact was built or installed. These
results establish protocol behavior locally, not production WARP startup gains.
The task commit uses `[skip ci]` because Whip's default PR workflow assembles an
APK. The dedicated Rust media workflow is updated to run the new scenarios on
future runs; the validation above is local for this task.
