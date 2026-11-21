# iOS session edge swipe (#489)

The retained `SessionScreen` wraps its existing content in the iOS-only
`WhipSessionNavigationView`. Android renders the same React Native `View` as
before. The existing rail back button and `onExit` destination are unchanged.

The native pan recognizer accepts one-finger touches within 24 points of the
window's left edge, originating inside this session's content. It attaches to
the window because Fabric's touch recognizer yields to recognizers outside its
root, allowing a recognized swipe to cancel React touches as well as UIKit and
WebKit interactions. Child pan recognizers wait for the edge recognizer to fail;
stationary long presses can still select text at the edge, and touches outside
the edge are rejected immediately.

Completion requires rightward travel exceeding vertical travel by 1.5 times,
and either 96 points of distance or 48 points with at least 700 points/second
rightward velocity. A backward finish or reversal exceeding 12 points rejects
completion. Cancellation never exits. Completion calls `onExit` once and locks
until the retained session is disabled and shown again.

Visibility, app activity, app overlays, and session sheets gate the recognizer.
Native visibility and presented-controller checks also protect modals opened by
nested terminal controls. Connection and keyboard state do not disable it.
The gesture owns no connection, tab, draft, or transcript state.

## Validation

Run the React checks in the project development shell:

```sh
nix develop -c npx tsc --noEmit
nix develop -c npx eslint src/components/SessionExitGesture.tsx src/components/SessionScreen.tsx __tests__/sessionChatOpen.test.tsx --max-warnings 0
nix develop -c npx jest __tests__/sessionChatOpen.test.tsx __tests__/sessionTerminalLifecycle.test.tsx --runInBand
```

The two React suites pass 225 tests, including the existing host/workspace exit
destination tests. Added checks cover retained terminal/chat surfaces, the rail
callback, offline availability, keyboard visibility, activity, and overlay gates.

On mini, in the persistent `/Users/kosumi/repos/whip-ios-device` worktree:

```sh
nix develop -c ruby scripts/test-ios-session-navigation.rb
```

The standalone UIKit/WebKit host compiles the production gesture controller for
arm64 and runs nine tests on the iPhone 17 Pro simulator with iOS 26.5. It checks completion,
short/leftward/vertical/interior drags, reversal, cancellation, once-only dispatch,
disable/reenable, hidden views, a presented sheet, keyboard/draft retention,
WebView/button touch cancellation, ordinary taps, stationary edge text selection,
and vertical WebView scrolling.
The host does not exercise a live SSH session or the complete Whip application.

The iOS production JavaScript bundle and Expo's Apple module discovery also
validate successfully. Compiling the Expo pod with the complete app dependencies
was blocked by mini's inability to download the existing RevenueCat
`PurchasesHybridCommon` dependency from GitHub. Physical-iPhone tuning and
full-app checks for terminal selection, chat selection, horizontal rails, and
live-session viewport/draft return remain pending. The user explicitly chose
simulator validation for now; these device acceptance checks have not been
marked complete.
