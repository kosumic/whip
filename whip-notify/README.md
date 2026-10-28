# whip-notify

Independent Rust HPKE protocol library and short-lived Herdr notification plugin. No WhipAir dependency, host daemon or listener.

See [installation, protocol, leases, relay deployment and security model](../docs/remote-notifications.md).

Whip offers per-host **Install on host** / **Uninstall from host** controls over its existing SSH connection. Installation downloads a version-pinned GitHub Release binary and verifies its SHA-256 checksum. No Rust compiler, Node or Python is needed on the host. This package is also directly installable without a marketplace listing:

```sh
herdr plugin install --yes --ref whip-notify-v0.1.2 kosumic/whip/whip-notify
herdr plugin uninstall dev.whip.notify
```

The host needs Herdr 0.9.5+, Git, curl and either `sha256sum` or `shasum`. Prebuilt targets are **arm64 Linux** (`aarch64-unknown-linux-musl`, statically linked) and **Apple Silicon macOS** (`aarch64-apple-darwin`). Unsupported platforms fail explicitly; installation never silently falls back to compilation. Herdr installs plugins globally for the SSH account across its sessions; device push opt-in remains separate. Uninstall preserves configuration for reinstall. Optional marketplace discovery uses the repository's `herdr-plugin` GitHub topic.

To download and link a local checkout:

```sh
sh build.sh
sh install.sh
```

For developers or hosts without a prebuilt binary, build the independent crate explicitly:

```sh
cargo build --release --locked
WHIP_NOTIFY_BINARY="$PWD/target/release/whip-notify" sh install.sh
cargo test --locked
```

The binary supports `paths`, `identity`, `register` (JSON on stdin), `unregister <device-id>`, `lease renew <device-id>`, `hook` and explicit administrator `uninstall`. It uses Herdr's `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`; `--dirs <config> <state>` supplies those same discovered paths for authenticated SSH commands outside a hook. The protocol library builds independently using `--no-default-features`.

## Releasing

Run the **Release notification plugin** GitHub Action on the intended revision, or push a `whip-notify-v<VERSION>` tag. `Cargo.toml` and `herdr-plugin.toml` must have matching versions. The action tests this crate and the installer, builds both arm64 targets, smoke-tests the binaries, and publishes the binaries, their `.sha256` files and the plugin manifest only after all builds pass. It uses the repository's GitHub token; no new secrets are required. The plugin release does not replace the mobile app's latest release.

```sh
gh workflow run release-whip-notify.yml --ref main
```

Published releases are never overwritten by the workflow. Bump both version fields for a new release. The mobile core derives its install tag from this package's `PACKAGE_VERSION`. SHA-256 detects corruption and substitution against the downloaded checksum; authenticity trusts HTTPS, the GitHub repository and its release maintainers. This is not an independent code signature.
