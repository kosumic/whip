# Android performance measurements

On October 1, 2026, a twenty-second capture of the tested ARM64 Android release
on a Pixel 9 Pro measured **31 ms median terminal output display latency** and
**60 ms at p95**, with live output and existing conversation history. The
JavaScript thread used 8% of one CPU core on Terminal and 14% on More while a
terminal remained connected in the background.

Display latency starts when output reaches the phone and ends at the terminal's
visible acknowledgement; SSH round-trip time is separate. Results depend on
the device, connection, and workload. See the
[performance report](android-performance-regression-2026-10-01.md) for exact
values, build conditions, the regression comparison, and validation.

### Earlier measurements

Whip's terminal latency is instrumented with correlated Android Perfetto slices
from native input handling through confirmed WebView presentation. August 27,
2026 release-build captures on a Pixel 9 Pro connected to the `thinker` host
produced the following baseline. The end-to-end capture contains 20 correlated
keystrokes; a subsequent passive capture covers 277 frames after terminal
encoding moved off the JavaScript thread. Network conditions, remote output, and
display scheduling vary, so treat these as representative observations rather
than universal benchmarks.

Release builds also retain a bounded history of the latest 500 SSH latency probes
that take at least 200 ms or fail. Each slow record separates the native SSH
ping/pong time from total JavaScript dispatch-to-resolution time. The history is
available in **More → Diagnostics**, persists across app restarts, and is never
uploaded automatically.

| Stage | Average | p50 / p95 | Observed range | Samples |
| --- | ---: | ---: | ---: | ---: |
| App wait before entering native code | 0.03 ms | 0.02 / 0.08 ms | 0.01–0.09 ms | 20 |
| Native/Rust validation, framing, and queueing | 0.19 ms | 0.11 / 0.42 ms | 0.03–1.12 ms | 20 |
| Complete React Native input-to-native dispatch | 0.39 ms | 0.27 / 0.75 ms | 0.12–1.38 ms | 20 |
| Queue accepted to first returned terminal frame | 84.76 ms | 61.68 / 212.60 ms | 0.15–343.80 ms | 20 |
| Returned frame to confirmed visible | 35.45 ms | 31.78 / 58.52 ms | 20.16–106.06 ms | 20 |
| Complete input to confirmed visible | 120.60 ms | 92.66 / 243.26 ms | 39.60–375.17 ms | 20 |

[![Android terminal input latency waterfall](android-terminal-input-latency.svg)](android-terminal-input-latency.svg)

The first three rows overlap and must not be added together. The final three
rows form the measured average critical path: 0.39 ms of local dispatch, 84.76
ms from native queue acceptance to the first returned frame, and 35.45 ms from
that frame to the conservative visibility marker. The queue-to-response span
includes SSH/network time, remote PTY processing, and inbound native delivery;
because the protocol cannot identify causality, unrelated terminal output can
also satisfy the first-frame marker.

Warm renderers and retained terminal bridges avoid cold attach work. In the
August passive post-change capture, 277 frames took 39.29 ms on average from Rust
frame delivery to the visibility marker (p50 38.95 ms, p95 55.43 ms, observed
range 19.09–73.58 ms). See [Android terminal latency
tracing](android-performance-tracing.md) for the slice definitions,
capture command, SQL analysis, and interpretation.

A September 17, 2026 passive capture on the same Pixel 9 Pro, with **60 FPS
spinners enabled** and the redundant resize loop fixed, recorded 748 completed
terminal updates over 45 seconds. **Median latency was 19% lower, while p95
was essentially unchanged:**

| Metric | August 27 | September 17 |
| --- | ---: | ---: |
| Inbound frame to visible acknowledgement, median | 38.95 ms | 31.45 ms |
| Inbound frame to visible acknowledgement, p95 | 55.43 ms | 54.74 ms |
| Inbound frame to visible acknowledgement, average | 39.29 ms | 35.81 ms |
| Whip CPU, percent of one core | 84.19% | 88.52% |
| JavaScript CPU, percent of one core | 54.31% | 8.58% |
| RenderThread CPU, percent of one core | 3.65% | 43.94% |

One of the 748 current acknowledgements exceeded 100 ms (0.13%), reaching
172.84 ms; none of August's 277 exceeded 100 ms. The cause of this isolated
observed stall has not been established. Median and p95 describe typical and
tail latency; rare stalls are tracked separately because p95 can hide them.

Total app CPU was 5% higher, with rendering now the largest thread cost.
The newer capture had more frequent but much smaller terminal updates, and
rendered 65.6 app frames/second versus August's 6.0.
The current local release skipped R8 optimization. These workload, rendering,
and build differences prevent attributing the comparison to a single change.
No ordinary native resize dispatches were recorded, versus 278 in August.
The historical input-to-visible table above has not been remeasured; this
passive comparison covers returned terminal frames only. See the
[60 FPS comparison report](android-60fps-august-comparison-2026-09-17.md)
for capture conditions, deadline misses, and raw-evidence locations.
