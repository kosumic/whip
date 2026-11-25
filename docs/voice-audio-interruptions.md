# Voice audio interruptions (#448)

## Verified failure path

On the connected Pixel 9 Pro, the previously installed APK reproduced the exact
reported state without any microphone mute action:

1. Start a global OpenAI voice call.
2. A separate foreground app requests `AUDIOFOCUS_GAIN_TRANSIENT` (2).
3. Android grants it and delivers `AUDIOFOCUS_LOSS_TRANSIENT` (-2) to Whip's
   `VoiceMediaFocus` listener. `dumpsys audio` records the listener and loss code.
4. Whip abandons focus and shuts down its native audio devices. The coordinator
   ends the call, destroying the provider rather than retaining it for regain.
5. The screen displays **Voice chat paused** and **The system interrupted the
   voice audio session**, with no recovery control. Releasing the probe's focus
   does not resume that call.

This establishes a reproducing interruption path. It does not establish which
external app or OS event caused the original user incident. The baseline
reproduction interrupted startup; the patched-device checks also exercised an
established provider session.

## Recovery contract

Rust retains the logical call and provider while native audio is suspended.
Suspension is separate from user mute, provider mute acknowledgements, provider
replacement, and UI lock. Duplicate loss and late gain are idempotent. Native
handles and session tokens prevent callbacks from affecting replacement calls.

Suspension immediately gates capture and output, retires queued/in-flight input
generations, cancels local cues, clears unfinished provider input, and interrupts
unheard output through the existing provider truncation/cancellation protocol.
Conversation context and tool ownership remain in the existing provider session;
no tool or prompt is replayed. Recovery retires the device boundary again and
preserves the existing user/provider microphone gate. Timed mute deadlines remain
absolute and cannot expire into capture while audio is suspended.

On Android, transient loss (including a duck request delivered to the speech
focus listener) suspends audio. The recorder and output workers stop; their device
resources must be released before replacement workers start. Focus gain permits
device reopening, followed by an explicit Rust resume. Recovery while the device
is locked waits for unlock. Permanent focus loss, output removal, service teardown,
device failure, or a recovery timeout ends the call.

On iOS, interruption began gates PCM immediately and pauses the engine/player.
For realtime calls, Whip waits for an interruption-ended event with `ShouldResume`
and for protected data to become available. It reactivates the audio session,
restarts the existing graph and discards stale audio. Recovery preserves the
speaker selection. A media-services reset, denied recovery, route loss, engine
failure or timeout ends the call. An interruption ends an active local call.

Both platforms bound recovery to 60 seconds. Terminal errors display **Voice chat
ended** and provide **Start new call**. Existing call-history resume restores saved
text into a fresh call; it does not resurrect provider state or replay old tools.

## Diagnostics

`WhipVoiceCall` / `WhipRealtimeAudio` on Android and `WhipVoice` on iOS record
platform focus requests, interruptions, route
reasons, service lifecycle, device failures and recovery outcomes. Session tokens,
native handles and Rust provider-attempt generations correlate transitions.
Repeated focus/interruption/route diagnostics have per-call budgets; Rust logs
only state transitions. No PCM, conversation text or credentials are recorded by
the new diagnostics. Existing audio counters are unchanged.

## Regression checks

Run commands inside `nix develop`:

```sh
cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib realtime_voice:: -- --test-threads=1
cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib voice_session:: -- --test-threads=1
cargo test --manifest-path crates/voice-call-openai/Cargo.toml --test contracts device_suspension
npx jest __tests__/realtimeVoiceConversation.test.ts __tests__/voiceChatScreen.test.tsx __tests__/voiceSessionManager.test.ts __tests__/i18n.test.ts --runInBand
npx tsc --noEmit
WHIP_DISTRIBUTION_CHANNEL=github android/gradlew -p android :app:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a \
  --tests io.github.kaminarios.whip.VoiceFocusPolicyTest \
  --tests io.github.kaminarios.whip.VoiceCallOwnerTest \
  --tests io.github.kaminarios.whip.CallPlaybackBoundaryTest
```

On mini, reuse the persistent iOS checkout and run
`nix develop -c ruby scripts/test-ios-speech.rb`. This includes the iOS interruption
policy tests and compilation of both native voice adapters. Install device builds
with `scripts/install-ios-device.sh`; never uninstall an existing call-data store.

## Device procedure

With an explicitly authorized short voice call active, run:

```sh
nix develop -c bash scripts/test-android-voice-focus.sh transient
# Repeat with duck, then permanent. Each probe holds focus for three seconds.
```

The separate probe app has no microphone access, provider key or Whip data access.
It uses a foreground activity because Android 15+ restricts focus acquisition.
Only the probe uses the debug key; Whip release installs use the upload key.

Check startup and established calls, playback, a user-muted call, background/return,
device lock/unlock, manual hangup during loss, provider replacement, Bluetooth or
headset removal, and failure to reopen devices. Confirm one provider/native handle
survives transient recovery, no stale output is audible, and permanent loss offers
a working new call. End every test call afterward.

On iOS, test an incoming phone call, audio interruptions with and without
`ShouldResume`, and a media-services reset. Use a physical device to verify
audio capture and playout after recovery.

## Validation recorded for this change

- Android baseline: reproduced on Pixel 9 Pro with an actual granted transient
  focus request and recorded `-2` focus loss. No mute action was involved.
- Android release: GitHub-channel, upload-signed, arm64-only APK built successfully.
  Its signing certificate matches the installed app, and it installed in place
  without deleting app data.
- Pixel checks on the earlier candidate: granted transient and duck requests
  suspended and resumed the same native call handle. Permanent loss displayed
  the correct terminal reason; **Start new call** created a fresh handle and
  reached **Listening**. Repeated muted recovery exposed a playback worker that
  could remain alive after suspension. Its outer loop now observes the media
  stop flag; the final release Kotlin build passed, and the rebuilt APK is
  installed. The final repeated-recovery check is waiting for device unlock.
- Rust: 166 voice tests and 16 coordinator tests passed; nine explicitly billable
  integration tests remained ignored. The provider suspension wire test and all
  ten PCM ingress tests passed.
- Android JVM: all eight focus, ownership and playback-boundary tests passed.
- JavaScript: 131 call/UI/localization/security tests passed, including delayed
  inactive notification after native recovery. Full TypeScript, affected ESLint
  and shell syntax checks passed. Concurrent browser localization work was
  preserved separately.
- iOS: both modified voice adapters compiled with system Xcode for arm64 Simulator;
  all 42 speech/native tests passed, including the three interruption-policy tests.
  The persistent worktree's missing symlink target was restored at its original
  path, and its dependency caches retained. Physical iOS validation was not
  performed: the user selected simulator tests only. AVAudioEngine/CallKit
  interruption behavior on a physical iPhone remains unverified.
