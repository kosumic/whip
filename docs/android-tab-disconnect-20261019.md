# Terminal disconnects with healthy SSH, 2026-10-19

The connected Pixel 9 Pro runs Whip 1.9.0 (versionCode 232). During this
investigation its application SSH probes continued succeeding, and returning
from the background successfully reattached six terminals. No spontaneous tab
failure or server close message was captured on the phone. The retained app
error filter contained zero errors for that launch. This does not establish
the trigger for the user's intermittent disconnects.

Two independent recovery defects were reproduced with a real loopback SSH
server and Herdr protocol-22 terminal sockets:

1. Herdr's `ServerShutdown` is decoded as `ServerMessage::Closed`. Unlike
   channel EOF, that message previously bypassed `terminal_bridge_closed`.
   With React attached it only notified the JavaScript handler, which removed
   the frame subscription; without React it only removed the bridge. Neither
   path started Rust recovery. The regression sends a temporary attachment
   rejection after opening completes and verifies that a new terminal attaches
   while SSH still answers probes and keeps the same generation.
2. A channel or input failure immediately after the attachment commit could
   see `retry_running = true` and decide that a retry worker already existed.
   The opening worker then cleared that flag and returned. Recovery was left
   with no worker. A reentrant attachment callback reproduces this window
   deterministically. Worker ownership is now cleared under the state lock as
   part of the successful attachment commit; callers no longer clear a flag
   that may already belong to a replacement worker.

Both regressions failed before their respective fixes and passed afterward.
They demonstrate recovery bugs, not the specific cause of the observed phone
disconnects. Another client taking over and a missing terminal are not assumed
to explain the user's report. Deliberate takeover messages still go through
client arbitration, with a regression ensuring that they do not start an
automatic reclaim loop.

Terminal recovery now records the close/error reason, SSH liveness, host state,
SSH generation, bridge ID, retry attempt, and whether a new worker was started
in `WhipHostRuntime` and the bounded private `no_backup/whip-runtime.log`.
Failed/restoring terminal state events also appear in the in-app network log.
Capture a future phone failure with:

```sh
nix develop -c adb logcat -v threadtime \
  WhipHostRuntime:V ReactNativeJS:V '*:S'
```

The regression tests live in
`packages/react-native-whip-ssh/rust/src/host_runtime/terminal/tests.rs` and use
the existing SSH fixture, extended with direct Unix socket forwarding.

Validation: 759 Rust library tests passed (3 ignored), strict production Clippy
passed, and 68 focused JavaScript lifecycle/renderer/arbitration tests passed.
The Jest invocation excluded generated `build/` and temporary checkouts to
avoid duplicate package and mock names in those copies.
Rust formatting and ESLint for the changed hook also passed. An app-source
TypeScript check remains blocked by six existing read-only `URL` property
assignments in `src/browser/address.ts` and `src/browser/controller.ts`.
The unrestricted TypeScript command additionally includes stale generated
checkouts under `build/` and reports errors from those copies.

An ARM64-only GitHub-channel release APK was built with the upload key and
installed successfully using `adb install -r`. The signing certificate matched
the previously installed app; the app was not uninstalled. The final packaged
native library was checked for the `ssh_alive=` diagnostic marker. APK SHA-256:
`bfb7e89516dcd4821b459b845eba8854cb49c2ca7005d793ab413011d2bd826e`.
After installation the saved host reconnected with 53 panes, an existing
terminal attached and rendered, and a background/foreground cycle reattached
that terminal in 328 ms without replacing SSH. Subsequent application SSH
probes succeeded. No spontaneous tab disconnect occurred in that check.
