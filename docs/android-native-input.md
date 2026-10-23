# Android terminal input

Android uses the nonvisual `WhipTerminalInputView` from the standalone
[`expo-whip-terminal-input`](../packages/expo-whip-terminal-input/README.md)
React Native package, registered through Expo Modules.
The WebView still renders xterm, handles terminal selection, and encodes clipboard
paste. Its hidden textarea is read-only and its keyboard/composition events are
blocked on Android. iOS uses the companion [UIKit input bridge](ios-native-input.md).

`TerminalInputConnection` uses Android's editable/spans for the current IME
word and active preedit. Each mutation emits terminal edits immediately, including
before `endBatchEdit`, `commitText`, or `finishComposingText`. `/` opens an
interactive command menu immediately; subsequent composing characters update it.
Batch edits defer only IME selection notifications.

Gboard may commit every individual letter, then replace the current word when a
suggestion is tapped. Commit/finish therefore retain that correction word and
its trailing separator; starting another word discards earlier committed words.
Newlines discard the prior prompt's context. It never contains remote output or
recalled history. Absolute IME offsets advance as prefixes are discarded, and
surrounding/extracted text reports the same offsets. Replacements can edit only
the retained word/preedit; surrounding deletion outside it sends explicit
Backspace/Delete keys. UTF-16 selection positions map to code-point terminal edits,
and deletion cannot split a surrogate pair. The IME context is limited to 1024 UTF-16
units; exceeding the limit keeps the already emitted input and restarts the IME.
This cannot infer a remote program's grapheme, cursor, or editing rules.

Rail actions, paste, and composer submissions cross a native UI-thread barrier.
The view retires the old connection and restarts Android input before emitting
an uncoalesced barrier event. The renderer host then enqueues the action in the
same `TerminalArbitration` queue used for native typing. Delayed calls on the old
connection return false. Virtual modifier changes also restart input; modified
text finishes its transaction immediately so Ctrl-C cannot leave a stale preedit.
Focus loss, backgrounding, session/client changes, disconnects, renderer reloads,
and view disposal invalidate input context. Binding identifiers reject events
from an old terminal; pending commands are rejected when that binding closes.
Explicit blur hides the native view's own keyboard. Refocus/window-focus return
restarts retired connections; a composer that already took focus keeps its IME.

Native events go directly to React Native and the existing `onInput` callback,
modifier/Kitty encoding, session routing, and terminal transport. Composition
edit keys are passed individually through the encoder inside one ordered queue
operation. Native input does not use the output WebView bridge or change Herdr's
protocol. Hardware keys and IME `sendKeyEvent` share an encoder, including
application-cursor mode and hardware control modifiers in Kitty report-all mode.
For plain SSH paste and submissions, the host reserves a queue position while
xterm encodes bracketed paste. Later native typing waits in that queue; the
WebView round trip is needed only for paste encoding.

The editor advertises normal multiline text with autocorrection, allowing the
keyboard's suggestions, gesture typing and dictation. Fullscreen extract editing
and autofill are disabled. Extracted-text queries and monitored updates expose
only the current correction word/preedit, including dictation revisions. Android 14 and newer use
an API-specific connection wrapper so suggestion `replaceText` operations also
emit terminal edits immediately. Replacement ranges must belong to the active
word/preedit; stale ranges cannot modify earlier terminal text. IME reconversion
outside the retained word is unavailable. Nothing logs typed
text or stores preedit across focus/session changes.

Android initializes xterm's cursor without focusing its textarea. Native input
focus drives the DOM renderer's visual cursor focus/blink state; xterm retains
control of cursor position, shape and application-requested visibility. Keyboard
input continues to go exclusively through the native view.

Run the tests in the development environment:

```sh
nix develop -c env WHIP_DISTRIBUTION_CHANNEL=github android/gradlew -p android \
  :expo-whip-terminal-input:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a
nix develop -c npm test -- --runInBand \
  __tests__/androidImeBridge.test.ts __tests__/terminalRendererHost.test.tsx \
  __tests__/terminalRenderer.test.ts __tests__/terminalComposerKeyboard.test.tsx \
  __tests__/terminalClipboardPaste.test.ts __tests__/terminalTouchBehavior.test.ts
```

The Android CI job runs the native tests. Robolectric tests exercise actual
Android editable/selection/composing behavior; Jest covers native event routing,
write ordering with a blocked transport, stale bindings, paste, focus ownership,
and iOS behavior.

Device acceptance checks (Gboard and Samsung Keyboard): type `/resume` in Codex,
navigate with arrows, complete shell text with Tab, recall history, and interrupt
mid-word with Ctrl-C. After each action, type a fresh word, replace its active
composition, and backspace. Also exercise CJK composition, emoji, Delete,
multiline clipboard paste, switching panes during composition, and transferring
focus to/from the composer. These checks require the rebuilt native app.

Verified on a Pixel 9 Pro (Android API 37, Gboard) using actual keyboard taps:
suggestion replacement after individual letter commits, a second corrected word,
live terminal replacement before Enter, and keyboard off/on recovery. In Codex,
`/` opened the menu immediately and each subsequent character through `/resume`
filtered it before Enter. Selecting a Gboard suggestion also changed Codex's
live prompt. Samsung Keyboard and spoken dictation were not exercised in this run.
