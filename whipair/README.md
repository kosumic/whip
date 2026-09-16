# whipair prototype

[![crates.io](https://img.shields.io/crates/v/whipair.svg)](https://crates.io/crates/whipair)
[![PyPI](https://img.shields.io/pypi/v/whipair.svg)](https://pypi.org/project/whipair/)
[![npm](https://img.shields.io/npm/v/whipair.svg)](https://www.npmjs.com/package/whipair)

`whipair` is a direct, one-shot SSH public-key enrollment prototype for
Whip. It uses the host's existing SSH port: no relay, TLS listener, additional
firewall rule, pairing account, or `sshd_config` change is required.

The host creates a temporary Ed25519 credential and adds only its public half
to the current user's `authorized_keys` with `restrict` and a forced command.
The QR contains the private seed, SSH endpoint, username, and SSH host-key pin.
Whip uses that credential for one restricted exchange, the host user approves
the submitted permanent public key, and `whipair` removes the temporary
authorization.

## Install

All non-Nix installations require `ssh-keyscan` from an OpenSSH client package
to be available on `PATH`.

### uv

Run the native binary from PyPI without installing Rust:

```bash
uvx whipair
```

`uvx` is an alias for `uv tool run`; either form creates an isolated tool
environment and runs `whipair`. Published wheels support macOS and Linux on
ARM64 and x64.

### npm

Run the native binary from npm without installing Rust:

```bash
npx whipair
```

The npm package is a dependency-free launcher containing the same four native
binaries. Node.js 18 or newer is required.

### Cargo

Install the [published crate](https://crates.io/crates/whipair) with Rust 1.85
or newer:

```bash
cargo install --locked whipair
whipair
```

### Nix

Run the public version:

```bash
nix run github:kosumic/whip#whipair
```

Without arguments, `whipair` lists the host's reachable interface addresses,
uses `ifconfig.me` to discover its public IP when `curl` is available, and also
offers a manual public-address choice:

```text
Choose how Whip will reach this host:

  1. Tailscale    100.84.12.5                             tailscale0
  2. Wi-Fi        192.168.1.20                            wlan0
  3. Public       203.0.113.10                            ifconfig.me
  4. Public/other Enter a public IP address or hostname

Selection [1]:
```

Public-IP discovery does not verify that SSH is reachable through the router or
firewall. Choose **Public/other** to enter a DNS name or a different address, or
select a specific reachable endpoint non-interactively:

```bash
nix run github:kosumic/whip#whipair -- serve \
  --advertise-host 192.168.1.10
```

If SSH is already listening on a nonstandard port, advertise it with
`--ssh-port`:

```bash
nix run github:kosumic/whip#whipair -- serve \
  --advertise-host ssh.example.com \
  --ssh-port 2222
```

`--ssh-port` defaults to `22`. It does not open a new port; it must match the
existing SSH service reachable at the advertised host. When no
`--advertise-host` is supplied, the interactive setup asks for the endpoint and
port, offering `22` as the default. Passing both options skips those questions.
`whipair` does not bind a TCP listener; Whip connects to the host's existing
SSH service.

For a public endpoint behind NAT, forward the advertised public port to the
host's SSH port and allow that SSH port through the relevant router, host, or
cloud firewalls. If the host cannot reach its own public endpoint because the
router lacks NAT loopback, automatic `ssh-keyscan` discovery will fail. Read
the local Ed25519 host-key fingerprint and pass it explicitly:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256

nix run github:kosumic/whip#whipair -- serve \
  --advertise-host ssh.example.com \
  --ssh-port 2222 \
  --ssh-fingerprint 'SHA256:...'
```

From a local checkout:

```bash
nix run .#whipair
```

The Nix app includes `ssh-keyscan`. Automatic discovery requests Ed25519,
ECDSA, and RSA host keys in Whip's `russh` preference order. Use
`--ssh-fingerprint` to provide a fingerprint explicitly.

During development, print the underlying envelope:

```bash
nix run .#whipair -- serve --advertise-host 192.168.1.10 --print-code
```

Exercise the SSH-only protocol with a disposable public key:

```bash
nix run .#whipair -- request \
  --code 'WP4:...' \
  --public-key ~/.ssh/id_ed25519.pub \
  --device-name 'Prototype client'
```

Inspect a copied envelope without exposing its temporary private seed:

```bash
nix run .#whipair -- inspect 'WP4:...'
```

## Prototype limitations

- The SSH server must use OpenSSH-compatible `authorized_keys`, support the
  `restrict` and `command` options, and read the current user's default
  `~/.ssh/authorized_keys` file.
- The interactive network selector uses `curl` to offer the public IP reported
  by `ifconfig.me` when available. Failure to fetch it does not block pairing.
- Automatic host-key discovery invokes `ssh-keyscan`; the Nix app supplies it.
  The Nix app also supplies `curl` for public-IP discovery.
- The terminal QR uses error-correction level L to stay compact.
- Whip's mobile scanner supports WP4. The `request` subcommand remains a
  protocol test client.

## Pairing protocol (WP4)

[![WP4 pairing sequence](docs/wp4-sequence.svg)](docs/wp4-sequence.mmd)

The canonical Mermaid source is
[`docs/wp4-sequence.mmd`](docs/wp4-sequence.mmd).
Render and validate the tracked SVG with:

```bash
nix shell nixpkgs#mermaid-cli -c mmdc \
  -i whipair/docs/wp4-sequence.mmd \
  -o whipair/docs/wp4-sequence.svg
```

### QR bootstrap envelope

The QR contains `WP4:` followed by Base45-encoded binary data.

| Field                       | Encoding                                            | Purpose                                     |
| --------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Address type                | 1 byte                                              | `1` IPv4, `2` IPv6, or `3` hostname         |
| SSH host                    | 4 or 16 bytes, or 1-byte length plus ASCII hostname | Address selected or advertised by the host  |
| SSH port                    | 2-byte unsigned integer, big-endian                 | Existing SSH service port                   |
| SSH username                | 1-byte length plus ASCII                            | Existing local account                      |
| Temporary Ed25519 seed      | 32 random bytes                                     | Restricted SSH bearer credential            |
| SSH host-key SHA-256 digest | 32 bytes                                            | Pins the SSH server identity during pairing |

For an IPv4 address and a five-character username, the complete code is 120
characters and renders as a 37-module QR at error-correction level L. Expiry
is enforced by the running host process and is intentionally omitted.

### Host authorization and exchange

Before displaying the QR, `whipair` adds an entry equivalent to:

```text
restrict,command="whipair exchange --socket …" ssh-ed25519 AAAA… whipair-temporary
```

`restrict` disables shell access, PTY allocation, forwarding, agent forwarding,
X11, and user startup commands. The forced command accepts one bounded JSON
`EnrollmentRequest` on SSH stdin and relays it through a Unix socket in a
mode-`0700` temporary directory to the visible `whipair` process.

The parent process validates the submitted OpenSSH public key and displays a
six-digit verification code derived from its SHA-256 fingerprint. Whip shows
the same code while it waits, so the user can compare the phone and host before
approving. Approval is bounded by the invitation TTL. On approval the host
appends the permanent key safely and idempotently, replies with an
`EnrollmentResponse`, removes the temporary entry, and exits. Rejection leaves
the one-shot invitation available until its TTL expires.

Whip verifies the SSH host key against the digest in the QR before sending any
enrollment data. After pairing, it stores the verified public host key in its
global known-hosts list, so the saved host does not require a second trust
prompt.

### Security properties and boundaries

- The QR is a short-lived bearer credential. Anyone who can scan it and reach
  SSH can request enrollment, but the key can invoke only the forced exchange
  command and the host still asks for approval.
- WP4 transfers a temporary private-key seed, never the private half of the
  permanent key being enrolled. Normal SSH authentication later proves
  possession of that permanent key.
- The temporary key is removed on success, expiry, or Ctrl-C. If the process is
  killed before cleanup, the leftover entry remains restricted and its forced
  command cannot connect to the vanished private Unix socket.
- Bare OpenSSH public keys understood by Whip's `ssh-key` parser are accepted.
  `authorized_keys` options are rejected, comments are preserved, and duplicate
  permanent keys are not appended.
- The writer refuses symlink targets and files not owned by the current user,
  serializes every update through a stable adjacent lock file, uses atomic
  replacement for removal, and creates `.ssh` and `authorized_keys` with modes
  `0700` and `0600` when needed.

## Publishing

The [`Publish whipair to crates.io`](https://github.com/kosumic/whip/actions/workflows/publish-whipair.yml)
workflow verifies the crate version, formatting, Clippy, tests, and package
contents before publishing. Crates.io trusts only `publish-whipair.yml` in
`kosumic/whip` with the protected `crates-io` environment. The workflow
uses a short-lived OIDC credential; GitHub stores no crates.io API token.

The [`Publish whipair to PyPI and npm`](https://github.com/kosumic/whip/actions/workflows/publish-whipair-packages.yml)
workflow builds native PyPI wheels and npm binaries for macOS and Linux on
ARM64 and x64. PyPI should trust `publish-whipair-packages.yml` with the
`pypi` environment. After the first npm release, npm should trust the same
workflow with the `npm` environment. Both registries then publish with
short-lived GitHub OIDC credentials and provenance instead of stored tokens.

PyPI supports a pending trusted publisher for the first release. npm requires
the package to exist before trusted publishing can be configured, so add a
short-lived `NPM_TOKEN` secret to the protected `npm` environment, manually run
the workflow once with **Publish the npm package** and **Bootstrap the first
npm release with NPM_TOKEN** enabled, configure npm trusted publishing, and
then delete the secret.

To release a version, update `version` in `whipair/Cargo.toml`,
`whipair/npm/package.json`, and the `mkWhipair` version in `flake.nix`,
refresh `whipair/Cargo.lock`, and run:

```bash
nix develop -c cargo test --locked --manifest-path whipair/Cargo.toml
nix develop -c cargo publish --locked --dry-run \
  --manifest-path whipair/Cargo.toml
nix develop -c uvx maturin build --release --locked \
  --manifest-path whipair/Cargo.toml \
  --out whipair/dist
```

Commit those changes, then push a tag whose version matches `Cargo.toml`
exactly:

```bash
git tag whipair-v0.1.3
git push origin whipair-v0.1.3
```
