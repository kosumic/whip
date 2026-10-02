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

Fresh host-state records include an opaque `offlineCacheBlob` serialized by
Rust. JavaScript debounces and stores it unchanged in AsyncStorage;
`AppCore.restoreCachedHost` validates and normalizes the stored blob into stale
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

## Provenance

The removed compatibility facade originated in the
[`react-native-ssh-sftp`](https://github.com/enatividad/react-native-ssh-sftp)
fork family, including the Dylan Kenneally fork previously vendored under its
package name. Whip's current API and Russh implementation are project-owned;
none of the upstream facade or native transports are included or linked.

Whip's package and transport changes are licensed under
`AGPL-3.0-or-later`; see the repository root `LICENSE`.
