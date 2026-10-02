# Android chat touch investigation

## Captured failure, September 30, 2026

Pixel 9 Pro, Whip 1.7.6 (226), release process PID 9293. The process was
kept alive while capturing the failure. Evidence is saved locally under
`.codex-diagnostics/chat-freeze-20260930/` (ignored by Git).

The tracing build identified the immediate blocker:

- Transcript swipes and taps target native view **10192**, an empty full-screen
  `ReactViewGroup` with `alpha=0` and `pointerEvents=AUTO`. Its ancestor path
  goes through the shared viewport overlay, bypassing the transcript list.
- The native tree lists view 10192 nine times under parent 10196, after the
  actual transcript viewport. No `viewport-touch-start` or `viewport-drag-start`
  event accompanies those failed gestures.
- At phone time **20:45:22.987**, `SurfaceMountingManager` reports that view
  10192 cannot be inserted into parent 10196 because it still has parent 10194.
  The surrounding errors say subsequent removal of that view is skipped because
  it was erroneously readded. These errors identify the same tag that later
  intercepts input; they are not merely unrelated rendering warnings.
- After another chat became visible at 20:49:24.751, gestures at 20:49:26.687
  and 20:49:27.177 still hit the invisible view 10192. This explains why
  switching chats does not recover interaction.

This establishes stale native overlay interception as the cause of this captured
freeze. The exact sequence that first corrupts the mounting hierarchy remains
unknown. The retained wrapper and `AgentChatView` root both change whether they
form a native stacking boundary when visibility/readiness changes, making their
flattening/reparenting transitions the source-level mitigation target. React
Native 0.86.3's `ViewShadowNode.cpp` and `SurfaceMountingManager.kt` contain the
relevant boundary and erroneous-readdition logic. An upstream report describes
related Fabric reparenting failures, but is not proof of the same trigger:
https://github.com/react/react-native/issues/57800.

The prepared mitigation sets `collapsable={false}` on both layers, so visibility
changes preserve native parentage. The chat root also uses the same visibility
condition for opacity and pointer events, disabling input while inactive or
waiting for its initial/restored viewport. It retains the existing mounted list
and saved scroll position. Tracing now includes view instance identity, child
count, and the `agent-chat-root` / `agent-chat-layer` test IDs, allowing future
captures to identify these boundaries and distinguish repeated instances.

The five focused readiness and Terminal/Chat lifecycle cases pass, along with
TypeScript, lint, and the arm64 upload-signed release build (`whip.skipR8=true`
for local use). The APK was built but not installed, preserving the captured
process; touch tracing was disabled after capture. These checks validate the
visibility contract; they cannot reproduce or prove the absence of native
mounting corruption. The fix
has not yet been validated against a recurrence on the phone.

## Captured failure, September 29, 2026

Pixel 9 Pro, Android 17, Whip 1.7.4 (226), release process PID 911.
The user reported chat switching and composer toggling before the failure;
restarting the app had previously restored input.

Observed without restarting the process:

- Chat updates and automatic following continue; the composer and toolbar work.
- Transcript swipes, tool-row taps, and scrollbar dragging do not respond.
- Switching Terminal → Chat does not recover transcript interaction.
- A second existing chat also ignores transcript gestures.
- Android's input dispatcher reports the app's channel as responsive. No app
  crash or input-dispatch ANR was found in the captured logs.
- The native hierarchy contains both the active and retained inactive chat
  scroll views. Their presence alone does not prove that one intercepts input.

The precise trigger and blocking view are **not yet established**. These findings
narrow the problem to interaction handling shared by the chat viewports. Do not
treat a successful restart or reinstall as a verified fix.

Local evidence is in `.codex-diagnostics/chat-freeze-20260929/` (ignored by Git):
screenshots, logcat, input-dispatch state, and native activity hierarchies.
The phone timestamps use its own timezone. `dump-visible-window-views` failed to
encode Whip because Android invoked WebView encoding from a binder thread;
the resulting empty ZIP entry is a diagnostic-tool limitation.

## Source analysis

The relevant composer open/close and retained-chat visibility code also exists
in the `v1.7.4` tag. The current checkout has other changes since that release;
the tests below exercise the current checkout, not the running release binary.

### Confirmed composer races

`TerminalScreen.tsx` resets composer state when the target changes, but does not
invalidate pending `openCompose` or `closeCompose` operations:

- Delay `setTerminalKeyboardOverlay`, open the composer for target A, switch to
  B, then resolve A's request. Its unconditional `finally` opens the composer
  on B and overwrites the saved keyboard preference.
- Open the composer on A with the keyboard visible, request close, switch to B,
  and open B's composer before `keyboardDidHide`. When that event arrives, A's
  pending close dismisses B's composer and restores the shared keyboard state.
  The one-second fallback in `closeComposerKeyboard` can also finish the close.

Both sequences reproduced deterministically in two temporary Jest behavioral
tests using the existing terminal composer harness. The tests deliberately
assert the faulty outcome; they are investigation evidence, not regression
tests establishing correct behavior. Their source and output are saved as
`terminalComposerRace.diagnostic.test.tsx` and `composer-races.log` in the local
evidence directory. To rerun, copy the test into `__tests__/` and use Jest's
`--runTestsByPath` with `--testNamePattern='diagnostic race:'`, then remove that
temporary copy.

These races explain incorrect composer/keyboard transitions. They **do not yet
demonstrate the persistent transcript touch failure**. A fix should invalidate
pending operations on target/visibility changes and subsequent composer intents,
and check ownership after each await before changing UI or keyboard state.

### Touch-routing hypotheses

The strongest area to inspect is the shared overlay in `TerminalScreen.tsx`
and its retained chat children in `SessionScreen.tsx`: multiple chats fail,
while controls outside this overlay still work.

Each retained chat switches between opacity 0 / pointer-events `none` and
opacity 1 / pointer-events `auto`. It does not set `collapsable={false}`. The
installed React Native `ViewShadowNode.cpp` makes the hidden wrapper a native
stacking boundary, while the shown wrapper can be flattened. This changes native
parentage during switching. It is a plausible lifecycle stress point, not proof
of a React Native defect or a stale pointer-events value. The shared overlay's
`z-20` already gives that outer view a stacking boundary.

The terminal WebView underneath remains touch-enabled in chat mode;
`renderingEnabled` controls terminal rendering, not native hit testing. A
misrouted touch can therefore reach the terminal. This is a defensive gap, but
does not itself explain why the foreground overlay would stop receiving input.

`OverlayScrollbar` refuses responder termination requests and only finishes a
drag on release/termination. Retained hidden scrollbars stay mounted; the chat
deactivation code clears its own drag state, not the scrollbar's responder.
An interrupted gesture is another candidate, although no retained responder
has been observed in the failing process.

No explicit app-owned `scrollEnabled={false}` lock was found on the transcript.
`ScreenUpdates` commits the active-to-hidden transition and rerenders when
reactivated; its memoization alone does not establish stale visibility.
The native keyboard-overlay module only changes soft-input adjustment flags;
it does not create an input-blocking overlay window. Existing Jest touch tests
inspect React props and invoke mocked callbacks, so they cannot validate native
Fabric hit testing or reproduce this device-level failure.

## Opt-in tracing

The diagnostic build adds native hit-test logging and an explicit view-property
dump. It does not change touch routing, remount chat, or restart the app when
tracing is enabled. Installing the build does replace the running process, so
capture the current failure before installing it.

Run commands from `nix develop`. Enable tracing on the running diagnostic build:

```bash
adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-touch on \
  > .codex-diagnostics/chat-touch-before.txt
adb logcat -v threadtime WhipTouchDiagnostics:I ReactNativeJS:I '*:S' \
  > .codex-diagnostics/chat-touch-log.txt
```

Each touch-down records React Native's computed target, its native target, and
the target's ancestor chain, including pointer-events, opacity, bounds, Z,
translation, and scroll position. Touch-up/cancel events share a gesture number.
There is no per-move logging. Tracing is off by default and resets when the
process exits. Native diagnostics do not read text or accessibility labels.

`AgentChatDiagnostics` also logs `viewport-touch-start` when the chat receives a
JS touch event, and `viewport-drag-start` when the list begins a native drag.
Correlate these with the existing chat activation and keyboard/composer events.

Start with a working chat and test one transition at a time:

1. Tap a tool row and scroll to establish working target paths.
2. Open and close the composer, then repeat the same gestures.
3. Switch chats, then repeat the same gestures.
4. Switch chats with the composer open; dismiss it and test again.
5. Repeat the sequence with Android Back dismissing the keyboard/composer.

At the first failure, keep the process alive and capture:

```bash
adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-touch \
  > .codex-diagnostics/chat-touch-failed.txt
adb shell dumpsys input > .codex-diagnostics/chat-touch-input.txt
adb exec-out screencap -p > .codex-diagnostics/chat-touch-failed.png
```

Compare the working and failing target paths. A hidden target or a pointer-events
change points to layer handling. A correct native target without the JS event
points to event delivery/responder handling. JS touch delivery without a drag
points to list/gesture interception. This distinction is needed before choosing
a fix.

Disable tracing after capture:

```bash
adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-touch off \
  > /dev/null
```
