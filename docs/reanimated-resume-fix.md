# Reanimated notification resume fix

Whip uses Reanimated 4.5.4, which includes upstream commit
[`610f2d5bc635bfda2c7114fe77a14a1c088f4744`](https://github.com/software-mansion/react-native-reanimated/commit/610f2d5bc635bfda2c7114fe77a14a1c088f4744)
from the 4.5 stable branch. See [upstream PR #9527](https://github.com/software-mansion/react-native-reanimated/pull/9527)
and [issue #9574](https://github.com/software-mansion/react-native-reanimated/issues/9574).

On Android, opening an agent notification after backgrounding Whip could leave
terminal controls and the composer in their keyboard-open positions and hide the
session tabs. Android reported the IME hidden and Reanimated shared heights were
already zero; stale settled animated props restored the old native view positions.
The upstream fix retains registry entries until they reach React and refreshes
settled props when a view animates again.

Expo 57 recommends 4.5.1, which contains this bug. The `expo.install.exclude`
entry in `package.json` deliberately keeps Reanimated at 4.5.4 when running Expo
dependency validation or automatic fixes. This patch release supports our React
Native 0.86 and Worklets 0.10 versions, and Whip builds its own native app.
There is no local Reanimated patch. See the upstream
[compatibility table](https://docs.swmansion.com/react-native-reanimated/docs/guides/compatibility/).
Remove the exclusion when upgrading to an Expo SDK that recommends a fixed
version. Rebuild the native app after upgrading; a Metro reload or JavaScript
update alone cannot fix the registry.

## Device regression procedure

Use an agent completion notification that opens a terminal:

1. Open the terminal composer and show the keyboard.
2. Switch to another app, with and without opening that app's keyboard.
3. Tap the agent notification to return to Whip.
4. Verify the keyboard is hidden, terminal controls and composer return to the
   bottom, and the session tabs are visible.
5. Open and dismiss the keyboard again, then open the terminal from Herd.

Also repeat with Whip's keyboard initially hidden and the other app's keyboard
visible. Tests for keyboard lifecycle state live in `keyboardInset.test.tsx` and
`terminalComposerKeyboard.test.tsx`; the native rendering regression requires a
device build.

Verified Reanimated 4.5.4 on a connected Pixel 9 Pro running Android 17 with an
upload-signed ARM64 GitHub-channel release build on 2026-10-24. Notification entry
passed with the keyboard initially open in Whip, in Settings, and in both before
switching. The repeatable notification fixture used the same agent response
extras and terminal navigation path. Herd entry and a normal composer keyboard
show/hide also returned the controls to their resting positions with session tabs
visible. App data was preserved during the in-place update.
