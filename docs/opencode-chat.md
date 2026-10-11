# OpenCode Chat View

Whip detects `opencode --version` through the host's login shell when opening or
reconnecting a chat. The host must expose the selected OpenCode session ID through
the Herdr integration, as with the existing OpenCode chat support.

- V1 uses `opencode export` and the read-only `opencode db` event queries.
- V2 uses `opencode api GET /api/session/{id}` and the paginated
  `/api/session/{id}/message` endpoint. The CLI handles local service discovery
  and authentication. No HTTP port forwarding or credentials in Whip are needed.

The v2 adapter is based on upstream v2.0.19, commit
`7ef4a1a56e7d23ec6a52d0d7572cea60061b3715`. Its schema-shaped regression fixture is
`packages/react-native-whip-ssh/rust/test-fixtures/opencode/v2-session.json`.
The relevant upstream contracts are `packages/protocol/src/groups/message.ts`,
`packages/schema/src/session-message.ts`, and `packages/schema/src/tool.ts`.
Incremental reads use the durable `session.log` contract in
[`packages/protocol/src/groups/session.ts`](https://github.com/anomalyco/opencode/blob/7ef4a1a56e7d23ec6a52d0d7572cea60061b3715/packages/protocol/src/groups/session.ts),
with event definitions in `packages/schema/src/session-event.ts` and the
`log.synced` watermark in `packages/schema/src/event-log.ts`.

V2 projects user text, assistant text and reasoning, tool inputs/results/errors,
task plans, and shell messages into the existing native chat model. Model-only
context and timeline control messages are skipped. As in the v1 adapter, user
file attachments are not rendered as chat attachments.

The first read captures a durable log watermark before fetching all message
pages. The host filters this initial log to its final `log.synced` frame, so old
event bodies do not cross SSH. The reader applies a complete snapshot only after
all pages succeed, and saves the watermark and every API message ID alongside
the projected cache, including IDs for hidden context and control messages.

Later polls read only durable events after that watermark and session metadata.
Unchanged history transfers no message bodies. Events invalidate individual
messages, which are fetched once per poll; the cached prefix is reused. A
committed rollback trims the cache at its boundary, including hidden boundaries,
then reads only changed messages on the new branch. Reconnecting with a current
cache resumes from its saved watermark. Older caches need one complete read.

Missing or regressed watermarks, log gaps, unsupported event types/versions,
compaction, and unavailable individual messages fall back to a complete
snapshot. The watermark precedes message reads, so concurrent events are replayed
on the next poll. Failed reads preserve the previous history and cursor. Cached
history remains available offline, and v1 event sequences cannot be reused as
v2 log positions or local snapshot revisions.

V2 polls the durable log after each 1.2-second delay while active.
Both OpenCode versions switch to a 60-second fallback after five quiet seconds
when the agent is idle, done, or blocked. Transcript changes extend the drain
period. Working status, submitted input, explicit chat reopening, and reconnect
resume immediately; unknown host status keeps normal polling.
Complete snapshots of large histories still need pagination. Text and reasoning
appear at durable block boundaries; per-token deltas use v2's separate ephemeral
event stream and are not consumed by this adapter. `session export` is
deliberately not used for polling because it excludes unfinished messages
entirely.

Run the compatibility tests with:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml opencode --lib
```
