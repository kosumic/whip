
Whip agent and workspace operating guidance

Follow the global AGENTS.md supplied at startup. Read the target host's
agentInstructions in hosts.list before using it; hosts.instructions can refresh it.
These user documents supplement the tools' operational guidance. Discover saved
host IDs with hosts.list and connect the intended host with hosts.connect.
Use that same host_id on every subsequent control call. An omitted host_id means
the calling agent's host, not the last host used. Never fall back to another host
after a failure. Use agents.summary for counts and agents.list for agent discovery.
These read Whip local state without remote requests. Omit host_id on local list/summary
tools to include all saved hosts. counts includes only current hosts;
complete=false means some hosts are stale or unavailable. Treat current=false
rows as cached observations, not proof an agent is currently running. Use
workspaces.list, tabs.list and panes.list for other IDs. Local list/summary tools
accept workspace_id together with host_id to scope rows and agent counts to one
space; omit workspace_id for all spaces. Space filtering precedes pagination and
includes unattached Core delegated agents in their parent's space, as in Herd.
Empty host_id and workspace_id strings also mean omitted filters on local tools.
Returned agent IDs and workspace_id remain their actual navigation targets.
Use hosts.refresh only when an explicit remote refresh is needed. Whip handles
transport details.

Workspace, tab, pane, terminal and agent IDs belong to one host and session.
Parse opaque IDs from responses; never construct them or reuse another host's
IDs. A moved pane can acquire a new ID. The focused pane is not necessarily the
calling agent. Agent targets are a live unique name or pane ID; terminal IDs and
agent kinds are not agent targets. Names match [a-z][a-z0-9_-]{0,31}.

For recognized agents use agents.inspect, agents.read, agents.prompt, agents.wait
and agents.send_keys. Use pane actions for shells, ordinary programs and intentional
raw terminal input. A retained agent identity or an idle/done state does not
alone establish that typing is safe: inspect its output for dialogs, foreground
commands and background work. Start agents only in an available interactive shell.

Default to a sibling pane in the same tab and cwd. Create a workspace or tab, or
change cwd, when the user requests it. Supply cwd explicitly on every creation.
Preserve focus (the default focus=false) unless the user asked to switch. Honor
the requested split direction; otherwise choose right for wide panes and down
for tall/narrow panes. Do not create unusably narrow repeated splits.

agents.start returns ready=true only after the expected kind and name become
interactive in the same terminal. A startup failure leaves the launched process
available for inspection. agents.prompt submits text and Enter together. Without
wait it acknowledges submission, not completion. Prefer wait:{} for normal work;
it atomically waits for observed activity and then idle, done or blocked. The
default timeout is 120 seconds; timeout_ms is bounded to 300000. Use until only
for a specific state. Lifecycle waits do not identify individual turns: an
already working agent's active turn may satisfy a prompt wait.

On blocked output, agent_blocked, agent_not_ready, agent_prompt_stalled, timeout
or connection loss, use agents.inspect and agents.read before further input.
Ask the user before answering approval or question dialogs. A timeout, stalled
response, cancellation or connection failure can occur after input was delivered:
never blindly resend a prompt or repeat a mutation. Upstream codes are in
structuredContent.error.details.herdr_code. outcome_unknown means inspect live
state before deciding whether another write is needed. Use logical keys with
agents.send_keys only when the requested interaction and current UI justify them.

Read sources are visible, recent, recent_unwrapped and detection. Prefer the
default recent_unwrapped text for logs/transcripts; select ansi only when styling
is evidence. Increase lines within the returned limits if needed. Alternate-screen
history may be incomplete. If a completed response remains unavailable, ask the
agent to write a temporary Markdown file on that same host and return its path;
use host file tools to read it. This is a fallback, not the initial prompt format.

Never close panes, tabs or workspaces you did not create unless the user asked.
Closing has no additional terminal confirmation. agents.stop preserves the pane
and conversation data while stopping the agent. Restart interrupts work; copying
creates a separate conversation. Missing or unsupported features are not permission
to stop, replace or upgrade a server. hosts.start_service is an explicit startup
operation, not an automatic retry. Disconnecting/deleting the calling host or
restarting the calling agent revokes its MCP connection.
