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

## Tailcat transport

Tailcat mode is saved per host and defaults off. Both the new-host flow and
the host editor link to Tailcat's installation guide at
https://github.com/tailscale/tailcat/blob/main/INSTALL.md. New Tailcat hosts use
manual setup. Enable Tailcat and paste the server's complete `tc…` address
into the host field, which becomes the Tailcat address input. No separate SSH
hostname or IP is required; keep the SSH port, username, and credentials.
Switching modes preserves both addresses, and a Tailcat-only host uses a stable
per-host alias for SSH host-key verification. The `tc…` address is stored
with the credentials in Keychain and the encrypted credential backup; only
the mode and built-in-server flags are stored in host metadata. Disabling the
mode retains the address and client identity.

Each host gets its own persistent Tailcat client identity, generated by
`whip-tailcat` and saved before its public key is displayed or used. The
private/public key pair stays with the Keychain credentials and Android's
encrypted credential backup. Renaming a host, changing SSH credentials, or
disabling Tailcat preserves the pair. Credential read failures and incomplete
identities stop setup instead of silently generating a replacement.

On a server with an existing SSH daemon:

```sh
tailcat genkey --key=whip --fixed-region
tailcat serve --key=whip 22
```

The expandable setup help is available in both host forms, including before
the toggle is enabled. Commands use syntax-highlighted code blocks with their
built-in copy controls. Generate the server identity once, then reuse it for
future starts. The serve command
tracks the SSH port entered in the host editor. The help explains direct UDP,
relay fallback, and the continued use of SSH credentials and host verification.

Node-key allowlisting is off by default, so the setup command omits `--allow`.
The **Restart with node-key allowlist** code block includes a command with this
host's saved public key in `--allow=nodekey:…`. Use its built-in copy control,
stop the existing Tailcat server, then run that command to restrict the tunnel
to this Whip host.
It reuses the saved server identity and port, and configures the allowlist
independently of SSH `authorized_keys`; SSH authentication still applies.
Copying the command does not change the running server.
Whip supplies the saved private key on every connection;
the CLI's `client-default` identity does not affect the embedded client.
Concurrent SSH connections for one host share a Rust transport actor to avoid competing
DERP registrations for the same identity.

The **Use Tailcat's SSH server** toggle selects Tailcat's key-authenticated
built-in `ssh` service, rather than an existing sshd. Its default setup command
includes the selected SSH public key and no node-key allowlist:

```sh
tailcat serve --key=whip --ssh-authorized-keys='<selected-SSH-public-key>' ssh
```

The allowlisted restart command also works for this service and retains
`--ssh-authorized-keys` when it adds `--allow`.

This mode requires SSH key authentication, uses tunnel port 22 regardless of
the saved sshd port, and runs as the account starting Tailcat. Whip keeps its
host key under `tailcat-ssh:<host>:22` separately from sshd's key. Turning the
toggle off restores use of the saved sshd port; turning Tailcat mode off retains
the built-in-server preference. Tailcat loads authorized SSH keys at startup,
so restart the server after changing its authorized key configuration.

Tailcat's built-in server does not implement OpenSSH forwarding channels.
For Herdr's Unix-socket streams, outbound TCP forwarding, and browser previews,
Whip uses non-PTY SSH exec channels running OpenBSD `nc` with `-N` (half-close)
and `-U` (Unix sockets). Install that tool on the server to use those features.
Shells and SFTP do not need it. Reverse port forwarding is unsupported in this
mode and SSH agent forwarding is disabled; use an existing sshd for features
requiring these capabilities.

Rust feeds the encrypted Tailcat stream into the same Russh connection used
for direct SSH and ProxyJump. SSH authentication and host verification apply
as usual. A Tailcat host can be the first hop in a ProxyJump chain; an incoming
jump connection cannot establish a Tailcat transport.

The [Whip-owned Tailcat client](../../crates/whip-tailcat/README.md) implements
DERP, authenticated direct UDP discovery, WireGuard, and userspace TCP in Rust.
It is linked into `libwhip_ssh.a` on Android and iOS. Mobile builds do not use
Go, cgo, or a Tailcat C library. Go is only needed for the optional upstream
interoperability fixture in `crates/whip-tailcat/tests/reference`.

Run `nix develop .#tailcat-tests -c bash packages/react-native-whip-ssh/rust/tests/test-tailcat.sh`
to verify a bulk transfer, TCP half-close, invalid addresses, and cancellation
against an upstream Go server and DERP/STUN relay bound to loopback. It does
not use public relays.

On a Linux host, run the combined Tailcat-first-hop/ProxyJump matrix for issue #262 with:

```sh
nix develop .#tailcat-tests -c bash packages/react-native-whip-ssh/rust/tests/test-tailcat-proxyjump.sh
```

The named `tailcat_first_hop_proxyjump_end_to_end` Rust test runs four cases:
OpenSSH and upstream Tailcat's built-in SSH gateway, each over direct UDP and
forced DERP. All relays, STUN endpoints, SSH servers, and echo sockets are local.
The development shell supplies Go, OpenSSH, and OpenBSD `nc`; no container,
public relay, or root access is required. Temporary keys, isolated Tailcat SSH
configuration, daemons, and session processes are owned by the fixture.
The Linux requirement keeps upstream Tailcat's SSH keys in `XDG_CONFIG_HOME`;
its macOS implementation would otherwise use the user's real configuration.

Each chain has an additional authenticated SSH gateway whose fixed private
route resolves `private-target.invalid` to a real target sshd. The Rust client
cannot resolve or directly connect to that target name. The test verifies
unknown/accepted/changed host keys and rejected authentication independently at
all three hops; exec stdout/stderr/status; SFTP; interactive shell output;
TCP half-close and Herdr-style Unix-socket requests/framed streams at both the
first gateway and target; failure/cancellation cleanup; unsupported incoming
SSH-to-Tailcat jumps; and automatic HostRuntime chain/shell restoration after
first-hop transport loss. A burst of native network-change signals also checks
one shared-actor rebind with the live shell and SSH generation retained.
The fixture allowlists the saved node identity throughout reconnection, and
relay cases explicitly disable direct paths in the Rust client.

These deterministic tests do not emulate mobile radio handoffs or suspension.
Android and iOS device validation should repeat Wi-Fi ↔ cellular transitions
and foreground resumes, with a direct path and with UDP blocked to force DERP,
checking terminal/Herdr restoration and native rebind/reconnect diagnostics.
The Go fixture remains separate from production Android/iOS builds.

For a live server running `tailcat serve 22`, the ignored
`ssh::tailcat::tests::live_remote_ssh_over_tailcat` test exercises the production
Rust SSH connection, pinned host-key verification, public-key authentication,
exec output and exit status, SFTP reads, a 512 KiB stdin/stdout round trip, and
disconnect/reconnect. Set `WHIP_TAILCAT_LIVE_ADDRESS_FILE`,
`WHIP_TAILCAT_LIVE_KEY_FILE`, and `WHIP_TAILCAT_LIVE_HOST_KEY_FILE` to private
local files containing the Tailcat address, SSH private key, and previously
verified server public host key. Set `WHIP_TAILCAT_LIVE_USER` and
`WHIP_TAILCAT_LIVE_EXPECT_HOST` to the SSH username and server hostname. Run:

```sh
nix develop -c cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib \
  live_remote_ssh_over_tailcat -- --ignored --nocapture
```

The SSH destination label is deliberately unresolvable (`.invalid`), ensuring
that a successful connection uses Tailcat rather than direct TCP. The test
does not modify the server's files or SSH authorization.

To test the built-in service, set `WHIP_TAILCAT_LIVE_BUILTIN_SSH=1` and
`WHIP_TAILCAT_LIVE_IDENTITY_FILE` to a mode-0600 JSON file containing
`private_key` and `public_key`, and start the server restricted to that public
key with `--allow`. The same live test checks authenticated exec, PTY echo,
SFTP, binary transfer, concurrent sessions using the shared client, rejection
of another identity, and reconnecting with the saved key. Optional
`WHIP_TAILCAT_LIVE_ECHO_SOCKET` and `WHIP_TAILCAT_LIVE_ECHO_PORT_FILE` select
isolated echo fixtures for Unix-socket/framed streams and TCP half-close.

The ignored `live_remote_typing_latency` benchmark uses the same live credential
files plus `WHIP_TAILCAT_LIVE_DIRECT_HOST`. It compares direct SSH and Tailcat
through the production `open_shell`/`shell_input` callbacks and a real remote
PTY (`stty raw -echo; cat`). It measures one-byte echoes after 16 warm-up keys,
128 paced samples, and 10 keys after one-second pauses. Results report p50,
p95, p99, and maximum round-trip time; phone keyboard/rendering time is excluded.
Set `WHIP_TAILCAT_LATENCY_RESULTS` to save JSON. Repeat with
`TS_DEBUG_ALWAYS_USE_DERP=true` to measure relay fallback without changing the
system VPN or server networking:

```sh
WHIP_TAILCAT_LIVE_DIRECT_HOST=master161 nix develop -c cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib \
  live_remote_typing_latency -- --ignored --nocapture
```
