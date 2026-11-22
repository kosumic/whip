# Tab creation and metadata recovery (#490)

Whip keeps terminal activation on the acknowledged `tab.create` response. The
background state paths differ because the backends provide different guarantees:

| Backend | Ordinary local creation | Recovery |
| --- | --- | --- |
| Legacy | Merge returned tab/root identity, preserving newer lifecycle metadata and existing layouts. Renew the known pane subscriptions before fetching state. | One snapshot after renewal covers the stream gap and missing geometry. Another reconciliation is required only if the snapshot discovers additional panes. |
| Core | Project the cached terminal model and acknowledged desktop document, including its exact layout. Late document echoes at an acknowledged version require no refetch. | Higher external document versions get a targeted document read. Missed events still invalidate documents and machine discovery. Transport failure, invalid projection, or refresh failure retains snapshot/reconnect recovery. |

There is no lossless, general snapshot-free legacy path with the existing
protocol. Status/scroll subscriptions enumerate pane IDs; replacement closes the
old stream, and acknowledgement supplies neither replay cursor nor state for the
gap. `TabCreated` also omits geometry. Whip does not infer layout dimensions from
the terminal, or remove the snapshot protecting this gap. A layout already
received through events can complete the control projection, but does not by
itself recover missed per-pane events.

Core serializes projection with controls and defers publication during an active
host snapshot. This prevents an older in-flight recovery result from erasing a
new creation. External changes use the model's revision/document rules, rather
than an assumption that the next event belongs to the local create.

## Reproducible cold-tab measurement

Use an upload-signed arm64 Android build from the GitHub channel, an authorized
physical device, and a disposable workspace on an already connected host. Use the
same server, network, initial tab count, build mode, and device for comparisons.
Run separately for a legacy host and a Core host.

1. Start a bounded runtime log capture (stop it with Ctrl-C after the experiment):

   ```bash
   mkdir -p artifacts/perfetto
   nix develop -c adb logcat -T 1 -v epoch -s WhipHostRuntime:I '*:S' > artifacts/perfetto/tab-create-runtime.log
   ```

2. In a second terminal, capture 30 seconds:

   ```bash
   nix develop -c scripts/capture-android-perfetto.sh 30 artifacts/perfetto/tab-create.perfetto-trace
   ```

3. Create five new tabs sequentially, typing a character into each when selected.
   Each must have a new renderer/terminal identity. Also capture a separate burst
   of rapid creates and one external split/rename; exclude these from sequential
   latency percentiles. Do not include initial host connection in the window.
4. Summarize metadata RPC/projection, subscription, and logical snapshot counts:

   ```bash
   nix develop -c node scripts/benchmark-tab-create.ts artifacts/perfetto/tab-create-runtime.log
   ```

5. Query the trace using `scripts/analyze-android-perfetto.sql`. Compare
   `Whip Herdr tab create RPC`, selection-to-renderer, renderer readiness,
   bridge/channel open, Hello/Welcome, initial resize, and first input-to-visible.
   Runtime log epochs correlate background snapshots with those intervals. The
   snapshot log counts logical refreshes; transport retries may send additional
   requests. A single debounced legacy snapshot can recover a burst of creates.

For an otherwise idle Core host, expect no subsequent snapshot or subscription
renewal for tab creation. On legacy, expect one renewal followed by one recovery
snapshot, provided no concurrent unknown topology change requires reconciliation.
Do not add overlapping phase durations together: renderer and background metadata
recovery can run concurrently. Attribute the remaining delay using the actual
critical path in the trace.

## Device availability during implementation

Initially the workstation exposed only `emulator-5574` (`sdk_gphone64_x86_64`).
The reused mini checkout exposed a
paired physical iPhone, but `devicectl device info details` reported that the
developer disk image could not be mounted.

A Pixel 9 Pro was subsequently connected. The GitHub-channel arm64 release
APK, version 2.4.1 (245), built successfully with the upload key and the documented
local `whip.skipR8` option. Its certificate matched the installed app; `adb install
-r` updated it in place, launch succeeded, and the app remained running without
an Android startup crash. No uninstall or app-data reset was performed.

Before/after on-device latency measurements remain outstanding. Successful
installation/startup and desktop SSH fixtures do not establish renderer/bridge
latency on a phone; no dominance or phone latency claims are made.

## Validation

All checks ran through `nix develop`:

- Host state: 63 passing tests, including exact-layout/event ordering,
  transactional rejection, Core freshness/generation fences, deferred recovery,
  and pending scroll-read invalidation.
- Host runtime: 275 passing tests, one unrelated opt-in proxyjump test skipped.
  The legacy loopback SSH regression observes exactly `events.subscribe` then
  `session.snapshot`, and recovers a status changed during the subscription gap.
- Full protocol suite and doctest pass, including rapid Core creates, delayed
  document echoes, concurrent document revisions and `missed` recovery.
- Live Core 0.1.19 integration passes with the installed binary, isolated server,
  and real loopback SSH: direct model tab/layout projection, multiplexed terminal
  traffic, restart, reconnect, and exec fallback.
- Three relevant JavaScript suites: 224 passing tests. App TypeScript, script
  TypeScript, changed JavaScript lint, and strict native/protocol Clippy pass.

An initial broad parallel `host_` filter also selected reverse-control suites
that share global platform/session state. Six tests failed in that mixed run;
all six pass when their suites run serially in separate processes (16 host-tool
tests, nine voice-operation tests, and the session-isolation test). The focused
host-runtime suite also passes serially. This does not establish a clean broad
parallel run.
