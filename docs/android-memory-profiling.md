# Android memory capture

Run from the repository's Nix environment with Whip already running:

```bash
nix develop -c node scripts/capture-android-memory.mjs baseline
```

The script takes three samples, separated by two seconds plus capture time,
and writes a new directory under `artifacts/memory`. It captures the installed
build, raw per-process `dumpsys meminfo --package` output, system memory, storage,
exit history, and a machine-readable `summary.json`. Associated isolated WebView
processes are included. It does not restart the app or change its settings.

Supply a label, a new output directory, and optionally 1–60 samples:

```bash
ANDROID_SERIAL=<device-serial> nix develop -c node \
  scripts/capture-android-memory.mjs cache3 artifacts/memory/cache3 5
```

Existing output directories are rejected. Without `ANDROID_SERIAL`, exactly one
authorized device must be connected. Missing process totals fail the capture
instead of silently producing zero usage; raw output remains available.

Compare the same installed build, PID, foreground screen, terminal workload,
and scrollback setting. Record background transitions separately. `dumpsys`
can request garbage collection, so use the same sampling procedure in both
conditions. A process restart invalidates a within-process comparison.

All JSON memory values are KiB. Keep native heap allocated, RSS, and SwapPSS
separate. On the inspected Android 17 build, reported total PSS includes
SwapPSS; adding the two double-counts swapped pages. A decrease in RSS can
mean more memory was paged out, rather than allocations being released.
Native heap allocations include Hermes and other native libraries as well
as Rust. These counters do not attribute memory to individual call stacks.

# Pixel 9 Pro investigation, 2026-09-14

The phone was running Android 17 and Whip 1.0.2, build 219. These measurements
describe that installed build, not the newer source or the two fixes committed
alongside this investigation. The app was not rebuilt, restarted, or reinstalled
for this comparison.

The main process remained PID 6298, and the associated WebView renderer remained
PID 10207. Each condition has three samples. The foreground Settings captures
started at 09:33:44 UTC and 09:34:29 UTC. Scrollback remained 5,000 lines.
The cache field was submitted and unfocused before measurement; its original
value of 20 was restored and verified after the comparison.

Median values, in KiB:

| Metric | Cache capacity 20 | Cache capacity 3 |
| --- | ---: | ---: |
| Main native heap allocated | 778,902 | 777,970 |
| Main Java heap allocated | 18,734 | 18,742 |
| Main RSS | 628,964 | 648,100 |
| Main SwapPSS | 945,534 | 930,721 |
| Main reported PSS | 1,436,543 | 1,440,936 |
| WebView renderer native heap allocated | 6,033 | 6,033 |
| WebView renderer reported PSS | 46,804 | 46,755 |

The main native allocation difference is 932 KiB (0.91 MiB, 0.12%). RSS increased
while swap decreased. This is not evidence of a meaningful memory improvement.
The main process reported zero live WebView objects in both Settings captures:
the high main-process allocation persisted without live terminal views. This
was not a benchmark of evicting a fully populated 20-view cache. The short,
sequential comparison cannot establish a leak or isolate allocation owners.

An earlier background capture had approximately 726 MiB of main native heap
allocations and much lower RSS, with more memory swapped out. The initial device
diagnostics also showed repeated low-memory kills and nearly exhausted storage
and swap. System pressure and foreground transitions confound RSS comparisons.

The source explains why the cache setting is not a native-bridge limit:

- `src/lib/terminalRendererLru.ts` limits retained xterm renderer entries.
- `TerminalRendererHost.disposeEntry` removes an evicted xterm view but calls
  `TerminalBridgeController.detachTerminal` to keep its bridge warm.
- `HostRuntimeConnection.detachHerdrBridge` removes the JavaScript event handler;
  it does not close the native bridge. The bridge-retention tests explicitly
  exercise this behavior across clients without a maximum.
- Explicit release, removing a terminal target, and disconnecting the host have
  separate cleanup paths. Changing eviction to close connections would change
  terminal resume behavior and needs its own ownership/reconnection coverage.

The next useful measurement is allocation attribution in the main process,
including Rust/SSH, Hermes, and transcript state. On a production Android OS,
[Perfetto heapprofd](https://perfetto.dev/docs/data-sources/native-heap-profiler)
requires a debuggable or profileable app. This project's release manifest does
not opt into shell profiling. Use an upload-signed local release with an explicit
profiling configuration for that experiment, preserving the app sandbox; retain
symbols from the same build. See Android's
[profileable manifest documentation](https://developer.android.com/guide/topics/manifest/profileable-element).

For a populated-cache follow-up, visit more terminals than the configured
capacity, repeat the same terminal sequence at each capacity, and compare native
allocation stacks as well as WebView memory. Include reopen latency and terminal
continuity before deciding whether to bound retained bridges. No cache defaults,
bridge ownership semantics, or SSH timeouts were changed from these measurements.

Raw phone captures remain locally under
`.codex-diagnostics/phone-20260914/memory-settings20` and `memory-settings3` and
are excluded from Git. Only the aggregate measurements are recorded here.

## Chat transcript retention

Inactive chat transcripts have a zero-byte resident cache budget. Switching to
another terminal or app section, returning to Terminal View, or backgrounding
the app detaches the chat. Rust freezes the stream, returns a final opaque
checkpoint, and removes the parsed session and pending checkpoint tokens.
The UI releases its transcript copies and remembers only the selected chat's
identity. Shared transcripts stay active until their last view detaches.

`whip-agent-chat.db` retains the complete checkpoint for each agent still present
on the host. SQLite serializes the final archive with other writes; an immediate
reopen waits for those writes before restoring history. Codex checkpoints end at
the last complete JSONL record, so partial tails are reread from the remote
source. OpenCode checkpoints preserve the event cursor. Returning to a chat
restores its checkpoint and verifies/catches up with the remote source before
revealing the viewport.

Ending or removing an agent deletes its local transcript row through authoritative
host reconciliation, including agents whose views are already inactive. Pending
writes finish before deletion, and later writes to removed keys are rejected.
Native operation epochs also reject bridge events queued before a detach or
replacement, so they cannot update a reopened chat or recreate obsolete history.
Closing a local view preserves SQLite history; it does not end the remote agent.

The budget applies to retained inactive transcripts, not active history or
temporary checkpoint/SQLite buffers. Persistence failures are recorded in app
diagnostics; reopening can recover from the remote transcript. Freeing objects
does not guarantee an immediate RSS decrease because allocators may keep pages.
Repeat the same multi-chat navigation sequence and background capture on the
phone to measure the resulting native/Hermes reduction; the earlier measurements
above predate this change.
