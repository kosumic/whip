# iOS session edge swipe (#489)

`EdgeBackGesture` provides iOS edge-back navigation through
`WhipSessionNavigationView`. `SessionExitGesture` remains a terminal-specific
adapter for the retained `SessionScreen`. The existing back buttons and their
actions are preserved. Android uses React Native views and retains its existing
system Back handlers.

| Screen | Edge-back action |
| --- | --- |
| Terminal/chat | Existing `onExit`, returning to the terminal's Herd destination |
| Browser | Dismiss an open panel first; otherwise use native WebKit history, or hide the browser at the first page without closing tabs |
| Terminal's older link browser | Page history, then the link list, then dismiss the list |
| Files | Close context/sort controls first; otherwise confirm discarding dirty edits before returning to the directory, then close the file manager |
| New host | Scanner → setup → choices → cancel; disabled during preparation/pairing |
| Host editor | Existing cancel action; disabled during connection/key work and nested sheets |
| Keychain, Known Hosts, Licenses | Existing close action, respecting nested confirmations and busy state |
| Downloads | Close Downloads while transfers continue |

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
completion. Cancellation never navigates. Completion dispatches once and locks
until JavaScript acknowledges the action with a new revision. This lets a second
swipe return from another step without remounting content. The terminal adapter
keeps its original lock until the retained session is disabled and shown again.

Browser gestures check `WKWebView.canGoBack` natively at touch admission and
yield to WebKit's own recognizers when history exists. Browser panels take
priority over page history. The JavaScript back handler also checks current
history to cover navigation changes between touch admission and dispatch.

Visibility, app activity, app overlays, and session sheets gate the recognizer.
Native visibility and presented-controller checks also protect modals opened by
nested terminal controls. Connection and keyboard state do not disable it.
The gesture owns no connection, tab, draft, or transcript state.

## Validation

Run the React checks in the project development shell:

```sh
nix develop -c npx tsc --noEmit
nix develop -c npx eslint src/components/{EdgeBackGesture,SessionExitGesture,SessionScreen}.tsx src/browser/{BrowserSurface,BrowserDownloadsScreen}.tsx --max-warnings 0
nix develop -c npx jest --runInBand \
  __tests__/edgeBackGesture.test.tsx __tests__/sessionChatOpen.test.tsx \
  __tests__/browserSurface.test.tsx __tests__/browserDownloadsScreen.test.tsx \
  __tests__/remoteFileManagerLoading.test.tsx __tests__/newHostPairing.test.tsx \
  __tests__/publicKeyScreens.test.tsx
```

The seven React suites pass 431 tests. Added checks cover retained surfaces,
browser panels/history/return, dirty-file discard/cancellation, host setup steps,
connection guards, Downloads, the terminal rail callback, offline availability,
keyboard visibility, activity, and overlay gates. The existing terminal
host/workspace destination checks also passed during the initial implementation.

On mini, in the persistent `/Users/kosumi/repos/whip-ios-device` worktree:

```sh
nix develop -c ruby scripts/test-ios-session-navigation.rb
```

The standalone UIKit/WebKit host compiles the production gesture controller for
arm64 and runs twelve tests on the iPhone 17 Pro simulator with iOS 26.5. Its window uses
the scene lifecycle, matching the app. It checks completion,
short/leftward/vertical/interior drags, reversal, cancellation, once-only dispatch,
disable/reenable, hidden views, a presented sheet, keyboard/draft retention,
WebView/button touch cancellation, ordinary taps, stationary edge text selection,
and vertical WebView scrolling, along with navigation inside presented screens,
browser history arbitration and consecutive back actions without remounting.
The host does not exercise a live SSH session or the complete Whip application.

The standalone host's WebKit history swipe did not complete on this runtime,
including a control run with the app recognizer disabled. The browser test
therefore verifies that the app gesture yields without exiting while native
history exists, then uses `WKWebView.goBack()` before verifying the first-page
exit. The interactive WebKit history transition itself remains a full-app check.

The iOS production JavaScript bundle and Expo's Apple module discovery also
validate successfully. Compiling the Expo pod with the complete app dependencies
was blocked by mini's inability to download the existing RevenueCat
`PurchasesHybridCommon` dependency from GitHub. Physical-iPhone tuning and
full-app checks for terminal selection, chat selection, horizontal rails, and
live-session viewport/draft return remain pending. The user explicitly chose
simulator validation for now; these device acceptance checks have not been
marked complete.
