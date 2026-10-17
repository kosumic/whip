# Reverse Control hosts and Herdr

Opted-in Claude Code, Codex and OpenCode agents can manage Whip's saved hosts
and operate remote Herdr sessions through the existing authenticated Whip MCP
connection. These tools work on Android and iOS without Shizuku. Rust owns the
schemas, argument validation, Herdr dispatch and response bounds; the app adapter
reuses host persistence, credential storage and connection lifecycle operations.

## User instructions

**More → Settings → Reverse Control → Global AGENTS.md** holds optional Markdown
instructions for every reverse-control agent. Changes save automatically with
device preferences. Each host's connection editor also has **Host AGENTS.md**,
saved with that host's metadata. Existing installations default both to empty.
These are documents stored in Whip; no file is written to an SSH host.

Call `hosts.instructions` at the start of a reverse-control session, including
sessions using only browser or device tools, and before using another host.
It returns `global` and `host`
strings; read global guidance first, then the host-specific guidance. An empty
string means no document is configured. Omit `host_id` to read the calling
agent's host instructions. Instructions are available before the target connects
and are limited to 32 KiB of UTF-8 per document. Changes are visible on the next
tool call without restarting the agent. Agents cannot overwrite these documents
through `hosts.save`.

```json
{"name":"hosts.list","arguments":{}}
{"name":"hosts.instructions","arguments":{"host_id":"host-mini"}}
{"name":"hosts.connect","arguments":{"host_id":"host-mini"}}
{"name":"herdr.snapshot","arguments":{"host_id":"host-mini"}}
```

## Host tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `hosts.list` | `{}` | Saved metadata, `has_agent_instructions`, and live connection status. No credentials or document contents. |
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

## Herdr tools

`herdr.snapshot` gets a live session snapshot. `herdr.request` accepts a typed
`request` object with an `action` discriminator. Both take optional `host_id`,
defaulting to the calling agent's host. Connect a different saved host first.
Requests run through Whip's existing Rust transport. Mutations refresh the actual
host snapshot so background creation cannot synthesize focused UI state.
`herdr.request` returns the upstream result with its `type` discriminator inside
`structuredContent.value.result`; `herdr.snapshot` retains Whip's snapshot model.

Supported actions are `ping`, `session_snapshot`, `workspace_create`,
`workspace_focus`, `workspace_rename`, `workspace_close`, `tab_create`, `tab_focus`,
`tab_rename`, `tab_close`, `pane_read`, `pane_read_visible`, `pane_get`, `pane_focus`,
`pane_rename`, `pane_split`, `pane_zoom`, `pane_close`, `pane_send_input`,
`pane_send_text`, `pane_send_keys`, `agent_start`, `agent_focus`, `agent_get`,
`agent_read`, `agent_wait`, `agent_send_keys`, `agent_prompt`,
`integration_install` and `integration_list`. Discover exact schemas with
`tools/list`. Unknown actions/fields and oversized inputs are rejected.

```json
{"name":"herdr.request","arguments":{"host_id":"host-mini","request":{"action":"workspace_create","label":"Build","cwd":"/Users/kosumi/repos/whip"}}}
{"name":"herdr.request","arguments":{"host_id":"host-mini","request":{"action":"pane_read","pane_id":"pane-1","lines":100}}}
{"name":"herdr.request","arguments":{"host_id":"host-mini","request":{"action":"agent_prompt","target":"reviewer","text":"Check the current build status.","wait":{}}}}
```

Workspace/tab creation and pane splits require an explicit nonempty `cwd` and
default to `focus:false`; set `focus:true` only when changing context is intended.
This leaves the app's existing focused creation controls unchanged. Prefer a
sibling pane in the same tab and cwd unless the user requests another layout.

Pane and agent reads accept `source` (`visible`, `recent`, `recent_unwrapped`,
`detection`), `format` (`text`, `ansi`) and `strip_ansi`. Recent reads default to
120 lines of `recent_unwrapped` plain text; `pane_read_visible` defaults to the
whole visible viewport. Select ANSI explicitly when colors are evidence. Lines
are bounded to 1–16000; returned text remains subject to the response limit.

`agent_start` pins the pane's terminal ID before launch, submits once, and polls
until the same name, kind and terminal become interactive. Its successful result
includes `ready:true`. The startup timeout defaults to 30000 ms and accepts
3001–300000 ms. A blocked startup returns `agent_not_ready`; the process remains
available for `agent_get` and `agent_read` inspection.

`agent_prompt` without `wait` reports `completion:"submitted"`. Add `wait:{}` for
Herdr's atomic submit-and-wait behavior, reported as
`completion:"lifecycle_wait_satisfied"`. Herdr must observe activity before a
settled idle/done/blocked state when prompting a non-working agent. An active
turn can satisfy the wait if the agent was already working; this is a lifecycle
wait, not a per-turn receipt. `agent_wait` waits without submitting input. Both
waits default to 120000 ms and accept `timeout_ms` from 1–300000, with optional
`until` statuses (`working`, `blocked`, `idle`, `done`, `unknown`). Default settled
statuses need not be repeated. `agent_send_keys` accepts logical key chords.

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
automatically replayed. Inspect `agent_get`, `agent_read` or the live snapshot
before deciding whether to retry. Ask the user before answering approval dialogs.

The MCP initialization and script instructions include built-in operational
guidance based on the [official Herdr skill](https://github.com/herdrdev/herdr/blob/143bf5fd4781d164260c63fe28e7dc08054ad32f/skills/herdr/SKILL.md),
covering host-scoped IDs, focus, topology, lifecycle waits, approvals, output
history and recovery. Global and host AGENTS.md supplement this guidance.

`herdr.start_server` starts Herdr with the saved command on a connected host.
`herdr.restart_agent` takes `terminal_id` and preserves the existing conversation.
`herdr.copy_agent` takes `terminal_id` and optional `label`, creating a fresh
conversation with that agent's saved launch options and Reverse Control preference.
Copies use the source agent's cwd, preserve user focus and require protocol 22.
Both accept optional `host_id`. Restart can interrupt busy agents. Restarting the
calling agent closes its old MCP connection. Ordinary `agent_start` requests do
not grant a new agent Reverse Control automatically.

The existing per-launch bearer authorization, concurrency limits and revocation
apply. Functional calls have a 325-second deadline, allowing bounded Herdr waits
of up to 300 seconds; configured agent MCP clients allow 330 seconds. Browser
downloads retain their separate 120-second deadline. Ordinary text responses are
bounded to 128 KiB. Instruction documents are separately bounded to allow for
JSON escaping. Cancellation drops outstanding Herdr control futures and tells the
app adapter to stop pending host work. Already accepted remote changes and
committed storage writes cannot be undone. Avoid retrying ambiguous writes;
inspect the live snapshot first. Authorization allows access to the app's saved
hosts, including hosts other than the one running the calling agent.

This extension changes the Rust/native profile contract and requires a native
rebuild, including regenerated UniFFI bindings.

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
