# Experimental Native Shell About

This is an opt-in embedded About renderer. The default More screen keeps the
React Native About implementation and its existing navigation. No terminal,
SSH, chat, billing or other More sections move to NSH.

## Boundary and linking

`MoreScreen` mounts `NativeShellAbout`, which selects the original `AboutSection`
unless the Expo extra `nshAboutExperiment` is true and the installed binary has
`WhipNativeShellAbout`. A native loading error also returns to the original UI.

The native view loads the production NSH bytecode and assets. `ui/About.tsx`
imports `WhipAbout` from `whip/about`. NSH registers that module from the
`packages/whip-nsh` Rust crate. Its `protocolLabel()` calls
`whip_core::herdr_protocol_label()` directly; `evaluateUpdate()` calls
`whip_core::evaluate_app_update()`. The dependency named `whip-core` is a Cargo
path dependency on the **existing** `whip-ssh` crate, rather than another core.
There is no React Native, JSI or UniFFI call on either NSH-to-core path.

When the native experiment is enabled, the combined archive **replaces** the
core-only archive at its existing link site:

* Android: `libwhip_nsh.a` is installed as the existing `libwhip_ssh.a` CMake
  input. Whole-archive linking retains NSH's name-based JNI entry points in
  `libreact-native-whip-ssh.so`. NSH's pinned Java sources load that library.
  No stock AAR or separate `libnsh.so` is packaged. JNI's class cache is
  initialized by the combined library's `JNI_OnLoad`.
  RN also compiles the library's CMake target through app-level autolinking:
  both Gradle projects must pass `WHIP_NSH_ABOUT` consistently. The Rust archive
  and whole-archive flags are **private** link dependencies, so `appmodules`
  cannot embed another copy of Rust. Experimental `assembleRelease` runs
  `scripts/verify-android-nsh.sh` against the final APK, checking JNI/core
  exports in the intended library and rejecting a second native owner.
* iOS: UBRN packages the combined archive into the existing
  `WhipSsh.xcframework`; the app never links a separate NativeShell framework.
  The Objective-C++ view uses NSH's C embedding API, which internally hosts
  `nsh_platform_ios::AppView` loading a TSX bundle. Rust-only `AppView::run`
  would render a Rust component and is not this TSX integration. The prebuilt
  `NshAppView` framework would not contain Whip's custom Rust module.
  The existing UBRN configuration preserves the custom podspec and Android
  Gradle file during regeneration; otherwise the generator would erase the
  opt-in native integration.

The core's process statics and `HostRuntime` registry occur once in that image.
About allocates **no AppCore or HostRuntime**. RN still creates its AppCore in
`useSessionRuntimeManager`. A later stateful NSH migration must receive that
same `Arc<AppCore>` from a native ownership API, retaining its HostRuntime Arcs;
it must not call `AppCore::new()` or reconstruct state from RN snapshots.

NSH's mobile hosts leave `EngineConfig::runtime` unset. The pinned source patch
`patches/shared-runtime.patch` adds `nsh_engine::set_shared_runtime` so native
initialization can supply `whip_core::shared_runtime_handle()`. This plain Rust
accessor uses the core's existing OnceLock. NSH's fallback Tokio runtime is
therefore never initialized in the mobile experiment. This patch is an explicit
local extension, **not an API claimed to exist upstream**.
The same patch cancels pending platform HTTP requests when an engine is
destroyed. NSH deliberately does not execute JS cleanup callbacks after VM
shutdown; native request cancellation must happen at the engine boundary.

The implementation was based on [NSH's Rust API](https://nsh.dev/docs/rust/),
[iOS embedding](https://nsh.dev/docs/ios/),
[Android embedding](https://nsh.dev/docs/android/) and
[native components](https://nsh.dev/docs/native-components/), and inspected
against source revision `201d780a9339b886ac87c741d3d4fd8fb64e1d30`.

## Preserved behavior

The original inventory is: a collapsed About header in More (after membership,
before tips/usage/settings), source and repository sharing, X profile, Herdr
website and sharing, Whip mark/name/tagline, installed version and validated
12-character commit link, installation QR/URL/sharing, host licenses navigation,
Rust Herdr protocol range, terminal-font manifest including platform fallback,
GoVue, and an on-demand update check only for GitHub distribution. Updates time
out after 15 seconds, reject HTTP/invalid release data, prevent concurrent
requests, show loading/errors/results and open GitHub's latest release page.

The NSH UI retains this inventory. The catalogs for English, Japanese, French,
Spanish and both Chinese scripts are imported directly, using the same i18next
interpolation engine without its React plugin. Font names and image/QR assets
come from the existing sources; the Herdr SVG is extracted from the current
inline mark. Shared link constants live in `src/lib/aboutLinks.ts`.
The existing Licenses page includes the mobile dependency notices generated by
`nix develop -c npm run generate:nsh-notices`; regenerate these when the NSH
revision or its locked dependencies change.

RN passes only host environment and installed build metadata: current locale,
palette, dark/light appearance, Glass Mode and Liquid Glass availability,
app/system font scale, version, validated commit and distribution
channel. Changes are sent to the running engine without restarting it. Core
data is never included in those props/events. Native bindings implement URL
opening, sharing, alerts and selection haptics. Licenses events retain RN's
existing navigation/back stack. The only RN events from NSH are height,
licenses and failure. Platform URL/share errors return to NSH for translated
alerts. No platform permissions are added; NSH permits only the required host
operations and HTTPS GET to the existing latest-release endpoint.

The NSH root reports its natural height. RN updates the native view's height
inside More's existing scroll view; the NSH UI has no scroll container. Width,
translation and font-size changes cause another layout/height report. The
native view is destroyed when RN drops it (Android `destroy()`, iOS
`nsh_app_destroy`); the engine patch cancels pending requests at teardown and
UI cleanup aborts them on normal component disposal. Expansion remains immediate
rather than using RN's Reanimated transition.

The UI uses Whip's original Inter faces, Lucide icon shapes, 16-point card
corners, control dimensions, text sizes, spacing, round source icons and inline
blue commit link. `prepare-nsh-icons.cjs` extracts the installed Lucide SVG
geometry at build time; no React components enter the NSH bundle. Android
registers the bundled Inter faces with NSH. iOS reuses the faces Expo already
registered before mounting the app: importing them again into NSH from different
temporary file URLs caused CoreText registration failures. NSH's supported
dynamic imports restrict that registration to Android/headless hosts. The iOS
host retains its error callback context itself until engine destruction, using
the C API's caller-owned context mode, so asset errors can safely trigger RN
fallback.

Glass Mode follows the existing host context: solid theme surfaces when off,
clear native Liquid Glass on supported iOS versions, an ultra-thin blurred and
tinted fallback on older iOS, and the existing tint-only treatment on Android.
On Liquid Glass, inset controls share the outer backdrop and use the existing
translucent button fill; stacking NSH's glass effects caused noticeably stronger
refraction than RN in the same-simulator comparison.
The embedded root remains transparent so the host's wallpaper shows through.
All these choices update in place with the host environment.

## Build and rollback

Run from the repository root using the Nix development environment:

```sh
nix develop -c bash scripts/prepare-nsh-about.sh
nix develop -c cargo test --locked --manifest-path packages/whip-nsh/Cargo.toml
nix develop -c npm run check:nsh-about
nix develop -c npm run test:nsh-about
```

Preparation fetches the exact NSH revision, applies the shared-runtime patch,
builds its CLI, generates the custom module descriptions, compiles TSX to
`bundle.nshc`, and copies the complete asset directory to native resources.
`App.tsx` stays beside `nsh.json`: NSH discovers custom Rust modules and
capabilities next to the entry. Preparation stages the existing images inside
that project before bundling, so the release contains relative asset URLs and
the original image bytes instead of workstation paths. The bundle contains
18 assets: six existing images, nine Lucide icons and three existing font faces.
Release builds use those bundled files and require no development server.
`NSH_ABOUT_EXPERIMENT=1` also runs preparation in npm's postinstall hook.

Android experimental local build (arm64, existing upload signing):

```sh
nix develop -c env NSH_ABOUT_EXPERIMENT=1 WHIP_DISTRIBUTION_CHANNEL=github \
  android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true
```

NSH requires Android API 28. Only the opt-in native build raises Whip's minimum
from 24 to 28. The Nix shell supplies libclang; the Rust build script points
bindgen and Clang at the NDK's API 28 sysroot. Production/CI builds must omit
`whip.skipR8`; NSH's name-based Java/JNI classes have consumer keep rules.

On mini, reuse `/Users/kosumi/repos/whip-ios-device`, inspect/preserve its status,
and prepare resources before CocoaPods. Set both environment variables for
dependency preparation, pod install and build:

```sh
NSH_ABOUT_EXPERIMENT=1 WHIP_DISTRIBUTION_CHANNEL=github \
  scripts/install-ios-device.sh
```

Use the dedicated build keychain and system Xcode as the existing script does.
Never uninstall to work around signing. To roll back, unset
`NSH_ABOUT_EXPERIMENT`, rebuild/reinstall in place, or ship an RN bundle with
`extra.nshAboutExperiment=false`. Missing native support automatically selects
the RN About UI.

### iOS simulator

The simulator also needs the **combined** Rust archive for
`aarch64-apple-ios-sim`; a device archive cannot run in the simulator even
though both use arm64. After preparing NSH and the existing device bridge,
run on the Mac inside `nix develop`:

```sh
export NSH_ABOUT_EXPERIMENT=1 WHIP_DISTRIBUTION_CHANNEL=github
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:$PATH
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
unset SDKROOT
export IPHONEOS_DEPLOYMENT_TARGET=16.4 CARGO_BUILD_JOBS=1
export LIBCLANG_PATH="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib"
export CC_aarch64_apple_ios_sim=/usr/bin/clang
export AR_aarch64_apple_ios_sim=/usr/bin/ar
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER=/usr/bin/clang
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_apple_ios_sim="-isysroot $(xcrun --sdk iphonesimulator --show-sdk-path) --target=arm64-apple-ios16.4-simulator"
cargo build --locked --manifest-path packages/whip-nsh/Cargo.toml \
  --features mobile --target aarch64-apple-ios-sim --release

nsh_framework_backup=$(mktemp -d "$PWD/build/nsh-simulator.XXXXXX")
xcodebuild -create-xcframework \
  -library "$PWD/packages/whip-nsh/target/aarch64-apple-ios/release/libwhip_nsh.a" \
  -library "$PWD/packages/whip-nsh/target/aarch64-apple-ios-sim/release/libwhip_nsh.a" \
  -output "$nsh_framework_backup/WhipSsh.xcframework"
mv packages/react-native-whip-ssh/build/WhipSsh.xcframework "$nsh_framework_backup/previous.xcframework"
mv "$nsh_framework_backup/WhipSsh.xcframework" packages/react-native-whip-ssh/build/
(cd ios && pod install)
```

Select a booted arm64 simulator from `xcrun simctl list devices`, set
`WHIP_IOS_SIMULATOR` to its UUID, and use system Xcode with the Nix compiler
overrides removed, as `scripts/build-ios-app.sh` does:

```sh
while IFS='=' read -r name _; do
  case "$name" in
    NIX_*|CC|CXX|CPP|LD|LDPLUSPLUS|AR|AS|NM|RANLIB|STRIP|LIPO|LIBTOOL) unset "$name" ;;
  esac
done < <(env)
xcodebuild -workspace ios/HerdR.xcworkspace -scheme HerdR \
  -configuration Release -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$WHIP_IOS_SIMULATOR" \
  -derivedDataPath build/ios-device -jobs 1 ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  FORCE_BUNDLING=1 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) WHIP_EMBEDDED_BUNDLE' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Automatic build
nsh_simulator_app="$PWD/build/ios-device/Build/Products/Release-iphonesimulator/HerdR.app"
codesign --force --sign - --timestamp=none --generate-entitlement-der "$nsh_simulator_app"
codesign --verify --deep --strict "$nsh_simulator_app"
xcrun simctl install "$WHIP_IOS_SIMULATOR" "$nsh_simulator_app"
xcrun simctl launch "$WHIP_IOS_SIMULATOR" io.github.kaminarios.whip
WHIP_IOS_TEST_DESTINATION="platform=iOS Simulator,id=$WHIP_IOS_SIMULATOR" \
  ruby scripts/test-ios-nsh-about.rb
```

Use the standard simulator ad-hoc signature. Adding device-style restricted
keychain/application entitlements to an ad-hoc simulator signature caused AMFI
to deny launch during testing. The UI runner drives the installed Release app
through XCTest, requires English/system language initially, restores its
temporary French selection, and saves screenshots in its `.xcresult` bundle.
It neither builds the application again nor starts Metro.
`testAboutReference` also runs against the original renderer. Select it alone
with `-only-testing:NshAboutUITests/NshAboutUITests/testAboutReference` to compare
both feature-flag values, or verify recovery from a deliberately invalid NSH
test bundle. It checks the source control and its touch target and attaches a
screenshot, logging which renderer is active.

Each case relaunches the installed app to isolate native presentation state;
the sandbox remains intact. The test runner has a runtime-checked **private
XCTest** adapter that excludes animation completion from its idle gate while
retaining process-idle checks and real app animations. This follows the
[WebDriverAgent quiescence approach](https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Categories/XCUIApplicationProcess%2BFBQuiescence.m).
Without it, the tested Xcode logged repeated 60-second animation-idle timeouts
after host/native presentations. The adapter is compiled only into the test
runner, fails explicitly if its selectors change, and is restored at suite
teardown; it is not part of the application or the NSH integration API.

## Verification

Commands run from `nix develop`:

* `cargo test --locked --manifest-path packages/whip-nsh/Cargo.toml --lib`:
  two direct protocol/version tests passed.
* `cargo test --locked --manifest-path packages/whip-nsh/Cargo.toml --test shared_runtime`:
  one test passed, covering two surfaces, the core's existing Tokio runtime,
  captured resource disposal and cancellation of a pending native request.
* Existing `whip-ssh` tests filtered by `app_update` and `protocol`: two and
  thirteen tests passed respectively.
* `npm run check:nsh-about` and `npm run test:nsh-about`: check passed and six
  real headless NSH tests passed. These exercise expansion/collapse and natural
  height, protocol data, links/sharing/licenses, all six live locale catalogs,
  theme changes, text hierarchy/commit styling, GitHub-only updates and platform
  errors. The platform-error case also exercises Android's font-import path.
* `tsc --noEmit`, targeted ESLint, `cargo fmt --check`, shell syntax checks and
  `git diff --check`: passed.
* Focused RN Jest suites (`nativeShellAbout`, `checkForUpdates`, `screenUpdates`,
  `iosBuildCache`, `licenseNotices`): 33 tests passed. The updated iOS cache
  suite was also rerun after the generator-preservation fix: 17 tests passed.
* Simulator follow-up: the three `nativeShellAbout` Jest tests, root TypeScript
  check and targeted ESLint passed after subscribing to live system font scale
  with `useWindowDimensions()`.
* `ruby scripts/test-ios-nsh-about.rb` on mini, Xcode 27.1 (27A9275): four UI
  cases passed across the final runs. The combined run passed scrolling/height,
  external website/return, and sharing/updates/Licenses; the locale case passed
  its focused rerun after adding an explicit stable-frame wait for the animated
  language picker. The rerun used
  `-only-testing:NshAboutUITests/NshAboutUITests/testLiveThemeAndLocale`.
  Dark mode and French/English changes retained the expanded NSH content.
  The installed 1.10.0 (4) GitHub build reported `Whip 1.10.1 is available.`
  through NSH networking and the existing Rust update evaluator.
* Live maximum Dynamic Type (`accessibility-extra-extra-extra-large`) changed
  the same native host's intrinsic height from approximately 1948 to 5754 points
  and its About title from 21 to 73 points high. Restoring `large` returned both
  to baseline, with one host and the same native pointer throughout. English,
  system/light appearance and the original text size were restored. Screenshots,
  native layout JSON and final logs are in `build/nsh-about-verification/` on
  mini and in the local checkout. Automation servers were stopped afterward.
* Visual-parity follow-up: reused Inter and Lucide geometry and corrected
  corners, spacing, source-icon clipping, inline links and glass behavior.
  NSH checks and all six headless tests, three RN host tests, root TypeScript,
  targeted ESLint and script syntax checks passed. All four native interaction
  cases passed together; reference/scrolling passed again after the final
  inset-card padding and glass adjustment. `testAboutReference` passed with
  the flag disabled, with NSH enabled, and with a deliberately invalid test
  bundle. The invalid bundle invoked native error handling and recovered to
  RN without crashing; native inspection then found zero NSH host views.
  Compared RN and NSH on the same simulator using an existing Rancher asset
  as a temporary wallpaper, dark appearance and Glass Mode. Comparison images
  are `original-glass.png` and `revised-glass-final.png` under
  `build/nsh-about-verification/`; this fixture is different from the user's
  Android wallpaper. Maximum Dynamic Type passed on the revised UI with a
  single native host, unchanged pointer and restored baseline.
  Restored the exact original cosmetic preference row, removed the temporary
  fixture image and reinstalled the valid NSH production bundle. Its final
  reference test passed with the experiment enabled.
* Android `:react-native-whip-ssh:compileReleaseKotlin` passed with the flag
  disabled and enabled. These focused source-set checks skipped the Rust build
  task. The first enabled full build compiled the combined archive and exported
  NSH from the library-module intermediate, but a subsequent size audit found
  that RN's app-level CMake build packaged a core-only copy instead. That APK
  was not a valid verification of NSH runtime packaging. The follow-up propagates
  the flag into app CMake, prevents transitive Rust-archive linkage, and checks
  the actual APK rather than only intermediate output. The checker rejected
  the earlier mispackaged APK as expected. The corrected enabled full build
  passed in 11m 35s, including `:app:verifyNshReleaseApk`: JNI initialization,
  engine create/destroy, the core constructor and production bytecode were
  present, with no second Rust owner among the packaged shared libraries.
  The disabled full build also passed (12m 51s); its `appmodules` library had
  no exported core constructor or NSH engine constructor.

The current production bundle contains the six original image assets with identical
bytes, nine extracted Lucide SVGs and three original Inter faces, all with portable
`asset:/` URLs. Android's custom Java/Kotlin runtime and both
platforms' combined arm64 Rust archives compiled.

| Platform | Verified result | Device status |
| --- | --- | --- |
| Android | Corrected arm64 Release APK built and passed final-APK validation for NSH initialization, engine/core exports, production bytecode and absence of a second Rust owner. Both native feature-flag values built successfully, with matching upload certificates and version 1.10.1 (235). The earlier core-only packaging result was invalid and has been corrected. | The phone disconnected after its certificate was compared successfully with the initial APK. `adb install -r` returned device not found, so the installed app was unchanged. The corrected APK has not been installed; interactive verification remains pending. |
| iOS device on mini | Combined archive and unsigned Release app built with system Xcode, iOS 16.4 target, and thin arm64; NSH host manager, `whip_nsh_initialize`, `nsh_app_create`, `nsh_app_load_bundle`, and production resources verified in the final app. | No signed physical-device installation was performed. |
| iOS simulator on mini | Combined simulator archive and arm64 Release app built; installed in place on Whip Input CI (iOS 26.5), launched without Metro. Native inspection confirmed `WhipNativeShellAboutView` hosting NSH's UIKit root. Final visual bundle includes all 18 assets. | Four interaction cases passed together: expansion/collapse and parent scrolling; native share; external website/return; real GitHub update evaluation; Licenses/back; live dark mode and French/English. Additional reference tests covered RN/NSH visual comparison, flag-off behavior and invalid-bundle recovery. Core protocol `17–22`, fonts and assets rendered. Maximum Dynamic Type resized the existing host and restored its baseline. |

The Android app build used the release command above with
`CARGO_BUILD_JOBS=1 --max-workers=2 --console=plain`. The iOS build used the
reused worktree, the existing bridge cache with `NSH_ABOUT_EXPERIMENT=1`,
`WHIP_DISTRIBUTION_CHANNEL=github`, `IPHONEOS_DEPLOYMENT_TARGET=16.4`, and
`scripts/build-ios-app.sh --unsigned`. Its output is
`build/ios-device/Build/Products/Release-iphoneos/HerdR.app` on mini.
The reused mini worktree retained its existing local changes and cached
dependencies (including RN 0.88.0, versus 0.88.1 in this checkout); its new NSH
lockfile was resolved against that worktree's core dependencies. This validates
native integration there, rather than a clean build of this exact checkout.

After reconnecting the Android phone, install the certificate-matched APK in
place, then inspect expansion/collapse, parent scrolling, share-sheet return,
Licenses/back navigation, live locale/theme/font scale and repeated view
mount/unmount. Do not uninstall. Android R8 production packaging and a signed
iOS device run remain additional checks; the local Android build intentionally
used the project's permitted `whip.skipR8` setting.

Upstream NSH does not yet expose the shared mobile runtime setter used here and
does not cancel outstanding network tasks on engine destruction at the pinned
revision. The small checked-in patch supplies both behaviors. Custom direct
Rust linking works on both platforms; using the stock Android AAR or prebuilt
iOS NSH framework would lose that custom module and is not a supported shortcut.

## App size

Measured on 2026-10-30 using this checkout's version 1.10.1 (235), GitHub
channel, arm64-v8a only, the same upload certificate, and `whip.skipR8=true`
for both builds. These are local signed APK sizes, not Play download estimates.
The disabled build preceded the CMake interface correction described above;
inspection confirmed its `appmodules` did not export the Rust core or NSH.
The corrected enabled build passed the final-APK ownership check.

| Packaged content | Native experiment off | Native experiment on | Increase |
| --- | ---: | ---: | ---: |
| Entire APK | 123.734 MiB | 218.943 MiB | **95.209 MiB (76.95%)** |
| `libreact-native-whip-ssh.so`, stripped | 30.507 MiB | 81.507 MiB | 51.000 MiB |
| DEX files, ZIP payload | 23.483 MiB | 65.900 MiB | 42.417 MiB |
| NSH bundle and assets, ZIP payload | 0 | 1.828 MiB | 1.828 MiB |

The remaining small difference comes from other files and ZIP/signing overhead.
NSH resources occupy 3.420 MiB before ZIP compression: the 18 image/icon/font
assets plus bytecode, JS, source map and configuration. Reusing source assets
currently stages additional packaged copies; it does not deduplicate them
against RN's existing assets.

Most of the DEX increase is packaging policy: the opt-in minimum SDK change
from 24 to 28 makes AGP store DEX uncompressed by default. Raw DEX changes only
from 65.650 to 65.900 MiB. See Google's
[DexPackagingOptions documentation](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/DexPackagingOptions).
This rule does not determine compression in APKs delivered from app bundles.
No release compression policy was changed for this comparison.

The native increase reflects this integration's whole-archive/export policy
and NSH's mobile feature set, including QuickJS, shader rendering and syntax
highlighting. It is not a minimum NSH footprint. RN/Hermes remains installed
throughout this milestone. Most of this additional runtime cost is paid once;
another NSH screen adds its UI/assets rather than another runtime or Rust core.
Turning only the frontend flag off keeps the linked runtime in the binary;
rebuilding with the native experiment disabled removes it.

Both measured APKs verified with `apksigner`, the same upload certificate,
arm64-v8a and their expected minimum SDKs. Evidence is saved locally in
`build/nsh-about-verification/android-size-report.json`. APK SHA-256:

* Off: `65944998f664fd5d42c57e13c299865bdf06f9910995a4f38ee87924faa69729`
* On: `66bc5a013dda1c15bcd7baf6e9001f178fe380211fdc031a9723ddfede2712fa`

To reproduce the comparison, retain each APK before building the other flag:

```sh
for nsh_about_experiment in 0 1; do
  nix develop -c env NSH_ABOUT_EXPERIMENT="$nsh_about_experiment" \
    WHIP_DISTRIBUTION_CHANNEL=github CARGO_BUILD_JOBS=1 \
    android/gradlew -p android :app:assembleRelease \
    -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true \
    --max-workers=2 --console=plain
  cp android/app/build/outputs/apk/release/app-release.apk \
    "build/nsh-about-$nsh_about_experiment.apk"
done
wc -c build/nsh-about-{0,1}.apk
unzip -lv build/nsh-about-1.apk
```

A production R8/App Bundle size comparison and a controlled iOS off/on
comparison remain unmeasured. The simulator app's uncompressed size cannot
establish the iOS App Store download increase.

## Files

Added:

* `packages/whip-nsh/`: Rust integration and lockfile, NSH entry/UI, environment
  adapter, capabilities/configuration, engine patch, notices configuration,
  Android keep rules, and native/headless tests.
* `src/components/NativeShellAbout.tsx`, `src/lib/aboutLinks.ts` and
  `__tests__/nativeShellAbout.test.tsx`.
* Android `src/nsh/` host and `src/noNsh/` fallback provider in the existing
  `react-native-whip-ssh` package; iOS `WhipNativeShellAbout.mm` in that package.
* `scripts/prepare-nsh-source.sh`, `prepare-nsh-about.sh`,
  `prepare-nsh-about-if-enabled.sh`, `nsh-about.sh` and
  `generate-nsh-notices.sh`, and `prepare-nsh-icons.cjs`; `test-ios-nsh-about.rb` drives the installed
  experimental app using the NSH package's iOS UI tests.
* `scripts/verify-android-nsh.sh` validates exports in the final packaged APK
  and checks that other shared libraries do not contain NSH or the Rust core.
* `assets/brand/herdr.svg`, `assets/licenses/nsh-dependencies.txt`, and this doc.

Modified:

* More's About slot, About's shared URL imports, `githubReleases`, licenses
  registry, Expo feature extra, package scripts, RN TypeScript/lint/build-output
  exclusions, `.gitignore`, and Nix's libclang setup.
* The existing core's plain Rust runtime-handle accessor; Android Gradle/CMake,
  Rust build script and package view-manager registration; iOS podspec/Podfile,
  bridge cache/build script, UBRN preservation rules and cache tests.

Generated NSH source checkouts, CLI outputs, native resources, bindings and
mobile archives are excluded from the change. Preparation recreates the NSH
outputs; existing binding generation recreates its original RN bindings.

The next migration should first add the native `Arc<AppCore>` handoff and its
lifetime tests, then move a small read-only Settings detail. A stateful Herd or
Hosts migration must follow that shared ownership work.

## Staging this milestone

These commands stage the migration and visual follow-up, excluding the unrelated
notification, database-test and launch-video edits already in the worktree:

```sh
git add .eslintignore .gitignore __tests__/{nativeShellAbout.test.tsx,iosBuildCache.test.js} \
  android/build.gradle android/app/build.gradle app.config.js flake.nix ios/Podfile package.json tsconfig.json \
  assets/brand/herdr.svg assets/licenses/nsh-dependencies.txt docs/native-shell-about.md \
  packages/whip-nsh packages/react-native-whip-ssh/{WhipSsh.podspec,ubrn.config.yaml} \
  packages/react-native-whip-ssh/android/{CMakeLists.txt,build.gradle,src/nsh,src/noNsh,src/main/java/com/whipssh/WhipSshPackage.kt} \
  packages/react-native-whip-ssh/ios/WhipNativeShellAbout.mm \
  packages/react-native-whip-ssh/rust/{build-android.sh,src/lib.rs} \
  scripts/{build-ios-uniffi.sh,ios-build-cache.cjs,project-build-directories.cjs,generate-nsh-notices.sh,nsh-about.sh,prepare-nsh-source.sh,prepare-nsh-about.sh,prepare-nsh-about-if-enabled.sh,prepare-nsh-icons.cjs,test-ios-nsh-about.rb,verify-android-nsh.sh} \
  src/components/{AboutScreen.tsx,MoreScreen.tsx,NativeShellAbout.tsx} \
  src/lib/aboutLinks.ts src/licenses/index.ts src/services/githubReleases.ts
git cm "feat: embed Native Shell About with direct Rust access"
```
