# Codex transcript rebind failures (#280)

Investigated November 1, 2026 for [issue #280](https://github.com/kosumic/whip/issues/280).
The reported build is commit `814438b182e0c53950387f04ee7b7ac00f1b6647`.
Initial source comparison and baseline tests used `main` at `027e4848`.

## Finding and limits

The code confirms a failure amplification path: one failed metadata poll can
replace a healthy transcript stream with a dependency on fresh SSH exec requests.
The original SSH failure in this incident is still unknown. No Android device
was connected during this investigation, and the available local logs contain
the older Fish-shell incident, not the full discovery error reported in #280.
Initial rendering alone cannot establish whether this incident started from a
restored cache or a successful live read.

The affected commit already contains both `947e23d7` (Fish-compatible polling)
and `e8214068` (automatic Codex discovery retries). The relevant polling,
restart, and execution behavior survives on current `main`; the session-file
diff since the affected commit moves shared code into `agent-transcript-core`
and updates fixture paths. The previously diagnosed Fish syntax bug is not an
explanation for this build.

## Confirmed behavior before the fix

The lifecycle is implemented in
[`agent_sessions.rs`](../packages/react-native-whip-ssh/rust/src/agent_sessions.rs).

1. `monitor_file_source` normally issues an SSH exec every two seconds. For
   Codex, that request runs file metadata lookup, rollout discovery, and optional
   title lookup. It runs independently of the existing `tail -F` stream.
2. Any execution or metadata-parsing error discards its underlying details and
   calls `fail_session` with `Transcript source metadata became unavailable`.
   It does not first check whether the tail is still delivering data.
3. A transient failure sets `retry_running` and schedules a restart after 1.5
   seconds. Bytes arriving during that interval can mark the transcript live
   again, but `stream_data` does not cancel the scheduled retry. Fresh tail data
   therefore does not prevent the impending restart.
4. `prepare_restart` advances the operation epoch, removes the old stream
   context, and closes the exec stream. Old callbacks are then rejected.
5. `resolve_and_open` must complete rollout discovery, metadata lookup, and
   referenced-history loading before it requests another tail. Discovery failure
   leaves history visible but removes the path for subsequent append updates
   until a later retry succeeds.

This is a confirmed code path, not a captured sequence from the reported
occurrence. A genuine rollout change, stream closure, reconnect, or idle wake
can also initiate rebinding. The banner alone does not identify its initiator.

## Why the terminal can keep working

[`HerdrConnection::execute`](../packages/react-native-whip-ssh/rust/src/herdr_connection.rs)
and [`execute_with_input_on`](../packages/react-native-whip-ssh/rust/src/ssh/mod.rs)
open a fresh SSH session channel for each command. The terminal and tail use
other channels. A rejected new channel does not imply that an established
terminal channel is unusable.

The pinned `russh` 0.64.1 source formats a channel-open rejection as
`Failed to open channel (...)`. This is compatible with the visible `Fai...`
fragment, but does not prove channel rejection or server channel exhaustion.
The rejection reason, deployed SSH server configuration, and channel count have
not been captured. Do not change server limits based on this fragment.

There was also no request deadline in the transcript exec path. The connection
wrapper cancels work when its connection revision changes, but a request that
never completes on a current connection cannot reach the retry handler.
Additionally, the generic exec reader ignored `ChannelMsg::Failure` and exit
signals; `exec(true, ...)` queues a request rather than confirming its acceptance.
An exec rejection needs explicit handling, especially if the server leaves the
channel open. Their role in the original incident remains unconfirmed.

## Recovery, history, and error reporting before the fix

- Transport/exec failures classified as transient already retry indefinitely
  with a fixed 1.5-second delay after each completed failed attempt. Adding only
  another discovery retry would not address healthy-stream teardown or an exec
  request that hangs.
- `SourceUnavailable` follows a different policy: Codex gets four retries with
  delays of 250 ms, 500 ms, 1 second, and 2 seconds. Exhaustion retains usable
  history as stale but stops that retry loop. An explicit reopen or relevant
  activity transition can restart it.
- For an unchanged source identity, the shared
  [`FileSourceCursor`](../crates/agent-transcript-core/src/agent_transcript/jsonl.rs)
  resumes at the last complete, committable JSONL boundary. This differs from
  the durable cache cursor, which advances after database confirmation. Partial
  trailing bytes are replayed; already ingested complete records are retained.
  A changed path or invalidated file starts a new source generation and rebuilds
  the projection, including removal of reverted turns.
- Epoch and stream-context guards reject callbacks from replaced operations.
  No evidence currently identifies a stale-epoch violation as the trigger.
- `execute_bytes` wraps transport errors in `ReadFailed`; discovery and metadata
  lookup wrap that error again. Both layers render `agent transcript read
  failed`, explaining the duplicate prefix. Nonzero command exit status is
  discarded when stderr is converted to a string; missing exit status is not
  rejected. The poll error itself is discarded completely.
- `NativeTranscriptService` logs the resulting status/error, revision, and
  binding count, but that event lacks the operation epoch and session key needed
  to correlate polling with a particular rebind. Existing runtime-file records
  are limited to 1,024 characters, so full error capture needs explicit handling
  rather than blindly routing long errors through that logger.

## Investigation baseline

On baseline `027e4848`, all **75** `agent_sessions::` tests pass under both Bash and
Fish. This includes real-file append, truncation/replacement and reverted-rollout
checks, referenced history, cache restoration, retry policies, and stale callback
rejection. These tests do not inject a metadata SSH failure into the running
monitor after a successful live stream, or test a hung/rejected exec request.
Passing them does not establish recovery from #280.

```bash
nix develop --command env WHIP_TEST_REMOTE_SHELL=bash cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --lib agent_sessions:: -- --test-threads=1
nix develop --command env WHIP_TEST_REMOTE_SHELL=fish cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --lib agent_sessions:: -- --test-threads=1
```

Local output is in ignored `.codex-diagnostics/issue-280-{bash,fish}-tests.log`.
No APK was built or installed during the investigation.

## Implementation direction

Preserve a healthy tail through transient poll failures and retry polling
independently with capped backoff. Use successful source observations to detect
replacement/truncation; a failed poll alone does not establish either. Retain
the real restart path for changed sources and unhealthy streams, including its
identity and cursor validation.

Add structured diagnostics before suppressing the current poll failure: phase
(poll exec, poll parse, discovery, metadata, history, stream open/read, or ingest),
session key, operation epoch, stream state, cursor boundaries, transport error
category/reason, command exit status, and output truncation flags. Capture the
underlying error without logging command stdout, transcript records, or
credentials; keep a concise user-facing error with one prefix. Record cache
restoration and first successful live ingestion separately so the next incident
can distinguish them. Handle exec rejection and deadlines with channel cleanup.

Regression coverage should drive an established live stream through intermittent
poll/SSH exec failures while appending records, then successful polling, rollout
replacement, a genuine stream failure, and discovery recovery. Assert continued
updates, retained history, correct identity/cursors, and no duplicates. Exercise
the commands under Bash and Fish, and include rejected or noncompleting exec
requests. The full reported SSH error remains necessary to attribute the
original trigger.

## Fix

`agent_sessions/file_source.rs` now retries failed metadata observations without
changing a live transcript's status, history, operation epoch, or tail stream.
Active polling backs off from two seconds to four, eight, sixteen, and at most
thirty seconds; a successful observation restores the normal cadence. Paused
sessions retain their existing sixty-second idle cadence. An explicit POSIX
shell wrapper distinguishes a successful observation of a missing source from
a failed SSH/stat request. Confirmed disappearance, replacement/truncation, and
stream failure still use the identity-checked rebind path.

Metadata, discovery, and referenced-history SSH exec requests have a
thirty-second deadline. Command rejection and
exit signals are handled explicitly, and EOF without an exit status is rejected.
Timeout/cancellation closes only the affected command channel. A worker retains
an outstanding channel-open request until confirmation so a late channel can be
closed; a per-connection gate bounds outstanding opens if a server stops replying.
Optional agent forwarding does not request an acknowledgement, keeping its
response separate from exec acceptance or rejection.
Shell argument quoting also preserves literal apostrophes and backslashes across
nested POSIX/Fish command layers; a direct round-trip regression includes quotes,
backslashes, variable/command-substitution syntax, and newlines.

Diagnostics distinguish cache restoration, first live ingestion, rebinding,
discovery/metadata/history failures, poll execution/parsing/recovery, and stream
opening/reading/parsing. They include a hashed session key, operation epoch,
status, stream context, and source/received/committed cursors. Underlying transport
errors retain their category; failed commands retain exit status, stderr, and
truncation information. Details are split across numbered records so the runtime
logger's per-record limit does not cut off the underlying error. Command stdout,
transcript records, and credentials are not logged. User-facing failures contain
one error prefix and automatic-retry guidance.

The new loopback SSH regressions establish a live transcript, reject a metadata
channel, return malformed metadata, and append messages across both failures.
They then replace the rollout, close the real tail, fail/reject discovery execs,
and complete a partial JSONL line during recovery. Assertions cover continued
live updates, history retention, identity, rollback, and replay without duplicate
messages. Additional coverage checks confirmed source disappearance, full stderr
and exit-status retention, concise errors, missing exit status, rejected/hung
commands, late channel-open cleanup, and rejected streaming exec requests. The
remote command fixture supports both Bash and Fish.

Final validation of the fixed working tree:

- Full Rust library suite under Bash: **940 passed, 10 ignored**.
- Transcript suite under Fish: **79 passed**.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo fmt --check` and `git diff --check`: passed.

These commands were run through `nix develop`. Final output is in ignored
`.codex-diagnostics/issue-280-final-{full-tests,fish-tests,clippy}.log`.
Android device installation and observation remain pending; no device was
connected during this work.
