# Herdr Skia: retained pixels and changed spans

This rerun compares the original row-picture prototype with retained pixels,
changed-span delivery, and cached text shaping. The original measurements remain
in [the baseline report](herdr-renderer-performance-ios-simulator.md) and
[baseline JSON](assets/herdr-renderer-benchmark-results.json).

Continuous-redraw client CPU fell **70.7%**, from 84.51% to 24.73% of one M4 core. Median picture preparation fell from 48.5 to 9.52 ms (5.1× faster). Mean sampled footprint rose from 184.8 to 203.5 MiB, **10.1% higher**. Keep xterm.js as the default pending physical-device, compositor, and input-latency validation.

## Results

Measured on 2026-10-27 in New York; the controller started at 2026-10-28T01:40:18.336Z. All **54 workload windows**, six process runs, and **24 standalone server completion-marker readbacks** passed, with no harness, renderer, or sampling errors. The analyzed results were independently recomputed locally from the raw JSONL and matched exactly. Measured renderer/model/input source hashes match the local sources.

[Complete per-trial and aggregate data](assets/herdr-renderer-benchmark-dirty-regions-results.json).

| Client CPU, % of one core     | Skia before | Skia now | xterm rerun |
| ----------------------------- | ----------: | -------: | ----------: |
| Idle shell                    |        2.52 |     2.53 |        0.34 |
| Typing                        |        9.07 |     8.27 |       17.33 |
| seq 1 100000                  |     invalid |     2.86 |        1.37 |
| Continuous full-screen redraw |       84.51 |    24.73 |       35.58 |
| CJK / combining / emoji       |       45.74 |    20.08 |       43.40 |
| vim cursor movement           |       12.04 |    11.71 |       25.45 |
| Resize / hide / reattach      |       13.52 |     6.91 |       13.99 |
| SSH disconnect / recover      |        5.50 |     3.37 |        2.11 |
| Sparse counter (new workload) |           — |    11.81 |       35.55 |

Continuous-redraw RN JS-thread CPU, including synchronous native work, fell from 77.62% to 19.64%. xterm's continuous CPU control changed from 35.33% to 35.58%. Skia submits fewer updates under its existing polling cap; lower total CPU than xterm here does not establish an equal-frame-rate efficiency win. No function-level or GPU profile was collected.

| Mean sampled client footprint, MiB | Skia before | Skia now | xterm rerun |
| ---------------------------------- | ----------: | -------: | ----------: |
| Idle shell                         |       169.6 |    193.3 |       214.9 |
| Typing                             |       169.9 |    193.6 |       215.5 |
| seq 1 100000                       |     invalid |    194.7 |       215.7 |
| Continuous full-screen redraw      |       184.8 |    203.5 |       222.2 |
| CJK / combining / emoji            |       182.1 |    205.2 |       252.4 |
| vim cursor movement                |       175.9 |    204.9 |       231.1 |
| Resize / hide / reattach           |       176.0 |    211.1 |       245.9 |
| SSH disconnect / recover           |       176.5 |    215.1 |       246.1 |
| Sparse counter (new workload)      |           — |    219.6 |       229.1 |

Retained pixels, snapshots, and cached text trade memory for CPU. These are fresh terminal harness processes, not full-app memory measurements or a long-session leak test.

| Observation                                      | Skia before | Skia now | xterm rerun |
| ------------------------------------------------ | ----------: | -------: | ----------: |
| Attach to first submitted frame, ms              |         267 |      228 |         639 |
| Attach to first two-animation-callback proxy, ms |         305 |      249 |         667 |
| Typing proxy median, ms                          |          67 |       66 |          34 |
| Typing proxy p95, ms                             |          84 |       84 |          51 |
| Continuous preparation median, ms                |       48.47 |     9.52 |           — |
| Continuous preparation p95, ms                   |       51.58 |    11.29 |           — |
| Unicode preparation median, ms                   |       26.73 |     7.01 |           — |
| Typing preparation median, ms                    |        5.00 |     2.28 |           — |
| Continuous full-screen redraw submissions/s      |        15.9 |     17.2 |        39.2 |
| CJK / combining / emoji submissions/s            |        15.1 |     14.3 |        15.8 |

xterm write-callback timing is not equivalent to full layout/paint time, so it is omitted from the preparation rows. Neither preparation nor submissions/s is display FPS. The typing proxy changed from 67 to 66 ms median, and from 84 to 84 ms p95. Faster preparation does not establish lower input-to-visible latency.

| Skia work counters            | Median cells painted/update | Newly shaped graphemes/trial | Shaping cache hits/trial |
| ----------------------------- | --------------------------: | ---------------------------: | -----------------------: |
| Typing                        |                           3 |                            0 |                       59 |
| Continuous full-screen redraw |                        1817 |                          220 |                   287105 |
| CJK / combining / emoji       |                        1610 |                           48 |                   100013 |
| vim cursor movement           |                           0 |                            0 |                        3 |
| Sparse counter (new workload) |                           3 |                           20 |                     2642 |

Sparse updates paint a median of **three cells**, including glyph neighbors, rather than repainting unchanged rows. Cursor-only updates leave text pixels alone. Window totals also include workload setup, completion text, and prompt changes. Pixel tests separately verify that untouched rows remain identical.

Typing bridge traffic fell from 176,755 to 10,526 **UTF-16 code units** (94.0% less). Continuous traffic was 24,597,487 units versus 22,994,700 before; that workload changes most of the grid and submission counts differ. These counts are not network bytes.

Continuous SSH download was **800.6 KiB/s for Skia versus 94.8 KiB/s for xterm** (8.4×). Herdr used 4.43% CPU with Skia and 10.11% with xterm. The local repaint optimization does not compress Endpoint traffic. Optional wire codecs remain a separate task.

## Implementation

- Rust compares full frames and patches against the authoritative cell grid.
  Identical updates advance validated revisions without sending a drawing update.
  Dirty spans coalesce until drained and include adjacent glyphs and wide-cell
  continuations. The bridge sends `(row, first_column, cells)` instead of a whole
  row for every cell change.
- Skia keeps a raster backing surface at device-pixel resolution. It replaces
  pixels only within dirty spans, using `Src` blending so transparent backgrounds
  erase old text. Cursor changes reuse the text snapshot and draw a separate
  overlay. There are no per-cell React components or grid state in React.
- A bounded LRU cache reuses shaped graphemes by text, foreground, bold, italic,
  and dim style; font and cell geometry are fixed for the cache's lifetime.
  Limits are 2048 paragraphs and 64K UTF-16 key units. Backgrounds are batched
  into adjacent runs of the same color.
- The OS still composites a complete image. Raster snapshot copy-on-write and
  texture upload can touch the whole buffer. This avoids rerasterizing unchanged
  terminal text; it does not promise partial damage in the iOS compositor.

These changes were measured together. The full-screen workload changes every
row's color, so its improvement cannot be attributed to skipping unchanged rows:
text-shaping reuse and background batching matter there. The sparse workload
directly measures avoiding work on unchanged cells and rows.

## Benchmark validation correction

The original prototype and first retained-pixel pass had Ctrl/Alt modifier bits reversed. Ctrl-U therefore left typed characters before the seq command. The earlier substring marker check matched command echo, so those Skia burst measurements are invalid. The original JSON is annotated and its burst row is excluded above. This report uses a complete rerun after fixing semantic modifier mapping, making seq success conditional with `&&`, and requiring a standalone output marker. The rejected pass is retained at `build/skia-damage-rejected` on mini. Other original workloads remain useful before measurements.

## Method and limits

The same Apple M4 mini (10 cores, 16 GiB RAM), iPhone 17 Pro simulator with iOS
26.5, Xcode 27.1, thin arm64 Release app, production Metro bundle, Skia 2.14.0,
and isolated Herdr 0.9.1 over loopback SSH were used. The actual grid was 80×24,
with JetBrains Mono size 8 and each renderer's normal pixel rounding.

Six fresh processes run in xterm/Skia/Skia/xterm/xterm/Skia order. The original
eight workload durations and renderer settings are retained; a ninth, final `sparse` workload updates a counter
in one row while the other rows stay static. No sparse baseline was collected
for the original prototype. Each table value is the median of three trials.
The original prototype's before values come from the earlier run; xterm is
remeasured in this run to expose host drift.

CPU means percent of one M4 host core. Client counters include the app and its
new WebKit processes. RN JS-thread CPU includes synchronous native JSI calls.
Memory is sampled physical footprint, not allocation count. Herdr CPU is separate
from client CPU and includes server emulation/rendering, excluding generator CPU.
The SSH daemon, simulator compositor, and host WindowServer CPU are not attributed
to those process totals; no GPU timing was collected.
SSH counts encrypted TCP payload, including management traffic, without WAN or
radio costs. Optional Endpoint delta/reuse/scroll codecs remain disabled.

Preparation ends at picture submission. The new path performs CPU rasterization
before submission; the original path recorded drawing commands for later paint.
Neither timing isolates the entire GPU/compositor cost. Submission rates and two
animation-callback observations are proxies, not measured display FPS or actual
input-to-visible latency. Instrumentation is opt-in and adds overhead, including
JS callbacks to xterm's normally native output path. The input proxy excludes OS
keyboard dispatch and does not identify a particular echoed glyph.

The harness, workloads, counter attribution, and reproduction commands are in
[the benchmark README](../scripts/herdr-renderer-benchmark/README.md). Physical
devices, WAN behavior, compositor FPS, and normal full-app memory remain untested.

## Validation

Thirteen offline Rust tests pass, including identical-frame suppression without
revision gaps, dirty-span coalescing, wide-cell expansion, malformed frames,
resize, and stale lifecycle callbacks. Sixty-seven focused JavaScript tests pass,
including five real offline CanvasKit pixel tests for retained rows, transparent
erasure, shaped-text reuse, cursor movement/removal, DPR scaling, resets, and
allocation bounds. TypeScript, targeted ESLint, and Rust formatting checks pass.

## Additional evidence and reproduction

The existing offline Rust model microbenchmark was repeated three times after warming the test executable. Medians were 5.945 ms for a full 80×24 decode/apply/drain and 14.280 ms for 1000 alternating one-cell patches, including fixture construction. The patches allocated 1,430,064 bytes in 13,751 allocations, with 822 bytes peak live increase during measurement, and serialized 374,896 bridge JSON bytes. The original row bridge serialized 7,049,896 bytes for 1000 patches. The current fixture alternates x/y to ensure every patch changes a cell; identical patches are now suppressed. These are x86_64 Linux debug-model measurements, not iOS renderer or device measurements.

Raw JSONL, counter self-test, environment, screenshots, and hashes remain in `build/skia-perf-live` on mini. `damage-results.json`, `damage-measurements.jsonl.gz`, and `damage-build-hashes.json` identify this run; the earlier baseline is preserved in `build/skia-damage-before`. The six-run reproduction command is unchanged:

```sh
nix develop -c bash scripts/herdr-renderer-benchmark/run-mini.sh
nix develop -c node scripts/herdr-renderer-benchmark/analyze.cjs \
  build/skia-perf-live/measurements.jsonl > build/skia-perf-live/damage-results.json
```

Measured native binary SHA-256: `da136130d807de931e5026405bbd92d9b17f4709f77edd1364ee7925a26636b1`. Production benchmark bundle SHA-256: `df2cd5e4f56e64b8620a91a4474c30aff375d1097b48f68d1d9fa7851092db5f`.

The updated normal simulator app was installed in place and relaunched after measurement. Its native binary matches the measured build. The normal app sandbox and preferences were retained; fixture listeners and temporary SSH keys were removed.
