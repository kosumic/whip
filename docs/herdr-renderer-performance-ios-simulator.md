# Herdr renderer performance: iOS simulator

This is the original row-picture baseline. See the
[retained-pixel and changed-span rerun](herdr-renderer-performance-dirty-regions-ios-simulator.md)
for the current implementation and updated results.

Validation correction: the original Skia `seq 1 100000` workload did not run.
Ctrl/Alt bits were reversed, so Ctrl-U left the preceding typing text in the
command line. The old substring completion check also matched command echo.
Discard that Skia burst row; it is marked invalid below. The continuous and
Unicode generators ran successfully and remain useful before measurements.

Measured on 2026-10-27. This prototype submits its first frame sooner and uses less
client memory than xterm.js, but full-screen redraws cost about 2.4× as much client
CPU and 8.7× as many SSH download bytes while submitting fewer updates. Keep
xterm.js as the default. These are simulator results, not physical-device results.

## Environment and method

- Apple M4 Mac mini, 10 CPU cores, 16 GiB RAM; Darwin 25.6.0. No thermal or
  performance warning was reported by pmset. Other host activity was not suspended.
- iPhone 17 Pro simulator, iOS 26.5; Xcode 27.1; thin arm64 Release native app and
  production Metro bundle. Skia 2.14.0, current shared fonts and Tokyo Night colors.
- Herdr 0.9.1 in a dedicated process/socket, through an isolated loopback SSH daemon.
  Both renderers use the same pane and actual 80×24 cell grid, JetBrains Mono size 8.
  Each renderer retains its normal device-pixel rounding; rasterization is not pixel-identical.
- Three **fresh app processes** per renderer, ordered xterm/Skia/Skia/xterm/xterm/Skia.
  Each table entry is the median of the three per-trial measurements.
- Client CPU and memory include the app plus its new WebKit WebContent, GPU, and
  Networking processes. All xterm trials had these three processes; Skia had none.
  Existing processes and the other booted simulator were excluded.
- CPU is percent of **one host core**, not percent of the whole 10-core machine.
  Host process CPU and thread CPU counters were normalized and independently
  checked against the OS process CPU clock. Memory is mean sampled physical
  footprint, sampled every 500 ms, not RSS or allocation count.
  Instruments Activity Monitor reported that its service was unavailable for
  this simulator, so process counters were read from the macOS host.
- SSH bytes are counted encrypted TCP payload in each direction, including
  management/events, excluding TCP/IP headers. The proxy is separate from timing telemetry.

## Client CPU and memory

| Workload | xterm CPU % | Skia CPU % | xterm RN JS-thread % | Skia RN JS-thread % | xterm MiB | Skia MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle shell | 0.31 | 2.52 | 0.01 | 1.27 | 235.5 | 169.6 |
| Typing | 17.50 | 9.07 | 1.42 | 3.75 | 220.2 | 169.9 |
| seq 1 100000 | 1.45 | invalid | 0.09 | invalid | 219.3 | invalid |
| Full-screen continuous redraw | 35.33 | 84.51 | 0.82 | 77.62 | 226.4 | 184.8 |
| CJK / combining / emoji redraw | 43.71 | 45.74 | 0.33 | 41.83 | 257.9 | 182.1 |
| vim cursor movement | 24.39 | 12.04 | 1.51 | 2.31 | 236.2 | 175.9 |
| Resize / hide / reattach | 14.91 | 13.52 | 0.82 | 10.02 | 248.3 | 176.0 |
| SSH disconnect / recover | 1.85 | 5.50 | 0.20 | 3.84 | 248.6 | 176.5 |

RN JS-thread CPU includes native Skia/JSI calls executed synchronously on that
thread. WebContent's JavaScript and native layout CPU are not split. During
continuous redraw, xterm's app used 6.13% and WebKit used 29.15%;
Skia's RN JS thread used 77.62% out of 84.51% client CPU.
Individual component medians need not sum exactly to the median total.

## Server CPU and SSH traffic

| Workload | Herdr CPU with xterm % | Herdr CPU with Skia % | Download to xterm KiB | Download to Skia KiB |
| --- | ---: | ---: | ---: | ---: |
| Idle shell | 0.64 | 0.70 | 0.0 | 0.0 |
| Typing | 1.47 | 0.86 | 6.5 | 3.9 |
| seq 1 100000 | 1.74 | invalid | 2.8 | invalid |
| Full-screen continuous redraw | 10.72 | 4.76 | 966.3 | 8443.5 |
| CJK / combining / emoji redraw | 4.76 | 2.68 | 1198.5 | 2959.6 |
| vim cursor movement | 2.03 | 1.06 | 5.9 | 7.2 |
| Resize / hide / reattach | 1.85 | 1.12 | 49.2 | 170.3 |
| SSH disconnect / recover | 0.83 | 0.91 | 26.3 | 81.2 |

These bytes cover each entire workload window, not one second. Continuous and
Unicode generators run for eight seconds; their windows include approximately
two additional seconds to settle. Exact durations and upload bytes are in the
[per-trial JSON](assets/herdr-renderer-benchmark-results.json).
Median continuous-redraw download rates were **94.8 KiB/s for xterm** and
**836.5 KiB/s for Skia**, computed per trial from the actual window durations.
Herdr CPU includes server terminal emulation and rendering, and excludes the
separate generator/shell processes. It is not included in client CPU.

The valid xterm seq burst is heavily coalesced by Herdr: only six submissions per
trial reached the client. It is not a test of parsing all 100000 original lines
on the phone. The original Skia burst is invalid and must not be interpreted as
a throughput measurement. Continuous full-grid redraw is the stronger client
throughput test here.

## Timing and update observations

| Observation | xterm.js | Skia |
| --- | ---: | ---: |
| Attach to first prepared/submitted frame, median | 640 ms | 267 ms |
| Attach to first two-animation-callback observation, median | 675 ms | 305 ms |
| Typing to next observation, median | 34 ms | 67 ms |
| Typing to next observation, per-trial p95 median | 67 ms | 84 ms |
| Prepared updates/s, continuous window | 40.1 | 15.9 |
| Prepared updates/s, Unicode window | 16.1 | 15.1 |

These timings are **proxies**, not compositor-visible latency or display FPS.
Attach timing starts after SSH/host readiness, and includes renderer/font startup.
It observes the first frame before grid feedback settles. The first trial starts
with a fresh pane; later attaches see retained pane contents. These are not
controlled cold-app-launch or empty-screen first-visible-frame measurements.
Typing is 30 printable input calls at nominal 200 ms intervals per trial, with no
other intended output; the next callback does not identify the echoed glyph.
It excludes OS keyboard dispatch.

Both observers are opt-in. xterm reports its write callback and two WebView
animation callbacks; Skia reports picture submission and two RN animation
callbacks. Observation adds per-frame JS messages to xterm's normally native
delivery path, and metadata callbacks to Skia. These measurements are instrumented
results and may affect absolute costs. Submission counts can coalesce or share a
display frame. Skia is capped at 30 presentation pulls/s; no sustained compositor
FPS was measured.

During continuous redraw, Skia picture preparation took a median
48.5 ms and a per-trial p95 median of 51.6 ms.
This exceeds a 30 Hz frame budget before other work. xterm's write callback
is not equivalent to its full native layout/paint cost, so those preparation
timings should not be treated as a complete rendering-cost ratio.

## Interpretation and limits

The current Skia implementation has a substantial full-grid cost on the RN JS
thread. It builds a paragraph per nonblank dirty cell and serializes full dirty
rows through JSON. The continuous trial transferred a median
22,994,700 UTF-16 bridge code units. The existing xterm native
path bypasses RN JS for cell output when benchmark observation is disabled.
The source and thread measurements point to paragraph batching/caching and a
more compact native bridge as the first areas to profile and improve. The wire
cost also motivates testing the optional negotiated surface codecs. None of
those optimizations were applied during this comparison.

There are wins: lower footprint, faster observed attach, and lower total client
CPU during typing and cursor-only vim interaction. Those do not offset the
continuous-output regression, higher idle CPU, higher typing latency proxy, or
wire amplification enough to justify migration.

The six runs completed all eight workloads. Management reads verified 18 output
completion markers; 12 workload-end screenshots were retained outside the timed
windows. Visual review confirmed rendered output and Unicode completion.
Resizing used viewport changes and visibility detach/reattach, not actual
multi-pane tab switching or orientation changes. Network loss closed only the
fixture's SSH sockets.

No physical device, WAN/radio test, compositor FPS, actual touch-to-visible
latency, per-frame allocation count, or statistically broad device study is
claimed. Simulator WebKit/Metal/CPU behavior does not establish device behavior.
Skia also lacks several interactions and cache/navigation features retained by
xterm. Memory savings describe these current implementations and may change as
feature parity is added; this is not an isolated comparison of drawing libraries.

## Reproduce and audit

Use the [benchmark runner and method notes](../scripts/herdr-renderer-benchmark/README.md).
The [results JSON](assets/herdr-renderer-benchmark-results.json) contains all 48
workload trials and the aggregate values. On mini, raw counters, environment,
CPU self-test, screenshots and results remain under
`/Users/kosumi/repos/whip-ios-device/build/skia-perf-live`.
A compressed raw-counter copy is also retained locally at
`.codex-skia-perf-measurements.jsonl.gz`. Invalid calibration attempts are
archived separately and excluded. The fixture server, proxy, SSH listener and
temporary source keys were removed; the normal Whip app was relaunched with its
xterm preference retained.
