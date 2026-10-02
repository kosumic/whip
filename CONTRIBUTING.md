# Contributing to Whip

Thank you for helping improve Whip. Whip is an independent, unofficial mobile client for Herdr. Small, focused contributions with a clear test plan are easiest to review.

## Start with the right channel

- Ask usage questions and discuss early ideas in [GitHub Discussions](https://github.com/kosumic/whip/discussions).
- Use the issue forms for confirmed bugs and scoped feature requests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Open a pull request when the change is ready for review.

For a substantial feature or architecture change, start a Discussion before investing significant time. This helps confirm scope without turning an early idea into a tracking issue prematurely.

## Development setup

Whip requires Node.js 22 and a custom Expo native build; it cannot run in Expo Go. Android development uses JDK 17, Android SDK Platform 36, NDK 27.1.12297006, CMake 3.22.1, and the ARM64 Rust target. iOS development uses macOS, Xcode, CocoaPods, and the ARM64 Apple Rust target.

On NixOS, the repository development shell provides the complete toolchain:

```bash
nix develop
npm ci
```

Start Metro in that shell with Whip's scheme and IPv4-compatible LAN bind:

```bash
npm start -- --scheme whip --host lan --offline
```

Then use a second development shell for the ARM64 device build:

```bash
nix develop
adb reverse tcp:8081 tcp:8081
ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a npm run android -- --no-bundler
```

For other systems, install Node.js 22, JDK 17, Android SDK Platform 36, Build Tools 36.0.0, NDK 27.1.12297006, and CMake 3.22.1. Then run:

```bash
npm ci
adb reverse tcp:8081 tcp:8081
ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a npm run android -- --no-bundler
```

On macOS, enter `nix develop`, run `npm ci`, then install the checked-in iOS pods with `cd ios && bundle exec pod install`. Open `ios/HerdR.xcworkspace` in Xcode for a signed device build. The unsigned CI invocation is documented in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

See [DEBUG.md](DEBUG.md) for the emulator and device troubleshooting loop, and [ARCHITECTURE.md](ARCHITECTURE.md) before changing transport, terminal, credential, or state ownership.

## Validate a change

Run the checks relevant to your change. Before requesting review, the full validation set is:

```bash
npx expo-doctor
npx tsc --noEmit
npm run check:herdr-api
npm run lint
npm test -- --runInBand
npm run bundle:ios
cargo fmt --check --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml
cargo clippy --locked --all-targets --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml -- -D warnings
cargo test --locked --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml
android/gradlew -p android app:lintRelease app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a --no-daemon
```

Document any check you could not run and why.

## Pull request guidance

- Keep one logical change per pull request.
- Explain the user-visible result and how you verified it.
- Add or update tests for behavior changes.
- Include before/after screenshots or a short recording for UI changes.
- Put documentation screenshots in `assets/screenshots`, capture them from a release build, and use generic host, user, path, and terminal values.
- Preserve the mobile-client product boundary unless a proposal has been discussed first; native Herdr controls should complement, not reproduce, the desktop management TUI.
- Use conventional commit subjects such as `fix:`, `feat:`, `doc:`, `ci:`, `test:`, or `chore:`.
- Do not mix dependency upgrades or generated files into an unrelated change.

## Security and privacy

Never place SSH passwords, private keys, passphrases, Tailnet credentials, host contents, or captured terminal secrets in issues, logs, screenshots, fixtures, or commits. Redact hostnames and Tailnet IP addresses when they are not necessary to reproduce a problem.

Do not weaken strict SSH host-key verification, changed-key rejection, platform credential-store policies, or the restricted agent-forwarding model. Changes to credential storage, Android backup behavior, iOS Keychain access, host trust, remote-content previews, or release signing require an explicit security review.

## Licensing and provenance

Only submit work you have the right to contribute. Identify copied, adapted, generated, or ported material and preserve its required notices. Do not copy implementation code from Herdr or another project merely because it is visible on GitHub.

Unless explicitly stated otherwise, accepted contributions are licensed under `AGPL-3.0-or-later`, as described in the repository's root [LICENSE](LICENSE). If licensing or provenance is unclear, pause and ask a maintainer before submitting the work.
