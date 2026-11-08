# Spinner lifecycle

Screen, row, and reduced-motion preferences determine whether animation is
enabled. App lifecycle suspension is handled separately by native schedulers.
Do not fold `AppState` into `AgentStatusAnimationProvider`: a background `false`
prop otherwise remains in place until foreground JS and React rendering catch
up, even after the native UI is visible.

- Android's dotted spinner registers a React native host lifecycle listener only
  while attached. Host pause, hidden ancestors, invisible windows, detachment,
  and explicit disable remove its Choreographer callback. Resume keeps its
  rotation and posts one callback, without changing the JS `enabled` prop.
- iOS's dotted spinner observes native active/inactive notifications. It removes
  its Core Animation rotation while inactive, hidden, detached, or disabled,
  saves its phase, and restores one keyed animation on native activation.
- Reanimated's Android scheduler already handles host pause/resume. The
  `react-native-worklets+0.13.0.patch` adds corresponding iOS lifecycle handling:
  pending frame callbacks remain queued while its display link is paused and
  resume on native activation. New requests cannot wake an inactive display
  link, and invalidation removes its observers.
- `useDecorativeProgress` retains phase across screen/list visibility changes.
  It treats timestamp gaps over 250 ms as suspension and advances by one normal
  animation step on return. Shorter dropped-frame gaps still advance at the
  normal speed. This is a decorative continuity heuristic: a foreground stall
  longer than 250 ms also retains phase. Explicit disable, including reduced
  motion, still stops the callback and restores the static pose.

## Regression checks

```sh
nix develop -c npm test -- --runInBand \
  __tests__/useDecorativeProgress.test.tsx __tests__/animationVisibility.test.tsx
nix develop -c android/gradlew -p android \
  :whip-native-spinner:connectedDebugAndroidTest \
  -PreactNativeArchitectures=arm64-v8a
# On mini, in the persistent /Users/kosumi/repos/whip-ios-device worktree:
nix develop -c ruby scripts/test-ios-spinner.rb
```

The Android instrumentation APK is a separate test application. It exercises
real task switches and rendered bitmap changes without replacing Whip or
starting JavaScript. Its log tag is `WhipSpinnerTest`; elapsed foreground timings
include activity launch and three display frames, rather than measuring only
the native scheduling callback.

The iOS suite builds the production Swift spinner and patched Objective-C++
Worklets frame queue for an arm64 simulator. Expo/RN wrappers are stubbed; UIKit,
Core Animation, and the display link are real. It checks lifecycle suspension,
phase retention, hidden/disabled views, repeated activation, queue draining,
and invalidation. `WHIP_SPINNER_TEST_SOURCE` and `WHIP_FRAME_QUEUE_TEST_SOURCE`
can select preserved baseline sources for comparison.

Full-app visual timing under JS contention and physical iOS device switching
need separate validation; these harnesses do not measure React mounting,
navigation, or the complete native bridge.

## Validation on 2026-11-08

- Both JS suites passed: 13 tests. Targeted ESLint and TypeScript checking passed.
- iOS arm64 simulator: all four native tests passed. The original sources failed
  three tests with four assertions covering suspension, hidden views, and phase.
  The fixed native resume callback scheduled its animation in 0.022 ms in the
  final run; this measures scheduling, not end-to-end visual latency.
- Android arm64 production and instrumentation sources compiled. Initial native
  rotation was observed on the Pixel 9 Pro. The app-switch run was inconclusive:
  the device was actively switched to another app through touch input. A final
  run timed out waiting for test-window focus. Physical Android resume timing
  and the full iOS app remain unverified.
