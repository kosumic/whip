60 FPS spinners versus August — September 17, 2026

The new busy-terminal capture has **lower average and median frame-to-visible acknowledgement latency, similar p95, and higher worst-case latency** than August. Whip process CPU is 5.1% higher in these observations. JavaScript CPU fell substantially; RenderThread is now the largest app thread cost. These are historical build observations with different workloads, not an isolated benchmark of the spinner toggle.

The user enabled **60 FPS spinners** and prepared a busy terminal. Recorded 45 seconds on the USB-connected Pixel 9 Pro / Android 17 without injecting input or navigating during capture. Whip remained foregrounded; Android thermal status was 0 before and after. The August 27 baseline is `terminal-callback-rust-base64-active.perfetto-trace`, build 216, also 45 seconds. Both raw traces were analyzed again with the same `overview.sql` and Trace Processor v57.2.

| Metric | August 27 | September 17, busy terminal, 60 FPS spinners |
| --- | ---: | ---: |
| Capture duration | 45.00 s | 45.02 s |
| Completed inbound-to-visible acknowledgements | 277 | 748 |
| Inbound-to-visible acknowledgement, average | 39.29 ms | 35.81 ms |
| Inbound-to-visible acknowledgement, median | 38.95 ms | 31.45 ms |
| Inbound-to-visible acknowledgement, p95 | 55.43 ms | 54.74 ms |
| Inbound-to-visible acknowledgement, maximum | 73.58 ms | 172.84 ms |
| WebView entry acknowledgement, p95 | 21.37 ms | 22.67 ms |
| Rust frame-delivery callback, p95 | 14.39 ms | 6.23 ms |
| Whip process CPU, percent of one core | 84.19% | 88.52% |
| JavaScript CPU, percent of one core | 54.31% | 8.58% |
| RenderThread CPU, percent of one core | 3.65% | 43.94% |
| Main-thread CPU, percent of one core | 12.00% | 12.83% |
| Fit resize spans / ordinary native resize dispatches | 278 / 278 | 0 / 0 |
| App surface frames | 271 | 2,954 |
| App surface frames per second | 6.02 | 65.62 |
| App deadline misses | 0 | 34 (1.15%) |
| App FrameTimeline duration, p95 | 16.56 ms | 14.98 ms |
| Renderer-bound payload counters / bytes | 278 / 15,221,612 | 750 / 214,455 |

Average acknowledgement latency fell 8.9%, median fell 19.3%, and p95 fell 1.2%. The maximum rose 2.35×; the current trace also has more samples. Only one current acknowledgement exceeded 100 ms (also the only one over 150 ms), versus none in August. The five-second current windows had p95 values between 49.79 and 57.68 ms. One August acknowledgement and two current acknowledgements were incomplete at capture end; none exceeded the query's nine-second timeout threshold.

The current trace delivers 2.7× as many acknowledged terminal updates, but much smaller payloads (about 214 KB versus 15.2 MB total). More frequent updates do not establish a heavier workload. The absence of ordinary resize spans is consistent with the resize-loop fix; historical resize-driven output can itself inflate traffic.

Rendering is the largest remaining measured app cost: RenderThread accounts for 43.94 of 88.52 one-core percentage points. This capture does not isolate the cause of the increase versus August or the incremental cost of choosing 60 instead of 30 FPS. August's app surface cadence was only about 6 FPS. The current decorative setting limits spinner updates, not the app surface rate; terminal output and other activity can push total rendering above 60 FPS.

FrameTimeline classified 157 current frames as Buffer Stuffing (5.31%). This describes queued buffers, not dropped frames. The 34 app deadline misses are reported separately. Neither capture measures battery power, and Whip process CPU excludes the separate WebView renderer and system compositor. Trace collection itself used 9.41% (August) and 13.28% (current) of one core in `traced_probes`.

Build and capture limits:

- The current build contains the resize-loop fix and the spinner toggle subsequently committed as `d2a14ff`. It is an upload-signed arm64 release installed in place, built with `whip.skipR8=true` for local testing. Its SHA-256 matches the installed base APK: `5f62ae82f3960648604a5ec8e2049921bd5176914ede2520222ce20d75560424`.
- Build configuration, historical instrumentation, thermal/display behavior, process lifetime, and unmatched remote output limit attribution to individual changes. The user reported the 60 FPS setting enabled; no setting was changed during these captures.
- The traces returned no nonzero error/data-loss-severity statistics. They reported 56 (August) and 25 (current) informational discarded chunks, so neither is claimed perfectly lossless.
- Visible acknowledgement includes React Native scheduling and the WebView acknowledgement return path, not a hardware pixel timestamp. Callback timing is not network RTT. No correlated input-to-visible samples were recorded, so the README's historical 120.60 ms average input-to-visible number has not been remeasured.

An earlier quiet-terminal capture from this session produced only three terminal updates in 44.98 seconds. It rendered 2,695 app frames (59.92 FPS), used 58.00% of one core overall and 40.16% in RenderThread, and recorded eight app deadline misses. Its 52.90 ms average / 57.14 ms p95 acknowledgement values are too sparsely sampled to serve as the latency comparison. It is retained as quiet-state evidence, not substituted for the busy run above.

Evidence is gitignored under `artifacts/perfetto/spinner60-20260917/`: `busy-terminal.perfetto-trace`, the earlier `live-terminal.perfetto-trace`, analysis results for both and August, summary JSON, capture logs, foreground/thermal records, installed APK hash, provenance, and `analyze.py`.

```bash
nix develop --command uv run --no-project --with perfetto python \
  artifacts/perfetto/spinner60-20260917/analyze.py \
  artifacts/perfetto/terminal-callback-rust-base64-active.perfetto-trace \
  artifacts/perfetto/spinner60-20260917/busy-terminal.perfetto-trace
```
