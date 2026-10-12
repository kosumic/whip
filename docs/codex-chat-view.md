# Codex Chat View history

Whip resolves the active Codex rollout using Herdr's native session ID and
follows its appended JSONL records over SSH.

Herdr can accept a Codex `/resume` session change without emitting a pane
update when the agent label and status stay the same. Whip reads `pane.get`
once when a bound Codex chat opens or returns to the foreground, and when
that chat's agent status changes. There is no additional identity polling
timer, and hidden chats do not make these reads. A changed session ID rebinds
the chat without requiring a prompt. Rust updates session identity only,
preserves status, scroll and focus, and discards responses overtaken by events,
snapshots, reconnects or local chat detachment. Unchanged identities emit no
host update; failed metadata reads leave the chat and connection state intact.

A silent `/resume` performed elsewhere while Chat remains visible cannot be
detected immediately without a Herdr notification. Opening Chat again,
foregrounding it or a subsequent status change triggers the identity check;
the existing host snapshot reconciliation also provides eventual recovery.

A Codex turn can contain additional user prompts consumed while the agent is
running. Whip retains every prompt in the turn's ordered message references
and begins a new assistant segment after each follow-up, so chat displays the
prompt between the surrounding responses. Tool completions still update the
segment containing their original call. Live updates, cache replay, and
backtracking preserve these references alongside the canonical turn ID.

Codex backtracking creates a replacement rollout while keeping the thread ID.
Its `SessionMeta.history_base` references an immutable prefix of an older
rollout instead of copying retained messages into the replacement. The
reference's `thread_id` identifies the older **rollout**, which can differ
from its stable thread ID. `end_byte_offset` and `end_ordinal_exclusive`
specify the retained boundary.

Before opening the replacement's live tail, Whip resolves the referenced
rollout in active or archived storage, reads exactly that prefix, follows any
earlier references, and replays the records from oldest to newest. It validates
both boundaries and rejects missing, truncated, or cyclic references. Prefixes
are read in bounded byte chunks so long histories stay below the SSH exec
output limit and UTF-8 characters survive chunk boundaries. Compressed `.zst`
bases are decoded with the host's `zstd` command.

Inherited records are cached separately from the active file's cursor. A
reconnection resumes the active file without duplicating retained messages;
older caches containing only the replacement file are repaired when bound
with the resolved prefix. The child rollout's header owns its identity and
initial directory, even when the retained records originated in another thread.

The regression tests in `agent_sessions/codex_history.rs` use real files and
the remote shell commands. They cover archived prefixes, repeated backtracks,
live appends, stale source callbacks, cache restoration and migration, large
UTF-8 prefixes, and invalid references.
