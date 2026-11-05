# Android transcript startup profile

Measured on 2026-11-03 on a Pixel 9 Pro with an upload-signed, ARM64 GitHub-channel
release build (`whip.skipR8=true`). The profiling APK SHA-256 is
`7b038b418f67e547485d54ff00be6f22d8bf0b24c344f1571548f0d3526e069c`.
These are observations from one device and workload, not latency percentiles.
The user confirmed the fresh session was **Codex**. No fresh OpenCode timing was
captured in this run.

## Measurement boundaries

Native stage durations use `std::time::Instant`. JavaScript diagnostics include
`performance.now()`. Logcat timestamps correlate native and JavaScript events;
durations are calculated within each clock domain where possible.

The explicit Chat marker records entry to the JavaScript button handler. It
does not measure physical touch-down or input delivery before that handler.
The visibility marker records React's reported visible presentation; it does
not measure the final displayed frame. Binding adoption is the start of local
transcript preparation, after the remote agent identity has become available.
Agent process startup and initial identity publication are outside that span.

Cache lookup includes database-worker queueing, the query, and resumption of
the awaiting caller. It must not be described as pure disk I/O. The cache
snapshot stage includes core restoration, cloning its state, and lock wait.
Cache stages precede the new remote-operation epoch, so correlate them by
transcript key and timestamp rather than the remote epoch alone.

SSH command elapsed time includes command-budget queueing, the channel-opening
gate, channel opening, sending the exec request, reading the command result,
and closing the channel. Read time includes remote execution and network
delivery. First-stdout time is a subset of read time. It does not separate shell
startup, command execution, and network transit.

The history span includes its individual history-command spans. Likewise,
parsing spans occur inside the tail-transfer interval. Do not add these nested
durations to their parent a second time. Diagnostic logging adds some overhead.

## Fresh Codex session

This was a local cache miss, with one normalized turn and 481,657 bytes of raw
rollout data including initialization records. It was not an empty file.

| Native stage | Measured duration |
| --- | ---: |
| Await cache lookup, returning no checkpoint | 228.3 ms |
| Blocking-worker scheduling | 0.2 ms |
| Cache restoration / initial state snapshot | <0.1 ms |
| Discover rollout | 91.8 ms |
| Read metadata and title | 93.0 ms |
| Resolve history, including the header command | 90.8 ms |
| Open tail stream | 11.1 ms |
| Tail startup through initial ingestion completion | 162 ms |
| Initial ingestion processing, included in the preceding interval | 23.0 ms |

The three completed remote commands totaled 273.4 ms, including just **0.032 ms
of command-budget queueing** and 29.6 ms of channel opening. The SSH command
budget was not a bottleneck in this fresh sample.

Binding adoption to native live data took approximately **807 ms**. The table
does not account for every millisecond: approximately 130 ms was between the
timed stages, including scheduling, binding changes, and publication of reset
and metadata events. The capture does not isolate those gaps further.

The Chat handler ran about 79 ms after the transcript was already live. Its
remaining delay was in the UI:

| UI interval | Measured duration |
| --- | ---: |
| Chat handler to viewport mount | 163.8 ms |
| Mount to first projection with a row ID | 310.8 ms |
| First row projection to readiness callback | 71.8 ms |
| Readiness callback to reported visible presentation | 151.5 ms |
| **Chat handler to reported visible presentation** | **697.9 ms** |

Binding adoption to reported visibility was **1,586.4 ms**, including the
preloading interval and the user's delay before pressing Chat. This is a
different boundary from handler-to-visibility latency. The row-projection
interval includes hook scheduling, native row access, and rendering; this
capture does not attribute all of it to native computation.

Only one explicit Chat-handler marker was captured for the fresh session.
There is no separately measured same-binding warm-reopen sample.

## Existing cached conversations

Four selections of cached conversations had 1.1–2.2 MB checkpoints:

- Awaited cache lookup: **725–835 ms**.
- Core restoration and snapshot: **21–44 ms**.
- Binding adoption to reported visibility: **2.19–4.07 seconds**.

A separate roughly 19 MB background transcript took **449–629 ms** for cache
lookup and **396–480 ms** for core restoration and snapshotting. These are
cache rehydration samples, not retained-view warm reopens. Remote refresh and UI
work can overlap for cached transcripts, so the intervals must not be summed
as if they were all sequential.

## Background rebind loop and crash

The extended capture contains a separate failure after the foreground sample:

- At 14:44:23.407 the app reported a transition to the background.
- Between 14:44:24.090 and 14:44:47.173 it adopted **77 bindings** for the same
  fresh Codex transcript, repeatedly starting from revision zero.
- At 14:44:47.266 React reported **Maximum update depth exceeded** in
  `SessionScreen`. Android recorded a fatal JavaScript exception at
  14:44:47.352.

Source inspection identifies a lifecycle mismatch: the foreground selection
lease and viewport subscription end on backgrounding, but the restore-intent
effect uses the screen's `visible` flag without checking `appActive`. It can
therefore reactivate a binding that cache reconciliation immediately releases.
This explanation is consistent with the captured sequence; no functional fix
was applied in this profiling task. The small foreground timing sample must
not be interpreted as evidence that all cache churn has been eliminated.

## Findings and limits

The fresh sample's visible delay after pressing Chat was UI preparation even
though the data was already available. Row initialization and the subsequent
visibility update merit investigation before assuming remote round trips
dominate the button delay. The cache wait, including a 228 ms miss, is another
measured cost; database-worker queueing, query time, and caller resumption need
separate timings to explain it further.

The background rebind loop and crash are a higher-priority correctness issue
than tuning the smaller foreground timing costs.

No latency optimization was made as part of the original profiling run. Those
changes add diagnostics and internal SSH timing metadata. Existing transcript
and SSH behavior checks passed: 85 transcript tests, 35 SSH tests (one
pre-existing ignored test), 183 chat UI tests, TypeScript, and targeted ESLint.

## Background restoration correction

The follow-up fix requires both screen visibility and an active app before
restoring an evicted Chat binding. Inactive/background cache eviction keeps
the selected conversation pending until foregrounding. Independent transcript
subscribers, including an active voice call, still retain their cache entries.

Nine new regression cases failed before this correction and pass afterward
across Codex, OpenCode, and Pi. They cover inactive/background eviction,
repeated cache reconciliation without reopening, one restoration on return,
and retention until an independent subscriber releases ownership. The full
targeted cache, Chat, and voice suite passes 269 tests, plus TypeScript and lint.

## Capture and analysis

### Retained foreground resumes (#363)

The retained viewport regression is separate from the cache-rehydration samples
above. A Pixel 9 Pro capture on 2026-11-05 confirmed that a same-process resume
reset completed readiness without a viewport unmount or binding replacement:

- `14:22:03.120`: app moved from active to background.
- `14:22:05.191`: app returned to active.
- `14:22:05.692`: the same retained viewport reported `ready: false`, then
  `ready: true` and its initial-ready callback, with source `retained-position`.

That is **501 ms from the app-active log to the readiness callback**. The
capture has no first-displayed-frame marker, so it does not establish a 501 ms
blank interval or isolate all of that time to readiness work. The native
activity launch was HOT; transcript cache rehydration was not this boundary.

The fix preserves readiness across activity changes when the mounted list,
binding/source, and saved position remain compatible. Background appends can
catch up while existing rows remain visible. Identity or row-owner replacement,
authoritative native row resets, transcript revision rollback, incompatible
geometry/insets, and unsafe retained positions still prepare before reveal.
Inactive eviction keeps the checkpoint saved at suspension rather than
overwriting it with hidden native movement.

Resume diagnostics now include:

- `chat-app-state-changed`: the JavaScript AppState notification, with a
  monotonic timestamp. Pair background and active events for the measured run.
- `viewport-activity-changed`: activity and readiness at the lifecycle boundary,
  plus row revision, row reset version, and list generation.
- `viewport-retained-reactivated`: completed readiness was reused.
- `viewport-invalidated`: why preparation was required.
- `native-rows-projected`: initial or reset native projection was committed.
- `viewport-visible` and `viewport-visible-frame`: root visibility committed
  and the next JavaScript animation-frame callback, with activation path,
  session, generation, and time since viewport activation.

Correlate these with `viewport-mounted`/`viewport-unmounted`, binding adoption,
and the existing readiness diagnostics. `cold-mount`, retained reactivation,
and retained preparation are different paths. A changed generation identifies
list preparation; it is not necessarily a new transcript binding.

The animation-frame callback is a JavaScript frame opportunity after React
reports visibility, **not proof that the compositor displayed the pixels**.
For app-active-to-frame latency, subtract the two event `monotonicMs` values;
the visibility event's `elapsedMs` starts later, at viewport activation. Do not
substitute the older rehydration timings for either interval.

The two new visibility regressions fail against the original component. With
the fix, all 389 targeted viewport, SessionScreen, row-owner, and retention
tests pass, along with TypeScript and targeted ESLint on `main`. They cover
retained-list identity and every committed root opacity during resume,
background appends before/after measurement, manual anchors and hidden native
movement, identity/owner/reset/revision changes, geometry/insets, and eviction.

An after-device timing is **not available**. The isolated JavaScript profiling
bundle was packaged with an existing upload-signed ARM64 native APK, but failed
startup on the unrelated UniFFI voice recognition-ended bridge checksum. A
retry with frozen bindings also failed that check. The original working APK
was restored with `adb install -r`; no uninstall or app-data deletion was used.
These failed startups are not resume samples, and no latency improvement is
claimed from them. A coherent native-and-JavaScript rebuild is still needed
for the after-device measurement.

Collect logcat at `threadtime` resolution, including `WhipHostRuntime` and
`ReactNativeJS`. Native records use `phase=startup-timing`, a hashed transcript
key, stage name, elapsed milliseconds, and optional command timing fields.
They do not record commands or transcript contents. JavaScript records include
`chat-open-pressed`, binding adoption, viewport mount, readiness, and visibility.

Local artifacts from this run:

- `.codex-transcript-profile-phone.log`: raw capture.
- `.codex/transcript-startup-measured.json`: parsed timings and events.
- `.codex/transcript-startup-measured.md`: per-binding timing tables.
- `.codex/profile-transcript-startup.mjs`: capture analyzer.

The earlier capture remains in `.codex/transcript-startup-baseline.md`. It has
no explicit button marker or native stage durations, so it cannot establish
tap-to-display latency or a per-command breakdown.
