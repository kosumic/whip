# whipair

Run Whip's direct, one-shot SSH public-key enrollment helper without installing
Rust:

```bash
npx whipair
```

The npm package contains the native `whipair` Rust binary for macOS and Linux
on ARM64 and x64. The host must also have `ssh-keyscan`, normally supplied by
its OpenSSH client package, on `PATH`. If `curl` is available, the interactive
network selector also offers the public IP reported by `ifconfig.me`.

See the [full documentation](https://github.com/kosumic/whip/tree/main/whipair)
for the protocol, security boundaries, and command-line options.
