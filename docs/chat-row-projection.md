# Native Chat View row projection

`chat_rows.rs` implements the six Chat View row kinds as typed UniFFI data:
`AgentChatRow`, `AgentChatRowContent`, `AgentChatRowSpacing`,
`AgentChatPartKind`, `AgentChatRowPatch`, and `AgentChatRowUpdate`.
`AgentChatRows` is the viewport owner. Create a live owner through
`HostRuntimeConnection.agentChatRows(key)`, or an offline owner through
`AgentChatRows.forSaved(namespace, agent, sessionId, conversation)`.
`poll(after, transcriptRevision, working, expanded)` returns revisioned patches;
`dispose()` releases the viewport cache and unregisters it. Native callbacks
keep only weak owner references. There is no global expansion state.

The owner retains message/part references, completion and renderability flags,
turn membership, filenames, and row descriptors. It retains no message text,
tool output, patches, private provider records, or copies of canonical messages.
The manager remains the canonical transcript owner. Initial restoration and
authoritative recovery read a snapshot on the blocking pool.

## Updates and lifecycle

Before delivering a transcript event, the manager feeds its existing typed
delta to the registered owners. Epoch validation excludes stale native
operations. Message and turn indexes identify affected turn segments without
walking historical turns. Identical presentation metadata is a no-op: growing
text and ordinary tool completion allocate no replacement descriptors. A new
streaming tail clears the old marker and changes only the affected segment.
Row revisions advance only for row patches; transcript revisions still validate
every delta. A long backlog of text-only updates cannot overflow the row journal.
Appending a turn also checks the previous tail. Truncation deletes the tail
range and retains the metadata anchor of every remaining turn.

Each segment has a cached row offset. Prefix/suffix comparison yields a typed
splice with an index, deletion count, and replacement rows. Insertions and
removals are zero-count/empty special cases. Multiple deltas in one event
coalesce through the dirty-turn set. The owner retains at most 128 update
entries; delivered entries are released immediately. A failed delivery can
recover from the authoritative cache without retaining a second full row array.
Falling behind that journal, a
native revision gap, or incompatible reset identities triggers an authoritative
reset. Stale revisions do nothing.

Legacy Codex supplies full canonical reset snapshots for ordinary updates.
The compatibility path compares their lightweight references and emits only
changed row ranges, retaining historical descriptors. Those inputs still
require a metadata scan; normal Claude, paginated Codex, and OpenCode deltas
avoid that scan. Canonical provider reconciliation and native search's existing
snapshot refresh policy are outside this row-cache optimization.

Addressable conversation readers use the existing versioned native snapshot
reader, so a host incarnation change or a saved-checkpoint replacement refreshes
their rows too. Unchanged versions do not reload history. Snapshot reconciliation
runs on the blocking pool and returns only changed row ranges. The hook discards
staged work when a restored transcript restarts its revision counter.

The React hook serializes polls, coalesces changes received during a poll, and
stages a result if its transcript objects have not reached JavaScript yet.
Projection revisions and transcript revisions are separate. A malformed or
missing projection revision requests recovery automatically; repeated malformed
recovery reports an error instead of looping. Disposal rejects pending native
work and prevents late JavaScript callbacks from touching a replacement store.
Warm hidden views keep their owner and expansion state. A temporary loss of the
host's JavaScript client retains the current source. Binding replacement and
viewport disposal release the owner.

## React and search

`transcriptBlocks()` and its production flattening/filtering code were removed
from `src/lib/agentChatBlocks.ts`; its question/running-tool UI helpers remain.
The old implementation is frozen under `test-support/` solely for benchmark
comparison and existing rendering fixtures. Its behavior tests moved to native
tests. `chatSearchPresentation.ts` was already absent in the current repository:
search documents already originate in the native `ChatSearchIndex`.

FlashList consumes `ChatRowStore.rows`, a descriptor array. Applying an empty
patch retains the exact array; splices preserve unaffected descriptor objects.
ID-to-index maps support search and viewport anchors. Rendering resolves only
requested rows through the existing native message index, a turn index, and
the native part index. Resolved render props are cached with weak source keys
so offscreen rows cannot retain replaced large messages. There is no complete
resolved `ChatBlock[]` cache. `extraData` notifies visible cells about transcript
content changes. Prompt previews invalidate for user edits, not assistant text
growth. FlashList mounts after the initial batch, with the saved anchor index.

React retains expansion interactions and scroll/focus/follow state. Only
changes-section IDs reach the owner; tool and metadata detail toggles remain
local. Saved changes expansion is supplied on the first poll. Native search and
rows share renderability, JSON-array identity, and duplicate-part identity
helpers. Hidden diff matches reveal their changes section, then navigate through
the updated row index. Literal Unicode matching, ordering, excerpts, and native
selection reconciliation are unchanged. No persistence schema changed.

Ordinary IDs are byte-for-byte compatible with the old JSON-array IDs. Diff IDs
still contain filename and index. A repeated part ID in a different message or
turn remains distinct. Previously ambiguous duplicates inside one message keep
the first original ID and add an occurrence element for later duplicates; search
uses the same fallback.

## Reproducing the benchmark

```sh
nix develop --command npm run --silent benchmark:chat-rows
```

This compiles/runs the release Rust microbenchmark, counts real native
allocations on the measured thread, serializes real UniFFI responses, and loads
the production TypeScript patch applier under Node. It compares against the
frozen old implementation. Workloads contain 100 turns, 1,000 turns, and 5,000
rendered rows, with 500 latest-turn text updates and 16-file expansion/collapse.
JS allocation bytes are V8 heap-profiler samples, including collected objects;
sampling runs separately from timing. Raw results are in
`chat-row-projection-benchmark.json` (Linux x64, Node 24.18.0, Rust 1.99.0).

| Rows | Old initial JS ms | New initial Rust + JS ms | Old streaming JS ms/update | New Rust + JS row work ms/update |
| ---: | ---: | ---: | ---: | ---: |
| 200 | 0.112 | 0.343 | 0.113 | 0.00025 |
| 2,000 | 1.113 | 2.787 | 0.821 | 0.00011 |
| 5,000 | 3.325 | 6.579 | 1.998 | 0.00010 |

Setup is slower and allocates additional native metadata. The measured benefit
is repeated row work and JS allocations, not initial load speed. At 5,000 rows:

- Native initial projection allocated 6,831,125 bytes across 80,061 allocations.
- Text-only native projection work allocated zero bytes and zero descriptors. JS sampled
  allocation fell from about 7.60 MB/update to about 111 bytes/update.
- Initial serialized row payload: 283,471 bytes. Streaming row payload: 28 bytes.
  Expansion: 952 bytes. Collapse: 44 bytes. These are **additional row response
  bytes**; the existing transcript protocol continues separately. Previously
  rows were constructed in JS and contributed zero row-protocol bytes.
- Expansion row work: 2.187 ms old versus 0.0213 ms Rust + JS; collapse:
  2.041 ms versus 0.00615 ms. Native expansion/collapse used 133/14 allocations.

These are desktop microbenchmarks, excluding canonical snapshot construction,
transcript reconciliation, FFI encoding/scheduling/decoding, lazy visible-row resolution,
React rendering, layout, and painting. They do not establish device frame time,
end-to-end latency, or overall application memory savings. Re-run on the target
device before making claims about those outcomes. Serializing and transferring
the envelope still allocates; the zero-allocation figure describes projection
work only. Use `--native-results path/to/results.json` to reuse measured native
results when rerunning just the JavaScript measurements.

The subsequent [Pixel 9 Pro profile](chat-row-device-profile.md) includes the
actual UniFFI boundary: cached row availability measured 1.232 ms median versus
8.026 ms for the previous JS builder on a 443-row conversation. Fresh native
viewport setup measured 117.087 ms median across three samples. These scoped
measurements do not establish a complete old/new UI frame-rate improvement.

## Verification

Native tests cover filtering, ordering, all providers' normalized tool names,
first-part timestamps, empty/working turns, multiple messages, 1,001 turns,
501 tools, stable/collision-safe IDs, streaming growth and tail changes,
completion/failure, spacing, independent diff expansion, truncation/reset,
revision recovery, disposal/reopening, stale epochs, and offline restoration.
TypeScript tests cover typed bridge conversion, small patches, preserved arrays
and anchors, staged revisions, binding replacement, automatic recovery, bounded
failure handling, saved expansion, async initial scroll positioning, existing
render components, and search into collapsed diffs.

Generated build copies and profiling snapshots are excluded from TypeScript and
Jest source discovery.
This run's results (commands run under `nix develop`):

- Rust tests: 830 passed, 4 ignored; the ignored projection benchmark also passed
  separately in release mode. The other ignored benchmarks were not run.
- `cargo fmt --all -- --check` and all-target Clippy with `-D warnings`: passed.
- `npx tsc --noEmit`, script type checking, and full-repository ESLint: passed.
- Relevant Jest suites: 21 suites, 430 tests passed, including transcript,
  rendering, viewport, search, session lifecycle, and typed bridge tests.
- Android arm64 release native module: Kotlin and C++/Rust checks passed via
  `:react-native-whip-ssh:compileReleaseKotlin` and
  `:react-native-whip-ssh:externalNativeBuildRelease`, using the GitHub channel
  and `-PreactNativeArchitectures=arm64-v8a`. UniFFI bindings were regenerated
  with the repository tooling.

The initial validation did not install an APK. Subsequent on-device profiling
used a temporary upload-signed JavaScript instrumentation build, then removed
the profiling hooks; see the device report. A full Android application check was not completed:
the release bundle encountered memory pressure, and a bundle-skipping attempt
could not satisfy its generated resource dependency. The successful checks cover
the changed native module. iOS compilation was not run on this Linux host;
Xcode and device testing remain outstanding.

Before committing, focused checks against the subsequent repository updates
passed: 18 native projection/lifecycle tests (one ignored benchmark), 298 Jest
tests across seven suites, app and script type checking, Rust formatting, and
ESLint for the changed chat code and profiling tools.
