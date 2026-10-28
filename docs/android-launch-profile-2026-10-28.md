# Android launch profile, October 28, 2026

Profiled the connected Pixel 9 Pro running Android 17, with Whip 1.10.0
(versionCode 234), its existing saved hosts, and application data intact.
The installed APK exactly matched the checkout's existing local release APK
(SHA-256 `af4a1920f9776cd7dc3e13de819a2f367082a1781043ec9747f3bf70389e1bfe`),
so its saved Hermes source map could resolve the startup samples.

Measurements use launcher intents and `am start -W`'s `TotalTime`. Cold runs
force-stop the process first; hot runs return from Home to the retained activity.
These are process-cold launches with ordinary filesystem caches, not first
installation, cleared-data, or reboot measurements. The target is the first app
screen, not completion of SSH reconnection. Android distinguishes initial display
from fully drawn readiness; Whip does not currently report `reportFullyDrawn`,
so no TTFD number is claimed. See
[Android's startup measurement guidance](https://developer.android.com/topic/performance/issues/launch-time).

The small logo changes reduced the cold-launch median by **20.1%**, from
**1.332 s to 1.064 s**. All seven final cold launches were faster than the
fastest original baseline launch. This is a useful low-effort improvement;
the measurements do not establish a stable p95 or a universal device result.

| Measurement | Original release | Final release |
| --- | ---: | ---: |
| Cold launches | 7 | 7 |
| Cold median | 1,332 ms | 1,064 ms |
| Cold mean | 1,375 ms | 1,054 ms |
| Cold observed range | 1,296–1,561 ms | 933–1,142 ms |
| Hot returns | 5 | 5 |
| Hot median | 90 ms | 71 ms |
| Hot observed range | 84–121 ms | 57–100 ms |

Three additional original-build launches measured 1,611, 1,407, and 1,475 ms
in a complete trace. They corroborate the slower baseline but are excluded from
the seven-versus-seven timing table. Device thermal status remained LIGHT (1)
at every before/after capture boundary. Live network restoration varies between
runs, and the hot-return differences should be interpreted with that variability.

The high-return optimization is logo rendering. The shared Whip logo contains
1,567 SVG paths. `AppLoadingScreen` rendered it while fonts loaded and again
while preferences and profiles hydrated. Both native platforms already retain
their launch artwork until `hideLaunchScreen`, so those loading logos created
thousands of hidden views. The Hosts header then mounted another copy.

The symbolicated startup sample contained 146 active samples; 110 included
React root rendering, 17 included SVG XML parsing, and 21 ended in native node
creation. These categories overlap and the sample includes early work after
initial display; they are evidence of substantial rendering work, not additive
percentages of total startup wall time.

Removing only the hidden logos reduced the cold median from 1,332 to 1,045 ms,
but two of seven runs still took 1,688 and 1,714 ms. Their first-draw traces
contained 387 and 324 ms `Record View#draw()` spans. That motivated replacing
the remaining shared UI logo with a PNG generated from the exact original SVG.

The final change keeps the native splash until the real screen lays out, uses
an accessible empty React loading placeholder, and renders `WhipMark` with a
single native image. The 512-pixel image preserves the SVG's framing and exceeds
the resolution needed by the current UI marks. The SVG remains the source of
truth; `npm run generate:android-icon` now regenerates the shared PNG alongside
the existing native launcher and splash assets. Regeneration did not change
the existing Android artwork.

The placeholder-only experiment also reduced the startup multi-get trace from
219 ms on average to 15 ms without changing persistence. This span includes
JavaScript scheduling and promise completion, so its original duration should
not be interpreted as 219 ms of database I/O. SSH restoration remains asynchronous
and takes additional time depending on credentials, network, and remote hosts.

Both full arm64 release builds completed successfully with the GitHub channel,
the upload key, and `whip.skipR8=true` for local developer installation. APK
inspection verified that the only native ABI is `arm64-v8a`. The signing
certificate matched the original installation, and the final APK was installed
in place. Its SHA-256 is
`456b1c670948460aa3b77c8786b86c59fe9b428b1c615110e7b99506e5fcf144`.
These results describe local release builds, not a separate R8-optimized
production benchmark.

Focused ESLint and the application TypeScript check passed. The generated PNG
was checked against a fresh rendering of its SVG source. iOS launch-screen
retention was checked in source; iOS startup timing was not measured.
The recorded Android transition was reviewed at 30 frames per second around
splash dismissal: the artwork transitions into the Hosts screen without an
intervening blank frame. Whip was left foreground, and no screen-recording or
Android Studio mirroring process remained.

Perfetto's initial-display times corroborated the final `am start` results to
within approximately 2–4 ms. The complete before, placeholder-only, and final
captures reported no trace errors or data-loss statistics. One final cold
interval lacks associated scheduler thread metadata, so no seven-run CPU-time
aggregate is claimed. The final startup multi-get span averaged 11 ms and
first-tab mounting averaged 222 ms; those spans exclude earlier native/runtime,
module, and font initialization and should not be added to process startup.

Raw timing files, complete traces, symbolicated samples, analysis SQL/scripts,
launch recordings, original and optimized APKs, and matching source maps are in
`artifacts/startup-20261028/` (ignored by Git). The initial `baseline.partial`
trace is incomplete and excluded from trace comparisons; its seven independently
completed launch timing files are retained. The complete `before` trace supplies
three additional baseline cold launches and the detailed baseline phase analysis.
The `after` trace measures the placeholder-only change; `final` measures both
changes. Reanalyze complete captures with:

```bash
nix develop --command node artifacts/startup-20261028/analyze.cjs before after final
nix develop --command node artifacts/startup-20261028/measurements.cjs
```
