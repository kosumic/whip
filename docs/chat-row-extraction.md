# Transcript view extraction (#361)

The implementation follows [the boundary review request](https://github.com/kosumic/whip/issues/361#issuecomment-6639723967).
The project owner explicitly authorized MIT for the extracted crate during
implementation. `agent-transcript-view` uses MIT and retains the original
OpenCode MIT attribution in its `NOTICE`; core's source and MIT licensing
are unchanged.

Adding optional `view` and `search` modules inside core would reduce dependency
wiring. With licensing cleared, the remaining reasons for a separate crate are
independent API/version stability and parser-only consumers: presentation
changes need not affect parser releases or add presentation surface to core.
Both crates share core's actual types by reference, so this boundary adds
no canonical state conversion or history copy.

## Boundary and compatibility

The portable crate owns the row descriptors, patches, metadata-only projection,
128-entry journal, identity/renderability helpers, and pure transcript search
and selection. It consumes core's actual models and borrowed deltas. Initial
restoration accepts the existing borrowed `AgentTranscriptView`, so extraction
does not add a canonical history clone. Search retains its existing derived
searchable strings and folded index; its snapshot refresh policy is unchanged.

Whip retains `AgentChatRows`, `ChatSearchIndex`, live/saved source identities,
canonical storage, epoch validation, locks, database reads, blocking-pool tasks,
FFI exports, and the React consumers. Its remote UniFFI declarations expand
from one schema of the portable types, matching the existing core adapter
pattern. There is no model conversion, extra FFI call, per-row bridge traffic,
provider adapter, runtime, or process-global state in the new crate.

See the [standalone API and consumer](../crates/agent-transcript-view/README.md)
for ownership, revision recovery, threading, limits, and versioning.

## Measurements

Baseline row implementation: `d75842806a2ab1609c972a959d5adb63fc2ad154`.
Measured on 2026-11-04 with Rust 1.99.0. The original benchmark workload remains
unchanged: 100, 1,000, and 2,500 turns; 500 latest-message text updates; 16-file
expansion/collapse; thread-local allocation counting; actual UniFFI serialization.
The benchmark fixture moved into the portable crate and is shared with Whip's
benchmark so workload construction has one implementation.

### Android arm64

The connected Pixel 9 Pro ran two release Rust executables in `/data/local/tmp`:
one compiled the original row source from the baseline revision, and the other
linked the extracted crate with Whip's remote-schema registration pattern.
Each executable was warmed once. Nine measured samples alternated execution
order. Both executables used the same current core, fixture, allocator counter,
release settings, UniFFI version, and benchmark body. No APK was changed, and
both temporary executables were removed after measurement.

[Raw samples and medians](chat-row-extraction-android.json) include every
workload. At 5,000 rows:

| Native operation | Before median | After median |
| --- | ---: | ---: |
| Initial projection + first poll | 21.833 ms | 21.500 ms |
| Streamed text accept + poll | 0.286 μs | 0.323 μs |
| Cached poll | 0.225 μs | 0.214 μs |
| Encode cached response | 0.482 μs | 0.428 μs |
| Expand 16 files | 37.272 μs | 37.354 μs |
| Collapse | 6.104 μs | 6.063 μs |

Allocation counts, allocated bytes, row revisions, and serialized response sizes
matched before/after at every workload size. At 5,000 rows both versions used:

- Initial construction: 80,061 allocations, 6,810,933 allocated bytes.
- Streamed and cached projection work: zero allocations and zero allocated bytes.
- Expansion/collapse: 133/14 allocations.
- Initial/streamed/expanded/collapsed response: 283,471/28/952/44 bytes.
- Cached serialization: three allocations for its 28-byte response.

Timing varies with device scheduling and CPU frequency, particularly in the
smaller workloads. Android reported thermal status 1 after sampling; device
frequency and background activity were not controlled. These results do not support a general speedup claim. The
5,000-row streaming difference is 37 ns/update in this measurement; there is
no allocation or payload regression. Counts describe allocation traffic within
the measured operations, not overall app memory or retained heap size.

This is native construction/update/encoding profiling on the actual device,
not a full `AgentChatRows` viewport or Hermes round trip. It excludes canonical
snapshot construction, Whip lifecycle, native dispatch, JS promise scheduling,
response lifting, React/FlashList, and frame time. The earlier
[full-boundary device profile](chat-row-device-profile.md) remains historical
evidence and was not repeated with instrumented APKs for this extraction.

Reproduce without replacing the installed app:

```sh
nix develop --command bash scripts/benchmark-chat-rows-native.sh \
  d75842806a2ab1609c972a959d5adb63fc2ad154 android DEVICE_SERIAL
```

Set `WHIP_ROW_BENCH_SAMPLES` to change the default nine samples. Generated
sources, executables, and console logs remain under the ignored
`artifacts/chat-row-extraction-android/` directory. The baseline copy exists
only in these benchmark artifacts, not in the portable library.

### Desktop

[Matched native samples and medians](chat-row-extraction-desktop.json) use the
same small release harness and existing Whip benchmark body as Android. Nine
warmed alternating samples produced the following 5,000-row medians:

| Native operation | Before | After |
| --- | ---: | ---: |
| Initial projection + first poll | 5.965 ms | 5.386 ms |
| Streamed text accept + poll | 84 ns | 91 ns |
| Cached poll | 40 ns | 43 ns |
| Encode cached response | 64 ns | 64 ns |

All allocation counts and serialized response sizes matched at all three sizes.
The 5,000-row initial projection allocated 6,831,125 bytes across 80,061
allocations in both versions; streamed/cached projection remained allocation-free.
The single-digit nanosecond differences are too small for an app-level timing
claim. Desktop background load was not controlled.

Reproduce the native samples:

```sh
nix develop --command bash scripts/benchmark-chat-rows-native.sh \
  d75842806a2ab1609c972a959d5adb63fc2ad154 host
```

The existing Node benchmark was also run with those native medians through its
documented `--native-results` option, retaining the production patch applier
and frozen legacy JS comparison. [Before](chat-row-extraction-before.json) and
[after](chat-row-extraction-after.json) contain the full outputs. Both use the
same unchanged JavaScript source; timing and heap-profiler sampling variation
are not extraction speedups. This avoids rebuilding unrelated native subsystems
for each sample. The initial default full-Whip release benchmark compilation
was stopped after the matched harness measurements completed.

To reuse measured native results, put the selected projection median array under
a `results` key and run:

```sh
nix develop --command npm run --silent benchmark:chat-rows -- \
  --native-results native-results.json
```

The existing default `npm run benchmark:chat-rows` command still builds and
runs the whole-Whip release benchmark; only fixture imports changed.

## Verification

- Standalone view: 26 behavior tests and the minimal consumer pass without Whip.
  Covers duplicate IDs, filtering for every provider, partial text, tool
  completion, coalesced deltas, expansion, truncation, stale revisions, journal
  exhaustion/recovery, Unicode excerpts, selection, and reveal-to-row identity.
- Core: 151 unit tests, two integration tests, and one doctest pass; three
  existing opt-in capture/benchmark tests remain ignored. No core files changed.
- Whip: 56 chat-related tests, five row restoration/lifecycle tests, and 17
  database/saved/offline tests pass. The chat selection includes one database
  test also covered by the database suite. Allocation regressions verify that
  borrowed restoration costs do not grow with transcript text size.
- React/transcript/search/cache: 520 tests pass across 18 existing Jest suites.
- Rust formatting, standalone and Whip all-target Clippy with `-D warnings`,
  app/script type checking, and linting of the changed license script pass.
- Rust dependency notices and the generated bundled license registry pass with
  MIT for the new crate and the retained OpenCode notice.
- Bindings were regenerated into ignored artifacts from the integrated native
  archive. Row/search shapes, converters, C++ declarations, and FFI functions
  are unchanged. Four UniFFI method checksums change with the remote type
  registration; the generated TypeScript expectations were refreshed. C++
  generation differs only by Whip's existing terminal tracing instrumentation,
  which is retained in the production file.

Native test runs require the Nix environment and a writable temporary directory.
An attempted direct sandbox run could not create its temporary databases; the
same suite passes with the normal Nix test environment. Device measurements
cover the native harness, not a rebuilt/installed Whip APK or an iOS app build.
