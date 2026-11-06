# Navigation responsiveness with retained chats

The reported delay affected every tab transition on the connected Pixel 9 Pro.
During six alternating Herd/More selections in an 18-second Perfetto capture,
Whip's JavaScript thread used 67.38% of one CPU core. A separate Herd sampling
profile placed 1,163 of 1,225 samples under React's scheduled root work.
These measurements identify rendering overhead; they do not measure exact
tap-to-visible latency.

Three retained priority chats were treated as active screens, so unrelated
parent renders redrew their prepared UI. Replacing host target objects also
renewed their foreground pins and transcript subscriptions. Those operations
notified the residency store subscribed to by the application root, causing
additional synchronous renders.

New voice settings/call context values and a composer selection callback keyed
to the complete target object also invalidated consumers below memoized screen
boundaries. Context propagation bypasses those boundaries.

The fix keeps hidden priority views current when their transcript changes,
while skipping unrelated parent updates. Pins depend on host/terminal identity,
and subscriptions depend on binding and selection identity. Voice and composer
contexts retain their values until the relevant settings or selected terminal
change. Native attention/terminal projections are reused for unrelated renders.
The AppShell request counter uses `useReducer`.

Validation: 366 tests passed across screen retention, session chat opening,
application presentation, transcript cache, and composer keyboard suites.
The new pin-retention and selection-context regression tests were also run
against the original components through a separate Jest transformer; both
failed as expected. Focused ESLint, TypeScript, and whitespace checks passed.

Captures, profiles, the original APK and source map, build logs, and regression
comparison logs are saved under the ignored directory
`artifacts/perfetto/navigation-20261106/`.

The GitHub-channel arm64 release built successfully with upload signing and
local developer R8 skipping. Its certificate matches the original installed
APK, and the artifact contains only `arm64-v8a` native libraries. APK SHA-256:
`4a1553eb6cf3e196e1e09edff803ca2136fbbe0d56796f13585d47eb3ad2d972`.
The upload-signed APK was installed over the existing app on the Pixel 9 Pro
using `adb install -r`, which reported success. The launch command brought
Whip's task to the foreground. USB disconnected immediately afterward, so an
on-device responsiveness improvement has not yet been verified.

## Remaining transition work

After installation, the user reported an improvement but still observed slow
switches. A new six-switch capture with Hermes sampling measured 51.94% of one
CPU core on JavaScript. Most active samples still belonged to synchronous React
root rendering. The live workload and expanded settings differed between these
captures, so the CPU observations are not an isolated benchmark.

Membership policy evaluation returned new capability sets and controller objects
on every app render. The adapter now reuses semantically unchanged projections
while continuing to ask Rust to evaluate the current clock on every render.
Purchase events, trial deadlines, and resume still refresh access decisions.

More and Herd now memoize their contents behind stable callbacks that forward to
the latest committed props. Herd presentation is prepared lazily and reused
until session data or filters change. This avoids rebuilding unchanged screen
contents merely to reveal their mounted native tree. Navigation emits
`Whip navigation selection to commit: <tab>` traces for direct measurement.
Mounted-tab retention and the More purchase-sheet flag use reducers.

The follow-up passed 94 focused tests, including callback freshness, preference
updates, unchanged membership identity, trial expiry, and Herd projection
invalidation. ESLint and TypeScript checks passed. The upload-signed arm64 APK
was installed in place successfully, with SHA-256
`d97f31ba7cd2804a66897ab01c698993cf3f80c5ed6c8702b3b2e3a1627a2ce2`.

The user confirmed bottom navigation was good after this update. Warm automatic
Herd/More captures measured 29.89% JavaScript CPU. Selection-to-effect-commit
slices were 212–388 ms for Herd and 224–265 ms for More in the first capture,
and 138–237 ms across both destinations in a subsequent capture. These slices
include passive effect processing and do not measure displayed-frame latency.

## Workspace chips and terminal tabs

The user then identified both workspace chips and terminal tabs as still slow.
A passive capture during the user's own test recorded seven terminal
selection-to-renderer-entry slices: median 201.14 ms, p95 213.09 ms, maximum
213.49 ms. Discard `workspace-before` as a reproduction: the phone left Whip
during that automated capture.

The next change memoizes individual workspace and terminal buttons using their
displayed fields. Stable handlers look up the latest committed resource by ID,
so unchanged buttons can be retained without keeping stale menu targets.
Terminal focus requests no longer toggle the global edit busy state or get
dropped by its mutation guard. The hidden terminal rail skips redraws while
Herd workspace filters change; its title cache still updates, and the rail
refreshes before being revealed. Transcript cache reconciliation also reuses
its supplied host snapshots for speech labels instead of synchronously fetching
the full host once per cached conversation. Events outside reconciliation still
read fresh metadata.

This follow-up passed 352 tests across rail menus, session chat/focus, workspace
selection, navigation, and transcript service suites. ESLint and TypeScript
checks passed. Upload-signed arm64 APK SHA-256:
`7ac5869e0f1013973e3788f5f867362bb021c65ec5c2086c9592692740bfb60e`.
It was installed in place successfully. After manually retesting both workspace
chips and terminal tabs, the user reported that they felt OK.

The final passive user test recorded four terminal selection-to-renderer-entry
slices: minimum 104.78 ms, median 175.54 ms, p95 185.14 ms, maximum 186.33 ms.
Four workspace selection-to-layout-commit slices measured minimum 157.41 ms,
median 199.86 ms, p95 348.50 ms, maximum 369.69 ms. Sample counts are small and
the selected resources/workload differed; these are device observations, not a
controlled speedup benchmark or total input-to-displayed-frame latency.
Both Perfetto capture and Hermes sampling were stopped after verification.
