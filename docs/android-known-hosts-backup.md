# Android known-host backup verification

Whip stores `herdr.known-hosts.v1` in Rust's local Turso `whip-app.db`
in Android's private database directory. Both backup rule sets include the entire
`database` domain, including WAL sidecars and retained legacy AsyncStorage
databases (`RKStorage` / `AsyncStorage`). Direct upgrades and restores import
legacy trust only before the durable migration receipt exists. A failed import,
read, or schema check preserves data and blocks trust mutations; it never treats
an error as an empty trust store. See [local storage](local-storage.md).

This is recovery support, not a persistence guarantee. Android controls backup
availability, timing, transport, quotas, user account association, and restore.
A true uninstall without an available backup can lose known hosts. Whip must
then show every SSH host key as unknown and require explicit fingerprint
verification; it never re-trusts a host automatically.

## Upgrade check

Use arm64 release APKs signed by the same upload key:

```bash
adb install android/app/build/outputs/apk/release/app-release.apk
# Trust host A in Whip and verify Known SSH hosts reports 1.
adb install -r android/app/build/outputs/apk/release/app-release.apk
# Launch Whip and verify host A remains present and connects without a new prompt.
```

## Backup/uninstall/restore check

Run this only on a disposable test installation because `adb uninstall`
deletes the app sandbox. Use a Play-enabled device or emulator with Android
backup enabled and the same Google account throughout.

```bash
adb install android/app/build/outputs/apk/release/app-release.apk
# Trust host A in Whip and verify Known SSH hosts reports 1.
adb shell bmgr enabled
adb shell bmgr backupnow io.github.kaminarios.whip
adb shell bmgr list sets
# Record the restore-set token printed above.
adb uninstall io.github.kaminarios.whip
adb install android/app/build/outputs/apk/release/app-release.apk
adb shell bmgr restore RESTORE_SET_TOKEN io.github.kaminarios.whip
# Launch Whip and verify host A is present and accepted without prompting again.
```

The application ID and signing identity must match the backed-up installation.
Some transports perform restore automatically at install time; `bmgr restore`
is useful for an explicit test when the active transport supports it. A missing
restore set or a transport that declines the package is a backup-unavailable
case, not a reason to weaken SSH host-key verification.
