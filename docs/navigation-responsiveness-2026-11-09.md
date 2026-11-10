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
