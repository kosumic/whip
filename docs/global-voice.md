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

The shared global catalog contains `hosts_list`, `herdr_snapshot`, `app_snapshot`,
`app_navigate`, `app_focus_host`, `app_focus_tab`, `app_open_agent`,
`herdr_delegate`, safe device status tools, and `remain_silent`. Function names
use underscores on the public voice wire; they map to the corresponding
Whip namespaces. Shared Phone Use parsers, typed host context, device
result sanitizers, and Herdr execution validate the supported operations. Existing launch-scoped
MCP behavior and its broader catalog are unchanged.

Every delegation requires explicit host and pane IDs, plus confirmation showing
the exact prompt in Whip. The native dispatcher pins the original agent before
confirmation and checks it again before sending. Native transcript observation
does not require opening the Terminal or Chat UI. Foreground host/tab selection
never grants or redirects delegation rights. Existing coding-agent approvals
remain authoritative. A submitted remote job can continue after hangup.

Unknown submission outcomes block additional prompts for that call. Mutations
are never automatically retried. Function IDs are bounded and deduplicated;
results use the initiating function ID. Calls expire after 55 minutes. Hangup,
replacement, or app lock revokes capabilities and cancels outstanding UI
confirmations. An unlock cannot reactivate an old permit. Already dispatched
remote work may have committed; cancellation does not promise remote rollback.
Presentation and OS effects require the app in the foreground.

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
