# Whip architecture

## Product boundary

Whip is a mobile client for a Herdr server running on another machine. It never starts a local Herdr runtime, shell, or PTY on the device.

The app has three presentation surfaces:

- **Herdr control surfaces become mobile UI.** Herd status, workspaces, tabs, panes, agent actions, settings, notifications, and connection state are React Native screens and sheets backed by structured Herdr state.
- **Pane terminals remain terminals.** When a user opens a shell or agent pane, the app attaches to that pane's terminal stream and renders its ANSI/TUI output faithfully in the terminal renderer.
- **Chat View is another projection of an agent pane.** It renders the Rust-owned normalized transcript for the same pane/session; it does not introduce a separate remote execution path.

The app must not render the full Herdr management TUI in a terminal and place mobile controls around it. Herdr's TUI is one client presentation; Whip is another presentation over the same server-owned state.

## Three planes

### Transport plane

The mobile device reaches a remote machine over SSH. A saved host profile owns host, port, username, authentication reference, Herdr binary path, named Herdr session, optional jump host, and optional agent-forwarding setting.

Metadata is stored in the embedded Rust-owned Turso application database. Passwords, private keys, and passphrases are stored through the platform credential store and referenced by profile ID; they must never be embedded in profile JSON, logs, screenshots, or fixtures. Android may back up only AES-GCM ciphertext, with its recovery token separated into Block Store. Global SSH keychain secrets are excluded from that recovery path.

Both platforms link one `whip-ssh` static library and expose one WhipSsh TurboModule. The Rust core loads one process-wide OpenSSH-compatible known-host repository, returns typed unknown/changed challenges for explicit fingerprint approval, and parses and validates structured trusted-key records supplied by the platform store. Unsupported SSH host certificates remain a separate typed failure through UniFFI and never enter the ordinary host-key approval flow. React Native owns confirmation UI and submits Rust-validated mutations to Rust persistence, but never parses native error strings or constructs OpenSSH `known_hosts` lines. Direct hosts and every jump-host hop follow the same rule.

### Control plane

The control plane reads and mutates structured Herdr server state:

- server/version/capabilities
- session snapshot
- workspaces and worktrees
- tabs and panes
- agents, status, metadata, and recent output
- create, focus, rename, split, resize, send, close, and launch actions

Rust `AppCore` is the application layer immediately below the native boundary.
It owns the ordered application sessions across hosts, active-session selection,
client-side workspace/tab/pane selection, selection reconciliation, each
session's logical terminal rail, and the revisioned `AppCoreView`. It also
builds application-level projections such as the multi-host Herd view. Each app
session may reference one `HostRuntime`, but `AppCore` does not duplicate or
replace Herdr server truth: the referenced runtime's `HostState` remains the
authoritative per-host projection.

`AppCore` also owns startup membership reconstruction, jump-host authentication
dependencies, active-first restoration with bounded background concurrency, and
connection-attempt admission/cancellation. React supplies readiness signals and
platform effects for credential access, biometric confirmation and navigation.
Native attempt tokens prevent delayed credentials or an old completion from
reviving a closed session or clearing a replacement attempt.

`AppCore.startConnection` drives saved, interactive and startup connection
transactions through typed phases: credential access, native ProxyJump graph
resolution, biometric approval, credential-service persistence, bounded unknown
host-key approval, transport connection, runtime attachment and terminal restore.
Changed host keys remain an explicit failure; this workflow never overwrites them.
The startup scheduler supplies its existing attempt and prior biometric approval,
so active-first ordering, dependency admission, background limits and persistence
continue to use the same native owner.
Startup supplies metadata rather than reading credentials before the transaction.
Native credential effects distinguish interactive picker/recovery access from a
background store read; background restore cannot open the editor or navigate.

React supplies individual effects through `SessionConnectionPlatform`: the
credential/recovery UI, biometric and trust prompts, known-host command dispatch,
physical `HerdrClient` attachment, terminal-storage loading, localized messages
and navigation. The hook retains runtime event rendering and offline-cache
notifications. The connection workflow calls `CredentialCoordinator` for durable
host saves; it does not duplicate credential transaction or SSH reconnect policy.

Each callback receives a retired-on-completion native permit tied to its attempt
and pinned connection identities. Committed metadata is reread before attachment
and after restoration. Close, unmount, cancellation and replacement invalidate
late callbacks. A process-wide per-host lane drains physical callbacks and cleanup
before a retry may create another transport. AppCore binds and opens the fallback
plain-SSH shell under the admission lock; cleanup removes only its own runtime
binding and UI handle. Terminal-restore failure retains healthy SSH for adoption,
while cancellation or a stale target disconnects the owned transport. Outcomes
distinguish ready, selected, busy, canceled, phase failure and cleanup failure;
phase diagnostics measure the actual callback and contain no credentials or
foreign exception text.

Whip opens SSH stream-local channels directly to Herdr's local API socket. Short-lived request channels carry structured actions and snapshots; a persistent subscription channel carries events. The MIT `herdr-protocol` crate owns versioned terminal encoding/decoding, control JSON serialization and response validation, subscription serialization, bounded incremental JSONL framing, event normalization, and the canonical domain types. It has no SSH, UniFFI, networking, callbacks, timers, or global runtime state. The `whip-ssh` Rust core owns request IDs, transport response framing and limits, deadlines, retries, subscriptions, connection lifetime, and translation from pure protocol errors to native errors. Shared type schemas register the canonical types in the existing UniFFI namespaces without conversion copies. The app also owns cohesive launch semantics: one typed shell/command/agent tab operation performs tab creation and the exact follow-up action, including managed-agent naming and typed partial failure. React Native supplies explicit shell or agent intents for dedicated UI actions and passes command-runner text as a command intent without tokenizing it. Rust alone interprets direct managed-agent command lines, preserves shell-bearing input as an ordinary command, and sequences `tab.create` with exactly one `agent.start` or `pane.send_input`.

Herdr Core uses a distinct generation-1 protocol. Saved backend overrides preserve legacy hosts; automatic detection prefers hc. A single framed core connection multiplexes RPC, event and terminal channels over the core Unix socket, with `hc connect` as the SSH exec fallback. The reusable `herdr-protocol::hc` module owns typed OpenRPC methods, negotiation, bounded buffering/credit, cancellation, event reduction, desktop document CAS edits, and projection into the canonical host model. Whip owns the authenticated transport, timers, independently scheduled renderer consumers and reconnect fences. Shared `herdr-app` JSON retains desktop fields and mods; private view focus/zoom stays local. Core ANSI terminals use local renderer scrollback. Core setup and launches never use legacy installers. See [Herdr Core hosts](docs/herdr-core.md) for operational details and isolated interoperability testing.

On generation-1 endpoints (Herdr protocol 22), each runtime also observes the server's structured `shell.snapshot.v1` through an inactive endpoint connection. It requests no rendered surface, input routing, or geometry ownership. Herd uses the snapshot's already-filtered `agent_order` rather than interpreting view criteria in the app, and preserves that order within each host. The complete JSON topology remains available for terminals, navigation, and notifications. Saved ordering belongs to one connection: reconnect, replacement installation, and explicit disconnect invalidate it. Herd falls back to the complete agent projection until the replacement observer supplies a fresh snapshot. Across hosts, any server projection (including an empty one) keeps agent rows grouped in the existing host ranking: connected hosts first, then aggregate visible-agent attention. Within each group, hosts with a projection keep server order and hosts without one use attention priority. If no host has a server projection, the existing global attention ordering remains unchanged.

Herdr protocol code asks a stable `HerdrConnection` for control, event, agent-view, or terminal streams; it does not receive an `SshSession`, socket path, stream-local channel ID, framing flag, or SSH generation. The connection owns socket discovery and cached-hint invalidation, selects the API or client socket for the logical stream, filters callbacks from replaced sessions, and cancels in-flight handshakes when its transport is replaced. There is no C ABI, callback context, dynamic symbol lookup, or JSON dispatch between the SSH and Herdr modules. Herdr JSON does not cross the React Native boundary. Rust applies snapshots, events, and confirmed mutation results to one authoritative per-host domain model. TypeScript invokes semantic operations and renders a typed, versioned projection.

Runtime failures cross UniFFI as tagged errors. SSH failures retain a stable `SshErrorCode` plus their diagnostic message, and protocol mismatches retain their expected and received versions. The native TypeScript adapter maps those fields mechanically to presentation codes; React Native does not classify native exception text or extract structured fields with regular expressions.

GitHub viewer reads run the host's `gh` CLI on auxiliary SSH exec channels. Rust
retries only channel-unavailable and transport-timeout failures while the original
SSH session remains alive: at most three attempts, with 150/300 ms backoff and a
30-second total deadline per command. A read retains its initial generation across
retries and optional metadata lookups; replacement invalidates successes and errors.
This recovery does not reconnect or reset a working terminal. GitHub mutations and
asset preparation never enter the read retry path. The TypeScript bridge preserves
the native code/message, operation, runtime ID and initial generation, and includes
the code in the displayed error. Runtime logs record failed read attempts, operation,
generation, transport liveness and retry disposition without command bodies.

The real loopback SSH regression tests in
[`host_runtime/github/tests.rs`](packages/react-native-whip-ssh/rust/src/host_runtime/github/tests.rs)
inject server channel refusals alongside concurrent reads, SFTP and a live terminal,
and cover persistent refusal, reconnect fencing and single-attempt writes. This
reproduces the failure mode in [#279](https://github.com/kosumic/whip/issues/279);
the original device failure's cause remains unconfirmed. On a device, repeatedly
refresh/reopen Commits while using terminal, Git and SFTP, then repeat during a
reconnect. `WhipHostRuntime` / `whip-runtime.log` entries distinguish
`ChannelUnavailable` with `transport_alive=true` from `SessionClosed`,
`ConnectionTimeout` and a changed generation. A persistent failure should show the
SSH code/message, and Retry should recover both failed metadata and list requests.

Transport/runtime timings are measured beside the Rust operations they describe and cross the native boundary as typed, coarse diagnostics. Connect/reconnect, terminal attach/recovery, and event-stream recovery produce one completion diagnostic; latency probes and ordinary Herdr requests produce diagnostics only when slow or failed. Successful latency calls still return a typed Rust-measured RTT/total/overhead record for live UI state. React Native owns bounded diagnostic history, thresholds, persistence, and display. It does not infer transport duration by timing an FFI promise.

One Rust `HostRuntime` owns each connected host's stable
`Arc<HerdrConnection>`, ProxyJump chain, reconnect loop, event subscription, and
Herdr terminal registry. `HerdrConnection` is the sole owner of the installed
authenticated `Arc<SshSession>` and its generation. Reconnect installs a new
session into the same connection object, advances the existing runtime
generation/epoch state, cancels stale work, and restores requested resources
without bouncing through JavaScript. Transcript sources likewise request
generation-guarded commands and logical exec streams from this connection
instead of retaining an SSH session or manufacturing channel IDs. Shell,
remote-file, forwarding, and preview workflows remain HostRuntime operations
and borrow the connection's current owned session; no string-key session alias
is published for React Native.

`HostState` owns workspace/tab/pane topology, layouts, server focus, derived
agent status, snapshot sync generations, monotonic state revisions, and
freshness. Snapshot requests carry both connection and sync generations. Events
that arrive while a snapshot is in flight are applied immediately and buffered,
then replayed over the accepted snapshot so an older response cannot erase
already-observed changes. Herdr does not currently expose a single revision
shared by its request and subscription channels, so Rust coalesces a follow-up
snapshot after gaps or inconsistent references instead of hiding that ordering
limit with delays. `pane.output_changed` is treated as a non-projecting
notification: terminal/transcript bytes and activity use their dedicated
streams, so known-pane output does not mutate the host projection revision or
send a redundant full snapshot.

Successful Herdr mutations are reconciled into Rust-owned `HostState`, and
React Native consumes the resulting projection without routinely requesting a
follow-up full snapshot. Rust alone decides when an incomplete or inconsistent
control result requires a resync. `AppCore` owns durable application/session
selection and repairs it against newer `HostState` revisions. React may retain
transient optimistic focus while an interaction settles, but that renderer-local
state is not the authoritative application selection.

If Whip needs a new server capability, it should be a neutral Herdr socket API method or event, not a mobile-specific endpoint and not a second source of runtime truth.

Herdr's Unix API accepts one normal request and then closes that socket
connection; only subscriptions remain open. Control requests therefore use
separate short-lived stream-local channels. Do not treat the API socket itself
as a multiplexed transport.
A cold connection uses `ping` as the availability handshake and reads the
Herdr version and protocol from its `pong` response. Rust then takes a bootstrap
snapshot to obtain the current pane IDs, opens the complete lifecycle and
per-pane event subscription, waits for Herdr's `subscription_started`
acknowledgement, and takes a reconciliation snapshot while buffering events.
The Turso app-data store retains one opaque resolved-socket hint per saved host across app
launches. TypeScript only loads and stores that hint; it has no socket validity,
invalidation, discovery, or replay policy. `HostRuntime` treats the hint as
untrusted, validates it through normal control traffic, and re-resolves it
through its current SSH session if the hinted path stops accepting channels.
Rust selects the
protocol-specific terminal attach variant from the ping result.

`startHerdrServer` is a readiness contract, not merely a remote shell launch.
The runtime serializes callers, probes `session.snapshot` first so an already
running server is not relaunched, starts Herdr only after retryable control-socket
unavailability, and polls native control snapshots to a 12-second deadline with
75–600 ms exponential backoff. Success requires a supported protocol, an
accepted generation-scoped authoritative snapshot, normal event-subscription
reconciliation, and a `HostStateChanged` projection. React Native neither sleeps
nor requests a follow-up snapshot after this operation.

### Reverse Control host actions

Rust `HostActionCoordinator` executes the authenticated `hosts.*` workflows.
It reuses the owning Reverse Control session
and request identity and serializes mutations, including credential source/target
operations. Opaque native permits fence each platform effect against cancellation,
runtime/session/pane/terminal replacement, app locking, adapter replacement and
relevant host-profile changes. Final responses are settled while the native
authorization locks are held; foreign callbacks run after those locks are released.
Native policy decides whether source or jump-host keys require biometric approval.
Confirmed mutations update the native projection before replying, so a following
host request does not wait for React to render. Newer app projections fence delayed
mutation completions.

TypeScript publishes secret-free application context and implements typed biometric,
credential-store, profile-store, snapshot, transcript and existing connection effects.
Its only operation handles are abort controllers for live platform connection calls.
It does not dispatch host tools, determine host ownership or build MCP results.
Credentials cross the private effect boundary only and never enter tool projections.
Storage exceptions become bounded typed failures rather than remote error text.
Credential-source fences are also checked against the committed native repository,
so an older React context cannot authorize a newly changed credential source.

Deletion keeps the existing transcript → snapshot → profile/credentials → live
runtime teardown order. Failure or cancellation prevents later phases. Error details
include completed phases and the possibly ambiguous current phase so a caller can
inspect state before retrying. Earlier commits are retained; metadata and secure
storage do not share an atomic transaction. Their lower-level compensation and
recovery policy belongs to the native credential coordinator described below.

### Host and credential transactions

Rust `CredentialCoordinator` owns host/profile saves, metadata edits, deletion,
disconnect timestamps, global SSH key mutations, Tailcat identity preparation,
and encrypted credential backup/recovery. Admission reserves a position in one
native FIFO shared by coordinator instances. Mutations read committed metadata
inside that queue rather than trusting an old renderer snapshot or caller key
array. Full profile saves reject stale revisions; deletion records retain IDs
that cannot be resurrected by an old editor or restoration request. Credential
reads bind private material to the current connection target. React keeps only
form state and versioned presentation subscriptions.

Keychain and the app-data database are separate stores. A host mutation commits
its metadata and a secret-free intent in one database batch, then updates secure
storage and its optional encrypted backup. Primary credentials carry opaque
receipts inside secure storage. Failure after the metadata commit publishes the
committed metadata, retains the pending intent, and returns a typed partial-commit
error. Restart repair finishes deletions and receipt-proven writes. An unproven
write requires an explicit host save/delete; it never silently generates a new
Tailcat identity or treats old credentials as the newly saved value. Native
timestamps advance monotonically to distinguish rapid edits.

Global key mutations first record public before/after metadata, then write secure
material, then commit metadata. A failed metadata commit compensates using the
previous material read within the same native queue. Failed compensation retains
the intent. An authenticated unlock reconciles the secure-store receipt with its
before/after metadata after restart; unrecognized states preserve both stores and
fail closed. Loading public key metadata alone never performs that private read.

Cancellation stops later effects. A worker retains its queue position until every
started storage callback settles, even if its client future is dropped or its
adapter closes. Necessary compensation and journal cleanup remain within that
same queue position. A delayed callback cannot overwrite a later deletion.
Platform callbacks only execute typed database, Keychain, biometric and native
vault primitives. They check native permits before execution and return bounded
outcomes without exception text. Rust decides completion, fallback, rollback and
recovery; no JavaScript mutation queue or cross-store compensation remains.

Only ciphertext enters the backup map. Recovery resolves selected IDs against
current profiles, retains per-host failure counts, and cannot restore tombstoned
IDs. Clearing the final encrypted backup attempts recovery-key cleanup; a cleanup
failure is diagnosed without reversing the deletion. Existing AsyncStorage import
receipts and legacy Keychain sources remain intact for migration retries.

### Known-host trust transactions

`app_database/known_hosts.rs` owns the process-wide SSH trust repository. Its
synchronous `begin` reserves FIFO order in the existing application database
worker before foreign async polling can reorder calls. Rust owns loading and
mutation admission, record validation and IDs, durable trust/revoke writes,
commit/rollback, and typed, revisioned projections. Prepared records become
effective in SSH authentication only after the database commit succeeds. Failed
reads or malformed data preserve previously installed trust and block mutations;
failed writes preserve the committed list and remain retryable.

The repository uses the existing `herdr.known-hosts.v1` row and Rust known-host
domain store. The read-only AsyncStorage importer and its native migration receipt
remain unchanged. After initialization, Rust reads the current database row;
the older batched startup snapshot cannot hydrate or replace trust. TypeScript
only forwards semantic commands, maps cancellation signals and typed outcomes,
and reads a fresh native projection before updating the UI. It owns no trust
mutation queue, prepared token, persistence acknowledgement, or rollback policy.
OpenSSH key representation, matching and explicit unknown-host approval remain
unchanged; changed keys and unsupported host certificates retain their distinct
SSH errors. Diagnostics contain operation categories, never host-key material or
raw storage exceptions.

Loads and replacement owners advance a native generation. Queued work and read
completions from an older generation cannot install records or publish Loaded.
Bridge detachment closes the owner while retaining committed trust. Dropped
callers and explicit cancellation stop queued work. Under the native state lock,
a mutation seals its commit point immediately before database I/O: `cancel()`
returns false after this boundary, and the native worker completes that durable
operation before processing the next one. Disk I/O holds no UI-facing state lock.
If ownership changes during a sealed commit, the write finishes in order while
the replacement stays Loading until its own authoritative read. Result consumption
is single-use; delayed result delivery cannot regress the rendered trust list.

### Agent-facing browser operations

Rust owns logical browser sessions and tab IDs, selected-tab admission, document,
view and driver generations, request ordering, leases, deadlines and cancellation.
Each MCP request pins its tab and position in the FIFO session queue at admission.
Cancelling a waiter preserves the order of later requests. Requests arriving
during archive hydration use the initial restored selection, so a later UI tab
selection cannot redirect them. Saved page locations never authorize an agent;
the native Reverse Control owner still validates runtime, launch, pane, terminal
and transport generation before effects and final replies.

The existing Rust browser engine drives DOM programs, navigation completion,
typed tool results and downloads. Typed platform effects prepare the SSH route,
mount/restore a WebView and execute individual page primitives. Native permits
reject stale documents, replaced drivers, renderer crashes, data clearing and
route changes, including late callbacks after cancellation or reconnect. Reads
are fenced again while settling the MCP response. Explicit user navigation also
invalidates an agent's pending page effect. Browser leases prevent view-budget
reclamation until the owning native request settles.

React owns actual WebView/WKWebView handles, native history tokens, view residency,
navigation controls, local UI commands and page-location persistence. It keeps
only per-effect abort handles for pending platform work; browser MCP requests no
longer pass through the JSON action/reply registry or a JavaScript agent queue.
Available views need no separate prepare round trip for each primitive. Downloads
remain native cache files uploaded as bytes to the original SSH owner, with
cancellation/rollback and cache cleanup through the transfer boundary.

### Terminal composer submissions

Rust `TerminalSubmissionQueue` owns per-terminal message IDs, admission, FIFO
ordering, retry limits, cancellation and typed submission projections. React
retains editable drafts, keyboard/focus state, image previews and native attachment
resources. A queued message transfers those resources out of the draft; successful
native completion releases them and publishes command history exactly once.
Unqueue transfers them back without discarding subsequent draft edits. Renderer
remounts retain unsent queues; authoritative terminal/session removal cancels them.

The renderer supplies the existing native keyboard barrier and terminal arbitration
reservation. SSH pastes are encoded by the originating xterm instance inside that
reservation. Only a Rust-minted permit can dispatch the resulting input. Native
writes pin runtime incarnation, SSH generation and terminal/pane identity; SSH shell
writes also pin the shell operation epoch. Delayed encoding, reconnection or adapter
replacement cannot revalidate an old permit or redirect it to another terminal.

Failures before dispatch remain unsent and may retry with bounded native backoff.
SSH input is accepted when its complete encoded submission enters the existing
native transport queue, which does not prove remote execution. Herdr retains the
existing separate paste/separator/Enter requests without replay, checking ownership
before each request. Lost replies and partial writes become ambiguous and block the
queue. They never resend automatically; the UI exposes the uncertainty before an
explicit unqueue/edit action. Queue contents are transient and are not restored
after process termination; persisted drafts and composer preferences are unchanged.

### Terminal plane

Each opened Herdr terminal owns an independent SSH stream-local channel to the
server's client-protocol socket. The Whip Rust core owns protocol validation,
binary encoding/decoding, the `Hello` / `Welcome` / `AttachTerminal` state
machine, prepared connections, and protocol-level cleanup. Its Herdr bridge
asks the shared connection for a logical length-prefixed terminal stream;
terminal frames do not travel through a JavaScript codec, generic JSON event
path, or a second native library. React Native sends
semantic input, resize, scroll, and close operations and receives typed control
events plus raw binary terminal/graphics payloads for the renderer. Do not
substitute the human-facing
`terminal attach` command: nesting that interface inside an SSH PTY leaks shell
chrome and breaks application-level input and resize behavior.

`TerminalAttach` is a direct pane connection. Its input bypasses Herdr's management
prefix router, so Whip must expose workspace, tab, and pane operations as native
actions. Ctrl/Alt and control bytes in the terminal key rail belong to the program
inside the pane; they are not Herdr navigation shortcuts.

Terminal sessions are identified by `terminal_id` and can be switched or closed
independently. Each `AppCore` session owns the ordered logical terminal rail,
its active `terminal_id`, metadata, and application-level lifecycle projection.
The attached `HostRuntime` separately owns the actual terminal registry,
transport lifecycle, restoration, geometry, and bridges. React projects the
rail and keeps terminal WebViews mounted while the user switches hosts, tabs,
and panes; input and resize events are routed to the exact native terminal
connection, and metadata commands never share an interactive shell channel.
Rust terminal lifecycle events include the native retry attempt and whether a
retry remains scheduled. React projects those events for status rendering;
persisted terminal metadata excludes transient transport state.

The renderer is responsible for ANSI color, alternate screen applications, cursor modes, bracketed paste, resize, selection, scrollback, clipboard, and mobile special keys. It does not interpret Herdr management state.

### Billing access policy

Rust `billing` evaluates trial eligibility and expiration, RevenueCat entitlement
identifiers, Cowboy/Rancher capabilities, distribution rollout, developer override
precedence, and purchase availability. One typed projection supplies the effective
tier, access reason, SDK status, trial countdown, capabilities, purchase route,
and next countdown/expiry deadline. Native store builds ignore developer overrides;
GitHub/development builds retain the existing preview and simulator behavior.
Unknown or unavailable customer information is distinct from confirmed absence of
an entitlement and cannot grant lifetime access from stale SDK data. A valid
installation-based trial is evaluated independently of SDK availability.

TypeScript adapts RevenueCat customer information and platform installation time,
executes purchase/restore/paywall and URL operations, renders localized prices,
and applies the projected cosmetic capabilities without mutating saved settings.
SDK reads are fenced across adapter lifetimes and customer-info events so delayed
refreshes cannot replace newer purchase/restore results or revocations. Resume and
Rust-provided countdown deadlines trigger policy evaluation with the current
clock; no trial duration, entitlement-to-tier table, or override decision lives in
React. Client-side cosmetic gating is not remote authorization: services must
verify paid entitlements independently.

### Rust-owned agent transcripts

Codex and OpenCode panes can expose two presentations of the same live process. The existing
Herdr terminal stream continues to feed the mounted xterm Terminal View. After
the user explicitly opens Chat, the Rust `HostRuntime` uses the pane's Herdr
`agent_session` ID to open an `AgentSessionManager` entry and resolve that exact
Codex rollout or OpenCode export/event source through the existing stable
connection:

```text
Herdr terminal stream       Codex rollout JSONL       OpenCode export + event DB
        |                           |                            |
        v                           v                            v
  Terminal View              Rust agent source/session runtime
                                           |
                             framing / cursors / retry
                                           |
                                           v
                               typed AgentTranscript
                                           |
                                           v
                                   Native Chat View
```

Rust owns rollout identity, byte-oriented JSONL framing, partial lines,
received/committable/durable offsets, source replacement and truncation
detection, catch-up, retry/rebind, and incremental normalization. The shared
connection layer guards the SSH generation and suppresses data and close
callbacks from replaced transcript streams; transcript state uses its own
operation and source epochs for reducer correctness.
Each state projection has a monotonic revision and can be fetched in full, so a
missed callback does not lose transcript correctness. The remote rollout remains
authoritative. Rust owns the host/agent/session identity, checkpoint format and
compatibility checks, and all local persistence through the official embedded
`turso` crate. A process-wide conversation database worker owns its connection
and orders reads, writes, final detach checkpoints, retention and host deletion.
It uses the existing Rust runtime from a dedicated thread, keeping portable
database I/O off the UI thread and Tokio executor threads. Only a successful
WAL transaction COMMIT with FULL synchronization confirms a durable checkpoint;
failed writes leave the durable cursor unchanged and allow a later retry. At
most one regular full checkpoint per session is in flight. Final detach admits
its checkpoint before evicting the core, and a fast reopen reads behind that write.

Native bootstrap provides Android's private no-backup files directory or an
iOS Application Support directory excluded from backup. `conversations.db`
contains a versioned conversation catalog with host namespace, agent, session,
creation/update times and checkpoint byte counts. A separate checkpoint table
references conversation IDs with cascading deletion. Saves commit both tables
atomically; catalog listing and pruning never materialize checkpoint blobs.
Identity and chronological
indexes support lookup, host pruning and saved-conversation listing without
reading blobs. Future message and search tables can reference conversation IDs
without changing the checkpoint format. The Turso FTS feature is compiled in;
current persistence does not create FTS tables or use experimental FTS APIs.

Opening Chat binds the terminal and semantic session, then asynchronously asks
Rust to restore and start that exact binding. A late restore is rejected if the
terminal was closed or rebound meanwhile. UniFFI carries normalized transcript
state and saved-conversation metadata; serialized checkpoints and confirmation
tokens never pass through JavaScript. Offline reads need no host runtime or SSH.
Missing caches remain a normal empty offline result and rebuild from the remote
source when available. Corrupt or incompatible databases are recreated after
closing all handles; ordinary I/O, permission and capacity errors do not delete
the database. Each transaction is durable independently of orderly shutdown;
dropping the last database sender drains admitted jobs and closes the worker.
UI reloads and background transitions keep the process-owned database alive.
The disposable Expo cache is not migrated. The worker removes only the old
`whip-agent-chat.db` file and known SQLite sidecars in Expo's former directory.
Transient source failure retains known content as stale rather than replacing it
with an empty transcript.

`AgentTranscript` is agent-neutral typed domain state: messages, turns, text,
visible reasoning summaries, tools, plans, notices, file diffs, lifecycle status,
and stable source-derived IDs. React Native mechanically projects those records
into the existing render types and retains only UI concerns such as scrolling,
expansion, composition, markdown, and navigation. It does not know rollout paths,
offsets, OpenCode event sequences, JSONL records, or retry policy. OpenCode uses
an official export for a cold snapshot and polls only newer durable events with
`opencode db`; Rust validates sequence continuity and falls back to an export on
divergence. Chat composer submissions return to the same Herdr pane and PTY used
by the mounted terminal.

### Rust-owned remote operations

`HostRuntime` owns Whip's non-UI remote-operation services. Its remote-filesystem
methods normalize Unix paths against the remote home directory and provide typed
directory entries and bounded UTF-8 reads over a generation-scoped lazy SFTP
session. Missing metadata remains absent; failed reads remain errors. React
Native receives absolute entry paths and does not parse `ls` output or assemble
operation paths from strings.

The runtime's `RemoteOperationManager` accepts native local file paths produced
by the Expo picker cache, streams bytes directly between the local file and SFTP, and exposes only
a stable `TransferId`, throttled byte progress, cancellation, and a typed final
result. Uploads write a unique temporary sibling, close it, then rename it into
place. When replacing a file, the previous destination is temporarily preserved
and restored if finalization or cancellation fails. Downloads likewise use a
temporary local sibling and rename only after a complete stream. Connection
replacement fails current transfers instead of attempting an unsafe implicit
resume; stale or cancelled completions cannot become successful. At most four
transfers run per host.

Attachment placement (`~/.whip/uploads`, collision-resistant naming, directory
creation, atomic transfer, and cleanup) is a Rust workflow. React Native retains
file/camera/photo/clipboard selection, preview chips, progress rendering, and
cancel intent. Picker inputs are copied by Expo to an app cache `file://`
location on Android and iOS before Rust opens them, so platform content handles
never become JavaScript/base64 transfer payloads.

The Git operation layer continues to run the remote `git` executable through
SSH, but Rust owns command construction, centralized POSIX shell quoting, exit/output
validation, porcelain `-z` parsing, absolute changed-file paths, and bounded
unified-diff parsing. React Native receives `GitRepository`, typed status entries,
and typed diff rows; it retains only tree grouping and rendering preferences.

The preview portion of `RemoteOperationManager` owns OS-assigned local listeners,
SSH forward/file-server resources, remote HTML server process metadata, cleanup, and idempotent stop.
React Native receives a `PreviewId` and local/display URLs, never a local port or
transport handle. Reconnect marks open previews disconnected and closes their
resources; previews are reopened explicitly instead of silently presenting a
dead URL. At most eight previews are open per host.

## Application and presentation state ownership

Rust owns two distinct levels of state:

- **`AppCore` application state:** application sessions across hosts, the active
  session, client-side workspace/tab/pane selection and repair, ordered logical
  terminal rails and active terminals, startup restoration, connection admission,
  Herd aggregation, and revisioned typed application projections.
- **`HostRuntime` per-host truth:** connection/reconnect state, authoritative
  `HostState` topology and server focus, synchronization/freshness, terminal
  transports, agent transcript sessions, monitoring, diagnostics, and remote
  operations. `AppCore` references these runtimes; it does not become a second
  owner of Herdr state.

React Native owns presentation and platform integration:

- **Profiles and platform security:** persistent profile metadata, last-used
  state, credential-store integration, and confirmation UI.
- **Mechanical render caches:** the latest typed, monotonic `AppCoreView`,
  `HostState`, Herd, terminal-rail, transcript, latency, and diagnostic
  projections needed to render without reconstructing native state machines.
- **Thin adapters:** one non-serializable `HerdrClient` facade per live host plus
  AppCore projection adapters. They forward typed semantic application/runtime
  operations and native views; they are not authoritative state owners.
- **Terminal presentation:** mounted WebView/xterm lifecycles, ANSI rendering,
  gestures, selection, scrollback, renderer caches, composer drafts, font size,
  and other presentation preferences. Rust owns the logical rail and transport;
  React owns how each rail entry is rendered.
- **Transcript presentation:** React subscribes to Rust transcript projections
  and requests typed offline reads or saved-conversation metadata. Rust applies
  fresh, synchronized Herdr retention directly, including unopened agents and
  previous-run caches. Runtime/revision guards reject stale retention and writes
  from replaced runtimes; host deletion fences delayed saves. Confirmed removal
  also releases presentation state. Temporary detach, disconnect and failed sync
  preserve history; a transcript shared by surviving panes is retained.
- **Platform surfaces:** navigation destinations, sheets, forms, pickers/share,
  previews, notifications, and presentation preferences. React may use
  transient optimistic workspace/tab/pane focus while a UI operation settles;
  Rust `AppCore` remains the durable, reconciled application selection.

Transport objects do not live in React component state. Rust owns application
state machines, SSH/API lifetimes, and connected-host domain truth; React
consumes typed versioned projections and invokes semantic actions through thin
facades. Client-side selection is distinct from Herdr server focus: changing
the former does not mutate the latter unless React invokes an explicit focus
operation.

## Mobile information architecture

### Hosts

A saved-host list is the entry surface. It shows identity, address, last connection result, and a primary connect action. Editing authentication is separate from operating a connected Herdr session.

### Herd

The attention surface can scope the queue to one live host or merge every live host. It orders agents by actionable status: blocked, done, working, idle, unknown, while preserving host, workspace, and pane context for terminal attachment and host-specific actions.

### Workspaces

Native workspace, tab, and pane navigation replaces the corresponding Herdr TUI
chrome. `AppCore` owns and reconciles durable client selection; React may show a
transient optimistic choice while an explicit focus operation changes server
focus. Closing a tab takes effect immediately, while other destructive
operations require confirmation.

### Terminal

An immersive terminal surface keeps a slim scrollable session rail, connection status, close/new actions, and a horizontally scrollable mobile key rail. Switching back to Herd, Hosts, or More must not disconnect or recreate terminal sessions.

### More

Connection details, notifications, speech, terminal preferences, known hosts, diagnostics, and disconnect are device-local settings. Server-owned Herdr settings should be clearly distinguished from mobile preferences.

More also presents device-local usage for today, this week (Monday start), this
month, and lifetime. A process-wide Rust tracker counts the union of foreground
time and background time with at least one fresh, working agent. Runtime events
update it before foreign callbacks, so background accounting does not depend on
React timers or mounted screens. React supplies lifecycle visibility, the app
documents path, and local calendar boundaries (including DST). Rust stores
disjoint usage spans and a lifetime total, atomically checkpointing
every 15 seconds and on activity transitions. A restart never resumes an old
interval; suspension gaps over five seconds and large clock changes are not
credited. Abrupt process death can lose up to one checkpoint interval. No remote
content or host identity is persisted in usage history.
The selectable usage chart groups those spans into local hours, days, months,
or years. Rust clips intervals at the supplied calendar boundaries, including
DST transitions; retaining spans keeps the lifetime chart available over time.

## Reliability rules

- Native activity launch is not proof that JavaScript rendered; visually inspect the expected screen.
- A stale control-plane connection must be visible and must not silently present old state as live.
- `HostRuntime` serializes reconnect attempts per host with bounded equal-jitter
  backoff, an explicit lifecycle state, monotonic epochs, and cancellation on
  user disconnect. A stale transport, event subscription, or terminal open may
  not replace a newer generation.
- During reconnect, retain known-good host state and mark it stale. Rust restarts
  the event subscription, performs a generation-guarded snapshot sync, and only
  marks the projection fresh after reconciliation. A failed read never becomes
  a successful empty snapshot.
- Terminal frames are byte-stream ANSI data carried through the typed UniFFI/JSI path. Do not convert the hot path to JSON strings or reinterpret partial UTF-8 before xterm receives the bytes.
- Keep control and terminal failures independent. One failed terminal must not disconnect the Herdr dashboard or other terminals.
- Backgrounding may suspend polling/rendering, but it must not imply that the remote Herdr session stopped.

## Current implementation

Implemented:

- a shared Rust `AppCore` owning application sessions across hosts, active
  session selection, workspace/tab/pane client selection and repair, logical
  terminal rails, multi-host Herd aggregation, and revisioned typed views;
- concurrent remote SSH control connections with an active-session selector;
- structured Herdr snapshots and native management screens;
- independent client-socket terminal controller per opened pane;
- persistent Hosts, Herd, Terminal, and More navigation adapted to Android and iOS conventions;
- a live-host rail plus nested Herdr workspace/tab/pane navigation;
- multiple mounted, switchable terminal sessions per host with Rust-owned bounded reconnect and same-host restoration using the last native geometry;
- Rust-owned Codex Chat sessions from exact Herdr session identity and remote rollout JSONL, with incremental parsing, durable opaque checkpoints, typed normalized projections, source-generation guards, and reconnect-safe live following;
- Rust-owned snapshot/event reconciliation with in-flight event replay,
  generation-guarded stale-response rejection, monotonic projections, and
  coalesced repair syncs;
- typed binary terminal frames through UniFFI/JSI, batched at the WebView boundary;
- terminal search, clipboard and OSC 52 writes, selection handles, long-press selection/paste, remote viewport swipes, and configurable gestures;
- mobile extra keys with one-shot and long-press-locked Ctrl/Alt modifiers;
- persisted terminal font, scrollback, cursor, notification, speech, language, appearance, security, and navigation preferences;
- multiple saved host profiles with platform-protected credentials and last-used ordering;
- strict host-key verification, nested jump hosts, restricted agent forwarding, and SSH-backed private-network browser tunnels;
- Rust-owned typed SFTP browsing, atomic native-file transfer, attachment placement, deletion, Git status/diffs, and `PreviewId`-managed forwards for text, code, Markdown, images, SVG, Mermaid, PDF, audio, video, and sandboxed HTML;
- shared Rust/Russh SSH behavior on Android and iOS through UniFFI, with typed binary terminal frames on the hot path;
- native Herdr control request/response handling and typed event-stream framing, validation, and normalization shared by Android and iOS;
- a shared Android/iOS Rust `HostRuntime` with explicit connection states,
  generation guards, cancellable reconnect, event-stream restart, and terminal
  restoration plus authoritative workspace/tab/pane/layout/focus/agent state;
  `AppCore` references one runtime per application session, and React Native
  receives typed lifecycle and versioned state projections;
- Android release signing/Play delivery, signed iOS App Store distribution, and unsigned ARM64 iOS device artifacts for CI compile validation.

## Local durable application data

`app_database.rs` owns `whip-app.db`, separate from the disposable transcript
cache. Native bootstrap chooses Android's private database directory (covered by
both backup rule sets), or iOS Application Support/WhipAppData (included in backup).
A dedicated worker serializes transactions using the existing Rust runtime;
portable database I/O never runs on the UI thread or Tokio executor. WAL with
`synchronous=FULL` acknowledges writes only after commit. The versioned
`app_values` table stores small settings and snapshots by their existing stable
keys, alongside a transactional migration-receipt table. Structured conversation
catalog and checkpoint tables remain separate for lookup, retention and future
search. Existing Rust host, trust, terminal and browser domain models keep their
validation, ordering and serialization responsibilities.

`appStorage` initializes the database and imports older data before reads or
mutations. Startup metadata is read in one batch; the trust repository performs
its own generation-fenced read before admitting mutations. Session persistence uses one native
`SessionPersistence` worker after the same initialization barrier: snapshot
deadlines, pending exports, runtime/revision cursors, terminal resume/font
transactions and live-host membership identities are Rust-owned. Commands enter
the worker synchronously in call order; committed identities advance only after
successful writes. Failed exports remain retryable and leave the previous durable
snapshot readable. Snapshot deletion follows earlier admitted writes and
cancels pending exports. Terminal persistence is gated on native storage
hydration so placeholders cannot overwrite a saved rail. Other app consumers
continue through the `appStorage` adapter. An initialization/read error remains an error, never an authoritative
empty store. Durable database corruption or a newer/unknown schema is reported
without deleting files, modifying SSH trust or enabling writes with defaults.
Only the separate transcript cache may be recreated automatically.

The AsyncStorage dependency remains exclusively as a read-only upgrade source.
Rust's key inventory selects every current fixed/dynamic key family and the older
host, device preference and browser preference formats used by direct upgrades.
One complete legacy snapshot and its receipt commit in a single transaction;
failed/incomplete reads and failed commits leave migration unfinished and retryable.
A committed receipt makes retries no-ops even if acknowledgement was lost, so
legacy values cannot overwrite edits or resurrect deleted data. Legacy data and
unknown library keys are retained for recovery, never cleared. Keep this importer
in future releases for users skipping versions. See
[the storage key inventory](docs/local-storage.md).

Passwords, private keys and passphrases remain in platform Keychain/Keystore.
Only metadata and native AES-GCM credential-backup envelopes enter Turso; metadata
writes containing unexpected plaintext credential fields are rejected. Android
Block Store recovery, device-bound wrapped keys and global-keychain rollback
behavior remain unchanged. Background image/download/usage files remain at their
existing locations with their existing backup behavior. No cloud database or
synchronization is configured.

## Local agent alerts

The Rust `LocalAlertCoordinator` owns local agent alert admission, host/pane/tab
identity, pending and active lifetimes, announcement ownership, dismissal, and
stale-result fencing. React forwards native status transitions, alert preferences,
and foreground state; Rust chooses whether to alert, dismiss, or use brief
foreground delivery. The coordinator receives runtime attachment identities and
invalidates that host's alerts when its runtime is replaced or detached.

Commands synchronously return typed effects with unique IDs. The TypeScript
adapter asks Rust to admit each effect immediately before calling the platform,
then acknowledges completion, failure, or skipped admission with the same ID.
Late scheduling results produce notification cleanup; late speech callbacks
cannot resume dismissed alerts or cancel a newer announcement. Token-scoped
speech stops preserve chat playback. Rust serializes Android persistent-alert
arming and dismissal and reconciles late completions against the current owner;
native dismissal also checks the notification ID.

TypeScript/native adapters own Expo notification scheduling and dismissal,
Android channels, permissions and presentation, localized text, vibration, TTS,
and native persistent-alert timeout/shake/OS-dismissal behavior. There is no
second authoritative alert lifecycle in TypeScript. The Rust coordinator is
independent of remote push registration, encryption, and relay delivery; it does
not run a native timer or renew remote push leases.

## Optional encrypted remote notifications

The independent [`whip-notify`](whip-notify/) Rust package and Herdr plugin provide remote push through [`notify-relay`](notify-relay/), a Cloudflare Worker/D1 service using Expo/APNs/FCM. WhipAir is isolated and unchanged. No host daemon or additional network listener is required. The existing local notification pipeline remains available without either component.

The Rust application notification manager owns device registrations, ordered enable/encryption/revoke transitions, relay verification, cleanup tombstones and replay admission. Platform adapters perform opaque Keychain storage, push-SDK and HTTP effects; typed state and semantic commands cross the UI boundary. A running JS notification consumer supplies a liveness pulse every three seconds, and the manager renews private device leases over the existing Rust SSH runtimes only while delivery and runtime health permit it. Stale or busy pulses never queue for later renewal. Herdr's `pane.agent_status_changed` hook checks each registered device's host-filesystem mtime independently: a lease younger than ten seconds suppresses remote delivery; expired, missing, corrupt or future-dated leases select remote delivery. iOS suspension and loss of Android JS/service readiness stop renewal. There is an unavoidable ten-second crash window and no exactly-once claim.

The host encrypts padded, versioned events separately for each device with RFC 9180 HPKE Auth (X25519/HKDF-SHA256/ChaCha20-Poly1305). Device keys live in the platform Keychain; the host notification identity is pinned over authenticated SSH. The relay holds routing tokens and opaque delivery metadata, never plaintext or decryption keys. APNs/FCM display a generic alert without starting JavaScript. On tap, Rust authenticates/decrypts and checks replay state; Whip reconnects to the saved host, obtains a fresh Herdr snapshot and resolves the pane. Receiving a push never schedules another local alert.

Each saved host's detail screen owns its relay configuration, device registration and plugin install/uninstall controls, using the existing Rust SSH runtime and Herdr's native GitHub plugin installer/API. It queries plugin status only for that host. General Settings retain local alert preferences. Installation pins the plugin release tag and downloads a SHA-256-verified arm64 Linux or macOS executable; hosts need Git and curl, with no Rust compiler or marketplace listing. An independent GitHub Action tests, builds and publishes the binaries without changing the mobile app's latest release. Herdr installations are shared by the SSH account's sessions, while opt-in and lease state stay per device/session. Uninstall stops that account's hooks and preserves host configuration for reinstall.

Clients use the managed relay by default without an enrollment code or shared client secret. Protocol 2 creates an inactive registration and sends a random, expiring proof through Expo to the intended receiver. The foreground app confirms it with its independent management capability before the route is activated. The proof is consumed transactionally and bound to that registration's routing parameters. Global D1 budgets limit verification pushes per token/IP. Pending state expires and is cleaned on the existing schedule. Token possession does not replace the SSH-pinned host identity or HPKE authentication. Self-hosted relay origins are optional host-detail settings.

Herdr 0.9.5 uses the dotted subscription above but serializes the hook envelope as `pane_agent_status_changed`; a captured real-hook fixture checks that boundary. The Worker uses manual redirects and rejects non-success responses because Workers does not implement Fetch's `error` redirect mode. Simulator push registration explicitly selects APNs sandbox; production devices retain provisioning-profile detection. Real Expo/APNs simulator acceptance covers terminated-app delivery, authenticated cold navigation with a fresh snapshot, active leases, and remote fallback after iOS backgrounding.

[Remote notification documentation](docs/remote-notifications.md) specifies the wire format, compatibility checks, optional server installation, native push provisioning, deployment, per-device enable/revoke/rotation/uninstall lifecycle, tests and limitations.

## Pairing and authorized-key application workflows

Issue #269: `ssh_workflows` is the Rust application owner for WP4 pairing
and authorized-key installation. TypeScript services submit immutable typed
requests and map results for the UI. Rust resolves canonical profiles outermost
first, validates route identities and prior-connection eligibility, asks for
biometric authorization before reading private keys, and obtains credentials and
Tailcat identities through the existing credential transaction coordinator.

Each operation has a native identity and generation. Credential edits invalidate
operations on admission to the native FIFO and block new workflows until the edit
settles. App lock and bridge detachment revoke the generation. A screen's
AbortSignal cancels its operation. Every prompt receives a short-lived native
permit, checked on entry and after its asynchronous response. Platform exceptions
become bounded typed errors without forwarding credential or private-key text.

Typed unknown-host challenges are bound to the exact route endpoint, algorithm,
public key and fingerprint. Rust allows at most one approval/retry per endpoint.
Changed keys have no approval path. Rust commits approvals through the shared
durable known-host repository, verifies the committed projection, and only then
retries. The post-commit platform effect refreshes UI trust state; it cannot
authorize a retry. Credentials, selected key and route remain pinned. Workflow
admission serializes prompts and mutations while existing SSH/ProxyJump/Tailcat
transports perform the I/O.

The transport checks the operation before authentication and seals mutation
dispatch against revocation. Only typed unknown-key failures before dispatch can
retry. Transport loss, timeout or cancellation after dispatch returns a typed
`OutcomeUnknown` containing the operation identity; enrollment and authorized_keys
commands are never automatically replayed. Authenticated hops close on
cancellation. Rust tests use fake platform and transport effects; adapter tests
cover callback permits, cancellation and result mapping.
