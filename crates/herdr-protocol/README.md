# herdr-protocol

MIT-licensed, transport-independent legacy Herdr protocols 17–22 and herdr-core
generation 1. Includes typed control APIs, framing, bounded routing and event
reduction, shared desktop document edits, and backend-neutral projections.
No SSH, sockets, Tokio runtime, UniFFI, mobile dependencies, or process/global state.

```toml
[dependencies]
herdr-protocol = "0.2.0"
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

## Herdr Core

`hc` is a separate protocol namespace. `legacy::{control,events,terminal}` names
the older protocol; its original root exports remain compatible.

- `hc::generated` contains all 32 methods from the pinned OpenRPC schema.
  `node scripts/generate-hc.cjs --check` verifies the checked-in models.
- `hc::session::Session` negotiates JSONL hello then nine-byte frames, correlates
  concurrent RPCs, bounds channels and pre-reply output, and detaches cancelled
  attachments. It emits bytes and actions for a caller-owned transport.
- `take_channel` delivers bounded output; `consumed` grants credit only after the
  consumer accepts those bytes. Each viewer needs an independent consumer.
- `hc::events` reduces terminal events and missed-event snapshots. Reported OSC
  status is authoritative; unreported terminals remain Unknown.
- `hc::client::Client` implements shared control semantics over the injected
  `Transport` trait. Raw input uses DATA on an attachment; `terminal.send` is a
  submitted prompt. Ambiguous mutations are never automatically replayed.
- `hc::documents` and `hc::edits` preserve unknown JSON and mod nodes, perform CAS
  writes, and rebase only confirmed conflicts. `projection::View` holds private
  client focus and zoom. Missing desktop documents produce terminal-only views.

Use an SSH direct-streamlocal channel to the discovered core Unix socket where
available. `hc connect` carries the same bytes over an SSH exec channel when
direct socket forwarding is unavailable. Endpoint helpers honor session/socket
overrides and the running core's lock file, without duplicating TOML parsing.

The maintained upstream-client audit, exact source pins, wire exceptions and
update procedure are in [UPSTREAM.md](UPSTREAM.md). Adapted Apache-2.0 portions
retain [NOTICE](NOTICE) and [LICENSE-APACHE](LICENSE-APACHE); our additions use MIT.

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
