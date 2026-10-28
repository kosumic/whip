# Herdr renderer comparison on mini

This developer harness measures the real xterm.js and Skia components in the
existing isolated `io.github.kaminarios.whip.skiasmoke` arm64 Release simulator app.
It needs that native app installed already, including Skia and the Endpoint v1
Rust bindings. It does not build a new native binary, create a worktree, uninstall
an app, or use any saved-host credentials.

From the persistent mini worktree:

```sh
nix develop -c bash scripts/herdr-renderer-benchmark/run-mini.sh
nix develop -c node scripts/herdr-renderer-benchmark/analyze.cjs \
  build/skia-perf-live/measurements.jsonl > build/skia-perf-live/results.json
```

The runner reserves loopback ports 22391–22393, creates a dedicated Herdr server
and temporary SSH keys, bundles this standalone entry with production Metro
settings, and launches six fresh app processes in xterm/Skia/Skia/xterm/xterm/Skia
order. Three trials per renderer avoid comparing a process retaining the other
renderer's fonts and caches. Each uses the same pane, JetBrains Mono size 8, and
an actual 80×24 cell grid. Feedback calibration uses reported columns/rows because
xterm's exported physical cell width is rounded. A grid mismatch makes analysis
fail. The normal app is paused during recording to avoid WebKit attribution
ambiguity; its data and preferences remain intact.

Workloads: eight seconds idle; thirty printable inputs at 200 ms intervals;
`seq 1 100000`; eight seconds of full-screen ANSI redraws; eight seconds of CJK,
combining-character and emoji redraws; vim cursor movement; six viewport changes
plus hide/show; and closure/recovery of only the fixture's SSH connection.
The retained-pixel rerun adds a final `sparse` workload: one changing counter in
one row, with the other rows static. It runs after the original eight windows.
Skia's opt-in samples also count painted cells, newly shaped graphemes, and
shaping-cache hits per update. These measure avoided work, not compositor damage.
Output windows include two seconds after each timed redraw generator ends.
Management reads verify completion markers outside those measurement windows.
Markers must occupy their own output line, so command echo cannot count as
success. The `seq` marker is conditional on a successful command exit. The
original prototype had Ctrl/Alt modifier bits reversed and its Skia burst row
is invalid; current runs use the corrected semantic input mapping.
Workload-end screenshots are also captured outside the measured windows.

`resource-sampler.c` reads macOS host counters every 500 ms. Process CPU time is
converted from Mach ticks to nanoseconds with the machine's timebase. Thread CPU
times are already nanoseconds. Its self-test verifies both against
`CLOCK_PROCESS_CPUTIME_ID`. CPU percentages use 100% for one core. Memory is
`ri_phys_footprint`, not RSS or a count of JavaScript allocations.

Client totals include the app and new WebKit WebContent/GPU/Networking processes
under this simulator's launchd, excluding those present before the fresh run.
Only the benchmark app is launched in that simulator during a run. The raw JSONL
retains process IDs, names, and counters to audit attribution. React Native JS
thread CPU includes native calls made synchronously on that thread. WebContent
CPU is reported separately; its JavaScript and native layout work are not split.
Herdr process CPU is separate and excludes the workload generator's own CPU.

The counted TCP proxy reports encrypted SSH bytes in each direction, including
management/event traffic, excluding TCP/IP headers and retransmission overhead.
This is a loopback connection; it does not model radio use or WAN latency.

`onFrameMetrics` is opt-in. The normal xterm native delivery path retains its
per-frame bypass of React Native JS when the observer is absent. With observation
enabled, xterm reports its write callback and two WebView animation callbacks;
Skia reports picture submission and two React Native animation callbacks.
These are different execution paths and are **presentation proxies**, not
compositor completion. Submitted updates per second are not display FPS. Typing
timing starts at the imperative input call and ends on the next proxy observation;
it excludes OS keyboard dispatch and does not identify an echoed glyph. The
isolated typing workload has no other intended output. Frame preparation costs
are diagnostic, not complete frame-rendering costs for either renderer.

The resize test uses viewport changes and visibility detach/reattach, not real
multi-pane tab switching or device rotation. Physical-device performance, actual
compositor FPS, and touch-to-visible latency require a separate device trace.

Results, counter self-test, environment, and screenshots stay under
`build/skia-perf-live`. Keys and fixture processes are removed on exit. Failed
calibration attempts are archived below that directory and must not be mixed
with the final run's measurements.
