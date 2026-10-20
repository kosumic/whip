# Chat row profiling on Pixel 9 Pro

Measured on 2026-10-20 with Whip 1.9.0 (232), Android 17, arm64, and the
installed release's Hermes runtime. FFI did not erase the cached-update benefit
in this conversation. Initial viewport creation remained substantially slower.

| Operation | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| Previous JS projection | 120 | 8.026 ms | 14.023 ms |
| Native poll through JS continuation | 120 | 1.186 ms | 2.514 ms |
| Native poll + descriptor mapping + patch application | 120 | 1.232 ms | 2.546 ms |
| Fresh native viewport, including FFI and patch application | 3 | 117.087 ms | — |

Fresh viewport samples ranged from 105.944 to 140.199 ms. The incremental row
path's median was approximately 6.5 times lower than the previous projection's
median. This is a measurement of row availability, not an overall application
speedup or a frame-rate comparison.

## What was measured

The live Codex conversation had four normalized turns and 443 rendered rows
during the cached native polls. The old projection saw 443–444 rows as the
conversation continued. The viewport stayed visible during measurement.

An isolated second native viewport used the same live canonical transcript and
expansion state. Three fresh owners were created, polled, and disposed. The last
owner then received 120 serial polls, separated by 20 ms timers. These cached
polls did not inject synthetic transcript deltas: all 120 returned zero row
patches and zero resets. The frozen previous `transcriptBlocks()` implementation
then ran 120 times against the same conversation's current JS turns, also with
20 ms timers. Its result length was consumed to retain the work.

The new timing includes request conversion, native dispatch, native scheduling,
projection/recovery as needed, UniFFI serialization and lifting, the JS promise
continuation, conversion to flat descriptors, and the production `ChatRowStore`
patch applier. It excludes lazy visible-row resolution and React/FlashList
rendering. The initial live-owner poll also includes the manager's canonical
snapshot cloning, which the desktop projection microbenchmark excludes.

The synchronous native call setup alone measured 0.719 ms median. Descriptor
mapping and patch application measured 0.018 and 0.012 ms median. Generated
response lifting occurs inside the round trip; it cannot be attributed to
native CPU or JS CPU from these counters alone. The combined statistics sum
each poll's three measurements before calculating percentiles.

Separately, the real UI made 12 polls during this capture. They saw 442–447 rows,
returned no resets, and inserted at most two descriptors per update. Their
round-trip median was 2.019 ms and their maximum was 26.420 ms. This small,
contended sample shows that the cached benchmark is not a guarantee about live
update latency.

## Capture and build integrity

The installed APK and its matching source map were saved before instrumentation.
The Hermes bundle hash matched the local release output. Temporary JavaScript
instrumentation was generated from that source map in an isolated directory;
production source files were not patched. The installed arm64 native library
was retained unchanged. Timing counters recorded numbers, not transcript text
or private IDs. The temporary manifest enabled shell profiling, and the APK
used the configured upload key with a verified matching signing certificate.

Perfetto recorded the counters, scheduling, and surface frame timeline over
35 seconds. All benchmark phases completed, and trace analysis reported no
error statistics. Device thermal status was zero during the final benchmark.
The trace also contains the benchmark's own extra work and Hermes sampling:
its frame counts are diagnostic, not a production FPS baseline.

Earlier captures are excluded: another coding session was driving the same
phone, and the first diagnostic bundle loaded duplicate JS bindings. The final
bundle resolved package subpaths to one binding instance. A separate clean
production frame capture was not completed after the phone returned to other
use. There is no complete before/after UI A/B in these results.

The temporary profiling APK was removed by an in-place reinstall. Concurrent
device work subsequently installed another normal build. Final inspection
verified shell profiling was disabled and the temporary benchmark URL/hooks
were absent. The app was never uninstalled; its original first-install date
and sandbox were retained. Build hashes and numeric results are recorded in
[chat-row-device-profile.json](chat-row-device-profile.json).

## Reanalysis

Raw traces, exact APKs, matching source maps, numeric-only instrumentation
sources, and preparation scripts remain locally under
`artifacts/chat-row-device/`; they are excluded from Git because they contain
private conversation screenshots and application sources. Analyze the final
trace with:

```sh
nix develop --command node scripts/analyze-chat-rows-device.ts \
  --trace artifacts/chat-row-device/final-ffi.perfetto-trace \
  --processor artifacts/memory/profiling-20261005/tools/trace_processor_shell \
  --output artifacts/chat-row-device/reanalysis.json
```

The analyzer and the scripts TypeScript project pass ESLint and type checking.
No production logic was changed for this profiling follow-up.

## Limits and next work

These results cover one real Codex conversation with roughly 443 rows, rather
than the desktop benchmark's 5,000-row fixture. They establish a lower cost for
making cached rows available through the native boundary in this workload.
They do not establish memory savings, an overall FPS improvement, or performance
for every provider or conversation size. Native delta intake occurs before the
poll and is not isolated by the cached-poll timing.

The 117 ms initial viewport cost is the clearest remaining concern. Attribute
that time between snapshot cloning, projection construction, and generated FFI
encoding/lifting before choosing an optimization. Reducing the initial work and
measuring a complete old/new UI A/B are the next useful checks.
