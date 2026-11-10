# whip-notify

Independent Rust HPKE protocol library, legacy Herdr notification plugin and optional Herdr Core push watcher. No WhipAir dependency or listening port.

Version 0.1.6 adds Core push through its OSC status event stream. Both backends use agent and tab labels plus the hostname in readable previews, without internal workspace or pane IDs. The standalone plugin and library are MIT-licensed. Upgrading preserves host identity and device registrations.

E2EE is configurable per saved host on each device. New Whip registrations default to readable previews; existing registrations remain encrypted. With encryption off, the hook sends bounded tab/agent/status and available task text alongside the authenticated encrypted routing envelope. With encryption on, it sends only the envelope and the OS shows a generic update. Plugin 0.1.3 adds the preview capability; upgrading preserves host identity and registrations.

See [installation, protocol, leases, relay deployment and security model](../docs/remote-notifications.md).

Whip offers per-host **Install on host** / **Uninstall from host** controls over its existing SSH connection. Installation downloads a version-pinned GitHub Release binary and verifies its SHA-256 checksum. No Rust compiler, Node or Python is needed on the host. This package is also directly installable without a marketplace listing:

```sh
herdr plugin install --yes --ref whip-notify-install-v0.1.6 kosumic/whip/whip-notify
herdr plugin uninstall dev.whip.notify
```

The host needs Herdr 0.9.5+, Git, curl and either `sha256sum` or `shasum`. Prebuilt targets are **arm64 Linux** (`aarch64-unknown-linux-musl`), **x86_64 Linux** (`x86_64-unknown-linux-musl`), both statically linked, and **Apple Silicon macOS** (`aarch64-apple-darwin`). Whip checks the host architecture and release availability before starting Herdr. Unsupported platforms fail explicitly; installation never silently falls back to compilation. The installer tag contains only the manifest and download scripts, so Herdr does not fetch the app's source and media. Downloads abort when stalled for twenty seconds; Whip bounds installation to three minutes and clears its busy state on failure. Herdr installs plugins globally for the SSH account across its sessions; device push opt-in remains separate. Uninstall preserves configuration for reinstall. Optional marketplace discovery uses the repository's `herdr-plugin` GitHub topic.

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

Rust consumers can use the MIT-licensed protocol library without host support:

```toml
[dependencies]
whip-notify = { version = "0.1.6", default-features = false }
```

The binary supports `paths`, `identity`, `register` (JSON on stdin), `unregister <device-id>`, `lease renew <device-id>`, `hook` and explicit administrator `uninstall`. It uses Herdr's `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`; `--dirs <config> <state>` supplies those same discovered paths for authenticated SSH commands outside a hook. The protocol library builds independently using `--no-default-features`.

## Herdr Core

Choose **Herdr Core**, save the host, connect, and enable **Server-side push notification** in Whip. The app installs a version-pinned, checksum-verified binary through authenticated SSH. Core requires neither legacy Herdr nor Git, Node, Python or Cargo. The host needs curl, a SHA-256 utility, and a running user service manager: systemd on Linux, or the logged-in user's launchd session on macOS. The watcher runs independently of the phone and Core's desktop app. It never installs provider hooks or changes Core's lifecycle.

For a source build or an already downloaded binary, install the watcher against the actual Core endpoint:

```sh
whip-notify core --socket /absolute/path/to/core.sock install
whip-notify core --socket /absolute/path/to/core.sock status
whip-notify core --socket /absolute/path/to/core.sock disable
whip-notify core --socket /absolute/path/to/core.sock enable
whip-notify core --socket /absolute/path/to/core.sock uninstall
```

`install-core.sh --socket PATH` downloads the matching release and performs the same installation. The binary lives under `$XDG_DATA_HOME/whip-notify/core` (default `~/.local/share`). Each endpoint gets a separate `dev.whip.core.<socket-hash>` service and private configuration/state under `$XDG_CONFIG_HOME/whip-notify/core/<socket-hash>` and `$XDG_STATE_HOME/whip-notify/core/<socket-hash>`. Standard XDG defaults apply. Disable/uninstall stop only the watcher and preserve identity keys and registrations for reinstall. Linux user services follow the account's systemd login/linger policy; the installer does not change it. macOS services run in the user's GUI login session.

The watcher connects to the existing local Core socket and subscribes to `events.subscribe`. Fresh OSC transitions into blocked/error send attention alerts; working/blocked/error to idle/done, or explicit done, send completion alerts. Unreported programs have no alerts. Initial snapshots, missed-event snapshots, reconnects, seen/pin label changes, and program exits do not produce historical or inferred completions. A missed stream establishes a new baseline; a disconnected stream reconnects. There is no durable delivery retry queue.

The shared `herdr-protocol` projection maps the desktop's `herdr-app` documents and standalone terminals to the same pane/workspace IDs as Whip. Layout and machine changes refresh these documents. Encryption, opt-in readable previews, registration pairing and the ten-second per-device lease use the same code and relay as legacy Herdr. A live local consumer suppresses push only for its own device.

To run the real interoperability test with an isolated Core, without starting a paid agent:

```sh
WHIP_HC_TEST_BINARY=/absolute/path/to/herdr-core cargo test --locked --test core_live -- --ignored
```

## Releasing

Run the **Release notification plugin** GitHub Action on the intended revision, or push a `whip-notify-v<VERSION>` tag. `Cargo.toml`, `herdr-plugin.toml` and `install-core.sh` must have matching versions. The action tests this crate and the installer, builds all three host targets, smoke-tests the binaries, and publishes the binaries, their `.sha256` files and the plugin manifest only after all builds pass. It also publishes `whip-notify-install-v<VERSION>`, a parentless commit containing only `whip-notify/{build.sh,platform.sh,herdr-plugin.toml,install-core.sh}`. Both backends install from this small tree while the release/source tag retains the full source. Installer tags are immutable: changed contents require a version bump. It uses the repository's GitHub token; no new secrets are required. The plugin release does not replace the mobile app's latest release.

```sh
gh workflow run release-whip-notify.yml --ref main
```

Published releases are never overwritten by the workflow. Bump both version fields for a new release. The mobile core derives its install tag from this package's `PACKAGE_VERSION`. SHA-256 detects corruption and substitution against the downloaded checksum; authenticity trusts HTTPS, the GitHub repository and its release maintainers. This is not an independent code signature.
