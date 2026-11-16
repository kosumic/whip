# Rust policy ownership (#459)

These extractions preserve the existing APIs and caller-specific policies.

## SSH enrollment

`whipair-protocol::exchange` owns the bare SSH wire-key SHA-256 comparison,
16 KiB per-stream output limit, newline-terminated request encoding, and JSON
response decoding. A closed channel may frame a complete response without a
newline; one LF and then one CR are stripped when present. Missing exit status
and optional approval fields retain their previous meaning.

Both russh handlers reject certificates before invoking the bare-key predicate.
They keep their own accepted-key recording and error mapping. The CLI alone
uses an absent pin for its explicit discovery operation. Mobile jump hosts,
Tailcat identities, permissions, cancellation fences and CLI reporting stay in
their respective adapters. Moving the full SSH exchange would couple these
different state machines and their error types.

## Credential transactions

`Workflow::stage_host_write` generates a fresh receipt and stages only the host
ID, username and legacy-source flag in the in-memory journal. It performs no I/O.
The caller still chooses whether to commit intent with profile metadata or as a
standalone journal write, always before writing secure material.

Ordinary saves and identity writes use `finish_host_write`: secure write,
cancellation check, an optional backup attempt of the committed material, then
intent acknowledgement. Optional backup failures remain diagnostic-only.
Legacy migration alone permits replay from the legacy slot, which remains intact.
Recovery installation instead preserves the encrypted backup it just read: intent
write, secure write, cancellation check, acknowledgement, then repair publication.
It does not encrypt another backup or mark backup migration complete. Existing
receipt reconciliation still attempts backup of a receipt-proven primary before clearing
an interrupted intent. Deletion and cleanup permits are unchanged. Receipts from
another host cannot prove a pending write.

## WebRTC sidebands

`webrtc::sideband` owns only stop-aware connection and the bounded WebSocket
close handshake. Realtime checks close success; GPT-Live retains its existing
best-effort WebSocket close. Each caller retains timing and error classification.

Full lifecycle unification would change behavior: Realtime validates and confirms
audio settings, tracks retryable retirement and hangs up through REST. GPT-Live
waits for the primary `session.started`, acknowledges `session.closed`, and sends
muted silence during final accounting. Their POST cancellation, negotiation,
generation fences, worker draining, orphan retirement and usage collection remain
explicit. Both already use the same `Handle` for final worker shutdown.

## Identifiers

`agent_browser_control::model::valid_identifier` owns the shared predicate:
nonempty, at most 256 UTF-8 bytes, no Unicode control characters. Browser IDs,
application host/terminal/pane IDs, voice targets and Herdr targets map failure to
their original domain errors/messages. Whitespace and punctuation stay accepted.
This predicate does not replace stricter provider-generated call/session ID
grammars, endpoint restrictions, authorization or live-target lookup.

## Shell arguments

`herdr_protocol::hc::endpoint::shell_quote` owns POSIX single-argument quoting,
including nested `sh -c` scripts; mobile remote Git operations reuse it. Quoting
does not validate a filesystem path. CLI authorized-key command paths keep their
UTF-8 conversion and LF/CR/NUL rejection before the equivalent POSIX expression.
Adding a Herdr dependency to the pairing CLI solely for that expression would
increase coupling, so its checked path helper remains separate.

`agent_sessions::shell_quote` stays separate: SSH invokes the login shell first,
which may be Fish. It puts both apostrophes and backslashes in double-quoted
segments so the outer login shell and inner POSIX shell preserve the same bytes.
Execution tests cover punctuation, command substitutions, Unicode, controls and
nested arguments; the login-shell tests also use Fish when installed. NUL cannot
be passed as an OS command argument; the CLI path boundary rejects it.
