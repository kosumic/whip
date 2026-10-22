# Codex ingestion allocations

Run the opt-in release benchmark from the repository root:

```sh
nix develop --command npm run --silent benchmark:codex-ingestion
```

It reuses the chat-row benchmark's thread-local counting allocator. Each workload
warms once, then runs five measured samples. The JSON reports median elapsed
time with the range, allocation count, cumulative allocated bytes (including
reallocations), and peak increase in live bytes for the median sample. Input
construction, comparisons of returned transcripts, and destruction of the
returned output happen outside measurement. Peak bytes measure the operation's
live-byte increase, not process RSS or Android memory pressure. Timings include
counting-allocator instrumentation and depend on host load; allocation counts
and bytes are the primary comparison.

Both legacy and paginated histories contain 100, 1,000, and 2,500 turns. Each
turn has an unchanged directory/model context, a start, a user prompt, an
assistant response, an extra legacy plan or paginated raw response, and a
completion. These synthetic fixtures use short metadata and small text parts;
they do not model large tool outputs or file diffs.

The four measurements cover:

- `steadyRecord`: 1,000 payload-free `realtime_item` records after prompt-title
  discovery. This isolates metadata comparison overhead because this decoder
  path and projection need no allocations themselves.
- `adapterReplay`: all pre-parsed JSON records through the production adapter,
  including decoding, projection, and incremental delta construction.
- `ingest`: a new session with 64 KiB JSONL chunks, including framing, JSON
  parsing, raw-line caching, updates, and snapshots emitted by ingestion.
- `restoreCache`: a new session restoring its complete raw JSON cache, including
  cache deserialization, record parsing/replay, and the returned transcript
  snapshot. Both the session and snapshot stay alive at measurement's end.

Every replay, ingest, and restoration is checked against the expected messages,
turns, and metadata outside measurement. Ingestion and restoration also check
the raw byte cursor. Cache serialization is excluded from restoration.

These are desktop Rust microbenchmarks. SSH, database I/O, UniFFI transport,
chat-row projection, React work, and rendering are excluded. Allocation traffic
and live memory are separate metrics; these measurements cannot establish the
cause of an application crash.

## Metadata comparison change

Previously, `CodexTranscriptAdapter::accept_incremental` cloned the session ID,
directory, and visible title before every record. It then compared those copies
against the resulting metadata.

The adapter now detects identity and directory changes where those fields are
assigned. Unchanged directories keep their existing string, and changed
directories reuse its capacity. Prompt-title discovery and rollback compare the
newly derived title with the existing title before assignment. A native session
name still overrides the derived title, so hidden prompt changes do not emit
metadata deltas. The existing metadata delta construction remains in place for
actual visible changes.

The baseline was recorded before that change, using source revision
`154a9611fec3497214624306f5e8f332b5c47538` with the benchmark scaffolding added.
Both runs use Linux x64, Rust 1.99.0, and the repository's release profile
(`opt-level = 3`, thin LTO, one codegen unit).

## Results

Raw measurements: [before](codex-ingestion-benchmark-before.json) and
[after](codex-ingestion-benchmark-after.json). The compared runs had identical
history modes, turn/record counts, input sizes, cache sizes, and sampling
configuration across the runs.

At 2,500 turns (15,001 records), each phase saved 47,498 allocations and 327,473
cumulative requested bytes (0.31 MiB):

| History | Phase | Allocations before | Allocations after | Reduction |
| --- | --- | ---: | ---: | ---: |
| Legacy | Adapter replay | 408,380 | 360,882 | 11.63% |
| Legacy | JSONL ingestion | 1,355,420 | 1,307,922 | 3.50% |
| Legacy | Full cache restoration | 698,449 | 650,951 | 6.80% |
| Paginated | Adapter replay | 795,078 | 747,580 | 5.97% |
| Paginated | JSONL ingestion | 1,136,928 | 1,089,430 | 4.18% |
| Paginated | Full cache restoration | 1,180,125 | 1,132,627 | 4.02% |

The neutral-record probe fell from 3,000 allocations / 21,000 allocated bytes
to zero across 1,000 records in every workload. Other record types still
allocate for decoding, content, projection, and updates.

Full restoration's allocated-byte totals fell from 57,038,634 to 56,711,161
bytes for legacy history, and from 111,608,086 to 111,280,613 bytes for paginated
history. Peak live-byte increases were essentially unchanged: 18,360,559 to
18,360,562 bytes for legacy, and 18,815,033 to 18,815,036 bytes for paginated.
This optimization reduces temporary allocation traffic without a material
reduction in measured peak memory.

Median full-restoration times were 35.89 to 33.38 ms for legacy and 55.74 to
54.34 ms for paginated history. The raw JSON includes the five-sample ranges;
these instrumented desktop timings do not establish device loading latency.

Validation: 848 Rust library tests passed; five additional tests were ignored.
Clippy across all targets with warnings denied, Rust formatting, and the
benchmark runner's ESLint and TypeScript checks also passed. Focused regressions
check metadata deltas, ignored fork
headers, directory changes, both app-server identity forms, prompt-title
rediscovery after rollback, native-title overrides, and the neutral record's
zero-allocation path.
