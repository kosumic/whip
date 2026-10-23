# expo-whip-terminal-input

A standalone React Native package for native terminal keyboard input on Android
and iOS, implemented with Expo Modules. Tested with Expo SDK 57. This package
requires Expo Modules Core; a bare React Native app must install Expo modules.
Whip consumes it as a local package. It is not published to npm.

Android uses a custom `InputConnection`; iOS uses UIKit's `UITextView` and
`UITextInput` behavior for composition, QuickType and dictation. Every edit is
forwarded immediately, including preedit updates. Typing `/resume` reaches the
terminal without waiting for Enter or composition finalization.

The component is a nonvisual keyboard owner. Your terminal renderer remains
responsible for output, cursor drawing, selection and paste encoding. Disable
its own hidden input element to prevent duplicate keyboard input.

```tsx
import { useRef } from 'react';
import {
  NativeTerminalInput,
  type NativeTerminalInputHandle,
} from 'expo-whip-terminal-input';

const input = useRef<NativeTerminalInputHandle>(null);

<NativeTerminalInput
  ref={input}
  binding="session-id:editor-generation"
  onTerminalInput={({ nativeEvent }) => {
    if (nativeEvent.data) enqueueTerminalInput(nativeEvent.data);
    if (nativeEvent.commandId !== undefined) acknowledgeBarrier(nativeEvent.commandId);
  }}
  onCommandError={reportInputError}
/>;

// After mounting, enable and focus when terminal keyboard input is requested.
input.current?.setEnabled(true);
input.current?.focus();
```

The package has no SSH, Rust, WebView or Herdr dependency. Its event payload is
`{ binding, data? , commandId? }`; events are never coalesced. A new binding
retires the previous editor and rejects its late IME callbacks. The app must
also reject events whose binding differs from its active session generation.

`NativeTerminalInputHandle` exposes `setEnabled`, `focus`, `blur`, `reset`,
`barrier(binding, commandId)`, `cursorKeys(application)`, `modifiedInput(active)`
and `kittyKeyboard(reportAll)`. Commands execute on the native UI thread.
Calling `barrier` retires correction context before emitting its acknowledgment
in the input event stream. Wait for that event before queuing external keys or
pastes; returning from a method is not a transport barrier. Command
failures are delivered to `onCommandError`; the app should reject pending
barriers and report the error. Without a handler the error is logged.

Only the bounded current correction word/preedit is retained. Never populate
this editor from terminal output or remote shell history. External navigation,
paste and session changes must retire context with a barrier or reset.

Expo autolinking registers the package on both platforms using
`expo-module.config.json`. Rebuild the native app after installation. There is
no manual React Native view-manager registration or platform config plugin.

In the Whip checkout, run the package's Android tests and native iOS keyboard
tests (the latter requires macOS and an arm64 iPhone simulator):

```sh
nix develop -c android/gradlew -p android \
  :expo-whip-terminal-input:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a
nix develop -c ruby scripts/test-ios-browser.rb \
  -only-testing:BrowserTests/WhipTerminalInputTests \
  -only-testing:TerminalInputUITests
```

The package's Android tests cover the real input connection and lifecycle;
`tests/ios` covers UIKit operations and actual QuickType/keyboard taps.
Whip's JavaScript tests cover the exported component, native command failures,
session routing and input ordering. Native dictation support still requires
spoken-input verification on a physical device.

Whip integration validation passed 37 Android tests, 37 iOS regression tests,
2,883 JavaScript tests, TypeScript and lint. Arm64 Android release and iOS
simulator builds passed. In the full simulator app, actual keyboard taps
corrected terminal text through QuickType, sent key-rail Tab before fresh typing,
and opened/filtered Codex's `/resume` menu before Enter.
