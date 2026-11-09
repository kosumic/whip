# Global voice calls (#326)

The phone button on Hosts, More, and the Terminal control bar starts a global
call using OpenAI and the saved Realtime or GPT-Live mode and voice, or returns
to the current global call. Global calls always use OpenAI, independently of the
local/OpenAI preference for agent calls, without changing that preference.
If the API key is not ready, setup shows its status and a link to Settings;
it never offers a local provider. No SSH connection or saved host is required.
Local turn-based calls remain agent-bound.

Global [GPT-Live calls](live-voice.md) use a Responses backend (`gpt-6-luna`,
configured in `realtime_voice/live/catalog.json`) with the same tool catalog and
native capability checks as Realtime. Whip waits for a complete, attributed
backend response before dispatching functions and returns every result through
`response.item.create` before requesting continuation. Duplicate, ambiguous or
incomplete function batches never replay work. Typed global messages enter the
backend as user input; they do not directly submit a coding-agent prompt.
Agent-bound Live calls continue using client delegation to their pinned agent.

The app shell presents the call. Changing tabs, opening an agent, disconnecting
a host, or editing voice preferences does not change its scope or restart it.
Minimize to navigate, tap the orb or phone button to return, or type a message
through the call composer. Typed global messages go to the voice conversation;
they are not implicitly submitted to a coding agent.

## Permissions and delegation

Starting a global call opts into saved-host metadata, connected agent status,
safe app navigation, and basic device info/battery/network status. The Rust
`WhipToolSession` owns a fresh, bounded capability session. It does not create
an MCP server, read a launch's bearer token, borrow a remote agent's authority,
or connect to a host automatically.

The shared global catalog contains `hosts_list`, `agents_summary`, `agents_list`,
`workspaces_list`, `tabs_list`, `panes_list`, `app_snapshot`,
`app_navigate`, `app_focus_host`, `app_focus_tab`, `app_open_agent`,
`agents_read`, `agents_prompt`, safe device status tools, and `remain_silent`. Function names
use underscores on the public voice wire; they map to the corresponding
Whip namespaces. Shared Phone Use parsers, typed host context, device
result sanitizers, and remote execution validate the supported operations.
MCP authorization remains launch-scoped; its broader catalog uses named Whip
operations rather than raw Herdr requests. Local status tools share the Rust
state and agent membership used by Herd. They never connect or request a remote
snapshot. Counts include current hosts only; `complete:false` marks incomplete
coverage, and cached list rows carry `current:false`. List tools accept optional
`host_id`, `offset`, and `limit`; summaries accept optional `host_id`. Both also
accept `workspace_id` together with `host_id` to scope rows and counts to one
space before pagination. Omit `workspace_id` for all spaces. Unattached Core
delegated agents follow their parent's space, matching Herd.
Empty scope strings are treated as omitted filters, including when GPT Live
sends `{"host_id":""}` to request all hosts.

## Coding-agent context (#404)

Global Realtime and GPT-Live expose
`agents_read({host_id, pane_id, limit?})` for one explicitly identified saved
host and pane. Discover IDs with `agents_list`; UI focus never selects a target.
The reader uses existing native transcript ownership without connecting to a
host. It returns ordered recent user prompts and speakable assistant prose and
questions, source identity, status, freshness, and truncation/unavailability.
Its default limit is 12 messages, bounded at 32. A question in history does not
prove that the same question is still pending. This reader is absent from
agent-bound calls and the ordinary MCP catalog; the existing MCP terminal-output
operation `agents.read` retains its separate launch-scoped authorization.

When **Voice announcements** is enabled, both provider modes also receive new
assistant prose and structured questions as quiet background context. Global
calls observe eligible agents on already-connected hosts, including agents
whose Chat View has never been opened. Disabling announcements stops unsolicited
updates; explicitly delegated answers still use the same event path after their
source and provider turn are correlated. Agent-bound calls observe only their
original pinned binding, including tasks started before the call or through
ordinary typed input. User messages are included only in explicit history and
bounded agent-bound startup context. Normal tool payloads, reasoning, plans,
and code excluded by automatic read-aloud never enter live model context.

Rust transcript commits drive this observer; provider delivery never blocks
ingestion. Every source starts with a silent baseline, and reconnects, source
replacement, and provider rotation establish new baselines. Updates carry
host/pane/binding, source epoch, revision, turn/message/part IDs and text offsets.
The queue holds at most 128 events/64 KiB, batches context every 500 ms, expires
waiting context after 30 seconds, and caps forwarded context at 256 KiB per
provider session. Dropped or truncated updates are reported honestly.
Realtime appends assistant context without requesting a response; GPT-Live
uses session-wide thinking context with no delegation ID. Neither creates a
user turn or authorizes agent work.

Delegated and independent assistant output share this event path. Separate
nonce/provider-turn tracking establishes delegation acceptance and completion;
unrelated messages cannot complete a request. Completion receipts contain
status rather than a second copy of the answer. Global call history shows tools
and delegation receipts invoked by that call; it does not mirror coding-agent
tool activity. Coding-agent tool lifecycle events remain in agent-bound local
voice history, including at teardown, and never enter forwarded model context.
Android/iOS retain their native automatic-TTS suppression during calls;
Rust advances silent TTS prefixes and discards pending speech so call-time
updates do not replay after hangup. Stop, pause, and lock controls retain their
existing behavior.

## Microphone control (#389)

Global Realtime and GPT-Live calls also expose `voice_set_microphone`:

- `{"muted":true,"duration_minutes":10}` mutes now and unmutes after ten minutes.
- `{"muted":true}` mutes indefinitely, replacing any previous timer.
- `{"muted":false}` unmutes now and cancels the timer.

The optional duration is a positive number of **minutes**, including fractional
minutes, bounded at 60. A duration on unmute, unknown fields, nonnumeric values,
zero and negative values are rejected natively. No confirmation is required.
Agent-bound and terminal calls do not expose this tool.

The native Rust call owner keeps the authoritative microphone intent and
deadline. Tools and manual controls update it; the call screen, Android service
and iOS call owner observe its published state. Navigation, minimization and JS
suspension do not own or cancel the timer. Every manual set/toggle cancels the
deadline, including a redundant set; every later tool command replaces it.
Expiry is checked by the native call loop. The absolute deadline and native
transition announcements survive provider reconnects and scheduled session
rotation within the same logical call. Recovery does not restart the duration:
if it expires while reconnecting, capture stays gated and the call unmutes once
the recovered provider is ready, queuing “Unmuted” once. Otherwise the remaining
time is honored. Explicit indefinite mute or unmute during recovery cancels the
old deadline; a new timed mute requires the provider to be ready.
Hangup, logical-call replacement, final failure, definitive audio-owner loss
and credential revocation cancel the deadline. Provider-session retirement
alone does not end the logical call. App lock follows the
existing policy below: an already authorized call keeps running, but locked
tool requests cannot obtain fresh capability authority.

Each actual state change queues the matching spoken “Muted” or “Unmuted”
announcement using the speech backend and voice selected in Settings. Speech
is synthesized on each transition, without bundled recordings or an audio
cache. System TTS and Phonon run locally; selecting OpenAI TTS makes the normal
speech request for each announcement, using existing credential protections.
Mute state changes do not wait for synthesis. Native playback borrows the call's
speech lease without replacing or completing it. Repeating the same state
changes only the deadline. Microphone delivery is suppressed until announcement
playback and its device-output tail finish, including backend initialization.
Failure or timeout releases that suppression without ending or changing the
call. Live unmute additionally waits for the matching server acknowledgement,
and a stale acknowledgement cannot override a newer mute.

## Delegation and capability lifetime

Every delegation requires explicit host and pane IDs, plus confirmation showing
the exact prompt in Whip. The native dispatcher pins the original agent before
confirmation and checks it again before sending. Native transcript observation
does not require opening the Terminal or Chat UI. Foreground host/tab selection
never grants or redirects delegation rights. Existing coding-agent approvals
remain authoritative. A submitted remote job can continue after hangup.

Unknown submission outcomes block additional prompts for that call. Mutations
are never automatically retried. Function IDs are bounded and deduplicated;
results use the initiating function ID. Tool capability permits expire after 55 minutes;
this is separate from the provider session lifetime. Hangup
or replacement revokes capabilities. App lock and leaving the foreground cancel
outstanding UI confirmations and device operations without ending the call.
Presentation, delegation confirmation and OS effects require unlocked foreground
Whip. Unlocking never approves or replays a cancelled action; a fresh request
must pass the same checks. Already dispatched remote work may have committed;
cancellation does not promise remote rollback.

## Lock and background lifetime (#390)

A call started while Whip is unlocked retains its microphone, playback, native
audio owner and provider session across backgrounding, screen-off, app lock,
biometric prompts and successful, failed or cancelled unlock. Mute, speaker route,
conversation and original target remain with the same call. This applies to
global and agent-bound calls whose audio mode supports background operation.
There is no opt-in, pause-on-lock state or restart on unlock. A new call is
unavailable while locked; a rejected replacement cannot interrupt the current one.

The locked call UI stays hidden. Protected credentials and SSH workflows retain
their existing authentication checks. Continuing an authorized conversation does
not authorize new protected UI actions or agent approvals. Android retains its
microphone/media foreground service and notification; iOS retains CallKit and
background audio. OS interruptions, permission loss and system lifecycle limits
still apply. Explicit Hang Up ends the call even while locked, and unlock never
resurrects it. Native session rotation and bounded connection recovery apply to
all user-started cloud voice calls, including agent and terminal scopes and
GPT-Live. See [the logical call lifecycle](realtime-voice.md#logical-calls-and-fresh-provider-sessions-378)
for retirement, retries, fresh authority and separate provider-session billing.

See [lock lifecycle device checks](voice-lock-lifecycle.md) for the Android/iOS
acceptance procedure and the limits of automated bridge tests.

Global transcript/captions stay separate from agent transcripts. Provider
usage is recorded with global scope and never follows UI focus. Usage & costs
can filter by scope. Remote-agent billing remains separate and unknown.
Global Live duration is recorded with global scope. Its displayed voice estimate
excludes delegated Responses backend charges and remote coding-agent spending;
those costs remain unknown in Whip.

Each global call loads **Settings → Phone Use → Global AGENTS.md** into
its initial model instructions, before the first response or tool call. It uses
the same document and formatting as Phone Use, ahead of built-in global
call guidance. Empty documents add no instructions; unavailable or oversized
documents prevent startup. New calls use the latest saved text. Host-specific
AGENTS.md documents are not included in global startup context.

On Android, **Settings → Phone Use → Allow Shizuku access for global calls**
defaults to off. The saved choice applies to new calls. Enabling it adds
`device_shizuku_status` and `device_shizuku_exec`, using the same validated
arguments, bounded results, live Shizuku authorization, and cancellation as
Phone Use. Pair Whip with Shizuku separately. Disabled calls cannot invoke
either tool, even by supplying a tool name directly. Hangup releases the call's
device session and cancels its commands. Agent-session Shizuku choices are
independent.

## Remaining Stage 4 work

This implements global Realtime and GPT-Live with the status/navigation/
confirmed-delegation permission set. #326 remains open for browser capability
sessions and document fences, opt-in consequential host or
device actions, persisted selected-agent billing associations, and Android/iOS
device acceptance checks. Browser control, host edits/connections/deletion,
remote shell execution, clipboard, location, downloads/exports, and device speech
are not granted by this global call catalog. Android commands require the
separate Shizuku opt-in described above.

## Testing provider tool arguments

Run the explicitly billable API probe from the development shell:

```bash
WHIP_VOICE_API_KEY_FILE=../gymami/.api \
  nix develop --command node scripts/test-voice-api-tools.cjs
```

The probe exports the actual Rust session configurations and tests all configured
Realtime models plus GPT Live with its configured Responses backend. It checks
host and space scopes, counts, lists, pagination, device queries, navigation and
Shizuku command arguments. Every tool result is synthetic; no real host, agent,
phone command or navigation action is executed. Realtime uses text output, and
Live uses typed backend requests with synthetic silence streaming. This checks
tool contracts rather than microphone, WebRTC or playback behavior.

Generated arguments are checked against the published schemas and replayed
through Whip's native dispatcher with a test platform. Credentials are read from
the named file without printing them. Reports and usage observations are written
to the ignored `.codex-voice-api/` directory. Set `WHIP_VOICE_API_MODELS` to a
comma-separated model subset or `WHIP_VOICE_API_OUTPUT` to another output path.
Set `WHIP_VOICE_API_SCENARIOS` to a comma-separated scenario subset for a focused
probe. `WHIP_VOICE_API_TRACE=1` records synthetic non-audio Live events for
protocol diagnostics in the same ignored output directory.
The two Rust helpers are ignored in ordinary test runs and require explicit
contract/report paths supplied by the script.
