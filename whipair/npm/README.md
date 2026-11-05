# whipair

Run Whip's direct, one-shot SSH public-key enrollment helper without installing
Rust:

```bash
npx whipair
```

To pair through a running Tailcat server, pass its tc address directly:

```bash
npx whipair 'tc…'
```

Scan the QR with Whip and approve enrollment on the host. The forwarded SSH
service defaults to port `22`; add `-p 2222` for a different port
(`--ssh-port` also works).

The npm package contains the native `whipair` Rust binary for macOS and Linux
on ARM64 and x64. The host must also have `ssh-keyscan`, normally supplied by
its OpenSSH client package, on `PATH`. If `curl` is available, the interactive
network selector also offers the public IP reported by `ifconfig.me`.

See the [full documentation](https://github.com/kosumic/whip/tree/main/whipair)
for the protocol, security boundaries, and command-line options.
