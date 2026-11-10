# Retained chat redraws during terminal navigation

The earlier navigation fixes remain present. A new report covered both
Herd/Terminal transitions and terminal-tab selection on the Pixel 9 Pro.
A short Hermes sample again put most active JavaScript work under React root
rendering, including context propagation and transcript row rendering. This
sample was exploratory and is not a latency comparison.

`AgentChatView` still changed activity, visibility, composer-menu, and read-aloud
props on every historical row when hiding or revealing a conversation. Link
callbacks also changed whenever SessionScreen supplied new callback closures.
That invalidated memoized completed tool cards and prose even when their content
had not changed.

Rows now follow activity/visibility changes only when their content needs them:
streaming output, running tools, prompt/Markdown images, or speech captions.
Read-aloud controls are passed only to response footers and text rows. Composer
callbacks retain their identity; their existing visibility/session guard rejects
late selections from hidden or replaced conversations. Link handlers retain
their identity while forwarding to the latest committed callbacks.

The regression test retains expanded tool content and completed prose across
repeated hide/show transitions, including replacement parent callbacks. It fails
against the original component and passes with the change. A separate check
confirms that a running tool's retained spinner still pauses and resumes.
The chat viewport, prompt image, Markdown, session chat, and terminal composer
suites passed 566 tests. TypeScript, focused ESLint, and whitespace checks passed.

## Device observations

Both builds used production JavaScript on the same connected Pixel. The updated
GitHub-channel release was built for arm64 only with upload signing and local
`whip.skipR8=true`. Its certificate matched the installed release. Installation
used `adb install -r` and preserved app data.

A temporary instrumentation app injected touchscreen events and verified the
actual screen and selected terminal after each action. The flow entered
Terminal, selected `debug blank`, selected `space`, selected `debug blank` again,
and returned to Herd. The timing excludes the initial setup selection of
`debug blank` within each cycle. No terminal input was sent.

Each completed pass contained four cycles. Omitting the first cycle gives three
enter/exit observations and six tab observations per pass. Timings start at
native touch UP and end when accessibility reports the expected selected UI;
they include accessibility-query overhead and do not measure displayed pixels.

| Median selected-UI state delay | Before | First updated pass | Updated repeat |
| --- | ---: | ---: | ---: |
| Enter Terminal | 1,023 ms | 993 ms | 604 ms |
| Switch terminal tabs | 949 ms | 1,027.5 ms | 538 ms |
| Return to Herd | 1,854 ms | 1,902 ms | 1,049 ms |

The first updated pass was mixed. The repeat after startup caches warmed was
faster, but live agent activity and terminal ordering changed during measurement.
These small samples do not establish an isolated speedup or eliminate remaining
stalls; the updated repeat still had a 2,046 ms maximum returning to Herd.

Early driver attempts that required a particular terminal on entry, or accepted
retained terminal controls while Herd was still visible, failed validation and
are excluded. Their records are retained alongside all completed passes.

Raw timing records, the navigation driver, the baseline-failing regression log,
test/build logs, and the original installed APK are under the ignored directory
`artifacts/navigation-20261109/`. Updated APK SHA-256:
`00d253103a09cd8229c0574aa7130afb88885412cf279700d9edebff7368f758`.

## Follow-up: screen transitions and a stale reconnect banner

The user reported that Herd/Terminal transitions remained slow and that
"Reconnecting terminal" stayed visible over a working native terminal. The
original redraw change was committed separately as `b5def1af`.

Returning to Herd synchronously fetched the full application view twice before
dispatching navigation. It now uses the committed terminal rail and snapshot,
so it returns to the workspace of the terminal actually displayed. Retained-chat
reconciliation also read complete host snapshots after Rust had already returned
valid bound projections. It now reads host metadata only to distinguish a lost
binding from a confirmed agent exit. Resume still reconciles authoritative native
bindings, including native changes that have not reached React's pane snapshot.

Hidden priority chats previously published their transcript updates as
synchronous React work. Those updates now use transitions so navigation can
interrupt their rendering. Foreground chat updates keep their existing priority.

The terminal rail now reconciles non-connected Herdr entries against the current
live native bridge in Rust. A missed or delayed lifecycle notification cannot
keep a working terminal marked disconnected. This does not create a connection
or PTY. A real close still reports disconnected, and normal retry/failure events
remain authoritative when no live bridge exists.

A native integration regression opens a real terminal bridge without a foreign
lifecycle listener, checks the application rail, delivers a delayed close, then
actually closes the bridge. The first two projections remain connected and the
last becomes disconnected. All 151 app-core tests and nine terminal lifecycle
tests passed. The navigation/chat reconciliation suites passed 232 tests; the
hidden-chat scheduling/viewport suites passed 222 overlapping tests. Focused
ESLint and TypeScript checks passed. The two new JavaScript navigation regressions
are also checked against the committed baseline.

Follow-up artifacts and navigation-only measurements are under
`artifacts/navigation-20261109/herd-transition/`. The first baseline profile ran
Hermes sampling; the separate `before-quiet-navigation.txt` pass ran with
sampling off. These passes switch only Herd/Terminal and do not select terminal
tabs or send input.

## PR/1 tab follow-up and final verification

The user identified PR and 1 in the nsh space as the slow pair. Local terminal
selection also replaced unchanged JavaScript host records, invalidating snapshot
presentation and the unfiltered priority-chat projection. Native projections now
share equal data using the existing query library, prepared once before React
can replay an update. Presentation snapshots are reused while their captured
fields remain unchanged. Priority-chat preparation depends on host metadata and
runtime identity rather than a local terminal selection.

The final six-suite check passed 243 tests, including pending transition replays,
out-of-order projections, unchanged host data during selection, changed native
metadata, changed snapshot fields, and retained terminal/chat lifecycle behavior.
Focused ESLint and TypeScript passed. The native changes retain the 160 passing
app-core/terminal integration tests described above.

The driver completed five PR/1 cycles before and after the cache change. The
final run explicitly selected nsh after reinstalling, because startup had
restored the Whip space. The failed attempt to find PR in Whip is retained and
excluded. These are selected-accessibility-state measurements, not displayed
pixel timings. Earlier screen-transition passes also changed workspace during
startup; they are not a controlled comparison of the same terminal workload.

The final on-device check switched PR to its actual terminal presentation,
verified that the transport banner was absent, saved a screenshot of terminal
output, and restored Chat. The user confirmed that switching now felt good.
The upload-signed arm64 APK was installed in place with data preserved. Its
SHA-256 is
`074e319dcb8377978c01bedab9c9a1897efeb3d084d371d2e6b8d26245757a95`.
Raw PR/1 records and screenshots are in the follow-up artifact directory.
