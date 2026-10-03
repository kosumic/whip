# Herd agent actions

Swiping left on a Herd agent closes its tab using the original distance,
fling threshold, red close indicator, and row-collapse animation. A short swipe
returns the row to its resting position. The close indicator is clipped to the
uncovered area so it does not show through glass rows.

Long press opens a glass-aware popup with Restart, Copy and Reverse Control.
It replaces the previous long-press shortcut to remote files. The popup is also
available through the row's accessibility actions. Copy and Restart use icons
with accessibility labels. Copy opens an optional tab-name prompt; leaving it
blank lets Herdr choose the name. Cancelling the prompt creates nothing.

Reverse Control is a saved preference for that agent. Changing the switch saves
immediately; dismissing the popup does not revert it. Turning it off revokes that
pane's current authorization immediately. Turning it on shows **Restart to enable**
until the agent initializes a fresh Whip MCP connection. The preference survives
app restarts; bearer tokens, listener ports, and SSH forwards are not persisted.

Restart captures the exact conversation ID before stopping the CLI, exits with
`/exit`, waits for a fresh snapshot identifying the same pane as a shell, and
resumes in place with the saved preference. Busy agents require confirmation
before Whip sends Escape to interrupt the current task. A changed conversation,
missing identity, failed exit, or changed SSH generation stops the operation.
After launch, Whip waits up to 60 seconds for startup verification. With Reverse
Control enabled, the new authorization is bound to the captured conversation ID
before launch. The resumed CLI's MCP handshake verifies that launch even if
Herdr has not yet reported its SessionStart metadata; a subsequently reported
different conversation still revokes access. Without Reverse Control, Whip
waits for Herdr to report the captured conversation. It never substitutes the
most recent conversation. A verification timeout reports the pending startup
condition without tearing down an already launched agent's connection.
The old Reverse Control authorization is revoked after the CLI exits. While
the replacement starts, transient shell reports cannot close its new MCP
connection. Normal exit cleanup resumes after verification; pane replacement,
conversation changes, and explicit revocation still close access immediately.

Copy starts a fresh conversation in another tab in the same workspace and
working directory. It inherits the preference and known launch options, removes
resume/continue/fork options, and leaves the original agent running. The new
agent then owns an independent preference. Launch options are retained for
agents started through Whip; externally started agents use their detected agent
type and directory because Herdr does not expose their original argv.

Rust owns agent identity, launch options, authorization, and serialized lifecycle
operations. Typed UniFFI `AgentControlView` records and the `ReverseControlState`
enum flow through AppCore sessions and Herd agent rows. React Native presents
these projections and persists Rust's opaque preference JSON in a store scoped
to each host. Reverse-control initialization, suspension, restoration, and
closure refresh the same projection; React keeps no separate preference map.
Both the UI and Rust reject unsupported Reverse Control agents; currently
Codex and OpenCode are supported.

Herdr has no atomic compare-pane-and-send endpoint. Avoid simultaneous terminal
input from another client during restart. Failed or ambiguously acknowledged
commands are not automatically replayed. If startup fails after Copy creates a
tab, Whip opens that tab so the shell and error remain accessible.

Validation:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
nix develop -c node_modules/.bin/jest --runInBand --runTestsByPath __tests__/agentPreferences.test.ts __tests__/herdTabSwipeActions.test.ts __tests__/herdWorkspaceSelection.test.tsx __tests__/i18n.test.ts
nix develop -c node_modules/.bin/tsc --noEmit
```
