# Global voice calls (#326)

The phone button on Hosts, More, and the Terminal control bar opens Global call
settings, or returns to the current global call. Choose OpenAI API, Realtime,
and a saved voice/model, then explicitly start the call. No SSH connection or
saved host is required. Local turn-based calls remain agent-bound; GPT-Live is
unavailable until the Stage 3 adapter (#325) is implemented.

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

The Realtime catalog contains `hosts_list`, `herdr_snapshot`, `app_snapshot`,
`app_navigate`, `app_focus_host`, `app_focus_tab`, `app_open_agent`,
`herdr_delegate`, safe device status tools, and `remain_silent`. Function names
use underscores on the public Realtime wire; they map to the corresponding
Whip namespaces. Shared Reverse Control parsers, typed host context, device
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

## Remaining Stage 4 work

This implements the global Realtime entry point and the status/navigation/
confirmed-delegation permission set. #326 remains open for GPT-Live delegation,
browser capability sessions and document fences, opt-in consequential host or
device actions, persisted selected-agent billing associations, and Android/iOS
device acceptance checks. Browser control, host edits/connections/deletion,
shell execution, clipboard, location, downloads/exports, and device speech are
not granted by this global call catalog.
