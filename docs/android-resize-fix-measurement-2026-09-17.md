Whip resize-loop fix — Pixel 9 Pro measurement, September 16–17, 2026

The patched app recorded **zero ordinary resize requests or native resize dispatches** during both untouched terminal output and eight verified tab switches. A fresh capture of the previously installed app reproduced 47 identical native resizes in 30 seconds. Live output continued after the fix.

Measured through adb and Perfetto on the same USB-connected Pixel 9 Pro / Android 17. Installed the upload-signed, optimized arm64 release APK in place with `adb install -r`; app data and saved connections were preserved. Whip was left foregrounded on the `depen` terminal.

| Untouched terminal, approximately 30 seconds each | Before | After | Observed change |
| --- | ---: | ---: | ---: |
| Fit resize requests | 47 | 0 | Eliminated in capture |
| Native resize dispatch spans | 47 | 0 | Eliminated in capture |
| Whip CPU, percent of one core | 192.25% | 90.53% | −52.9% |
| JavaScript CPU, percent of one core | 83.96% | 7.96% | −90.5% |
| RenderThread CPU, percent of one core | 52.77% | 44.22% | −16.2% |
| Inbound frame to visible acknowledgement, p95 | 93.85 ms | 57.06 ms | −39.2% |
| WebView entry acknowledgement, p95 | 52.70 ms | 24.18 ms | −54.1% |
| Rust frame-delivery callback, p95 | 63.45 ms | 7.62 ms | −88.0% |
| App surface frames | 2,488 | 2,415 | Similar rendering frequency |
| App deadline misses | 10 | 9 | Similar |
| App FrameTimeline duration, p95 | 13.70 ms | 13.79 ms | Similar |

Every baseline fit reported `33x31`, cell size `28x68`. CPU percentages represent scheduled execution divided by capture duration; 100% is one occupied core. Whip process CPU excludes the separate WebView renderer and compositor. These measurements show the resize loop stopped and JS work fell substantially; they do not show that continuous rendering was eliminated. RenderThread is now the largest measured thread cost in the untouched-terminal capture.

Eight tab selections were observed in each comparison trace:

| Tab selection to renderer entry | Before | After |
| --- | ---: | ---: |
| Median | 515.18 ms | 135.25 ms |
| p95 | 913.08 ms | 234.43 ms |
| Maximum | 983.10 ms | 246.05 ms |
| Fit resize requests | 47 | 0 |
| Ordinary native resize dispatch spans | 44 | 0 |

The baseline tab trace lasted 30 seconds; the verified post-fix trace lasted 45 seconds because adb resolved each tab by its accessibility label before tapping. Both alternated `cleanTEST` and `depen`, with eight selection spans each. The post-fix median selection interval was 73.7% shorter, but the changed tap cadence and UI-hierarchy inspection overhead prevent treating this as an exactly controlled benchmark. The baseline also contains one initial bridge resize and three superseded ordinary requests. The selection marker ends when the renderer entry is reached, not when the terminal becomes visible.

A separate 20-second background/foreground trace recorded three initial bridge resize spans and three native dispatch spans when bridges reattached. It recorded no fit resize requests and no recurring resize loop. The terminal remained usable on return. This checks foreground lifecycle behavior; it does not establish rotation or ownership-takeover behavior on the device.

Conditions and limits:

- Thermal status remained LIGHT (1) throughout. Android animation settings were retained. Both terminal captures contained real remote output; no terminal commands or text were injected.
- Output was not replayed identically. Renderer-bound payload counters changed from 771 samples / 307,244 bytes before to 475 samples / 129,426 bytes after. Removing resize-provoked redraws can itself reduce this traffic, but other live-output differences also contribute. The verified tab trace after the fix still delivered 1,656 payload samples / 1,590,013 bytes.
- The old APK was build 221 from commit `52ab702943b6bf4e37e5277e07f55d8a1b30b389`. The patched APK was built from `ac62b5de5662ceb0e7dafdd7b686f53b522d3720` plus the working-tree fix and pre-existing local changes. Thus this is an installed-build before/after comparison, not an isolated single-patch A/B test. Installation also restarted the process.
- Release build used `:app:assembleRelease -PreactNativeArchitectures=arm64-v8a`, with R8 enabled. The APK contains only `arm64-v8a` native libraries. Its bundled terminal HTML was verified against the patched source, and the installed APK SHA-256 matches the built APK: `c62fc55d94c9b2ef9f6a7bc308f246775f1c1bf0dc369edfae039f4100ce654f`.
- Same Perfetto capture configuration and Trace Processor v57.2 analysis queries as the prior investigation. No nonzero error/data-loss-severity statistics were returned. Informational discarded-chunk counts were 13/16 for the before/after live traces and 15/19 for the before/verified-after tab traces; recordings are not claimed perfectly lossless.
- Visible acknowledgement intervals include React Native scheduling and the WebView acknowledgement return path, not just screen rendering. No battery-power measurement was made.

Evidence is gitignored under `artifacts/perfetto/resize-fix-20260916/`:

- `before-live.perfetto-trace`, `after-live.perfetto-trace`
- `before-tabs.perfetto-trace`, `after-verified-tabs.perfetto-trace`
- `after-resume.perfetto-trace`
- Corresponding `*-results.json`, `analyze.py`, capture logs, screenshots, thermal/foreground records, `verified-taps.log`, `build-provenance.json`, `source.patch`, and `installed-apk-sha256.txt`.

Exploratory `before-switching` and `after-tabs` recordings are excluded from the tab comparison: their fixed-coordinate taps did not produce the intended eight selections. Label-based selection was used for the final post-fix run.

Analysis can be rerun with:

```bash
nix develop --command uv run --no-project --with perfetto python \
  artifacts/perfetto/resize-fix-20260916/analyze.py \
  before-live after-live before-tabs after-verified-tabs after-resume
```
