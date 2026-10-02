# Android SSH runtime lifetime

The Rust process registry owns each `RuntimeInner` strongly. Previously it held
weak references, and dropping a UniFFI `HostRuntime` wrapper disconnected SSH.
React cleanup also disconnected clients, with an Android-alert-specific retention
map that destroyed retained clients on the next mount.

```text
Before: React -> UniFFI wrapper -> RuntimeInner <- weak registry
After:  process -> strong registry -> RuntimeInner
        React -> replaceable UniFFI wrapper -------^
        Android service -> health scheduling / wake lock / notification
```

## Rules

- `create_host_runtime` atomically creates or adopts one runtime per ID;
  `get_host_runtime` acquires an existing live runtime without credentials or a
  transport reconnect. The native incarnation and SSH generation are unchanged.
  Existing runtime configuration remains authoritative until Disconnect.
- Dropping foreign wrappers only releases references. React unmount detaches
  AppCore, callbacks, timers, and UI projections. A subsequent client obtains the
  native runtime and projects its current state, including reconnecting state.
- Android React module invalidation clears foreign event sinks and UI monitoring
  signals without shutting down SSH. The new bridge installs fresh sinks.
- Disconnect serializes teardown and permanently marks that incarnation closed.
  Acquisitions reject a runtime while it is disconnecting. Teardown invalidates
  epochs, cancels operations, closes streams/bridges, disconnects SSH and jump
  sessions, publishes disconnected state, and removes the registry entry.
  Repeated disconnects are harmless; old wrappers cannot reconnect or unregister
  a replacement. The ID stays reserved until cleanup finishes to prevent old
  resources colliding with a replacement using the same ID.
- The foreground service owns execution protection, notification, and wake lock.
  Its JNI signal controls background health scheduling directly, without React
  or Headless JS. Stopping it never disconnects a runtime.
- Health checks run when `app_active || background_monitoring_active`, at the
  existing 15-second interval. Three-second latency polling requires
  `app_active && hosts_visible && !access_locked`. Service-disabled background
  runtimes sleep their health worker; transport keepalive/detection and persistent
  reconnect retain their existing behavior.
- A terminal-history/UI restoration failure detaches the UI rather than closing
  a healthy connection. Initial authentication/connection failures still use the
  existing error cleanup and host-key trust flow.
- Process death loses all sockets and registry entries. Restoration in a new
  process creates new transports; Android foreground execution is not a guarantee
  against process termination or network loss.

## Changed areas

- Rust: `host_runtime.rs`, `host_runtime/connection.rs`, `events.rs`,
  `monitoring.rs`, `diagnostics.rs`, and `tests.rs`.
- Native adapter: `src/index.ts`, regenerated UniFFI TypeScript/C++ bindings,
  Android `cpp-adapter.cpp`, `WhipSshModule.kt`, and `HostRuntimeMonitoring.kt`.
- App UI: `HerdrClient.ts`, `TerminalBridgeController.ts`,
  `sessionRuntimePolicy.ts`, `useSessionConnectionLifecycle.ts`,
  `useSessionRuntimeManager.ts`, `useLiveHostMonitoring.ts`, and
  `backgroundMonitoring.ts`.
- Android app: `HerdrBackgroundService.kt` and `HerdrBackgroundModule.kt`.
- Jest: session manager/lifecycle tests, native attachment and monitoring tests,
  client adoption/in-flight-detachment tests, and affected mocks/API expectations.

## Automated verification

Rust tests cover strong retention after wrapper release, acquiring by ID,
concurrent adoption with one incarnation, stable generation, joining in-flight
connection operations, idempotent disconnect, rejection of reconnect on a closed
wrapper, final native destruction, background-health/visible-latency policy, and
service toggles/React invalidation retaining a registered runtime.

Jest covers manager unmount/remount, restoration failures, explicit disconnect,
client adoption without native `connect`, late failures after detach, handler
replacement and stale cleanup, and FGS/background signals without disconnect.
Existing terminal, transcript incarnation, authentication, and reconnect tests
remain in the suites.

Commands run from the repository root through `nix develop -c`:

```bash
cargo fmt --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml -- --check
cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
cargo clippy --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --target aarch64-linux-android -- -D warnings
npx tsc --noEmit
npm run lint
npx jest --runInBand --modulePathIgnorePatterns '<rootDir>/.codex' \
  --testPathIgnorePatterns '<rootDir>/.codex' '<rootDir>/__tests__/mockWhipSsh.js'
android/gradlew -p android :app:compileDebugKotlin \
  :app:externalNativeBuildDebug :app:lintDebug \
  -PreactNativeArchitectures=arm64-v8a
android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true
```

The Jest exclusions omit pre-existing nested worktrees under `.codex`; the first
unfiltered run discovered their duplicate package names. The release command uses
the configured upload keystore; `whip.skipR8` is only for the local device build.
Formatting also ran on the newly added TS/TSX tests with Prettier.

## Results and device coverage

- Rust: 353 passed, 1 pre-existing ignored; host and arm64 Android Clippy passed
  with warnings denied.
- Jest: 142 suites, 1,064 tests passed, including the additional late-detach test.
- TypeScript, ESLint, Rust formatting, and whitespace checks passed.
- Android arm64 Kotlin/JNI compilation, debug lint, and the upload-signed local
  release build passed. The APK contains the arm64 native SSH library only.
- In-place installation on the connected Pixel 9 Pro succeeded and preserved app
  data. Startup restored an existing saved host successfully.
- Device logs captured a UI detach/remount in PID 26679 followed by adoption of
  native incarnation 1, SSH generation 1, without a second SSH connect. The
  foreground service started, and subsequent foreground/background transitions
  did not log a disconnect or reconnect.

The device was being used during verification. Interactive screen navigation,
FGS-off toggling, background without FGS, deliberate Wi-Fi/mobile transitions,
and the final Disconnect gesture were not exercised end to end on the phone.
Their ownership/policy paths have automated coverage; actual Android scheduling,
OEM battery restrictions, network migration, and prolonged background behavior
still require an uninterrupted device session. Process death always requires a
new connection.

Native lifecycle messages use the `WhipHostRuntime` logcat tag so creation,
adoption, explicit shutdown, actual destruction, and background-health policy
changes remain observable with no JS event sink. Service and UI attachment logs
use `HerdrBackgroundService` and `ReactNativeJS` respectively. There is no
per-monitor-tick lifecycle logging.

The final APK includes that logcat-only diagnostic follow-up. The installed
lifecycle build was tested before the diagnostic follow-up; the final APK was
rebuilt successfully but not reinstalled while the phone remained in use.
