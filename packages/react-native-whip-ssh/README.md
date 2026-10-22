# react-native-whip-ssh

Whip's single native SSH and Herdr module. It owns the Tokio runtime, Russh
sessions, ProxyJump chain, known-host verification, shell/exec/SFTP/forwarding,
Herdr control and event streams, terminal bridges, host-state reconciliation,
agent transcript streams, reconnect restoration, and WP4 pairing.

`HostRuntime` owns an authenticated `SshSession` directly. Herdr API requests
and long-lived streams call typed Rust methods on that session; no C ABI,
dynamic library lookup, callback context, or JSON dispatch exists between the
SSH and Herdr implementations. React Native sends semantic requests and
receives typed results/events; raw Herdr JSON never crosses the boundary.

The same crate owns the Herdr terminal codec, Welcome/Attach handshake,
prepared bridge, and protocol-level terminal lifecycle. Raw and
length-prefixed channels stay in Rust so control messages and terminal frames
are decoded without crossing JavaScript first.

Terminal and graphics payloads cross the Whip UniFFI/JSI boundary as binary
`ArrayBuffer` values. Metadata and low-frequency controls use typed records and
data-carrying enums. Terminal bytes are never JSON, base64, or UTF-8 decoded in
the adapter.

Herd follows the connected server's filtered agent ordering on generation-1
endpoints. Rust observes `shell.snapshot.v1` with `surface_active: false` and
projects its ordered pane IDs over the complete JSON host state. It does not
render a management terminal or duplicate Herdr's view query language. View
updates use the existing host-state revision; hidden agents remain available to
terminal and notification APIs. The optional observer starts and retries
independently of the primary event stream, with bounded recovery canceled when
events stop or the connection is replaced.

When any host has a server projection, including an empty view, aggregate agent
rows stay grouped in the existing host ranking (connected first, then visible
agent attention). Server-backed groups preserve server order; other groups use
local attention priority. Without any server projection, the existing global
attention ordering remains unchanged.

Fresh host-state records schedule a debounced `exportOfflineCache` request.
Rust encodes the latest validated metadata only when the debounce expires,
skipping revisions already persisted for that runtime incarnation. JavaScript
stores the opaque blob in the Rust Turso app-data store and flushes pending
exports on backgrounding, UI detachment, and before disconnecting.
An export queued before a transport failure can still save the last validated
snapshot. `AppCore.restoreCachedHost` validates and normalizes the stored blob into stale
offline metadata. Rust owns the versioned cache schema and also reads legacy
JavaScript snapshot records.

WP4 pairing remains a logically separate QR-pinned bootstrap module but shares
the Whip crate, executor, native module, and platform library.

## App API

Create one typed runtime per host and use its semantic SSH, Herdr, terminal,
transfer, preview, and agent APIs:

```ts
import {
  createHostRuntime,
  type RuntimeConfig,
} from 'react-native-whip-ssh';

const config: RuntimeConfig = {
  runtimeId: 'primary-host',
  ssh: {
    host: 'server.example.com',
    port: 22,
    username: 'alice',
    authMode: 'key',
    secret: privateKey,
    forwardAgent: false,
  },
  jumpHosts: [],
  sessionName: 'whip',
  herdrCommand: 'herdr',
};

const runtime = createHostRuntime(config);
await runtime.connect();
const output = await runtime.execute('uname -a');
```

Key management and WP4 pairing are named typed exports from the same package.
There is no generic `SSHClient` compatibility facade or dynamic method adapter;
all host operations go through `NativeHostRuntime` and generated UniFFI APIs.

Run the terminal-path copy benchmark from the repository root:

```sh
npm run benchmark:terminal-bridge
```

Measure native host-state costs for 10, 100, and 1,000 panes (one agent per pane):

```sh
nix develop -c cargo test --release --lib \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  host_state::benchmark -- --ignored --nocapture --test-threads=1
```

The benchmark reports elapsed time, allocation count/traffic, and peak live-byte
increase on the measured thread. It separates validation, normalization, cache
export, projection, and UniFFI encoding, and replays status, focus, scroll, and
pane updates. Ten-batch comparisons model the previous eager cache encoding and
blob clone versus one deferred export. They exclude SSH, JS storage, UI work,
and lock contention, and are not device latency measurements.

## Provenance

The removed compatibility facade originated in the
[`react-native-ssh-sftp`](https://github.com/enatividad/react-native-ssh-sftp)
fork family, including the Dylan Kenneally fork previously vendored under its
package name. Whip's current API and Russh implementation are project-owned;
none of the upstream facade or native transports are included or linked.

Whip's package and transport changes are licensed under
`AGPL-3.0-or-later`; see the repository root `LICENSE`.
