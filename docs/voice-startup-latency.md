# Voice call startup measurements

Measured on a Pixel 9 Pro on 2026-11-05. Whip used the GitHub-channel, upload-signed
arm64 release APK built from `cac1649c` plus the GPT-Live WebRTC changes. These
measurements cover call startup; they do not measure time to the first spoken
response. The first observed call is not a proven cold application launch.

## Whip GPT-Live

| Call | First microphone capture | First RTP input / Listening |
| --- | ---: | ---: |
| First observed | 3,914 ms | 3,943 ms |
| Repeat 1 | 1,915 ms | 1,938 ms |
| Repeat 2 | 1,940 ms | 1,969 ms |

The two repeated calls averaged 1,954 ms to Listening. Their session-creation
POST averaged 594 ms, followed by 867 ms of peer negotiation. The control
sideband starts in parallel. On the first and third calls, microphone input
began before the initial control snapshot arrived, confirming that the snapshot
no longer gates media startup.

The original WebSocket PCM build's repeated calls averaged 2,024 ms to first
capture, versus 1,928 ms with WebRTC: a 96 ms difference in this small sample.
The first observed WebRTC session-creation request took 2,604 ms. That interval
includes HTTP client initialization, network setup, server processing and
response reading; it does not isolate any one of those costs.

The HTTP client and its pool remain alive for the app process after first use.
Each call still creates and closes its own voice session and media connection.
Creating the client earlier does not itself establish a network connection.

## Realtime API after playout fixes

The upload-signed arm64 APK with SHA-256
`87374d899cf6c8089b64d33e9a5537ec996aef3fad093db9a34a46396fd0935d`
adds explicit backend and client-stage timings. After force-stopping and
relaunching Whip, the first Realtime API call measured:

| Stage | Time |
| --- | ---: |
| Queued transition | 33 ms |
| Microphone permission | 2 ms |
| Suspending chat speech | 306 ms |
| Call service | 22 ms |
| Credentials | 72 ms |
| SDP offer | 90 ms |
| Session creation | 1,598 ms |
| Peer negotiation | 1,305 ms |
| Native audio-device setup | 130 ms |
| First capture, measured from request | 3,771 ms |
| Listening, measured from request | 3,791 ms |

Negotiation and sideband attachment overlap, so these intervals must not all be
added together. This trace has no multi-second queued transition. An earlier
13,150 ms trace spent 5,482 ms before native media setup and 5,422 ms creating
the session; that older trace did not identify its backend. Its pre-media wait
cannot be attributed to HTTP client creation. The new client-construction timer
measured 0–1 ms in host API tests; that is not a phone measurement.

These calls do not establish a before/after speed improvement. They use
different backends and network conditions. The playout corrections address
missing audio, while the client-stage timers separate local waits from network
and server time.

With the reliable-media/caption APK
`392faf1a4b8b54fbd90ab55cacb99c1416b812bffccecc1ec4434e2a77cf8ec6`,
the first GPT-Live call reached Listening in 3,908 ms. Its queued transition was
40 ms, speech suspension 95 ms, call service 91 ms, session creation 2,199 ms,
and peer negotiation 966 ms. The user confirmed that this call heard speech,
spoke smoothly, and highlighted captions. This verifies the audio correction;
it does not demonstrate a cold-start speed improvement.

The next Realtime API call in the same app process reached Listening in
5,096 ms after roughly three minutes idle. Its queued transition was 13 ms,
speech suspension 74 ms, session creation 2,318 ms, and peer negotiation
2,164 ms. Sideband attachment took 2,416 ms in parallel with negotiation;
settings confirmation arrived after media input had already started. The user
confirmed smooth, complete speech. These traces show that startup latency
remains in session/network setup even after the audio correction.

In the measured build above, Listening/first-input is not the end of the ready cue. The native microphone
temporarily uploads silence while that cue plays, preventing the cue from
triggering a response. In these two calls capture resumed 1,472 ms and
1,445 ms after cue suppression began, respectively: about 5.44 seconds from
the Live request and 6.62 seconds from the Realtime request. Those are the
appropriate endpoints when measuring acceptance of speech after the cue.

The subsequent ready-cue fix removes this microphone gate. It mixes the same
tone into native device output and feeds that mix to the echo canceller, while
keeping capture active. First-input readiness no longer has a further
cue-duration-plus-tail wait. The historical numbers above remain the baseline;
session creation and media negotiation are separate remaining startup costs.

## Installed ChatGPT Android app

Inspected version `1.2026.300` (version code `2630015`) and captured one
user-started call with Perfetto, touchscreen events and a screen recording.
The ChatGPT process was already running. Perfetto clock snapshots aligned the
touchscreen's monotonic timestamps with the trace's boot-time clock.

| Event | Time after voice-button touch release |
| --- | ---: |
| ChatGPT audio-recording Java thread first runs | 56 ms |
| Android audio service receives `AudioRecord.start` | 988 ms |
| Audio service finishes `AudioRecord.start` | 1,181 ms |

Whip's closest corresponding metric, logged after `AudioRecord.startRecording()`
returns, averaged 1,817 ms on its two repeated calls. That is a different endpoint
from first capture or first RTP input. The apps were measured at different times
with different instrumentation, so the difference cannot be assigned precisely
to a particular optimization.

Verified differences and limits:

- ChatGPT's native WebRTC factory constructs a `livekit.org.webrtc.Environment`
  with DTLS 1.3, SNAP and SPED enabled. Whip currently enables DTLS 1.3/Auto,
  SNAP and a pre-negotiated data channel, but does not implement SPED. This
  establishes the inspected client configuration, not the features negotiated
  in every call. [OpenAI's WARP guide](https://developers.openai.com/api/docs/guides/realtime-webrtc-warp)
  documents how these features reduce connection round trips.
- ChatGPT's network and worker threads were active at least 122 seconds before
  the captured voice tap. This establishes an already-active RTC runtime, not a
  pre-established server session or media connection. Whip's repeated SDP-offer
  creation took only 6–7 ms, so factory reuse alone cannot explain the full gap.
- The APK contains voice-prewarm telemetry, including an instant-connect prewarm
  path and dedicated prewarm-request timing data. This capture did not establish
  whether that feature was active. The APK also has a separate Codex/Orbit voice
  preparation owner; its presence does not establish use by ordinary ChatGPT
  voice calls.

ChatGPT's first RTP packet and individual server-request phases were not
measured. The actionable follow-ups are to measure Whip's HTTP construction and
network/server phases separately, add SPED support, and investigate overlapping
native preparation with negotiation. ChatGPT's private prewarm paths should not
be assumed to have equivalent public API lifecycle or billing behavior.
