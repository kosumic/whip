# whipair

Run Whip's direct, one-shot SSH public-key enrollment helper without installing
Rust:

```bash
npx whipair
```

Install [Tailcat](https://github.com/tailscale/tailcat/blob/main/INSTALL.md)
separately, then start its built-in SSH server with a Whip pairing QR:

```bash
npx whipair --tailcat
npx whipair --tailcat -- --key=my-server
npx whipair --tailcat -- 2222
```

Arguments after `--` go directly to `tailcat serve`; stdout and stderr pass
through. The default built-in service needs no installed sshd or SSH credentials.
A forwarded port such as `2222` selects host SSH enrollment instead. Keep the
command running while using the server; Ctrl-C stops it.

For an existing server, use `npx whipair 'tc…'`. Add `--host-ssh -p 2222` to
explicitly pair with its forwarded SSH server.

The npm package contains the native `whipair` Rust binary for macOS and Linux
on ARM64 and x64. Host SSH enrollment also requires `ssh-keyscan`, normally supplied by
its OpenSSH client package, on `PATH`. If `curl` is available, the interactive
network selector also offers the public IP reported by `ifconfig.me`.

See the [full documentation](https://github.com/kosumic/whip/tree/main/whipair)
for the protocol, security boundaries, and command-line options.
