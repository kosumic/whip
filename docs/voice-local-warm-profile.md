# Local voice preparation: phone measurements

Measured on 2026-11-06 using the user's installed Pixel 9 Pro build, Android SDK
37, arm64. APK SHA-256:
`7ac5869e0f1013973e3788f5f867362bb021c65ec5c2086c9592692740bfb60e`.
The exact source snapshot was not identified. The user confirmed that this newer
installed build contains the preparation changes. All measurements used the same
Whip process, PID 17608; the app was not restarted. These are startup measurements
in an existing process, not controlled fresh-process cold-start measurements.

All 14 calls reached microphone upload and session-settings confirmation, then
completed shutdown. Each enabled trial logged `preparedClient=1`; each disabled
trial logged `preparedClient=0`. Trial 7 verified Realtime startup after at least
65 seconds of prepared idle time. No negotiation failure occurred in this run.
Speech quality and caption highlighting were not evaluated by these startup tests.

Later investigation found that this measured build could show GPT-Live Listening
before `session.started`. The times below describe that build's UI transition,
not proof that opening speech would be accepted. The readiness correction now
requires session confirmation before showing Listening; these historical figures
must not be used as post-fix readiness measurements.

| Mode / preparation | Calls | Median local peer + offer | Median session POST | Median Listening |
| --- | ---: | ---: | ---: | ---: |
| GPT-Live / off | 5 | 12 ms | 2,395 ms | 3,621 ms |
| GPT-Live / on | 5 | 8 ms | 899 ms | 2,117 ms |
| Realtime / off | 2 | 11 ms | 2,210 ms | 3,236 ms |
| Realtime / on | 2 | 9.5 ms | 2,192 ms | 3,404.5 ms |

GPT-Live used Marin. Realtime used GPT Realtime 2.1 Mini and Marin. Listening is
measured from the JS call request to first uploaded microphone RTP; it excludes
the model's first reply. Settings confirmation can follow Listening. The full
timing fields and individual trials are in
[voice-local-warm-profile.json](voice-local-warm-profile.json).

Across modes, local setup medians were 12 ms off and 8 ms on. Excluding the first
observed call gives 10 ms off and 8 ms on. Small sequential samples and scheduling
noise prevent a precise causal estimate. The large GPT-Live total-startup
difference coincided with a 1,496 ms difference in median session POST time, which
local crypto preparation does not skip. Realtime showed no total-startup
improvement. These results do not support a seconds-scale benefit from this
local-only toggle.

The first observed GPT-Live call took 6,555 ms to reach Listening, including a
5,483 ms session POST and 70 ms local setup. It was already in a running process.
Enabled GPT-Live calls ranged from 1,764 to 3,705 ms. Session POST and subsequent
negotiation remain the dominant startup work.

Idle memory was sampled in on/off/off/on order, three samples per block, without
starting any calls during capture. Both conditions had already used the shared
HTTP client and audio libraries. Android `dumpsys meminfo` may request GC.

| Main-process memory | Off median | On median | On minus off |
| --- | ---: | ---: | ---: |
| Native heap allocated | 1,609,620.5 KiB | 1,609,767.5 KiB | +147 KiB |
| Resident memory (RSS) | 1,900,102 KiB | 1,897,254 KiB | −2,848 KiB |

The native-allocation ranges overlap: off 1,607,726–1,610,276 KiB, on
1,606,841–1,612,995 KiB. The measured delta is below whole-process fluctuation;
147 KiB is not an isolated allocation count for the cached object. Likewise, the
lower RSS median does not establish memory savings. Associated WebView samples
are retained separately in the JSON; reported PSS and SwapPSS must not be added.

The preparation measured here retains local crypto material and initializes the
shared HTTP client. It keeps no provider session, microphone, negotiated peer,
SDP, ICE state or socket open while idle. Provider session creation still occurs
on Call. Unlike the rejected whole-peer prototype, a new peer and sockets are
created for every call.

This profile predates the anonymous HTTPS preparation added after #379. Current
behavior also keeps the HTTP pool warm while foregrounded; these measurements
do not establish the performance or memory cost of that addition.

Private raw logs, screenshots and memory dumps are under
`build/local-factory-profile/`. Testing ended with all calls closed, GPT-Live /
Marin selected and local preparation enabled. No commit was made.
