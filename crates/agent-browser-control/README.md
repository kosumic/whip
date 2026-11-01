# agent-browser-control

MIT-licensed Rust library for browser-agent actions. It contains the typed action
schema, argument validation, DOM runtime, normalized results/errors, output limits,
generation fences, and asynchronous execution engine extracted from Whip.

```toml
[dependencies]
agent-browser-control = "0.1.0"
```

Implement `engine::Bridge` for an existing browser, parse an action with
`BrowserAction::parse(name, &arguments)`, and call `engine::run` with its session,
request identity, and current tab context. The result has the same JSON shape as
Whip's browser MCP tools; `BrowserResult::mcp()` builds the MCP result envelope.
`examples/memory.rs` is a complete, runnable in-memory adapter:

```sh
cargo run --example memory
cargo test --locked
```

The example and tests need only Rust. The library has no React Native, Expo,
UniFFI, WebView SDK, SSH, host-profile, or Herdr dependency. It does not launch a
browser or provide an MCP HTTP server.

## Bridge contract

The engine emits `Primitive` operations for document state, page JavaScript,
navigation/history, screenshots, downloads, and tab management. Return the JSON
shapes represented by the engine's `Document`, `TabsResult`, and primitive
handlers. Page evaluation returns parsed JSON from the generated program.

| Primitive | Bridge response |
| --- | --- |
| `DocumentState` | `{id, identity, url, public_url, ready}` |
| `Evaluate` | `{ok: true, value: ...}` or `{ok: false, error: {code, message, details}}` |
| `Navigate`, `Back`, `Forward`, `Reload` | `{target: string or null, navigated: boolean}` |
| `Screenshot` | `{image: base64 JPEG string}` |
| `Download` | `{destination_path, bytes, mime_type}` after trusted delivery |
| `ListTabs` | `{tabs: [{tab_id, url, title, selected}]}` |
| `NewTab` | `{tab_id}` |
| `CloseTab` | Any small JSON value; the engine produces the closed result |

Run the engine inside a Tokio runtime with time enabled. A bridge can return
`BrowserError` directly for permission failures, stale identities, or unavailable
native effects.

- Bind tab IDs to their session as `<session>-tab-<unique suffix>`. Supply the
  current tab inventory in `Context`. The engine rejects foreign and missing
  active tabs, and validates tab ownership in returned inventories.
- Supply a nonempty document `id` and opaque `identity`. Before running an
  evaluation, screenshot, or download, compare its identity to the current native
  tab generation. Check again before accepting a result. The generated JavaScript
  also compares `document.__whipDocumentId` to the captured document ID before it
  runs. Install that nonsecret ID on each new document. The existing property
  name and DOM runtime keys are retained for native-backend compatibility.
- Capture `fence::TabFence` and validate it against `TabState` while holding your
  state lock. Navigation invalidates document generations; view/driver replacement
  and user actions invalidate the corresponding generations. View checks allow
  navigation to change the document while still rejecting replacement views.
- Authenticate and authorize callers before dispatch. Session ID prefixes and
  generation fences enforce identity consistency; your adapter owns permissions,
  operation leases, tab lifecycle, and route/session closure. Retain exclusive
  leases until pending effects and result delivery have finished.
- Make dropping a bridge call revoke its native effect permit, cancel queued
  effects, and reject late callbacks. The engine drops pending work at the
  deadline or cancellation; it cannot undo an already completed browser action.

`engine::run` validates directly constructed actions as well as parsed ones and
enforces a 20-second deadline (120 seconds for downloads). Use
`engine::run_with_control` with a clonable `control::OperationControl` to shorten
expiry or cancel an operation. `OperationControl::check` is also available for
adapter effect/result fences. The default deadline remains an upper bound.

## Limits and trust

Requests are limited to 64 KiB; text results to 128 KiB; screenshots to 2 MiB;
raw eval results to 64 KiB; waits to 10 seconds; downloads to 64 MiB. Typed action
limits and output validation also apply. HTTP(S) URLs cannot embed credentials.
Downloads stay in the native adapter and return only destination/size/MIME
metadata. Implement bounded streaming and destination policy in that adapter;
the engine validates the returned destination and byte count.

Browser cookies, launch/auth tokens, and native capabilities are never engine
inputs to page programs. Keep them in the native browser or trusted adapter.
`public_url` should omit query strings and fragments; Whip's adapter sanitizes it.
Raw `eval` deliberately runs caller-supplied page JavaScript, so permission to use
it belongs to the embedding application. Normal DOM reads omit sensitive inputs;
they are not a sandbox for raw eval or arbitrary page content.

Whip retains its session registry, FIFO admission/leases, Reverse Control checks,
native Android/iOS drivers, and remote download transport. Those depend on app
ownership and cannot be moved into a general library without changing their trust
contract. Its behavioral DOM and native WebView tests exercise this crate through
the same adapters.
