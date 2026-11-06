# iPhone simulator navigation trace

On mini, the iPhone 17 Pro simulator running iOS 26.5 reproduced expensive
React work while entering/leaving Terminal and switching terminal tabs.
Hermes sampling attributed much of the avoidable work to decoding complete
Rust host/app snapshots through UniFFI:

- AppShell fetched a complete host snapshot for each priority chat even though
  the committed presentation already contained its panes.
- SessionScreen fetched the same runtime snapshot separately for each retained
  chat during reconciliation.
- The reverse-control adapter fetched the complete application view and
  republished host policy on every render, including terminal selection changes.

AppShell now uses its committed presentation snapshot. Chat effects lazily read
each runtime once per pass; they create a new cache on every effect invocation,
including foreground/resume, so native changes missed by React remain visible.
Reverse-control context uses committed connection statuses and updates when
host profiles, readiness, security policy, instructions, or connection status
change. Rust continues to own host-action policy and authorization.

The simulator also displayed a native input-view lookup failure as
“Reconnecting terminal.” Native input setup/teardown errors now produce a local
diagnostic instead of directly marking the SSH connection as failed. Pending
input barriers still reject, and failed edits cannot be sent. Transport/write
failures retain their existing error handling. The reconnect overlay was absent
in native inspection after the fix.

## Comparison

Both bundles used source revision `5a63e437`, the same cached native simulator
app, production Expo bundling with the GitHub channel, and optimized arm64
Hermes bytecode. The second bundle added only the four changed navigation/input
source files. The simulator app was updated in place without uninstalling or
clearing its data. The reused mini checkout and dependency/build caches were
preserved.

XCTest drove three repetitions of Terminal → setting tab → kk tab → Back to
herd → More → Herd. All 18 transitions passed before and after. Hermes sampling
and Instruments Time Profiler recorded both runs. Source maps attributed
inclusive samples to the following snapshot reads:

| Path | Before | After |
| --- | ---: | ---: |
| Retained-chat exit checks | 480 | 154 |
| AppShell priority target host reads | 340 | 0 |
| Reverse-control application-view reads | 287 | 0 |

These are sampled stack observations, not call counts or elapsed milliseconds.
Whole-profile active samples were 9,177 before and 8,224 after, but recording
lengths differed (63.9 versus 56.1 seconds) and connected hosts remained live.
Do not interpret those totals as a controlled CPU or latency speedup. XCTest's
roughly 1.4-second action durations include event synthesis and polling; they
do not measure tap-to-displayed-frame latency. Physical iPhone responsiveness
has not been measured in this task.

The 35-second native captures sampled 8.591 versus 8.232 seconds on JavaScript
and 3.686 versus 3.461 seconds on the main thread. These single live-workload
captures show a modest aggregate difference; the strongest evidence is the
removal of the redundant decoding paths above.

## Direct latency follow-up

The CPU samples and passing functional tests did not establish a latency fix.
A follow-up enabled timing at the existing navigation selection/commit and
terminal selection/renderer-entry markers in diagnostic copies of both release
bundles. Terminal exit timing also includes its synchronous native state reads.
The marker code was identical in both versions. CPU profiling was off; records
were saved after frame callbacks, outside the measured selection-to-commit
interval. These diagnostic changes were not added to application source.

After a three-cycle pilot, the longer comparison reversed the run order
(patched first, baseline second). Each version completed all 66 transitions in
11 cycles. Excluding the first cycle leaves 10 observations per screen transition
and 20 terminal-tab observations per version. Warm app-side medians were:

| Action | Before | After | Samples per version |
| --- | ---: | ---: | ---: |
| Enter Terminal | 78.2 ms | 72.0 ms | 10 |
| Leave Terminal | 117.2 ms | 110.1 ms | 10 |
| Switch terminal tabs | 41.7 ms | 34.5 ms | 20 |
| Open More | 43.1 ms | 39.7 ms | 10 |
| Open Herd from More | 74.5 ms | 72.4 ms | 10 |

Entering/leaving ends at the navigation effect's commit marker. Terminal-tab
timing ends when the selected terminal reaches its renderer entry. Neither
includes time between physical touch and the JavaScript handler starting, or
proves that the target content has been displayed.

A separate marker waits for two requestAnimationFrame callbacks after completion.
Its warm medians were 149.3 → 147.1 ms entering Terminal, 99.6 → 82.9 ms switching
terminal tabs, and **265.9 → 324.2 ms leaving Terminal**. Exit maxima were
318.2 → 629.7 ms. Initial frame callbacks took multiple seconds in both versions
under the faster driver. These callbacks are a frame-scheduling proxy, not a
measurement of displayed pixels, and connected host activity remains live.

The measured app-side gain is modest. Visible responsiveness and the initial
stall cannot be considered fixed on this evidence; exit frame scheduling needs
further investigation. The normal patched bundle was restored after measurement.
Raw records, UI action logs, the diagnostic instrumentation, and
`latency-summary.json` are in `artifacts/ios-navigation-20261106/`.

Validation: 296 tests passed across application presentation, chat retention and
resume, native input ordering/failures, and reverse-control policy suites.
The resume regression explicitly changes native state without updating React's
pane snapshot. Focused ESLint, TypeScript, and whitespace checks passed.
A separate XCTest check enabled the terminal keyboard, observed the actual
iOS keyboard, and disabled it again without sending input to the remote shell.

Local Hermes profiles, source maps, reports, and diagnostic helpers are under
the ignored `artifacts/ios-navigation-20261106/` directory. Native traces and
XCTest result bundles remain on mini under
`/Users/kosumi/repos/whip-ios-device/build/ios-navigation-probe/`, labeled
`current-baseline` and `fixed`. Sampling was stopped after each capture.
