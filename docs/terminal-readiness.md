# Terminal readiness and recovery

The tab rail and terminal banner use the Rust terminal rail's lifecycle state.
Agent activity and a healthy SSH connection do not establish terminal readiness.
An idle pane is green only when its terminal is connected.

Saved terminal state contains identity and selection, not connection status.
Restoring it into a running session must preserve live lifecycle state, errors,
and retry counts, including a pane opened before asynchronous storage finishes.
A fresh process still starts restored terminals as connecting until native
attachment completes. Offline cached panes remain disconnected.

Reopening a retained native bridge publishes Attached again without replacing
the bridge or remote terminal. Exhausted setup and recovery workers settle as
Failed so another open can start a new attempt. Each new attachment operation
gets a distinct epoch, including after renderer release; late work from a
released attachment cannot claim or overwrite its replacement.

Retry is available in the connecting banner as well as after failure. It releases
the viewer attachment and opens it again using the existing terminal identity.
It does not close the remote pane or restart the agent.

## First selection of a tab

Entering a workspace or restoring its terminals registers each tab's preferred
pane in the Rust rail without changing selection. While the app is visible,
the renderer prepares candidates from that workspace and host within the user's
existing xterm cache limit. Recently used renderers take priority over unvisited
candidates; plain SSH shells retain their existing protection from eviction.
Preparation fits the hidden renderer and attaches its native bridge before the
user selects it, so selecting a prepared tab activates the existing renderer
and bridge without another connection round trip.

A completed agent's status alone cannot color an unattached terminal green.
Tabs without a terminal lifecycle entry remain neutral; attaching tabs use the
pending color. Tabs outside the cache budget still attach when selected.

The follow-up report clarified that switching back was already seamless and
that the delay occurred on first selection. Regression tests now cover preparing
a tab before its first selection, activating it without reopening its terminal,
respecting the renderer budget without eviction churn, and leaving other hosts
unopened.

## Investigating a single-pane report

Capture timestamped `native-terminal-state` NetworkDiagnostics entries while
selecting a tab containing exactly one pane and while backgrounding and resuming
the app. Each entry includes `timestampMs`, `sessionId`, `tabId`, `paneId`,
`terminalId`, native `state`, `projectedStatus`, `reconnectAttempt`, `retrying`,
and any error. Correlate these with native `terminal-attach` and
`terminal-recovery` diagnostics. A transition to Attached should project
connected; setup exhaustion should project error and allow Retry.

For issue #321, the deterministic regression reproduced an attached single-pane
terminal becoming Connecting when its saved rail was restored. The original
implementation also returned from a retained open without publishing readiness,
and setup errors before bridge creation could leave Opening after retries ended.
These are reproducible lifecycle defects; they do not establish which timing
caused the original device report.

Behavioral coverage lives in `app_core/terminal_rail.rs`,
`host_runtime/terminal/tests.rs`, and `__tests__/terminalRendererHost.test.tsx`.
It exercises single-pane switching and late restoration, retained bridges,
setup exhaustion followed by retry, retry during a pending handshake,
background/foreground release, and terminal recovery with healthy SSH. The
isolated real Core interoperability test in `hc_transport/tests.rs` covers the
newer backend alongside the legacy protocol fixtures.

## Device verification

The upload-signed arm64 GitHub build was installed in place on a Pixel 9 Pro.
On the first selection of the green `install` and `kk` tabs after launch, short
recordings showed no Connecting terminal banner, and diagnostics recorded no
new native attachment or recovery operation during either selection. The first
raw terminal display was already populated. The `install` chat view briefly
showed an empty background while its transcript loaded; this check establishes
terminal attachment readiness, not seamless chat transcript loading.
