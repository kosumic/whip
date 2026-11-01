# herdr-protocol

MIT-licensed, transport-independent Herdr terminal protocols 17–22, typed control
API requests/responses, shared domain validation, and bounded JSONL event parsing.
No SSH, sockets, Tokio, UniFFI, mobile dependencies, callbacks, or global state.

```toml
[dependencies]
herdr-protocol = "0.1.0"
```

```rust
use herdr_protocol::terminal::{self, HerdrTerminalAttachLaunchMode, ServerMessage};

let protocol = 22;
let hello = terminal::hello(
    protocol, 80, 24, 8, 16,
    HerdrTerminalAttachLaunchMode::for_protocol(protocol),
)?;
assert_eq!(hello, [0, 22, 80, 24, 8, 16, 0]);
assert!(matches!(
    terminal::decode(&[0, 22, 1, 0], protocol)?,
    ServerMessage::Welcome { protocol: 22, encoding: 1, error: None }
));
# Ok::<(), terminal::CodecError>(())
```

Run `cargo run --example messages` for terminal, control, and event examples
without opening a connection.

## Wire compatibility

| Protocol | Terminal layout and capabilities |
| --- | --- |
| 17 | Legacy terminal layout; prefix-input-source tag 10 |
| 18–19 | Keyboard-report-all inserted at tag 10; prefix moved to 11 |
| 20 | Terminal-attach launch mode 2; terminal-bell tag 12 |
| 21 | Published preview keeps the legacy layout |
| 22 | Endpoint generation 1, updated hello/resize and server tags |

The version passed to the terminal codec must be the negotiated server protocol.
Unsupported versions return `CodecError::UnsupportedProtocol`. Decoding a Welcome
does not accept a connection: the caller must check the returned protocol,
encoding, and server error before sending further messages. Terminal `decode`
takes a complete payload after the transport's length prefix has been removed.
Partial payloads return a typed truncation error; unknown tags remain `Ignored`.

`control::HerdrControlRequest::encode(id)` emits one JSONL request.
`control::parse_response(&request, bytes)` checks the response envelope, result
discriminator, and domain fields. `parse_json_response` retains additional result
fields for clients using a newer API. Transport, request-ID correlation, deadlines,
replay decisions, authentication, and connection lifetime belong to the caller.
Protocol errors are separate from these transport/application failures.

`events::subscription_request(protocol, pane_ids)` preserves the supported
version-specific event set, pane deduplication, and the `android_events` request ID
used by `JsonlEventParser`. `HerdrEventKind` exposes the same capability table.
Feed arbitrary chunks into `JsonlEventParser::push`; it retains incomplete lines
and produces typed acknowledgement, event, or server-error items. Known malformed
events become `ProtocolInvalid`; unknown event names become `ProtocolUnknown`.
Input retains Whip's lossy UTF-8 normalization. Malformed JSON, blank lines, and
unrecognized envelopes are skipped. `end()` discards an unfinished line on reset.

## Limits and validation

Terminal decoding enforces the existing 32 MiB frame limit; control responses
are limited to 8 MiB. The event parser retains at most one 1 MiB partial line,
reports an oversized line once, discards through its newline, and resumes parsing.
The returned vector scales with the number of complete items in the supplied
chunk, so callers should keep transport reads bounded. Whip uses 32 KiB reads.

`cargo test` runs the relocated control/event fixtures plus golden terminal frames
for every protocol 17–22. Whip keeps its transport, subscriptions, retries,
reconnection, host runtime, sinks, and native error translation in the app. Shared
schema macros register the canonical types in Whip's existing UniFFI namespaces
without allocating conversion copies or duplicating the domain definitions.

The retained upstream control schemas and their exact source revisions remain in
[`protocol/`](https://github.com/kosumic/whip/tree/main/protocol). They are versioned
separately; this extraction does not reinterpret older wire formats or infer a
new control schema from the terminal protocol number.

## License

MIT. Third-party dependencies retain their own license and copyright notices.
