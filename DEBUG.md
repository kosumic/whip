# Expo Android build and debugging guide

This repository is an Expo SDK 57 Android app with native modules. It uses a custom Expo development build; **Expo Go is not sufficient**. The verified development target on this machine is the Android API 36 AVD named `expo-api-36`.

This guide is written for future coding agents working on NixOS with Sway/Wayland. Run project commands from the repository root unless a command says otherwise.

## The four layers

Treat these as separate processes with separate success criteria:

1. **Emulator** — Android has booted and `adb` can reach it.
2. **Native app** — Gradle built and installed the debug APK.
3. **Metro** — the development client can fetch and execute the JavaScript bundle.
4. **Rendered UI** — the expected React Native screen is visibly present and interactive.

Do not report a successful launch only because `am start` returned `Status: ok`, the package has a PID, or `MainActivity` is resumed. Those checks only prove that the native shell opened. Always inspect the rendered screen; an Expo error activity can also be resumed.

## Enter the development environment

The project flake supplies Node.js 24, JDK 17, Android platform 36, Build Tools 35/36, and NDK 27.1:

```bash
nix develop
node --version
java -version
adb version
```

Install the locked dependencies when `node_modules` is absent or the lockfile changed:

```bash
npm ci
```

The complete SSH stack is maintained in `packages/react-native-whip-ssh` and is
installed through a local `file:` dependency. Its JavaScript facade, UniFFI
bindings, native installers, and Rust/Russh crate live together there. Make SSH
changes in that source directory, never in `node_modules`.

On NixOS, the Android SDK in the Nix store is immutable. Do not let Gradle or `sdkmanager` attempt to modify it. If a build requires another Android platform, Build Tools release, or NDK release, add that version to `flake.nix`, update the lock if necessary, and re-enter `nix develop`.

The flake's `android.aapt2FromMavenOverride` is intentional. It makes Gradle use the Nix-provided `aapt2` binary instead of a dynamically linked Maven binary that may not run directly on NixOS.

## Start or verify the emulator

List available AVDs before assuming one exists:

```bash
nix develop ~/nixpkgs#android --command emulator -list-avds
```

Start the verified AVD in its own terminal:

```bash
nix develop ~/nixpkgs#android --command emulator -avd expo-api-36 -gpu host
```

Wait for Android and verify the connection:

```bash
adb wait-for-device
adb shell getprop sys.boot_completed
adb devices -l
```

`sys.boot_completed` must print `1`, and `adb devices -l` must show an emulator in the `device` state. If the emulator says the AVD is unknown, run `emulator -list-avds` and check that `$HOME/.android/avd/expo-api-36.ini` exists. An installed system image is not itself an AVD.

Keep the emulator on the host. Putting it in Podman adds KVM, Wayland, audio, and ADB forwarding complexity and does not avoid the Android SDK or system-image downloads.

## Start Metro

Start Metro in a dedicated terminal and leave it running:

```bash
nix develop
EXPO_UNSTABLE_MCP_SERVER=1 npm start -- --scheme whip --host lan --offline
```

Confirm that Metro is listening before launching the app:

```bash
curl -fsS http://127.0.0.1:8081/status
```

The expected response is:

```text
packager-status:running
```

`EXPO_UNSTABLE_MCP_SERVER=1` enables Expo's local MCP integration. The repository includes `expo-mcp` as a development dependency.

## Connect the emulator to Metro

Create the ADB reverse tunnel every time the emulator is restarted:

```bash
adb reverse tcp:8081 tcp:8081
adb reverse --list
```

The reverse tunnel lets the Android app reach the host Metro server as `localhost:8081`. This is more deterministic than relying on the emulator's `10.0.2.2` host alias.

## Build and install the development client

With the emulator and Metro already running:

```bash
nix develop
ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a npm run android -- --no-bundler
```

This synchronizes the terminal assets and runs `expo run:android`. The first native build can be slow because Gradle downloads and transforms React Native, Hermes, Android plugins, and Maven dependencies. These artifacts are cached and later builds should be much faster.

The debug APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

For a verbose native build without Expo's launcher wrapper:

```bash
cd android
./gradlew app:installDebug --info --console=plain \
  -PreactNativeDevServerPort=8081 \
  -PreactNativeArchitectures=arm64-v8a
```

### Reuse the writable Android SDK cache

This machine already has a writable SDK cache at:

```text
/home/kosumi/repos/.android-sdk-herdr
```

It contains Build Tools 36, CMake 3.22.1, and the 2 GB NDK
`27.1.12297006` used by previous successful builds. If entering `nix develop`
would download the Android closure again, compile directly with the cached SDK
and an installed Nix JDK 17:

```bash
cd android
env \
  JAVA_HOME=/nix/store/<jdk17-path> \
  ANDROID_HOME=/home/kosumi/repos/.android-sdk-herdr \
  ANDROID_SDK_ROOT=/home/kosumi/repos/.android-sdk-herdr \
  ANDROID_NDK_ROOT=/home/kosumi/repos/.android-sdk-herdr/ndk/27.1.12297006 \
  GRADLE_OPTS=-Dorg.gradle.project.android.aapt2FromMavenOverride=/home/kosumi/repos/.android-sdk-herdr/build-tools/36.0.0/aapt2 \
  ./gradlew :app:installDebug --console=plain \
  -PreactNativeArchitectures=arm64-v8a
```

Find the current JDK 17 store path instead of copying a stale hash:

```bash
fd -t d 'openjdk-17' /nix/store --max-depth 1
```

The full JDK path must be used. A partially realized `openjdk-headless` path may
fail to start with a missing `libjli.so` until its complete Nix closure exists.

Whip's maintained native build target is `arm64-v8a`. Use a physical ARM64 device or an ARM64 emulator image; do not silently fall back to a multi-architecture release build.

## Relaunch deterministically

This app's Android package is `io.github.kaminarios.whip`, its main activity is `io.github.kaminarios.whip.MainActivity`, and its development-client scheme is `whip`.

If Expo does not open the project automatically, force-stop it and launch the development client against the reverse-tunneled Metro server:

```bash
adb reverse tcp:8081 tcp:8081
adb shell am force-stop io.github.kaminarios.whip
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d 'whip://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
```

Then wait for the UI to settle and inspect the screen.

## Required visual verification with Argent MCP

Argent is the device automation and inspection MCP. Expo MCP handles Expo/EAS functionality; it does not replace emulator inspection.

Use this order:

1. `list-devices` and select `emulator-5554` (or the current serial).
2. `await-screen-idle` after launches or reloads.
3. `screenshot` and `describe` before interacting.
4. For React Native inspection, connect the debugger to Metro port `8081`, then use `debugger-component-tree`.
5. Use coordinates returned by `describe` or `debugger-component-tree`; never guess tap coordinates.
6. After an action, wait again and capture another screenshot/description.
7. Inspect debugger/native logs when the screen is blank, stale, or showing an error.

A valid launch for this repository visibly shows the **Hosts** screen, either with the **No servers yet** empty state or with saved remote profiles. Opening **Add host** shows the **Remote Herdr connection** form with Tailscale host/IP, SSH user, authentication, Herdr command, and session fields.

Do not treat these as sufficient proof of a working Expo launch:

```bash
adb shell pidof io.github.kaminarios.whip
adb shell dumpsys activity activities | rg 'mResumedActivity|topResumedActivity'
```

They are useful supporting checks, but the Expo error screen also satisfies them.

## Diagnose `Unable to load script`

Symptom: the emulator displays **There was a problem loading the project** and `java.lang.RuntimeException: Unable to load script`.

Check each link in order:

```bash
curl -fsS http://127.0.0.1:8081/status
adb devices -l
adb reverse --list
```

Repair and relaunch:

```bash
adb reverse tcp:8081 tcp:8081
adb shell am force-stop io.github.kaminarios.whip
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d 'whip://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
```

Successful Android logs contain lines similar to:

```text
isMetroRunning(): Async result = true
loadJSBundleFromMetro()
ReactNativeJS: Running "main"
```

If the error remains, restart Metro with its cache cleared and repeat the reverse tunnel and relaunch:

```bash
npx expo start --dev-client --clear
```

## Logs and runtime checks

Clear old logs immediately before reproducing a problem so stale errors are not mistaken for the current run:

```bash
adb logcat -c
```

Watch the useful React Native and Android errors:

```bash
adb logcat | rg -i 'ReactNativeJS|ReactNative|AndroidRuntime|FATAL EXCEPTION|DevLauncher|Unable to load|Metro|Bundle'
```

Useful state checks:

```bash
adb shell pidof io.github.kaminarios.whip
adb shell dumpsys activity activities | rg 'mResumedActivity|topResumedActivity|io.github.kaminarios.whip'
adb shell pm list packages | rg 'io.github.kaminarios.whip'
```

For a failed Gradle build, preserve the first meaningful exception and rerun the failing task with `--stacktrace --info`. The final cascade of Gradle errors is often less useful than the first missing package, compiler error, or native-linker error.

## Decide whether a native rebuild is needed

Usually **no native rebuild** is needed for changes limited to:

- `.js`, `.jsx`, `.ts`, or `.tsx` application code
- styles and React components
- JavaScript-only assets already served by Metro

Use Fast Refresh or reload the app through Argent/Expo.

Rebuild and reinstall after changes to:

- `app.json` native configuration, including scheme or permissions
- `android/`, Kotlin, Java, manifests, or Gradle files
- native dependencies in `package.json`
- Expo config plugins
- bundled Android assets such as the patched terminal files

Avoid `./gradlew clean` as a routine step; it destroys useful incremental build outputs. Use it only when evidence points to stale native artifacts.

## Project validation

Run checks appropriate to the change:

```bash
npx expo-doctor
npx tsc --noEmit
npm run lint
npm test -- --runInBand
npx expo export --platform android
```

For a final Android smoke test:

1. Start the emulator and Metro from clean terminals.
2. Restore `adb reverse tcp:8081 tcp:8081`.
3. Install or relaunch the development client.
4. Verify the rendered connection screen with Argent.
5. Check logcat for fatal exceptions.
6. If testing the actual Herdr connection, first verify the same SSH command from the host:

```bash
ssh user@laptop.tailnet.ts.net 'herdr status server --json'
```

Never put SSH passwords, private keys, Tailnet credentials, hostnames, or captured secrets into logs, screenshots, fixtures, or commits. End-to-end tests must verify the expected fingerprint on first use and must treat a changed host key as a failure.

## Credential recovery

Remembered SSH passwords, private keys, and key passphrases remain in
`react-native-keychain` for normal use. `CredentialVaultModule` also encrypts a
backup with a random 256-bit AES-GCM recovery key. Only the ciphertext is stored
in AsyncStorage and included in Android Auto Backup. The recovery key is wrapped
locally by Android Keystore and separately stored as a small Android Block Store
token.

The local wrapped key and Keychain files are excluded from Android Auto Backup.
After reinstall, the restored ciphertext therefore stays locked until the user
approves Android's biometric/device-credential prompt. The app then retrieves
the Block Store token, decrypts each credential, and imports it back into
Keychain. This is device authentication, not a FIDO passkey or relying-party
login.

Block Store cloud backup is enabled only when Google Play services reports that
end-to-end encryption is available. Otherwise the token is stored for supported
same-device/device-transfer restore only. Backup services must be enabled, and
both Auto Backup and Block Store sync are asynchronous, so recovery is not an
immediate guaranteed snapshot.

Native vault changes require a rebuild. Validate without exposing secrets:

```bash
npm test -- --runInBand __tests__/credentialVault.test.ts __tests__/credentialVaultNative.test.ts
nix develop --command android/gradlew -p android :app:compileDebugKotlin --console=plain
```

Do not uninstall the user's active app to exercise recovery. Use a disposable
emulator signed with the same debug certificate, save a test-only credential,
confirm `herdr.credential.backups.v1` contains ciphertext rather than plaintext,
then follow the same-device uninstall/reinstall flow. A differently signed APK
cannot update an existing installation and must never be worked around by
uninstalling the user's app.

## Herdr terminal architecture

The Android session view follows Voltius's mobile terminal model: selecting a Herdr tab enters an immersive terminal workspace, the normal bottom navigation disappears, the tab and pane rails stay compact, and every opened terminal WebView remains mounted while hidden. Host and space controls live in Herd's queue scopes so the terminal can stay focused. Keeping the WebViews mounted preserves xterm state when switching panes.

Do not implement the live view by running `herdr terminal attach` inside the SSH shell. That command is the human-facing nested-PTY interface; it echoes the SSH login and attach command and does not behave reliably as an application transport.

Use a direct SSH stream-local channel to Herdr's client-protocol socket instead. The shared Rust codec performs the binary `Hello` / `Welcome` handshake, sends `AttachTerminal`, and carries terminal frame, input, resize, scroll, bell, and detach messages. Terminal frame bytes stay binary through UniFFI/JSI and are batched only at the WebView boundary.

A direct terminal attach owns a server-side resize lock for that pane. When a
terminal screen unmounts, the app enters the background, or a live host is
closed, the bridge must send Herdr's detach message and close the stream-local
channel. Removing only the JavaScript frame callback leaves the controller
alive, keeps the pane at the mobile viewport's dimensions, and prevents a
desktop client from restoring its PTY size.

The codec implementation and protocol fixtures live in
`packages/react-native-whip-ssh/rust/src/herdr_codec.rs` and its Rust tests.

The terminal HTML is generated by `scripts/sync-terminal-assets.ts` and copied into the APK at `android/app/src/main/assets/herdr-terminal.html`. Regenerate it and rebuild the APK whenever the script changes:

```bash
node scripts/sync-terminal-assets.ts
cd android
./gradlew app:installDebug --console=plain \
  -PreactNativeDevServerPort=8081 \
  -PreactNativeArchitectures=arm64-v8a
```

For a real smoke test, connect to a disposable or known-safe Herdr pane, open **Session**, and verify all of the following visually:

1. The complete remote TUI appears, not an SSH banner or attach command.
2. The Herd host/space scopes and the Terminal tab/pane rails match the selected terminal.
3. A tap focuses xterm and the Android keyboard causes the terminal to refit.
4. Extra keys and typed input update the remote TUI.
5. A vertical swipe scrolls the Herdr viewport and a double-tap sends Tab.
6. Switching away and back preserves the terminal surface.

A remembered private key is intentionally shown only as `PRIVATE KEY LOADED`; do not reveal it for screenshots or inspection unless the user explicitly chooses **Tap to replace**.
