# Terminal keyboard geometry

Whip uses one application-root `KeyboardProvider`. Expo SDK 57 selects
`react-native-keyboard-controller` 1.21.9, alongside React Native 0.86.3 and
Reanimated 4.5.1. Keyboard preloading is disabled to preserve startup focus and
avoid a keyboard flash while loading fonts.

## Geometry and rendering

`useKeyboardInset` is the terminal's keyboard adapter. Controller
`useKeyboardState` selectors provide bottom-obstruction visibility and destination
height for React consumers, including chat end spacing. `useKeyboardHandler`
provides animation and interactive-dismissal frames to shared values. Keyboard
frames never cause per-frame React state updates.

The adapter measures the untransformed terminal viewport synchronously on the UI
thread with Reanimated. Layout changes refresh its cached bounds; animation
frames also use the current native viewport. Overlap is the controller's window
bottom obstruction minus the viewport's distance from the window bottom, clamped
to the viewport height. A layout snapshot updates the React bounds together.
There are no React Native keyboard listeners, delayed keyboard measurements, or
measurement revision counters in this path. A mounted adapter seeds its animation
value from the controller cache when the keyboard is already open.

Terminal canvas translation, the floating composer, expanded composer padding,
and controls use animated styles. The controls retain their measured height;
their existing safe-area padding moves beneath the keyboard, so navigation-area
space is counted once. Expanded composer padding uses window obstruction rather
than the terminal viewport's potentially smaller overlap. The PTY's geometry
bottom inset stays zero. Moving the canvas to reveal the cursor does not fit or
resize xterm.

Backgrounding suppresses presentation; foregrounding reads the controller cache
and refreshes viewport bounds. Hook subscriptions, native handler registrations,
and chrome timers are removed on unmount. Reconnect status changes do not dismiss
the keyboard or clear the input request. Direct input requests transfer between
tabs; composer focus requests and delayed callbacks remain scoped to their draft
context. Hiding a terminal screen still releases its input focus.

## Session chrome

Chrome hides immediately for a bottom-obstructing keyboard. Its return is delayed
120 ms to bridge terminal/composer focus handoffs. This delay affects only chrome,
never keyboard geometry or cursor avoidance. A new show cancels pending
restoration.

The tab and pane rows keep their layout and children while hidden. Opacity,
pointer events, and accessibility hide them together. The surrounding absolute
container uses `box-none`, so its retained layout cannot intercept terminal
input. The new-tab button stays mounted and becomes disabled without a client.
Pane close controls and the adjacent browser control also retain their slots
during temporary disconnection.

## Android integration

The manifest already specifies `adjustResize`, and the project already enables
edge-to-edge layout. `KeyboardProvider` explicitly retains edge-to-edge behavior
and translucent system bars. This combination allows WindowInsets animation
tracking while leaving the Activity viewport full-size. No Whip module switches
the Activity to `adjustNothing` anymore: `HerdrSoftInputModule`, its registration,
and the TypeScript overlay service/callers were removed.

Keyboard Controller 1.21.9 also owns React Native Dialog tracking through its
`ModalAttachedWatcher`; it temporarily manages modal input modes itself. The
existing form avoidance views now use the controller's `KeyboardAvoidingView` on
both platforms. Browser and connection forms no longer add a second Android
keyboard padding path. Settings, keychain, and downloads use its aware scroll
view; remote-file editing also gets explicit avoidance. The connection form's
focused-field scrolling measures its already-avoided scroll viewport rather than
reading a second keyboard frame.

The library handles keyboard height relative to its translucent navigation-bar
configuration. Whip consumes this window obstruction directly and subtracts only
the actual viewport gap and the controls' existing safe-area padding. It does not
add navigation insets to the keyboard height.

## iOS fallback and limits

Version 1.21.9 exposes height, not a floating keyboard rectangle. Its original iOS
observer reports raw notification height even for floating keyboards. The focused
`patch-package` patch updates that same observer, rather than adding another
observer or React Native listener:

- Convert UIKit's real end frame from screen coordinates into the active window.
- Report only the bottom intersection of a full-width, bottom-attached frame.
- Report zero bottom obstruction for floating, undocked, offscreen, or absent
  keyboards, including narrow floating keyboards that touch the bottom.
- Track `keyboardWillChangeFrame` through the existing observer for resizing and
  undocking, and suppress invalid floating-keyboard watcher/KVO heights.
- Retain docked keyboard animation and interactive dismissal.

The native helper has executable Swift geometry cases. The patch must be reviewed
when upgrading the library. Controller hooks remain the application-facing APIs.
Visibility in the terminal adapter means a *bottom-obstructing* keyboard; a
floating keyboard does not hide bottom chrome or reserve a false bottom inset.

Interior floating keyboards can still cover terminal content. The controller
API does not expose their rectangle to JavaScript, so Whip cannot perform
rectangle-specific cursor avoidance. It does not invent coordinates from height.
Stage Manager/multiple-window frame conversion, live iPad undocking, fold/unfold,
OEM keyboard animation sequences, and navigation modes still need device checks.

## Verification

Commands run in `nix develop`:

```sh
npx tsc --noEmit
npm run lint
npx jest --runInBand
WHIP_DISTRIBUTION_CHANNEL=github android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true
```

Results on the completed change:

- TypeScript: passed.
- ESLint: passed with zero warnings.
- Full Jest suite: 232 suites, 2,962 tests passed.
- Android release: passed; APK contains only `arm64-v8a` native libraries.
- Native iOS geometry: ten cases passed; UIKit conversion module compiled for arm64 iOS.
- Direct npm and bundled license notices: passed.
- Shell syntax and `git diff --check`: passed.

The APK is at `android/app/build/outputs/apk/release/app-release.apk`.

`whip.skipR8` is only for this local validation build. The standard upload signing
configuration remains in effect. No app was uninstalled or installed.

On mini, `scripts/test-ios-keyboard-geometry.sh` was run from an isolated build
folder beneath the persistent iOS checkout. It runs ten native geometry cases
with Xcode's macOS SDK and compiles the patched UIKit frame-conversion sources
for arm64 iOS. The script explicitly selects Xcode SDKs because Nix's SDKROOT can
refer to an incompatible older SDK. The existing checkout, Pods, and signing
state were preserved. A complete iOS application build was not performed because
the persistent checkout contains unrelated source changes; these isolated checks
do not validate full-app native linking.

No device behavior is claimed as verified. Before release, test:

1. Android 15/16: gesture and button navigation; portrait/landscape; Gboard and
   Samsung Keyboard. Open/dismiss repeatedly and rapidly transfer composer focus.
2. Fold/unfold with an open keyboard and switch SSH sessions/Herdr tabs; confirm
   one chrome transition, stable selected tabs, and unchanged PTY dimensions.
3. Reconnect/disconnect with direct input and with a saved composer draft; confirm
   no status-triggered dismissal, no shifted controls, and working reconnected
   input (including Codex/Claude interactive commands).
4. iPhone and iPad: docked, floating, undocked, hardware keyboards; rotate and
   interactively dismiss. Verify safe areas, cursor translation, and scrollback.
5. Background/resume, mount with the IME open, expand/collapse the composer, and
   switch drafts. Verify chat scrolling, browser forms, regular inputs, and modal
   forms as well as native terminal forwarding.

## Changed files

- Root/dependency setup: `App.tsx`, `package.json`, `package-lock.json`.
- Terminal tracking: `src/hooks/useKeyboardInset.ts`,
  `src/hooks/useSessionChromeVisibility.ts`, `src/lib/keyboardGeometry.ts`,
  `src/lib/floatingChrome.ts`, `src/lib/terminalRenderer.ts`.
- Terminal/session UI: `src/components/TerminalScreen.tsx`,
  `src/components/SessionScreen.tsx`, `src/browser/OpenBrowserButton.tsx`.
- Form compatibility: `ConnectionScreen.tsx`, `HerdScreen.tsx`, `PaneDetail.tsx`,
  `ResourceEditorSheet.tsx`, `RemoteFileContextSheet.tsx`, `RemoteFileManager.tsx`,
  `GlobalKeychainScreen.tsx`, `MoreScreen.tsx` under `src/components`, plus
  `src/browser/BrowserSurface.tsx` and `src/browser/BrowserDownloadsScreen.tsx`.
- Removed mode switching: `src/services/terminalSoftInput.ts`,
  `android/app/src/main/java/io/github/kaminarios/whip/HerdrSoftInputModule.kt`;
  updated `HerdrBackgroundPackage.kt` in the same directory.
- iOS fallback: `patches/react-native-keyboard-controller+1.21.9.patch`.
- Tests: `jest.config.js`, `jest.setup.js`, `test-support/keyboardAnimation.ts`,
  `__tests__/keyboardInset.test.tsx`, `terminalComposerKeyboard.test.tsx`,
  `terminalKeyboardAnimation.test.ts`, `sessionChatOpen.test.tsx`,
  `terminalRenderer.test.ts` in `__tests__`,
  `__tests__/native/keyboardBottomOcclusion/main.swift`,
  `scripts/test-ios-keyboard-geometry.sh`.
- Dependency attribution: `src/licenses/generated.ts`,
  `assets/licenses/generated/b0fd50df5e9be71b.txt`.
- This migration note: `docs/keyboard-controller-migration.md`.

References: [installation](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/installation),
[platform behavior](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/recipes/platform-differences),
[Jest mock](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/recipes/jest-testing-guide),
[issue #208](https://github.com/kosumic/whip/issues/208).
