# Chat viewport blanking

Reproduced on the Pixel 9 Pro using the `Transcript load` and `side` Chat View
tabs. Baseline: the navigation APK from the preceding investigation. Patched:
source based on `0ad35341` with the AgentChatView changes described here.

## Cause and changes

The shared terminal viewport supplies different bottom clearance for each
chat's composer and controls. AgentChatView treated these routine inset changes
as lost measurements: it cleared readiness, incremented the FlashList key, and
remounted already prepared rows. On returning to the other chat it hid the
viewport until fresh load, measurement and scroll callbacks arrived. The device
logs and recording confirmed this happening repeatedly on ordinary tab changes.

Ready viewports now retain their list and readiness when only those spacers
change. The extra first-render opacity gate for changed padding was removed.
Cold preparation, source/binding replacement and viewport width/height
revalidation remain guarded. Regression tests exercise repeated hidden and
reactivation-time inset changes while preserving visibility and manual position.

Fast swipes did not trigger those readiness resets. Scroll geometry previously
scheduled ordinary React work for every offset event, competing with cell
rendering. Offset-only chrome updates now use transition priority, while refs
used for native position tracking, restoration and checkpoints update immediately.
FlashList also prepares one viewport of extra content rather than relying on its
short default render-ahead distance. This increases offscreen rendering work.

## Device checks

Both 30-second captures performed eight validated chat switches and eight
90-ms swipes, four in each direction. A separate instrumentation helper resolved
the real controls and checked the selected tab after every tap. No terminal
input was sent. Log collection and video settings were the same before/after;
Hermes CPU sampling was off.

| Observation | Before | After |
| --- | ---: | ---: |
| Inset-triggered viewport resets | 15 | 0 |
| Prepared on each warm reactivation | 0 of 7 | 7 of 7 |
| Warm activity-to-visibility diagnostic interval | 178–489 ms | 2–10 ms |
| Near-empty video frames, sampled at 30 fps | 52 of 901 | 0 of 898 |

The diagnostic interval starts after the activation render and is not
tap-to-displayed-frame latency. First cold visits still prepare their contents;
their single observed diagnostic intervals were 279 ms before and 577 ms after.
These live-workload captures do not establish a cold-open speed comparison.

The pixel check compares a fixed 680×1100 content crop with a visually verified
blank-background frame. A pixel is foreground when its grayscale difference
exceeds 24; a sampled frame is near-empty below 0.5% foreground coverage.
The seven baseline near-empty intervals lasted approximately 167–367 ms each.
This detects large empty viewports; it does not prove the absence of partial
cell gaps or flashes shorter than the 33-ms sampling interval.

An additional stress pass started at the top: its first eight gestures hit the
boundary, followed by eight moving downward flings. The corrected upward-only
pass started near the end and recorded eight descending offsets from 10,260
to 1,601, followed by momentum toward the top. Both stress recordings had zero
readiness invalidations and zero near-empty sampled frames (900 and 899 frames).
This is evidence for the tested paths, not every possible fling or transcript.

Validation: 394 viewport/retention/session tests and 134 coupled composer/keyboard
tests passed. Focused ESLint, TypeScript and whitespace checks passed. iOS was
not built or measured for this change.

## Artifact

`artifacts/perfetto/chat-blank-20261106/Whip-v2.0.0-236-arm64-chat.apk`
is an upload-signed GitHub-channel arm64 release built with local-only skipR8.
SHA-256: `2170fa0d3bf5f28c1d8e4b67a029efef159e8661eead5651742b5f50a27cd682`.
The installed base APK matches. Installation used `adb install -r` and preserved
Whip data. The temporary instrumentation APK was removed; recording/log processes
finished and no Android Studio screen-mirroring agent was running at cleanup.

The same ignored artifact directory contains videos, extracted frames, native
selection records, viewport logs, the capture script, exact source map,
pixel-analysis output, signatures, and build/test logs.
