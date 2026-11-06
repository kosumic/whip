# Pixel navigation measurements

Measured on the connected Pixel 9 Pro, inside Whip's Herd/Terminal screens and
the `kk` / `setting` terminal tabs on the same connected host. This does not
measure Android app switching.

Both APKs are production-JavaScript, upload-signed GitHub-channel releases,
version 2.0.0 (236), arm64 only, built locally with `whip.skipR8=true`. Every
installation used `adb install -r`; Whip's data was preserved. The baseline
already includes the four snapshot/input changes described in
`ios-navigation-responsiveness-2026-11-06.md`.

## Changes

- Transcript-cache pin/listener bookkeeping reconciles imperatively instead of
  invalidating the application root through `useSyncExternalStore`.
- The terminal screen's cache snapshot changes when bindings appear/disappear,
  rather than for every pin/listener change. Rust still decides retention.
- Closed command history no longer constructs its rows and translated labels
  during terminal renders.
- Unchanged keyboard-protocol notifications and resets preserve React state.
- The root preserves its current projection when Rust's revision is unchanged
  or older. Rust increments that revision for host changes and local selection.

The cache-root and unchanged-projection regressions failed before their fixes
and passed afterward. Existing transition-replay, lifecycle, retention,
foreground/resume, composer and native-input checks passed. Focused ESLint,
TypeScript and whitespace checks passed.

## Method and limits

A separate temporary Android instrumentation APK injected real touchscreen
DOWN/UP events. It located controls by exact accessibility labels, guarded
against hidden retained controls, and validated the selected destination after
every action. It never sent terminal input. Each state-timing pass performed
six cycles of Terminal → setting → kk → Herd. Discarding the first cycle leaves
five entering, ten tab-switching and five leaving observations per pass.

The reported state interval starts at native touch UP and ends when Android's
accessibility tree reports the expected selected UI. It includes query overhead
and is **not tap-to-displayed-pixels latency**. No profiler ran during these
state-timing passes. Final comparisons left the live chat quiet during the run.

Earlier runs interleaved diagnostic work with a live connected workload. The
first cache-only pass looked faster, but its repeat did not reproduce that gain.
Those results do not establish a cache-only speedup. Raw records retain every
completed pass rather than selecting only the fastest result.

## Quiet comparison

Medians for the quiet baseline and both completed final-build passes:

| Touch UP → selected native UI state | Baseline | Final pass 1 | Final pass 2 |
| --- | ---: | ---: | ---: |
| Enter Terminal | 828 ms | 667 ms | 599 ms |
| Switch terminal tabs | 737 ms | 553.5 ms | 556 ms |
| Return to Herd | 1,392 ms | 744 ms | 760 ms |

Each column has five enter, ten tab and five exit observations. In the second
final pass, maxima were 644 ms entering, 716 ms for tabs, and 1,252 ms leaving.
The largest individual accessibility query in those groups took 75, 71 and
133 ms respectively. These observations support an improvement, but the
remaining delays are substantial. They do not establish displayed-pixel timing
or a guarantee under every connected-host workload. A repeat attempt that lost
Whip foreground before its first touch was discarded and retried from the
validated starting tab.

Separate Perfetto passes delayed accessibility queries for 1.5 seconds after
each tap and correlated injected touch timestamps with existing application
selection/commit and renderer-entry markers. These markers precede confirmed
display. Terminal exit does not currently emit that selection marker, so its
state timings cannot be treated as an equivalent app-side commit measurement.

The final short traces each retained all three expected markers with no reported
data-loss statistics. Touch UP → the enter commit was 505.5 → 361.8 ms. Touch UP
→ renderer entry for the two tab directions was 362.1 / 498.5 → 280.5 / 280.1 ms.
These are one enter and two tab observations per APK, not a percentile benchmark.
The final tab handlers started 6.7–16.1 ms after UP and spent 264.3–273.4 ms
before renderer entry: synchronous work after the handler remains a bottleneck.

The final APK is `Whip-v2.0.0-236-arm64-navigation.apk` in the artifact directory,
SHA-256 `7ebf00cc30bcd214eedfd77d54bba0db3493b3720af53aad58b90d40cc40799c`.
Its installed `base.apk` hash matches. Upload signing, version and arm64-only
native code were verified. The final build is installed in place on the Pixel.
Sampling/touch diagnostics are off, the temporary test APK was removed, and no
Android Studio screen-mirroring agent was running at cleanup.

Artifacts, signed-APK hashes, query timings, test/build logs, the temporary
instrumentation source and comparison summaries are in
`artifacts/perfetto/pixel-navigation-20261106/`. Superseded intermediate APKs were
removed to recover disk space; the baseline and final APKs remain. Diagnostic
traces, profiles and source maps are retained, with large files gzip-compressed.
