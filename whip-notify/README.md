# whip-notify

Independent Rust HPKE protocol library and short-lived Herdr notification plugin. No WhipAir dependency, host daemon or listener.

See [installation, protocol, leases, relay deployment and security model](../docs/remote-notifications.md).

Whip offers per-host **Install on host** / **Uninstall from host** controls over its existing SSH connection. Once published on the default branch, this package is also directly installable without a marketplace listing:

```sh
herdr plugin install --yes KaminariOS/whip/whip-notify
herdr plugin uninstall dev.whip.notify
```

The host needs Herdr 0.9.5+, Git and a current Rust toolchain. `herdr-plugin.toml` builds only this standalone package. Herdr installs plugins globally for the SSH account across its sessions; device push opt-in remains separate. Uninstall preserves configuration for reinstall. Optional marketplace discovery uses the repository's `herdr-plugin` GitHub topic.

For a local checkout:

```sh
cargo build --release --locked
sh install.sh
cargo test --locked
```

The binary supports `paths`, `identity`, `register` (JSON on stdin), `unregister <device-id>`, `lease renew <device-id>`, `hook` and explicit administrator `uninstall`. It uses Herdr's `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`; `--dirs <config> <state>` supplies those same discovered paths for authenticated SSH commands outside a hook. The protocol library builds independently using `--no-default-features`.
