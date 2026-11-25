# Voice media activation (#457)

Creating a speech lease or reserving a call's playback turn does not acquire
audio focus. Native adapters activate audio at these boundaries:

| Path | Activation boundary | Lifetime |
| --- | --- | --- |
| Android PCM read-aloud / preview | The existing bounded prefill is ready on a paused `AudioTrack`, immediately before `play()` | Until completion, cancellation, failure, or handoff; queued adjacent chunks reuse the request |
| Android Realtime / Live call | Rust reports transport `mediaReady`, both native devices initialize, then focus is granted before playout and capture start | The entire live call, including silence, mute, listening, barge-in and AEC |
| Android output-only Realtime / Live preview | The first nonempty Rust PCM packet is held by the playback worker before requesting focus and starting its track | Until preview ends or fails |
| Local turn-based call | Local model preparation and recognition permission/context preflight finish; shared call audio activates immediately before recognition starts | Across recognition cycles, waiting, and spoken turns; a muted call can activate through its first spoken turn |
| iOS PCM read-aloud | First PCM is ready; activate the session, start the prepared engine, and schedule/play the buffer on main | Until completion or cancellation; call speech borrows the conversation’s audio session |
| iOS Realtime / Live call | Rust reports transport `mediaReady`. Whip activates `AVAudioSession` and starts voice-processing capture and playout | Whip releases the session on hang-up and reactivates it after an interruption when iOS permits recovery |
| iOS Realtime / Live preview | Retain the first nonempty PCM buffer, activate the session and engine, then submit that buffer before reading more | Until preview completes or is cancelled |

Full-duplex activation never waits for an assistant response. Waiting that long
would prevent live input, barge-in, and a continuous echo reference. Local calls
likewise retain their call owner between turns instead of reacquiring per reply.
On iOS, credentials, network setup and local model loading can finish before
Whip activates the audio session.

Android `TextToSpeech.speak` and direct iOS `AVSpeechSynthesizer` playback do not
provide the prepare/play split used by these PCM paths. Their narrow practical
boundary is immediately before the playback API call, after engine/voice setup.
They can still own focus during internal system-engine or network synthesis.
Their started callbacks arrive too late to guarantee an unclipped first word.

Android's PCM worker waits for main-thread activation without holding its device
lock. Cancellation retires the lease and fences a pending activation callback;
denied focus rejects playback without consuming the first buffered frame or
retrying it through a different synthesizer. An active call supplies the speech
owner's focus, avoiding a competing transient request. Call focus-loss policy and
the existing recovery timeout remain in effect after activation.

## Timing diagnostics

Android logs `event=media_ready`, `event=first_pcm_ready`, `event=focus_request`
and `event=first_audible_frame` using monotonic `at_ms` timestamps. Compare each
owner's focus request with the first observed played frame to measure silent
ownership. `media_ready` for a call means live devices/transport, so subsequent
silence while listening is intentional. System TTS marks its start callback as
`boundary=system_callback`. Playback-head observations have polling/device latency;
they do not measure acoustic output at a microphone.

iOS uses monotonic `at_s` timestamps. PCM's first-output marker is explicitly
`boundary=scheduled`. These are software
boundaries, not proof of acoustic first-sample timing.

## Validation

Run checks with `nix develop`:

```sh
android/gradlew -p android :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin \
  -PreactNativeArchitectures=arm64-v8a
npx jest __tests__/composerSpeechInput.test.ts __tests__/voiceConversation.test.ts \
  __tests__/realtimeVoiceConversation.test.ts --runInBand
```

On an idle Android device, run `PcmSpeechPlaybackTest` instrumentation to exercise
delayed synthesis, cancellation during prefill, rejected playback, short-buffer
drain and consecutive output with real `AudioTrack`. With another app playing
music, check read-aloud/model initialization, Realtime and Live call startup,
previews, rapid stop/restart, mute during startup, headset route changes, and
locked/background call activation. Use `scripts/test-android-voice-focus.sh` for
transient, ducking and permanent focus loss after activation.

On macOS, `nix develop -c ruby scripts/test-ios-speech.rb` runs arm64 simulator
adapter tests and compiles both voice adapters. Physical-device checks remain
necessary for audio routing, Bluetooth, interruptions, uninterrupted listening/AEC and
first-phoneme audio. Simulator/unit-test results cannot establish those behaviors.
