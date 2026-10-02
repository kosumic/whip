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

V2 projects user text, assistant text and reasoning, tool inputs/results/errors,
task plans, and shell messages into the existing native chat model. Model-only
context and timeline control messages are skipped. As in the v1 adapter, user
file attachments are not rendered as chat attachments.

The reader fetches all pages before applying a snapshot. Changed messages produce
incremental UI updates; unchanged snapshots are no-ops. Failed reads preserve the
previous history. Cached history remains available offline, and cached v1 event
sequences cannot be reused as v2 snapshot revisions or vice versa.

V2 currently polls the complete projected history after each 1.2-second delay.
Large histories therefore need more requests. Text and reasoning appear at
durable block boundaries; per-token deltas use v2's separate ephemeral event
stream and are not consumed by this adapter. `session export` is deliberately
not used for polling because it excludes unfinished messages entirely.

Run the compatibility tests with:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml opencode --lib
```
