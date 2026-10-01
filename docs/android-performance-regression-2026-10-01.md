# Android global rerendering regression

Investigation on the connected Pixel 9 Pro, using an upload-signed arm64 release
and the existing app data. The reported slowdown affects all screens.

## Findings

The JavaScript thread remains saturated after terminal history finishes loading,
including while the static More screen is selected. Terminal output consequently
waits for JavaScript before reaching its WebView.

Hermes sampling then identified the dominant work: 3,394 of 3,598 Herd samples
(94.3%) were inside React's root work. NativeWind styling, repeated hook renders,
context propagation, and allocation dominated the stacks. Hidden host rows and
Herd content also appeared while another screen was selected.

The primary render loop came from session projection updates. Root diagnostics
showed a new session-state object approximately every 150 ms while terminal state
was unchanged. The manager queued a terminal-state update followed by an
allocating functional session updater in the same transition. React replayed
that updater while processing other updates, producing new session identities
and retriggering session effects. Caching the native projection object itself
with `setState(view)` preserves identity across those replays. That change is
included in the concurrent Rust state ownership refactor, commit `71d315f`.

`GlassProvider` created `{ blurTarget, enabled }` on every parent render. Context
consumers, including hidden Herd and Terminal screens, therefore rerendered even
when glass settings were unchanged. Context updates bypass the memoized
`ScreenUpdates` boundary. Stabilizing that provider value prevents unrelated
host updates from invalidating all those consumers.

There was also redundant transcript work. `SessionScreen` reconciles retained agent chat bindings on terminal/host updates,
including bindings whose chat viewport is hidden. Previously every reconciliation
called `currentAgentChat`. Rust cloned the complete transcript, UniFFI transferred
it synchronously, and TypeScript rebuilt the presentation projection even when
the transcript revision had not changed. The measured Codex cache was 18,541,043
bytes; this routine read must not scale with conversation history.

Temporary JavaScript timing markers were added to a diagnostic bundle packaged
with the phone's original native libraries. Markers were removed from the final
source. Twenty-second diagnostic captures measured:

| Screen | JS CPU, one core | Full transcript reads | Total synchronous read time | Largest read |
| --- | ---: | ---: | ---: | ---: |
| Terminal, catching up | 86.21% | 70 | 1,177.47 ms | 100.39 ms |
| Terminal, settled | 90.02% | 83 | 1,261.53 ms | 25.52 ms |
| More, settled | 94.62% | 70 | 1,137.35 ms | 44.17 ms |

The settled terminal capture measured inbound-to-visible latency of 225.60 ms
at the median and 376.20 ms at p95. AppCore host projection took only 35.57 ms
across four calls in that capture. Transcript reads are a measured contributor;
these system traces do not attribute all JavaScript CPU to them.

## Changes

Session state retains the native projection object across transition replays.
A behavioral regression test queues both state updates, suspends the transition,
and interrupts it with urgent renders. The original allocating updater fails
with three different identities; the fixed updater preserves one. Both updates
matter: a single-state fixture allows React's eager evaluation to hide the bug.

The glass provider memoizes its value by blur target and enabled preference.
Hidden screens retain their native trees and receive real preference changes,
while unrelated parent renders no longer update the context.

Rust now exposes an identity-and-revision check that returns a boolean without
cloning history. `NativeTranscriptService` reuses its delta-maintained render
cache when the same transport, binding token, and revision are still current.
Missing deltas, replaced bindings, closed terminals, and changed transports retain
the full reconciliation path. Rust owns the freshness decision.

The first transcript-only device build still measured 89.31% JavaScript CPU and
227.80 ms median terminal latency, so that change alone did not resolve the
reported slowdown. With both transcript and glass changes, JavaScript still used
90.54% of one core on Terminal and 96.48% on More. Terminal median/p95 latency
improved to 100.12/147.01 ms, but the session render loop still needed fixing.

## Final device measurements

The full integrated arm64 release built successfully and was installed in place
with the upload certificate. Screenshots verified Whip remained foreground
during these twenty-second captures. The terminal loaded its history and
continued receiving output. The final APK SHA-256 is
`c15eb8d9b982866d12b27e58982eb71df1b0f83c9c25e380fa9cfd12e291371c`.

| Measurement | Original diagnostic release | Final integrated release |
| --- | ---: | ---: |
| Terminal JS CPU, one core | 90.02% | 7.98% |
| Terminal total app CPU, one core | 161.70% | 58.33% |
| Terminal inbound-to-visible median | 225.60 ms | 31.14 ms |
| Terminal inbound-to-visible p95 | 376.20 ms | 59.64 ms |
| Terminal measured frames / bytes | 83 / 20,802 | 136 / 31,645 |
| More JS CPU with terminal resident | 94.62% | 13.65% |
| More total app CPU, one core | 125.75% | 40.44% |

The final More capture received 501 terminal frames containing 113,710 bytes
while retaining the hidden terminal. A separate More capture before mounting
the terminal used 2.49% JS CPU; that quieter capture is not the comparison above.
The saturated JavaScript thread is resolved in these device observations.

## Validation

- 148 JavaScript tests passed across seven focused suites, including session
  replay, hidden screen context, transcript, chat-opening, and native bridge tests.
- The Rust test verifies unchanged, changed, replaced, missing, and closed
  bindings.
- Two glass/hidden-screen tests verify that routine parent updates do not render
  a hidden context consumer, but changing the preference does.
- Focused ESLint, TypeScript checking, and `git diff --check` passed.
- The strengthened replay test was checked against the original allocating
  updater: it fails there and passes with the cached native projection.
- The full upload-signed arm64 release built and installed without uninstalling
  or clearing application data.

Raw captures, screenshots, logs, the original APK backup, and analysis results
are in `artifacts/perfetto/regression-20261001/` (ignored by Git). Captures named
`diagnostic-ready` and `diagnostic-more-ready` were taken after the user left Whip
open. Discard `diagnostic-settled` as a foreground comparison: the phone switched
to another app during that capture.
Final comparisons use `integrated-final-terminal` and
`integrated-final-more-resident`. Exclude the isolated bundle repacks
(`glass-isolated` and `stable-isolated`): their terminal did not load correctly.
The final measurements use the full Gradle-built APK and its matching source map.

The live remote terminal workload and source tree changed during investigation;
the final build includes concurrent workspace changes. Results are device
observations, not an isolated benchmark of a single commit. Some diagnostic
captures report discarded tracing chunks, so sample counts are lower bounds.

## Sampling JavaScript on a release APK

Profiling is off by default. An explicit activity dump command enables Hermes
sampling without adding a JavaScript timer or UI control:

```bash
nix develop -c adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-hermes-start
# Reproduce the slowdown, then stop and retrieve the profile.
nix develop -c adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-hermes-stop
nix develop -c adb pull /sdcard/Android/data/io.github.kaminarios.whip/files/whip-hermes-profile.json
```

Keep the exact APK's `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`
before another build replaces it. To resolve the Hermes frames, give a copy of
the profile a `.cpuprofile` suffix and run:

```bash
nix develop -c node node_modules/metro-symbolicate/src/index.js index.android.bundle.map whip-hermes-profile.cpuprofile
```
