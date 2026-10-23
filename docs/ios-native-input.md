# iOS terminal input

The standalone [`expo-whip-terminal-input`](../packages/expo-whip-terminal-input/README.md)
React Native package registers its views through Expo Modules.
`WhipTerminalInputView` owns a nonvisual UIKit `UITextView` editor. UIKit provides
selection, marked ranges, QuickType and dictation support. xterm still renders
the terminal and its blinking cursor; its hidden textarea cannot receive mobile
keyboard input. The chat composer is separate.

Every native edit, including marked text, immediately emits its difference to
React Native. Typing `/resume` therefore reaches the terminal character by
character without Enter or composition finalization. Autocorrection replaces
already delivered characters with terminal cursor/deletion sequences. UTF-16
surrogate pairs remain intact.

The editor keeps only the current correction word and trailing separator, or an
active marked phrase. Earlier words are discarded with UIKit input-delegate
notifications. The 1024-unit bound retires the editor after sending the edit.
Remote output and shell history never populate this context.

The shared `NativeTerminalInput` component sends events through the existing
session binding, input arbitration and transport queue. Key-rail actions, paste
and composer submissions cross the same native UI-thread barrier as Android.
Pane changes, focus loss, backgrounding and external input retire the UIKit
editor, rejecting delayed callbacks from the previous editor. A new editor can
regain keyboard focus without taking focus from the chat composer.

Expo view-ref methods execute native commands on the UI thread without React
tags or Fabric wrapper lookup. Both edits and barrier acknowledgments use the
same ordered event stream. Command failures reject pending application barriers.
The UIKit container passes touch hit testing through to the terminal while
keeping interaction enabled, which its editor needs to become first responder.

Hardware arrows, Tab, Backspace, Delete, Escape and Ctrl-letter input bypass
UIKit editing and retain terminal application-cursor and Kitty protocol modes.
Normal printable hardware input remains with UIKit for composition/dead keys.

On macOS, use the existing development checkout and an arm64 iPhone simulator:

```sh
WHIP_IOS_TEST_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro' \
  nix develop -c ruby scripts/test-ios-browser.rb \
  -only-testing:BrowserTests/WhipTerminalInputTests \
  -only-testing:TerminalInputUITests
```

Native tests exercise the production UIKit editor. UI tests tap actual keyboard
keys and QuickType suggestions, inspect emitted bytes before Enter, and toggle
the keyboard off/on. JavaScript tests cover shared routing, focus, barriers,
paste ordering and duplicate WebView input suppression. Spoken dictation needs
a separate device check; simulator visibility of the Dictate button does not
verify speech recognition.

Verified on `mini` with the iPhone 17 Pro simulator (iOS 26.5): all 37 native,
WebKit, clipboard and keyboard UI tests passed. Actual keyboard taps delivered
`/resume` one character at a time; QuickType corrected consecutive words before
Enter, and keyboard off/on recovered. The full arm64 release app also built and
installed in place. An additional full-app check connected to an isolated remote
terminal: each `teh` letter arrived separately, and tapping QuickType's `the`
sent two deletes followed by `he ` immediately. A key-rail Tab crossed the Expo
UI-thread barrier, followed by fresh typing in order. In the real Codex TUI, `/`
opened the command menu and `/resume` filtered it without Enter. All 2,883
JavaScript tests, TypeScript and targeted ESLint checks passed. Late command
errors from a retired view cannot reject another pane's pending input.
