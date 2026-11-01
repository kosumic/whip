# Extraction benchmark

Measured on 2026-11-01 with rustc 1.99.0 (b940084d7 2026-09-28), linux/x64.
The baseline is the existing Whip benchmark at commit `814438b182e0c53950387f04ee7b7ac00f1b6647`;
the extracted library uses the same benchmark, inputs, allocation counter, and
release settings (optimization 3, thin LTO, one codegen unit).

Compiled binaries ran in three back-to-back pairs with alternating order.
Each existing benchmark operation warms once, records five samples, and takes
the median. The table reports the median of those three operation medians.
Build time, fixture creation, validation, output destruction, SSH, databases,
FFI, row projection, and UI work are excluded. These are local synthetic timings,
not measurements of Android/iOS rendering or network performance.

| History | Turns | Ingest before (ms) | Ingest after (ms) | Restore before (ms) | Restore after (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy | 100 | 1.379 | 1.285 | 1.068 | 1.041 |
| legacy | 1,000 | 19.178 | 18.059 | 11.174 | 11.072 |
| legacy | 2,500 | 94.397 | 84.185 | 30.089 | 28.514 |
| paginated | 100 | 1.916 | 1.876 | 1.787 | 1.800 |
| paginated | 1,000 | 18.895 | 18.420 | 18.383 | 17.898 |
| paginated | 2,500 | 49.366 | 48.143 | 47.197 | 46.569 |

Allocation counts, total allocated bytes, and peak live-byte increases matched
exactly for every measured operation in all three pairs: six histories times
four operations (metadata-only steady updates, adapter replay, ingestion, and
checkpoint restoration). Runtime ratios across these operation medians ranged
from 0.892 to 1.048 of baseline, with no material regression observed.
Small timing differences on a shared host should not be treated as a device
performance prediction or attributed entirely to the extraction.

Full sample ranges and allocation/memory counts are retained in
[the raw results](benchmarks/extraction-2026-11-01.json).

Reproduce the extracted measurements from the repository root:

```sh
nix develop -c node scripts/benchmark-codex-ingestion.ts
```
