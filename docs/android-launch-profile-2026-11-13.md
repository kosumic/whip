# Android launch profile, November 13, 2026

Profiled the connected Pixel 9 Pro on Android 17 with Whip 2.3.0
(versionCode 242), saved hosts, preferences, credentials, and app data intact.
The original installation exactly matched the existing local arm64 release APK:
SHA-256 `8a2890a076761e331a775af497634d55801b617750d186246436ae9984305cfe`.

The launch screen has no fixed minimum-duration timer. `MainActivity` retains
Android's starting window until `App.tsx` has loaded fonts, hydrated preferences
and host profiles, and laid out the first application screen. Host reconnection
continues asynchronously afterward.

## Verified timings on the original APK

These are process-cold launcher starts using `am force-stop` followed by
`am start -W` with MAIN/LAUNCHER. Filesystem caches remain warm; these are not
first-install or reboot measurements. Values below are `TotalTime`, which
Perfetto's time to initial display corroborated within approximately 3 ms.
This measures the first application frame, including time before the starting
window appears, rather than the exact duration of the visible logo. Whip does
not report `reportFullyDrawn`, so these are not fully interactive or SSH-ready
times. See [Android startup metrics](https://developer.android.com/topic/performance/issues/launch-time).

| First screen | Cold launches | Median | Observed range |
| --- | ---: | ---: | ---: |
| Hosts | 6 | 1,282 ms | 1,235–1,294 ms |
| More | 3 | 1,408 ms | 1,407–1,542 ms |

Perfetto verified the actual first tab for every launch. The capture initially
intended to alternate tabs reopened Hosts in all six runs: the intervening More
selection had not persisted before force-stop. Consequently, every launch in
`tabs.perfetto-trace` is counted as Hosts, including timing files named
`tab-more-*`. More was then selected, allowed to settle, confirmed by a cold
relaunch and screenshot, and measured separately in `more-final`.

The final captures had no reported trace errors or data loss. Thermal status
was LIGHT (1) at their capture boundaries. The two screen groups are sequential,
not an interleaved controlled benchmark; their difference is descriptive.

## Where startup time goes

Hosts is the startup path relevant to the user's normal launch. More's UI is
guarded by `navigation.mountedTabs.has('more')` in `AppShell` and is not mounted
during a Hosts cold launch. Its separate render measurement must not be treated
as the cause of the Hosts launch delay.

- The shared startup multi-get completed in 7–10 ms in the verified final
  captures. Storage is a small part of this measured critical path.
- On Hosts, storage hydration starts 725–782 ms after launch (median 739 ms),
  and the read completes in 6.9–9.0 ms. On More it starts at 696–809 ms.
  Native initialization, runtime/module evaluation, and font loading precede
  that point; current markers do not separate all of those earlier costs.
- More's first-tab mount span is 491–542 ms; Hosts' is 280–326 ms. These spans
  include React rendering, commit work, and scheduling, rather than pure CPU.
- In the initial symbolicated Hermes capture, 84 of 123 active samples included
  React root rendering and 27 included module evaluation. These categories
  overlap and the sample also includes work after initial display.

For Hosts startup, the largest elapsed portion precedes storage hydration.
`AppShell` statically imports the other screens, so loading their JavaScript and
dependencies is shared startup work even when their UI is not mounted. This is
distinct from rendering More's settings. The current measurements do not assign
a reliable wall-time cost to each imported screen or to font loading separately.
Hosts already uses a FlatList. Further optimization should first separate native
initialization, module evaluation, font loading, and the Hosts/shared-shell render
cost instead of treating More's offscreen controls as the Hosts bottleneck.

More's eager settings rendering is a separate optimization opportunity for
launches that actually restore More. Virtualizing individual sections and
initializing expansion state before mounting their bodies were not implemented
or benchmarked here.

After the user clarified the normal startup screen, a fresh Hermes sample and
Perfetto capture explicitly verified a Hosts cold launch. With thermal status
NONE (0), that single sampled launch took 864 ms: storage began at 547 ms, its
read took 5.7 ms, and first-tab mounting took 244 ms. It is a diagnostic sample,
not a new repeated benchmark or an application improvement. Of 65 active Hermes
samples, 42 included React root rendering and 18 included module evaluation;
these overlapping categories include some work after initial display. The
capture is retained in `artifacts/startup-20261113/hosts-sampled/`.

## Rejected module-loading experiment

An Android-only Metro `inlineRequires` experiment built successfully as an
upload-signed arm64 release with the GitHub channel and local `whip.skipR8=true`.
The signing certificate matched, and installation used `adb install -r`.

| Comparison | Original median | Deferred-loading median |
| --- | ---: | ---: |
| Initial seven cold launches per APK, with Perfetto | 1,441 ms | 1,319 ms |
| Five cold launches per APK after reinstall, without Perfetto | 1,625 ms | 1,674 ms |

The apparent initial improvement did not reproduce. A video picture-in-picture
overlay was visible during earlier captures and absent in later screenshots,
so background workload also varied. No startup improvement is claimed.
The Metro change was reverted, and the original APK was restored in place.
The restored installation's SHA-256 was verified against the original above.
The standard local release APK and its matching combined Hermes source map were
also restored. Retained APKs are named `installed.apk` and `inline.apk` in the
artifact directory.

That global-Metro experiment left no application code change. The subsequent
targeted changes below are separate from it. No app data was cleared and no app
was uninstalled. Raw timings, APKs and matching source maps, complete traces,
query results, scripts, and screenshots are retained under
`artifacts/startup-20261113/` (ignored by Git).

## Targeted Hosts startup changes

`AppContent` now initializes saved state while fonts load. The first tab still
waits for fonts (or the existing font-error fallback), host profiles, and
preferences. All eight fonts and the native launch-screen retention remain in
place. A `Whip startup fonts` async span measures the font-readiness wait,
including JavaScript scheduling, rather than claiming pure font-file I/O.

Screens not needed for Hosts now use synchronous `require()` on their first
render: Herd, terminal sessions, More, voice chat, connection editing, keychain,
known hosts, licenses, new-host setup, and remote files. The wrappers preserve
props, refs, and mounted component state. They introduce no asynchronous blank
screen fallback. The bundle still contains every screen; their evaluation moves
to first use, as described in
[React Native's JavaScript loading guidance](https://reactnative.dev/docs/optimizing-javascript-loading).
First visits to deferred screens can consequently pay module-initialization cost.

| Hosts comparison | Original APK median | Targeted build median |
| --- | ---: | ---: |
| Initial seven-launch series per APK, with Perfetto | 1,274 ms | 1,443 ms |
| Later five-launch series per APK after reinstall, without Perfetto | 1,468 ms | 1,290 ms |

The later comparison observed a 178 ms (12.1%) lower median. Its observed ranges
were 1,455–1,546 ms for the original and 1,270–1,431 ms for the targeted build.
Both recheck boundaries reported LIGHT thermal status. The earlier series moved
in the opposite direction, so the later result is provisional: these small,
sequential, live-device samples do not establish a stable production speedup or
p95. The original APK embeds revision `79f92358`; the rebuilt APK embeds
`b2746a98`, whose intervening committed change only reformats a Rust expression.

The verified targeted Hosts trace shows the storage read ending before the font
wait ends in all seven launches. The font-wait span measured 171–303 ms (median
179 ms); the first-tab mount measured 239–296 ms. Moving font registration into
the native build is a possible next experiment, but was not implemented or
benchmarked here. These measurements do not justify attributing the entire
font-wait span to the large CJK font.

The complete baseline trace supplies derived startup rows for six of its seven
raw launch timings; all six identify Hosts. Its first raw timing is retained
without a detailed stage claim. All seven targeted rows identify Hosts, and
neither capture reports trace errors or data loss. An earlier targeted capture
restored Herd after the saved tab changed during the build. That capture is
retained as `optimized.perfetto-trace` with `herd-excluded.csv` and is excluded
from the Hosts comparison; `hosts-final` is the verified Hosts capture.

Focused tests cover deferred module initialization, preserved screen state,
updated props, saved-tab hydration before startup readiness, navigation, voice
refs, and preference/storage behavior. TypeScript and focused ESLint passed.
The full arm64 release built with the upload key, GitHub channel, and local
`whip.skipR8=true`; certificate and single-ABI checks passed before in-place
installation. This is a local release benchmark, not an R8-optimized production
or iOS device benchmark.

The installed targeted APK's SHA-256 is
`4782616a6216452fc866b4ebb9e1d2df4eba1d295fe1e3b147f5650325237491`.
On-device checks opened More, Herd, Terminal, and Add Host, then returned to
Hosts. No host was added or edited. Captured post-check logs contain no fatal
Android or JavaScript module-loading error. Installation preserved the existing
hosts, settings, credentials, and app data. No screen-mirroring process remained.
The new artifacts and their analysis scripts are in
`artifacts/startup-20261113/hosts-optimize/`. The interrupted `before` capture
lost its USB connection and is excluded; `baseline` is the recovered capture.
