# Claude Code Chat View

Claude panes use Herdr's existing `agent_session` ID and Whip's native
`AgentTranscript` model. Input still goes to the same pane/PTY. Neither React
Native nor the terminal renderer parses Claude transcript records.

## Discovery and lifecycle

Rust validates the session ID as a UUID and searches
`$HOME/.claude/projects/**/*.jsonl` for that exact filename. Candidates are
ordered by modification time, then pathname for deterministic ties. Subagent
and tool-result directories, control characters, and path traversal are
excluded. Records explicitly naming another session are ignored.

Codex and Claude share `agent_transcript/jsonl.rs`: byte framing, device/inode
source identity, source generations, reconnect cursors, and durable offset
confirmation. `agent_sessions.rs` shares stat, `tail -c +OFFSET -F`, cache
publication/backpressure, retries, and a periodic stat check that rebinds a
replaced or truncated source. Codex's existing cache schema remains compatible.
OpenCode keeps its export/database cursor lifecycle.

A reconnect resumes after the last complete incorporated record. A crash
resumes from the persisted checkpoint; partial tails are reread. Claude safely
skips malformed complete records, including oversized/invalid UTF-8 lines.
Cached history remains loading until the remote opening byte boundary is
reached. Source replacement discards the old projection and byte cursor.

## Projection

- User prose and assistant text become native messages. Assistant `thinking`
  becomes reasoning; signatures and redacted thinking are omitted.
- Whitespace-only text is omitted while its record remains in the ancestry
  graph. Persisted structured interruption markers become warning notices in
  the current turn; `isApiErrorMessage` becomes an error notice and failed turn.
- `tool_use` creates a stable tool part keyed by its call ID. The original tool
  name is preserved, with arguments mapped to neutral input fields.
- Outer `user` records containing `tool_result` never become user bubbles.
  Their `tool_use_id` updates the matching tool's status, output, error, finish
  time, and explicit exit code. `toolUseResult` can supply stdout/stderr,
  interruption, a file path, and structured edit hunks. Orphan results remain
  internal; ambiguous rich metadata for multiple results is not assigned.
- UUIDs, parents, and physical offsets are retained in normalized checkpoint
  nodes. Projection selects the latest main leaf and follows its ancestors,
  including metadata/progress links. A known `last-prompt.leafUuid` can select a
  branch; subsequent descendants advance it. Broken links/cycles fall back to
  chronological main records while pruning known sibling alternatives.
  Sidechain bodies never enter the main transcript.
- Multiple assistant records and tool completions stay in the same user turn.
  Custom titles take precedence over AI titles; `cwd` supplies the directory.
- Ordinary appends emit message/turn deltas. Branch changes truncate the
  affected suffix before inserting new IDs. Speech uses completed assistant
  records and preserves the existing loading/reconnect baseline behavior.

## Tolerated limitations

Unknown records and content blocks contribute no chat bubbles. Image/document
payloads, redacted thinking, tool-reference blocks, queue events, file-history
snapshots, and subagent bodies are ignored. Rich tool objects are inspected only
for known useful fields; durations, arbitrary diagnostics, and background-task
lifecycle metadata are not inferred. Explicitly unrelated session records are
ignored, including copied fork history with another session ID. Compaction
roots select the new active chain; this does not recreate historical context
that Claude removed or summarized. Local slash-command markup stored as an
ordinary user string remains text. In-place overwrites that retain the inode
and never expose a smaller size cannot reliably be identified by stat alone.

Text/output fields are capped at 64 KiB, content arrays at 256 entries, tool
arguments at 64 fields, and physical JSONL lines at the shared 4 MiB limit.
Only bounded normalized nodes are checkpointed; raw image payloads and unknown
wire objects are not retained. The remote JSONL remains authoritative.

## References and tests

The parser was implemented from inspected schema concepts, without vendoring
either application's parser. `test-fixtures/claude/main.jsonl` is an authored
fixture using representative shapes from:

- [claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer/tree/9367cf0),
  including `src/lib/conversation-schema`, `parseJsonl.ts`, and the sample
  project JSONL fixtures.
- [claudecodeui](https://github.com/siteboon/claudecodeui/tree/dc7cb6c6), including
  its Claude session reader, ancestry selection, and session synchronizer.

Rust tests cover content, tool reconciliation, branches, partial records,
malformed/oversized records, reconnects, source changes, offset checkpoints,
shell discovery, native identity, archives, and speech baselines. TypeScript
tests exercise the normalized bridge, pane recognition, saved-chat listing,
and speech routing for Claude alongside Codex and OpenCode.

An additional integration check uses an actual Claude Code 2.1.31 session
[published by kitaekatt as a bug reproduction](https://gist.github.com/kitaekatt/6881749202eea47fc54e506621378e78).
It contains 43 records (31,866 bytes): user/assistant messages, thinking,
AskUserQuestion calls, rejected tool results, interruption markers, blank
assistant blocks, an API error, and file-history metadata. Run:

```sh
nix develop -c node scripts/test-claude-transcript.mjs
```

The runner downloads the immutable raw revision
`e103924b94e89c0c9ef21222c51eafe401bd9913` and verifies SHA-256
`1e8a88ac211335fbac6d1c504d5330ff06e58b3b028bc889909e5d23f96b71e9`.
The unmodified third-party conversation stays under ignored
`.codex/claude-transcript-tests/`; only its downloader, provenance, and tests
are tracked. The normal test suite remains offline.

The integration test compares whole-file parsing with 1-, 97-, and 4096-byte
chunks and restores a checkpoint at every record boundary, including partial
tails. It checks tool reconciliation, absence of tool-result user bubbles and
empty text, and interrupted/error turn states. Offline regression tests retain
the minimal shapes needed to reproduce the defects found in this capture.
