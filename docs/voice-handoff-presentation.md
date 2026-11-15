# Voice handoff presentation (#445)

The remote transcript remains the source of truth. Whip sends the original
Realtime tool request, or GPT-Live's existing bounded generated request, plus
the existing speaker-attributed JSON context. It does not rewrite the task,
promote speech captions to instructions, or insert synthetic executable turns.

## Presentation format

New agent-bound submissions append a versioned presentation record containing
an exact display request and the existing correlation nonce. Rust requires a
complete wrapper, matching canonical UUIDs, valid quoted context, and agreement
between the display request and actual task input. GPT-Live's known generated
instructions are checked separately from its exact spoken request.

There are no presentation keys, signatures, or additional persistence. This is
structural recognition, not an authenticity or authorization mechanism. A literal
complete valid wrapper has the same presentation meaning; marker-like user text,
quoted examples with surrounding text, mismatched requests/nonces, and malformed
or truncated wrappers remain raw. Older handoffs without presentation metadata
also remain raw. Replay uses the same format checks across installations.

Only user text parts receive the optional display request. Chat View, prompt
copying, pinned previews and native transcript search use it. Expanding “voice
handoff details” shows the unmodified remote text. Provider messages, checkpoints
and correlation fingerprints retain the full text. Submission IDs, targeting,
admission acknowledgments and completion correlation remain independent.

## Incremental context and provider parity

Realtime continues using `handoff_context::Context` and `Snapshot`: at most 32
public speech captions, 8 KiB of serialized caption data, 2 KiB per caption.
Snapshots freeze at tool admission, are filtered against the shared
acknowledgment/fingerprint cursor under the pinned agent's submission lock, and
advance only after a successful host acknowledgment. Newer caption revisions
are replacements; older deferred snapshots cannot roll the cursor backwards.
Failed/uncertain writes never advance it or trigger a retry of executable input.

GPT-Live now captures the same bounded context from ordered public fragments
whose end timestamps precede the delegation boundary. Its original request
selection, offset admission, duplicate fragment handling and uncertain-submission
rules remain separate and unchanged. Tool/delegation events and future fragments
are excluded. Fragments are not asserted to be final utterances; assistant
playback prefixes use the existing playback accounting. The original generated
request instructions remain in remote input; its exact newly spoken fragments
form the display request. This lets an initial pronoun follow-up
carry prior voice-only dialogue without replaying those captions as tasks.

## Codex / Herdr protocol audit

Compared refreshed source at Codex `ee344ca9458351a6ea102795fa73110ad3ede5dc`
and Herdr upstream `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` (its local
branch has diverged, so it was preserved; the relevant protocol files match):

- Codex's `core/src/context/realtime_delegation.rs` separates escaped `<input>`
  and `<transcript_delta>`. Its TUI recognizes that structure and displays input.
- `core/src/realtime_conversation/transcript_tail.rs` directly records model and
  client history without inference. Codex owns the thread, rollout persistence
  and active-turn lock. The regression
  `inbound_handoff_request_sends_transcript_delta_after_each_handoff` checks that
  a second handoff does not resend the first delta.
- Herdr's `src/api/schema/agents.rs::AgentPromptParams` exposes target, text and
  optional lifecycle waiting. The supported methods in `src/api/schema.rs`, and
  Whip's `herdr-protocol`, provide no history-only transcript append operation.

Consequently Whip cannot flush completed voice-only dialogue into arbitrary
remote history without executing another task. The first actual delegation may
still carry a larger bounded snapshot; later ones carry acknowledged deltas and
revisions. Context persists remotely as part of those real submissions, subject
to the coding agent's own history retention/compaction. Ending a call without a
delegation does not inject its remaining transcript. A future history-only
protocol capability would be required to change that guarantee.

Global-call confirmation, targeting, pinned binding, UI approvals, submission
IDs, steering/deferred admission and uncertain-outcome behavior are unchanged.
