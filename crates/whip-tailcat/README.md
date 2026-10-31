# whip-tailcat

Whip-owned, client-only Tailcat transport for [Whip issue #254](https://github.com/kosumic/whip/issues/254).
It uses BoringTun for WireGuard, smoltcp for userspace TCP, and Tokio for
asynchronous I/O. It does not depend on SSH, React Native, UniFFI, Go, cgo, or
the Tailcat C ABI. There is no server, CLI, TUN interface, or system routing.

```rust,no_run
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use whip_tailcat::{ClientCache, ClientOptions, Identity};

# async fn example(address: &str, saved_private: &str, saved_public: &str) -> std::io::Result<()> {
let identity = Identity::from_saved_keys(saved_private, saved_public)?;
// Keep one cache in the application's connection manager.
let clients = ClientCache::default();
let client = clients.connect(address, &identity, ClientOptions::default()).await?;
let mut stream = client.dial_tcp(8080).await?;
// Send an application-specific byte protocol to the served port.
stream.write_all(b"request").await?;
stream.shutdown().await?; // FIN; reading remains available
let mut response = Vec::new();
stream.read_to_end(&mut response).await?;
# Ok(())
# }
```

For SSH, dial port 22 and pass the stream to `russh::client::connect_stream`.

Generate a new identity with `Identity::generate()` only when creating a new
profile. Export `private_key()` and `public_key()` to application-owned secure
storage. Import preserves the existing `privkey:`/`nodekey:` encodings and
rejects invalid or mismatched keys instead of replacing them. Compact CBOR
`tc…` addresses support embedded relay metadata or a DERP region ID, with and
without a WireGuard pre-shared key. Addresses require the separate discovery
key used by Whip's existing upstream Tailcat version.

Cloned clients and cached connects share one actor per server and identity.
The cache rejects conflicting active configurations to prevent duplicate DERP
registrations. Streams keep the actor alive. Keep one cache in the connection
manager; independently constructed clients can create duplicate registrations.
Dropping a stream cancels its connection.
`shutdown()` waits for pending bytes and FIN to be acknowledged. `close()` closes
all client clones and streams and waits for the actor to stop. The last owner
also cancels the actor automatically.

The default limit is 32 TCP streams, including pending dials. Each uses four
bounded 64 KiB TCP/application buffers. Relay channels, endpoint candidates,
pending discovery probes, and command queues are bounded. Direct endpoints
require an authenticated discovery response matching a pending transaction and
source endpoint. Direct leases expire after 15 seconds without renewal, falling
back to DERP; periodic probes can restore the direct path. `relay_only` disables
direct discovery and traffic. Relay TLS validates system/Mozilla roots or an
address's certificate pin. Embedded `InsecureForTests` is ignored unless the
caller explicitly enables `allow_insecure_relays`.

Call `network_changed()` after Wi-Fi/cellular transitions or foreground resume.
It rebinds UDP sockets, clears old endpoint leases, and schedules DERP
reconnection while retaining the identity and TCP/WireGuard state. DERP also
reconnects after network failures with bounded backoff. A peer restart may
require a fresh TCP connection; this crate does not replay application data.

## Validation

Run from the repository root, using its pinned development environment:

```bash
nix develop -c cargo fmt --manifest-path crates/whip-tailcat/Cargo.toml --check
nix develop -c cargo clippy --locked --manifest-path crates/whip-tailcat/Cargo.toml --all-targets -- -D warnings
nix develop -c cargo test --locked --manifest-path crates/whip-tailcat/Cargo.toml
nix develop .#tailcat-tests -c bash crates/whip-tailcat/tests/interop.sh
nix develop -c cargo build --locked --release --manifest-path crates/whip-tailcat/Cargo.toml --target aarch64-linux-android --lib
```

Ordinary Rust tests use a local TLS DERP fixture and wire-format vectors. The
optional interoperability script separately builds the pinned upstream Go
server/DERP/STUN fixture in `tests/reference/`; it is never part of a library or
mobile build. It tests direct UDP, forced DERP, binary transfers larger than the
buffers, both half-close directions, shared identities, concurrent streams,
stream limits, drop/close cancellation, network rebinding, and reconnecting.

On macOS, run the native arm64 test inside an already booted iPhone simulator:

```bash
WHIP_IOS_SIMULATOR=YOUR_SIMULATOR_UDID nix develop .#tailcat-tests -c node crates/whip-tailcat/tests/ios-simulator.cjs
```

This uses system Xcode and `simctl spawn` for the iOS executable. The separately
provisioned upstream server runs on macOS. The test verifies direct UDP, forced
DERP, concurrent streams, binary transfers, half-close, and live TCP through
network rebinding. The default development shell has no Go dependency; only
the `tailcat-tests` shell includes it.

Whip's SSH adapter consumes this crate through `russh::client::connect_stream`.
Android and iOS builds link the Rust transport without a Go build or C ABI.
Real-device Wi-Fi/cellular transitions, controlled packet loss, SSH/Herdr/SFTP
integration, and an iOS device app build remain part of that migration.

## Attribution

Protocol, DERP, and network actor code is adapted from BSD-3-Clause
[spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81](https://github.com/spullara/tailcat-rs/tree/b24e19b9624049c269e689edeacee4e871884d81).
Only transport components and test fixtures were adapted. The full server,
SSH/SFTP services, CLI, browser runtime, and dependency tree are not included.
The optional Go interoperability baseline is
[tailscale/tailcat at 52fbad323e9d](https://github.com/tailscale/tailcat/tree/52fbad323e9d),
matching Whip's existing transport pin. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
