Whip Android performance measurement — September 16, 2026 (host date)

Measured the installed Whip 1.7.0 (versionCode 221, non-debuggable) on a USB-connected Pixel 9 Pro running Android 17. The main finding is high sustained JavaScript CPU use and delayed terminal updates during live output and tab switching. The resting host list also does substantial rendering work.

| Measurement | Live terminal, 30 s | Terminal tab switching, 30 s | Resting host list, 20 s |
| --- | ---: | ---: | ---: |
| Whip process CPU, percent of one core | 176.33% | 197.68% | 65.05% |
| JavaScript thread CPU | 79.05% | 87.18% | 4.41% |
| RenderThread CPU | 50.96% | 60.12% | 36.94% |
| Main/UI thread CPU | 14.04% | 14.17% | 15.38% |
| App surface frames | 2,424 | 3,121 | 1,210 |
| App deadline misses | 23 (0.95%) | 6 (0.19%) | 4 (0.33%) |
| App FrameTimeline duration, p95 | 14.33 ms | 12.22 ms | 16.07 ms |
| Whip resident memory during capture | 737–794 MiB | 746–801 MiB | 453–469 MiB |

CPU is scheduled time divided by capture duration; 100% means one fully occupied core. Whip process CPU excludes the separate WebView renderer and system compositor. The WebView sandbox process observed during the terminal captures used another 25.76% and 23.08% of one core respectively; attribution is by process name, not a verified parent relationship. The host-list measurement followed a fresh process start, whereas the terminal measurements used the existing long-lived session, so their memory difference is not evidence of a leak.

Terminal latency from Whip's async markers:

| Interval | Live median / p95 / max | Switching median / p95 / max |
| --- | ---: | ---: |
| JS inbound frame to visible acknowledgement | 46 / 151 / 632 ms | 40 / 494 / 754 ms |
| WebView injection to entry acknowledgement | 16 / 64 / 632 ms | 13 / 475 / 735 ms |
| Rust inbound frame delivery callback | 1.32 / 104 / 624 ms | 1.05 / 386 / 733 ms |
| xterm write acknowledgement | 0.11 / 14.83 / 125 ms | 0.13 / 14.37 / 548 ms |
| Resize dispatch to visible acknowledgement | 68 / 195 / 481 ms | 69 / 636 / 1,051 ms |
| Tab selection to renderer entry | No samples | 364 / 471 / 478 ms |

There were 515 completed inbound-to-visible samples during live output and 582 during switching, with one additional sample incomplete at capture end. Ten coordinate taps on existing terminal tabs produced eight tab-selection spans. No terminal text or commands were injected. Tab positions can move, so the result describes observed tab selections, not ten verified switches between a fixed pair of tabs. There were no renderer-readiness spans establishing cold renderer creation in this capture.

The JavaScript thread spent 23.72 of 30.01 seconds running during live output and another 4.39 seconds runnable but waiting for CPU. During switching it spent 26.16 seconds running and 2.54 seconds runnable. This strongly suggests local JavaScript work and scheduling pressure are material contributors to the delays. Exact JavaScript functions were not sampled, so the trace does not establish a particular component or function as the cause. The measured JS decode and synchronous renderer dispatch stages were short (p95 below 0.1 ms); most measured tail latency lies around callback delivery and WebView acknowledgement. These intervals overlap and their percentiles must not be added.

FrameTimeline reported buffer stuffing on 470/2,424 live frames (19.39%, including one mixed classification) and 1,808/3,121 switching frames (57.93%). This describes queued frames and increased latency, and must not be reported as the dropped-frame percentage. App deadline misses are listed separately above. See [Perfetto's FrameTimeline definitions](https://perfetto.dev/docs/data-sources/frametimeline). FrameTimeline duration is not a terminal response-time measurement.

Cold startup measurements, from one 55-second trace containing three force-stop/relaunch cycles:

| Milestone, measured from Android launch start | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Android startup display milestone | 340 ms | 302 ms | 271 ms |
| First app tab committed | 2,059 ms | 2,062 ms | 1,944 ms |
| Live-host restoration completed | 3,346 ms | 3,615 ms | 3,265 ms |

The in-app `Whip startup to first tab` span itself was 476–535 ms, but starts after runtime initialization; reporting it alone would understate launch-to-content time. Storage multi-get took 226–277 ms. The live-host restoration span took 897–1,139 ms; its SSH-connect stage had a median of 730 ms and maximum of 968 ms. These are three process-cold starts with OS caches retained, not cold-boot tests.

The post-switching `dumpsys meminfo` snapshot reported 781.4 MiB total PSS, 847.5 MiB total RSS, and 105.2 MiB swap PSS. The resting-host-list snapshot reported 387.0 MiB PSS and 511.6 MiB RSS. These later snapshots are separate from Perfetto's sampled RSS ranges. A single chat-cache-persist async span lasted 5.17 seconds; this is elapsed operation time, not evidence of a five-second main-thread block.

The next investigations supported by these measurements are:

1. Sample the JavaScript thread during live terminal output and repeated tab selection to identify the work behind the 79–87% core utilization.
2. Inspect callback queueing and acknowledgement scheduling around the 475 ms WebView-delivery p95 during switching.
3. Profile continuous rendering on the resting host list: it submitted about 60 app frames/second and used 37% of a core in RenderThread even with only 4.4% JavaScript CPU. Background visuals and ongoing status animation are candidates, not proven causes.
4. Investigate runtime initialization before the first-tab span if reducing the approximately two-second launch-to-content time is a priority.

Measurement conditions and limits:

- Used `nix develop`, adb, the existing `scripts/capture-android-perfetto.sh`, device Perfetto v54.0, and host Trace Processor v57.2.
- USB charging; Android thermal status 1 (LIGHT) before and after testing. Existing background apps, network traffic, and screen visuals were retained. This is a real-device snapshot, not a controlled performance regression benchmark.
- Captured live output already present in the app, existing-tab navigation, three process restarts, and an untouched host-list interval. No reinstall, data clearing, rotation changes, or synthetic remote commands were used. Whip was left on its host list.
- Follow-up APK inspection identified embedded commit `52ab702943b6bf4e37e5277e07f55d8a1b30b389` and verified that its terminal HTML matches the checkout. Existing local source changes were not built or changed for this measurement.
- The main statistics queries reported no nonzero error/data-loss-severity entries. An additional buffer-health query reported 3, 4, and 5 discarded trace chunks in the live, switching, and startup captures respectively; therefore these are not claimed to be perfectly lossless traces. All three startup sequences and the expected capture durations were present.
- The capture itself adds overhead: `traced_probes` consumed about 10–14% of one core in the terminal/idle captures. No untraced control was recorded.
- Visible acknowledgements include React Native callback scheduling and two animation-frame boundaries; they are not hardware display timestamps. Rust callback duration is not network RTT. No keystroke-to-visible latency or battery-drain rate was measured.

Local raw evidence is under `artifacts/perfetto/measurement-20260916/` (gitignored):

- `live-terminal.perfetto-trace`
- `tab-switching.perfetto-trace`
- `cold-starts.perfetto-trace`
- `host-list-idle.perfetto-trace`
- Matching `*-results.json`, `details.json`, memory snapshots, startup command output, and screenshots.
- `overview.sql`, `analyze.py`, and `details.py` contain the analysis queries. `overview.sql` contains multiple result sets and is run through `analyze.py`; the current trace-processor CLI rejects it as a single multi-result query.

Open a trace in [Perfetto UI](https://ui.perfetto.dev). To rerun the local analysis with the existing v57.2 executable:

```bash
nix develop -c uv run --no-project --with perfetto python \
  artifacts/perfetto/measurement-20260916/analyze.py \
  live-terminal tab-switching cold-starts host-list-idle
```

Comparison with previous measurements

The latest earlier Perfetto capture on disk is `terminal-callback-rust-base64-active.perfetto-trace`, modified August 27, 2026. It records build 216 on a Pixel 9 Pro / Android 17 for 45 seconds. The same SQL and Trace Processor version were applied to both traces; the current comparison uses the 30-second live-terminal capture, excluding deliberate tab switching.

| Metric | August 27, build 216 | September 16, build 221 | Observed change |
| --- | ---: | ---: | ---: |
| Inbound-to-visible median | 38.95 ms | 46.21 ms | +19% |
| Inbound-to-visible p95 | 55.43 ms | 150.55 ms | 2.72× |
| Inbound-to-visible maximum | 73.58 ms | 632.11 ms | 8.59× |
| WebView delivery p95 | 21.37 ms | 63.66 ms | 2.98× |
| Rust frame delivery p95 | 14.39 ms | 104.36 ms | 7.25× |
| JavaScript CPU, one-core percentage | 54.31% | 79.05% | +24.74 percentage points |
| Whip process CPU, one-core percentage | 84.19% | 176.33% | 2.09× |
| Completed inbound-to-visible samples/second | 6.16 | 17.16 | 2.79× |
| App surface frames/second | 6.02 | 80.78 | 13.41× |

The current run has worse measured tail latency and higher CPU, but workloads and rendering behavior differ substantially. These data do not establish a build regression. The older terminal activity spans the whole capture, not a short foreground interval. The current run also settles over time: its last five seconds have a 55.55 ms inbound-to-visible p95, close to the previous run's 55.43 ms overall p95. The prior trace reports 56 discarded chunks, versus three in the current live capture. Different trace instrumentation versions are another limit on exact cross-build attribution. There is no equivalent tab-switch selection sample in this latest earlier trace.

The last dedicated startup capture found is `whip-cold-start-storage-bootstrap-repeat-20260824.perfetto-trace` (August 24, build 215; one startup). Launch-to-first-tab was 1.554 seconds, versus a current median of 2.059 seconds across three starts: about 32% slower in these samples. Launch-to-live-host-restored was 5.116 seconds, versus a current median of 3.346 seconds: about 35% faster. Host/network state and historical thermal conditions were not controlled, so these are observed differences rather than isolated code effects.

The latest memory baseline is newer than those Perfetto traces: `.codex-diagnostics/phone-20260914/memory-build220-fresh/summary.json`, captured September 14 at 09:46 UTC with Whip 1.0.2 build 220. This supersedes the earlier build-219 figures documented in `android-memory-profiling.md` for purposes of comparing with the last capture. Compare its three-sample main-process median with the current post-terminal-switch snapshot:

| Main-process memory | September 14, build 220 median | Current build 221 snapshot |
| --- | ---: | ---: |
| Native heap allocated | 356.8 MiB | 348.5 MiB |
| Reported PSS | 628.8 MiB | 781.4 MiB |
| RSS | 787.6 MiB | 847.5 MiB |
| SwapPSS | 9.8 MiB | 105.2 MiB |

Native heap allocated is about 2.3% lower, while reported PSS is 24% higher, RSS 7.6% higher, and swap substantially higher. Both snapshots report one live WebView in the main process, but the earlier build was fresh and the current terminal process was long-lived; the exact screen/history/workload was not matched. The comparison therefore does not demonstrate either a memory regression or an improvement from the retention changes. PSS already includes swap on this inspected Android build, so the columns must not be summed. The current fresh-host-list snapshot (123.6 MiB native allocation) is a different state and should not be substituted for the current terminal value.

Historical query outputs and five-second workload checks are saved locally as `previous-results.json` and `comparison-windows.json` alongside the current traces.

Follow-up [Perfetto and code analysis](android-performance-bottlenecks-2026-09-16.md) isolates a large animation cost and identifies a resize/refresh/reactivation feedback path. That path can itself provoke terminal output, so the historical update-count ratio is not independent evidence of a heavier external workload.
