# Realtime live network check, 2026-11-04 (#359, #360)

Ran Whip's Rust WebRTC transport, Opus decoder and production iOS native
playback bridge against the public OpenAI API on `mini`: arm64 iOS Simulator
26.5, iPhone 17 Pro, Xcode 27.1, Rust debug build. The isolated app used the
#360 implementation (`5b61db56`) plus the four-file follow-up described below.
No microphone was opened and no coding-agent task was submitted.

The supplied API key was transferred privately to the isolated app, read through
a test-only native credential callback, and removed from its temporary file
before calls began. The harness erased its retained credential, confirmed the
file was absent and terminated after testing. The source credential and the
installed Whip application's credentials and data were left untouched. Recorded
diagnostics contain counters, durations and hashed identities, without keys,
SDP, wire payloads, audio or transcript text. The native credential store itself
was not exercised by this simulator harness.

## Findings and fixes

The original implementation sometimes kept a preview open until its 30-second
deadline, despite receiving completed response and audio-stop events. RTP kept
arriving and prevented the jitter queue from becoming empty. Packet admission
now stops at the existing audio-tail grace deadline, preserving packets already
received within that grace so playback can drain. This uses the server's
[documented audio-stop event](https://developers.openai.com/api/reference/resources/realtime/server-events),
which signifies that the response's server output buffer has drained.

Closing the media peer before HTTP hangup also produced unacknowledged cleanup
timeouts. Increasing the deadline alone did not resolve these failures. Server
hangup now happens while the media peer still exists, followed by peer close
even if hangup fails. The HTTP hangup deadline is five seconds; the owned-worker
drain deadline is eight seconds, allowing for the two-second peer-close budget.
No retry is allowed without acknowledged retirement.

Recovery policy remains based on the attempt identity and one-retry gates in
[Codex's TUI at ede589336e9ecc64cb05045c2961fb1277858f1d](https://github.com/openai/codex/blob/ede589336e9ecc64cb05045c2961fb1277858f1d/codex-rs/tui/src/chatwidget/realtime.rs).

## Final live run

All **11 cases passed**. All **14 created calls** received successful HTTP
hangup acknowledgements, matched to their hashed call identities. Calls made
after failure/cancellation used fresh native owners.

| Case | Created calls | Result |
| --- | ---: | --- |
| Default `gpt-realtime-1.5` preview | 1 | Audio, expected caption, playback drain and cleanup |
| `gpt-realtime-2.1-mini` preview | 1 | Audio, expected caption, playback drain and cleanup |
| `gpt-realtime-2.1` drain regression | 1 | Completes after server stop; no preview timeout |
| One injected negotiation timeout | 2 | First call retired before one successful retry |
| Two injected negotiation timeouts | 2 | Terminal error after the retry budget; no third POST |
| Injected cleanup failure | 1 | Terminal cleanup error; no retry |
| Injected uncertain creation result | 1 | Terminal unknown-outcome error; no repeated POST |
| Injected startup sideband close | 2 | First call retired before one successful retry |
| Injected sideband loss after first audio | 1 | Visible terminal error; no reconnect |
| Cancel while actual call POST is pending | 1 | Late call identity recovered and retired; no playback |
| Normal preview after the fault cases | 1 | Fresh successful call and cleanup |

Faults were explicitly injected in a temporary copy of the Rust source;
HTTP call creation, WebRTC negotiation, audio playback and hangup remained real.
The unknown-result and cleanup-failure injections first acknowledged real server
retirement in the harness, then supplied the synthetic error to production
recovery logic, avoiding deliberately orphaned calls. These cases verify retry
policy, not natural packet loss or ambiguous outcomes on a carrier network.
Test hooks and the standalone harness are not part of the shipping application.

Single-run timing samples from request to observed native playback level:

| Model | Native media ready | First audio | Final explicit stop drain |
| --- | ---: | ---: | ---: |
| `gpt-realtime-1.5` | 4.85 s | 5.80 s | 254 ms |
| `gpt-realtime-2.1-mini` | 3.00 s | 3.80 s | 246 ms |
| `gpt-realtime-2.1` | 2.15 s | 4.25 s | 264 ms |

The 50 ms observation interval and debug simulator build limit interpretation.
These samples include network startup and are not production latency targets or
a statistically meaningful comparison of models. In-flight POST cancellation
drained in 657 ms in the final run.

The four-file follow-up passed Rust formatting checks. Strict arm64 Android
Clippy against main at `3be9e336` reported 11 existing lint diagnostics in other
files (TTS/usage accounting, the Realtime actor, speech playback/captions and
credential handling); none were in these four changed files.

## Remaining qualification

#359 still tracks capture backpressure/fairness under load and physical Android
and iOS qualification: speaker echo, microphone interruptions/barge-in,
Bluetooth route changes, backgrounding and representative latency. This preview
run does not qualify microphone capture, native keychain access, delegation,
task correlation or real network loss/roaming. Simulator playback and injected
control failures cannot establish those results.
