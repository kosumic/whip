# Phone Use hosts and agents

Opted-in Claude Code, Codex and OpenCode agents can manage Whip's saved hosts
and operate agents and workspaces through the existing authenticated Whip MCP
connection. These tools work on Android and iOS without Shizuku. Rust owns the
schemas, argument validation, remote dispatch and response bounds; the app adapter
reuses host persistence, credential storage and connection lifecycle operations.

## User instructions

**More → Settings → Phone Use → Global AGENTS.md** holds optional Markdown
instructions for every Phone Use agent. Changes save automatically with
device preferences. Each host's connection editor also has **Host AGENTS.md**,
saved with that host's metadata. Existing installations default both to empty.
These are documents stored in Whip; no file is written to an SSH host.

Global voice calls also load the global document at startup. They use the latest
saved text for each new call and do not include host-specific documents.

Whip automatically loads the global document during MCP initialization and
includes its actual contents before built-in server guidance. The global document
is also included in the `browser.list_tabs` and `hosts.instructions` tool
descriptions for clients that omit server instructions. Startup fails with
an explicit error if the document cannot be loaded; it does not silently start
without the user's guidance. This uses MCP server instructions, rather than
writing or replacing the agent's native instruction files or configuration.

Codex launches also receive a synchronous `SessionStart` command hook. It loads
the global document through an authenticated, launch-scoped `/instructions`
endpoint and adds it directly to model context, including when tools are deferred.
The hook runs on startup, resume and compaction, and passes the full bounded
document without spilling it to a preview file. Only Whip's generated hook is
trusted through invocation-scoped config; existing hook trust and instruction
files are preserved. The generated command avoids nested backslash escapes so
Herdr's shell quoting also preserves the hook config and trust hash on fish hosts.
If fetching fails, the hook stops the turn before a model request so the user can
restore the connection and retry. This requires a Codex version with inline
lifecycle hooks enabled; other MCP clients receive the initialization and
discovery guidance.

`hosts.list` includes each host's AGENTS.md directly in its `agentInstructions`
field. Read the target host's guidance when choosing a host, before connecting
or operating on it. Host instructions are loaded on demand instead of being
added to startup context.

Call `hosts.instructions` for a targeted refresh during a session. It returns `global` and `host`
strings; read global guidance first, then the host-specific guidance. An empty
string means no document is configured. Omit `host_id` to read the calling
agent's host instructions. Instructions are available before the target connects
and are limited to 32 KiB of UTF-8 per document. Changes are visible on the next
`hosts.instructions` call or tool discovery without restarting the agent. A new
or resumed MCP initialization also loads the latest documents. Agents cannot
overwrite these documents through `hosts.save`.

```json
{"name":"hosts.list","arguments":{}}
{"name":"hosts.instructions","arguments":{"host_id":"host-mini"}}
{"name":"hosts.connect","arguments":{"host_id":"host-mini"}}
{"name":"agents.list","arguments":{"host_id":"host-mini"}}
```

## Host tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `hosts.list` | `{}` | Saved metadata, each host's `agentInstructions`, `has_agent_instructions`, and live connection status. No credentials. |
| `hosts.instructions` | Optional `host_id` | Global and target host AGENTS.md. |
| `hosts.save` | `profile`, optional `host_id`, `credential_from_host_id` | Create or update metadata with a partial profile. Omit `host_id` for a generated id. New hosts require `host` and `username`. |
| `hosts.connect` | `host_id` | Connect with Whip's saved credentials and jump hosts. Reuses a live connection and keeps the current app view. |
| `hosts.disconnect` | `host_id` | Close that host's Whip connection. |
| `hosts.delete` | `host_id` | Remove the profile, credentials, transcript/snapshot caches and connection. |

Profile fields use the same names as saved host metadata: `name`, `host`, `port`
(a string), `username`, `jumpHostId`, `forwardAgent`, `authMode`, `herdrCommand`,
`herdrSocketPath` and `sessionName`. Set `jumpHostId` to null to remove a jump
host. Rust validates the existing host graph, including cycles. Editing a
connected profile affects its next connection.

Metadata edits preserve the saved credential. To reuse another saved host's
credential, pass its id in `credential_from_host_id`; authentication modes must
match. The copy remains local and retains biometric protection for private-key
use. Changing an existing authentication mode requires a matching credential
source or editing the host locally. New profiles without a credential can be
completed in Whip's connection editor. Tools never accept or return raw SSH
passwords, private keys or passphrases.

```json
{"name":"hosts.save","arguments":{"profile":{"name":"Mini","host":"mini.local","username":"kosumi","authMode":"key"},"credential_from_host_id":"host-existing"}}
{"name":"hosts.save","arguments":{"host_id":"host-mini","profile":{"name":"Build Mac","jumpHostId":null}}}
```

Connections keep Whip's biometric checks and unknown/changed SSH host-key flow.
These may prompt on the phone. An agent cannot silently trust a host key. Calls
require successfully loaded preferences/profiles and an unlocked app. Cancelling
a pending connect stops that attempt; a late credential or trust response cannot
start it. Deleting or disconnecting the calling host ends its MCP session, so its
final response may be cancelled.

## Agent and workspace tools

Agents use named Whip operations. Raw `herdr.snapshot`, `herdr.request`, and
other `herdr.*` tools have been removed, including direct calls from clients
with an old cached catalog. Herdr remains an internal transport.

`agents.summary` returns counts by status from Whip local state, using the same
agent membership as Herd. `counts` includes only connected, fresh hosts;
`complete:false` means some saved hosts cannot currently be counted. Per-host
`observed_counts` may be cached; check `current`, `freshness`, revision and
observation timestamps before treating them as current. `working` means actively
working; `total` also includes idle, blocked, done and unknown agents.

`agents.list`, `workspaces.list`, `tabs.list`, and `panes.list` return local
IDs and compact metadata. They accept optional `host_id` (all saved hosts when
omitted), `offset` and `limit` (default 20, maximum 50). Follow `next_offset`
for additional rows. Cached rows have `current:false`. These tools never
connect, navigate the UI or fetch a remote snapshot. `hosts.refresh` explicitly
refreshes a connected host when requested fresh remote state is needed.

Remote controls default to the calling agent's host when `host_id` is omitted:

- `agents.inspect/read/prompt/wait/send_keys/start/focus`
- `agents.stop/restart/copy` (take `terminal_id`; copy accepts an optional label)
- `workspaces.create/focus/rename/close`
- `tabs.create/focus/rename/close`
- `panes.inspect/read/read_visible/focus/rename/split/zoom/close/send_input/send_text/send_keys`
- `hosts.start_service/integration_list/integration_install`

Discover each exact schema with `tools/list`. Controls preserve Whip's existing
validation, lifecycle waiting, cancellation and connection-generation checks.
Successful results use `structuredContent.value.result`; transport discriminators
are not part of the agent contract. Mutations reconcile Whip state.

```json
{"name":"agents.summary","arguments":{}}
{"name":"agents.list","arguments":{"host_id":"host-mini"}}
{"name":"workspaces.create","arguments":{"host_id":"host-mini","label":"Build","cwd":"/Users/kosumi/repos/whip"}}
{"name":"panes.read","arguments":{"host_id":"host-mini","pane_id":"pane-1","lines":100}}
{"name":"agents.prompt","arguments":{"host_id":"host-mini","target":"reviewer","text":"Check the current build status.","wait":{}}}
```

Workspace/tab creation and pane splits require an explicit nonempty `cwd` and
default to `focus:false`; set `focus:true` only when changing context is intended.
This leaves the app's existing focused creation controls unchanged. Prefer a
sibling pane in the same tab and cwd unless the user requests another layout.

Pane and agent reads accept `source` (`visible`, `recent`, `recent_unwrapped`,
`detection`), `format` (`text`, `ansi`) and `strip_ansi`. Recent reads default to
120 lines of `recent_unwrapped` plain text; `panes.read_visible` defaults to the
whole visible viewport. Select ANSI explicitly when colors are evidence. Lines
are bounded to 1–16000; returned text remains subject to the response limit.

`agents.start` pins the pane's terminal ID before launch, submits once, and polls
until the same name, kind and terminal become interactive. Its successful result
includes `ready:true`. The startup timeout defaults to 30000 ms and accepts
3001–300000 ms. A blocked startup returns `agent_not_ready`; the process remains
available for `agents.inspect` and `agents.read` inspection.

`agents.prompt` without `wait` reports `completion:"submitted"`. Add `wait:{}` for
Herdr's atomic submit-and-wait behavior, reported as
`completion:"lifecycle_wait_satisfied"`. Herdr must observe activity before a
settled idle/done/blocked state when prompting a non-working agent. An active
turn can satisfy the wait if the agent was already working; this is a lifecycle
wait, not a per-turn receipt. `agents.wait` waits without submitting input. Both
waits default to 120000 ms and accept `timeout_ms` from 1–300000, with optional
`until` statuses (`working`, `blocked`, `idle`, `done`, `unknown`). Default settled
statuses need not be repeated. `agents.send_keys` accepts logical key chords.

The new lifecycle actions, startup readiness, atomic prompt waits and explicit
tab/split cwd are conservatively gated to negotiated protocol 22. On protocols
17–21, other existing controls remain available; unsupported extensions return
`unsupported_feature` before sending input. Whip does not stop or replace a server
to enable a feature. Requests stay bound to the selected host and SSH generation.

Tool failures expose the upstream code in
`structuredContent.error.details.herdr_code`, including `agent_blocked`,
`agent_not_ready`, `agent_prompt_stalled` and server `timeout`. Connection loss
uses `host_disconnected`; client deadlines use `timeout`. Ambiguous transport
outcomes include `details.outcome_unknown:true`. Prompts and mutations are never
automatically replayed. Inspect `agents.inspect`, `agents.read` or refresh Whip state
before deciding whether to retry. Ask the user before answering approval dialogs.

The MCP initialization and script instructions include built-in operational
guidance for Whip operations,
covering host-scoped IDs, focus, topology, lifecycle waits, approvals, output
history and recovery. Global and host AGENTS.md supplement this guidance.

`hosts.start_service` starts Herdr with the saved command on a connected host.
`agents.restart` takes `terminal_id` and preserves the existing conversation.
`agents.copy` takes `terminal_id` and optional `label`, creating a fresh
conversation with that agent's saved launch options and Phone Use preference.
Copies use the source agent's cwd, preserve user focus and require protocol 22.
Both accept optional `host_id`. Restart can interrupt busy agents. Restarting the
calling agent closes its old MCP connection. Ordinary `agents.start` requests do
not grant a new agent Phone Use automatically.

The existing per-launch bearer authorization, concurrency limits and revocation
apply. Functional calls have a 325-second deadline, allowing bounded Herdr waits
of up to 300 seconds; configured agent MCP clients allow 330 seconds. Browser
downloads retain their separate 120-second deadline. Ordinary text responses are
bounded to 128 KiB. Instruction documents are separately bounded to allow for
JSON escaping. Cancellation drops outstanding Herdr control futures and tells the
app adapter to stop pending host work. Already accepted remote changes and
committed storage writes cannot be undone. Avoid retrying ambiguous writes;
inspect agents.inspect/agents.read first. Authorization allows access to the app's saved
hosts, including hosts other than the one running the calling agent.

This extension changes the Rust/native profile contract and requires a native
rebuild. No public UniFFI record or method signatures change in this update.

## Verification

The Rust suite tests wire options, protocol gating, pinned startup identities,
blocked/stalled/ambiguous outcomes and single-submission semantics. An opt-in
contract test drives the same request layer over a real Herdr socket in a unique
named session. It uses an isolated config and fake Claude process, never a paid
model. It checks focus/cwd, readiness, waits, reads, blocking, stale targets and
connection loss, then stops/deletes only its named session and closes its own
outer pane. Run from inside Herdr:

```bash
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --lib disposable_herdr_contract -- --ignored --nocapture --test-threads=1
```
