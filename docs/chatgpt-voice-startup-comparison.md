# ChatGPT Android voice startup comparison

The microphone-acquisition change is committed on main as `e5f425e0` and was
installed before this comparison. The connected Pixel 9 Pro has ChatGPT
`1.2026.300` (version code `2630015`). Its installed base APK SHA-256 matches the
previously inspected APK:
`38b17d766429d2ac7aa396f7ae2ec87182b1f581777dbb8f2089f6581458b148`.

## Fresh phone measurements

Three silent ChatGPT calls were started and ended in one already-running app
process. Perfetto records the actual motion-event UP dispatch to ChatGPT and
Android's `IAudioRecord.start` operation on the same boot-time clock. This
avoids assuming that a host tap command arrived immediately. The third gesture
was dispatched about half a second after its host command, making the device
input timestamps necessary.

| ChatGPT trial | Record thread first scheduled | Microphone-start request | Microphone start completed | Native start operation |
| --- | ---: | ---: | ---: | ---: |
| 1 | 101 ms | 1,392 ms | 1,406 ms | 14 ms |
| 2 | 41 ms | 1,545 ms | 1,565 ms | 20 ms |
| 3 | 64 ms | 774 ms | 786 ms | 12 ms |

All durations start at motion-event UP dispatch. They measure microphone
startup, not the first transmitted RTP packet, server readiness, or first
spoken response. The visible orb is not used as proof of media readiness.

Whip's installed early-acquisition build opened its microphone in 654–1,517 ms
across six calls. Its timer starts at the app's call request and is logged after
`AudioRecord.startRecording()` returns, so it is a close but not identical
endpoint to ChatGPT's audio-service completion. Different routes, scheduling
and measurement times also limit comparison. These samples put microphone
startup in a similar range; they do not show a remaining multi-second Whip
microphone-initialization penalty.

Whip's first-RTP/Listening times remained 2,545–5,166 ms. Its session POST took
893–3,580 ms and peer negotiation 677–981 ms. Repeat calls also spent up to
977 ms queued before setup; suspending existing chat speech took 288–412 ms.
Those local waits and connection phases remain relevant after microphone
acquisition was moved earlier. [Whip's raw phone timings](voice-early-microphone-profile.json).

## Implementation evidence

ChatGPT's existing network/worker threads were scheduled about 183 seconds
before the first measured voice tap. This demonstrates an already-active RTC
runtime. It does not establish a pre-existing server session, selected ICE pair,
or connected media transport.

The matching APK's native factory initialization uses the DTLS 1.3, SPED and
SNAP field trials. Whip's str0m configuration enables DTLS Auto/1.3, SNAP and a
pre-negotiated data channel in the measured build, which did not implement SPED.
A subsequent [Rust SPED implementation and local benchmark](voice-sped.md)
does not establish equivalent device-level startup results. OpenAI documents that
these optimizations reduce connection round trips and can be enabled
individually. A configured feature is not proof that it was negotiated on every
call. [Official WARP guide](https://developers.openai.com/api/docs/guides/realtime-webrtc-warp).

The regular-voice preparation path is more than an HTTP-client cache. Targeted
inspection of the matching APK shows:

- The voice owner's `z571.O` builds preparation parameters marked
  `instant_connect=1` and submits a preparation intent to the transceiver engine.
- `wx21.n` retains an `iw21` transport owner in its state. It creates an owner
  when absent, checks the requested identity against retained state, and has
  distinct preparation (`fy21`) and actual-call (`cy21`) branches. A matching
  subsequent call can therefore use retained transport state.
- The explicit instant-connect miss reasons include expired/empty/mismatched
  transport state and failed prefetch. Eligibility/context reasons include app
  visibility, disabled prefetch, recent voice use, an already-active call, and
  changes to conversation, model, language, voice and privacy parameters.

This establishes support for prepared session/transport reuse rather than just
retaining a client object. Runtime cache-hit state and encrypted request timings
were not observable in this capture, so it does not prove that preparation
shortened these particular calls. The separate Codex/Orbit preparation path
must not be treated as evidence about ordinary ChatGPT voice calls. JADX could
not reconstruct every coroutine in the large classes; these observations use
the explicit preparation dispatch, retained-owner branch and enum definitions,
with the factory field trials also checked against the cached Smali export.

A compiled ChatGPT realtime URL is `https://android.chat.openai.com/realtime/`.
Whip uses the public `/v1/live/sessions` and `/v1/realtime/calls` endpoints.
The compiled URL establishes a separate app integration; it does not identify
the exact request or backend allocation time in these calls. ChatGPT's private
prewarm lifecycle cannot be assumed to be a public API feature with identical
configuration, accounting, or reuse rules.

Whip prefers TCP candidates, retaining UDP fallback, because earlier API tests
found audible gaps on the affected UDP path. The inspected ChatGPT factory uses
libwebrtc. Android socket inspection lacked reliable UID attribution and this
trace did not contain packet records, so the selected ChatGPT media protocol
was not established. Restoring UDP preference solely from a latency comparison
would ignore the existing reliability evidence.

## What the evidence supports

The strongest remaining implementation gap is SPED and the possibility of a
prepared connection/session path. Neither alone has been measured to explain
the whole latency difference. Whip's microphone now starts early enough that
further device-start optimization is unlikely to remove its remaining public
session POST and negotiation waits.

The next useful measurements are Android DNS/connect/TLS/response-header
breakdown for the session POST and the owners of the queued-transition and
speech-suspension waits. The HTTP client pool is already reused; constructing
another client earlier is not equivalent to preparing a connected session.
Transport work should add/adopt SPED and compare candidate policies under both
latency and audible-playback checks. Any prepared-session design needs explicit
ownership, retirement and accounting behavior rather than assuming ChatGPT's
private implementation can be copied directly.

No microphone content, credentials, private app storage or decrypted requests
were collected. All profiling calls were ended. Numeric evidence is in
[the comparison profile](chatgpt-voice-startup-comparison.json); raw local trace
and APK-derived artifacts are under `build/chatgpt-startup-comparison` and
`build/chatgpt-startup-analysis`.
