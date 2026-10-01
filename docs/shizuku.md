# Shizuku authorization

On Android, **More → Shizuku → Pair with Shizuku** requests authorization for
Whip through the official Shizuku API. Install and start Shizuku first, then
accept its permission prompt. The section links to the official download page
when Shizuku is missing and opens its manager when the service needs to be
started or authorization needs to be changed.

Status comes from the Android service and refreshes when its binder connects or
dies, when permission is answered, and when Whip returns to the foreground.
Whip does not save a permission grant locally. Reverse-control MCP exposes
`device.shizuku_status` and `device.shizuku_exec` through a Shizuku UserService.
The service runs commands as Shizuku's shell/root identity; Whip's own process
and remote SSH sessions retain their existing identities.

The integration requires an Android native rebuild; a Metro-only update cannot
add the API or provider. Shizuku server versions before 11 are unsupported.
The provider is protected by `android.permission.INTERACT_ACROSS_USERS_FULL`,
as required by the [official developer guide](https://github.com/RikkaApps/Shizuku-API).

To check on a device:

1. Open More without Shizuku installed and confirm **Install Shizuku** opens
   its official download page.
2. Install Shizuku with the service stopped and confirm **Open Shizuku** opens
   the manager. Start the service and return to Whip.
3. Tap **Pair with Shizuku**, allow access, and confirm the paired status.
4. Deny a request and confirm Whip offers to open the manager for authorization.
5. Stop or restart the service and confirm the status updates. Revoke Whip's
   permission in Shizuku and reopen Whip to confirm access is no longer shown.
6. On iOS, confirm the Shizuku section is absent.

## Privileged reverse-control tools

Only launches opted into Whip reverse control can call these tools. Pairing is
performed by the user in More; MCP calls never open a Shizuku permission prompt.
The live service checks permission before command execution. On Android 17,
Shizuku 13.6 can show an empty app list despite granting access; see
[upstream issue #1970](https://github.com/RikkaApps/Shizuku/issues/1970).

```json
{"name":"device.shizuku_status","arguments":{}}
{"name":"device.shizuku_exec","arguments":{"argv":["/system/bin/id"]}}
{"name":"device.shizuku_exec","arguments":{"argv":["/system/bin/dumpsys","battery"],"timeout_ms":5000}}
{"name":"device.shizuku_exec","arguments":{"argv":["/system/bin/sh","-c","settings get system screen_brightness"],"max_output_bytes":1024}}
```

`argv` begins with an absolute Android executable path. Arguments are literal;
shell expansion only occurs when explicitly invoking a shell. Commands have
closed stdin and run from `/`. Up to 128 argv entries are accepted, with 8192
UTF-8 bytes per entry and 16384 bytes total; NUL is rejected. `timeout_ms` defaults
to 10000 and accepts 100–15000. `max_output_bytes` defaults to 8192 and accepts
1–8192 per stdout/stderr stream. Output is UTF-8 text; invalid bytes are replaced.
Excess output is discarded while pipes continue draining.

The result includes `uid`, `exit_code`, `stdout`, `stderr`, `truncated`, and
`timed_out`. A nonzero exit code means the command failed. Timeout returns
`timed_out: true` and `exit_code: null`, with any captured output. MCP cancellation
or launch close returns an error and stops that launch's outstanding commands.
Each command runs in its own process group; cancellation, timeout, and normal
completion kill remaining members. Deliberately detached daemons are unsupported.
Four commands may run concurrently. The UserService is stopped when the last
launch using it closes, Whip exits, or Shizuku disconnects.

ADB-backed Shizuku runs as uid 2000, not root: app-private files and operations
denied by SELinux remain inaccessible. iOS status returns `unavailable`; execution
returns `device_unavailable`. Missing authorization returns `permission_denied`.

Device instrumentation tests require an already running Shizuku service and
Whip authorization. They verify the execution UID, privileged battery diagnostics,
literal argv, exit codes, stdout/stderr bounds, timeout child cleanup,
cancellation before/during exec, and native bridge session isolation.

Build the upload-signed arm64 app and its device tests, then install both in place:

```bash
nix develop -c android/gradlew -p android :app:assembleRelease :app:assembleReleaseAndroidTest \
  -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true -Pwhip.testBuildType=release
nix develop -c adb install -r android/app/build/outputs/apk/release/app-release.apk
nix develop -c adb install -r android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
nix develop -c adb shell am instrument -w -r \
  -e class io.github.kaminarios.whip.ShizukuPrivilegedToolsTest \
  io.github.kaminarios.whip.test/androidx.test.runner.AndroidJUnitRunner
```

`whip.skipR8` is for this local validation build only. Omit it for production.
If Shizuku is stopped or Whip is unauthorized, device tests are skipped;
successful compilation alone does not verify privileged execution.
