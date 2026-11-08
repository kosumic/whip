# Terminal-scoped voice calls (#350)

Choose **OpenAI → Realtime** in voice conversation settings. In a connected plain
SSH terminal or a Herdr pane without a coding agent, start Voice chat from the
composer. The call header identifies its terminal scope. Local turn-based calls
remain agent-bound. Coding-agent calls retain their existing delegation tools;
terminal calls receive only `terminal_exec`, `terminal_read`, `terminal_input`,
`terminal_cancel`, and `remain_silent`.

For example, ask “show disk usage.” The voice assistant runs a command using the
original host's SSH connection, acknowledges admission, keeps listening, and
explains the actual stdout/stderr and exit status. Commands run through a
**separate SSH exec channel**, using the terminal's reported working directory
when available (OSC 7 for SSH shells, pane metadata for Herdr). Shell exports,
aliases, functions, and jobs are not inherited. Without a reported directory,
execution starts in the SSH server's default exec directory. A failed directory
change stops execution. Each result reports this context explicitly.

`terminal_exec` returns a call-scoped job ID immediately; admission is not
completion. `terminal_read` with that ID returns bounded stdout, stderr, elapsed
time, completion state, and the final structured result. A nonzero exit status
reports failure; an absent exit status remains unknown. Only one command may run
at once, with up to eight jobs retained per call and a maximum five-minute command
timeout. Output retains the latest 12 KiB per stream. Automatic progress requires
actual new output and is paced at 15 seconds; final results are delivered once.
Automatic output context is capped at 64 KiB, after which completion still arrives
and the model can explicitly read bounded output. ANSI/OSC/device control strings
are removed before text enters the voice model.

Without a job ID, `terminal_read` observes the fixed terminal: visible text for
Herdr, or the bounded SSH output received since the call began. This is terminal
output, with no structured exit status. Foreground program and shell idleness are
reported as unverified. `terminal_input` requires an explicit
`target: "selected_terminal"` and either text or a supported key. It is for a
user's explicit request to interact with that terminal or its program. Input
delivery never establishes shell execution or process completion. Shell commands
use `terminal_exec`, even when an interactive program is running. A detected
coding-agent takeover of a Herdr pane invalidates the terminal call.

Calls pin the runtime incarnation, SSH connection generation, terminal identity,
and (for Herdr) pane identity and server recovery revision. SSH shell replacement
also invalidates the pin. Focus changes cannot redirect tools or results. Reads
and input check the pin before and after work; stale results cannot reach a
replacement call. Host disconnect, credential replacement, or hangup
ends the call through the existing native owner. Tool-call IDs are deduplicated;
arguments cannot select another host or terminal.
App lock/unlock and backgrounding preserve the existing call and its pinned
terminal; unlocking does not start a new provider session.

`terminal_cancel` stops observation and closes the command's SSH channel.
**Cancellation, timeout, transport loss, and hangup cannot guarantee remote process
termination.** An uncertain command or input outcome prevents new mutations for
the rest of that call; no command is replayed. Reads remain available while the
original terminal is valid. An explicitly requested Interrupt key sends Ctrl-C
to the selected interactive terminal, not to a separate exec job. Ending the call
cancels outstanding observations and unsent tools without disconnecting the host
or affecting other SSH channels.

Validation includes a local SSH test server exercising real shell output,
nonzero exit status, streaming progress, channel cancellation, and call teardown,
plus call-scope, identity, argument, and UI-service regressions. Physical Android
and iOS microphone/speaker qualification remains a separate manual check: test
disk usage, a long command, explicit interactive input, focus changes, disconnect,
terminal replacement, app lock, and hangup. Do not treat automated coverage as
physical audio validation.

The wire integration follows the public [OpenAI Realtime function-tool
contract](https://developers.openai.com/api/docs/guides/realtime-mcp): Whip runs
the tool in Rust and correlates each output with the provider's `call_id`.
