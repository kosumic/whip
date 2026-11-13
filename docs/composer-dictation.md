# Composer dictation lifecycle

`ComposerDictation` remains the recognized-text and hint core. Its lifecycle
coordinator in `rust/src/composer_dictation/lifecycle` owns the microphone lease
using `mobile-speech::Arbiter`, retained managed-call reservations, generation and
cycle admission, provider choice, permission/playback sequencing, context budget,
Android continuous fallback/backoff, stop-result draining, cancellation and cleanup.

The TypeScript service executes typed effects against Expo Speech Recognition or
OpenAI capture, forwards platform events, publishes the native view and stores
accepted transcript fragments. It has no lifecycle timers or restart/fallback flags.
Every asynchronous effect is admitted before execution and acknowledged with its
command ID, generation and cycle. Late permissions, uploads and context responses
cannot advance a replacement session. Native deadline notifications wake the
adapter only on a policy transition; presentation does not poll FFI.

Expo start/result/error/end events have **no session IDs**. Adapter cycle labels
fence retired listeners and async work, but cannot identify arbitrary stale OS
events. Rust admits results only after start and closes recognition conservatively:
a terminal event (or the missing-end deadline) triggers `getStateAsync`; two
inactive observations separated by 250 ms are required before restart or release.
Empty Android cycles back off to 2 seconds, while listening silence has no timer.
There are at most three unsuccessful idle checks. An unconfirmed recognizer keeps
the microphone quarantined until a later end or explicit retry and confirmed idle. The UI stays in
finishing and another dictation cannot acquire the microphone. This deliberately
prefers retaining ownership over overlapping unidentified recognizers.

Manual stop drains the last unconfirmed hypothesis once. A nonempty final consumes
that hypothesis; an empty final cannot erase it. Cancel discards unconfirmed text
and preserves already accepted segments. Local-only calls never downgrade to a
backend without the shared local PCM feed. Only a reserved local managed call can
skip playback suspension; backgrounding cancels ordinary composer input. App lock
continues to cancel through the composer's disabled/unmount lifecycle.

## Validation

Run in `nix develop`:

```sh
cargo test --locked --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml composer_dictation --lib
npm test -- --runInBand __tests__/composerSpeechInput.test.ts __tests__/voiceConversation.test.ts __tests__/realtimeVoiceConversation.test.ts __tests__/voiceSessionManager.test.ts
npx tsc --noEmit
```

Rust tests cover out-of-order/stale events and acknowledgements, missing native
callbacks, bounded Android fallback, long pauses, stop/cancel text semantics,
background interruption, retained local-call reservations and cancelled cloud
uploads. Adapter tests check OS effect execution, permissions, audio-sink fencing,
PCM tokens, native idle queries, transcript handoff and native-state observations.
The wire protocol is versioned with the native app build: regenerate the UniFFI
bridge when changing lifecycle APIs and install a matching native binary.

## Device regression checklist

Use upload-signed arm64 Android builds and the persistent iOS device worktree.
Install in place; never uninstall to test recognition.

- Dictate multiple utterances, edit the draft between utterances, then stop during
  an interim hypothesis. Verify final corrections and the last partial appear once.
- Cancel during microphone permission, recognize again in another composer, and
  grant the old prompt. Verify the replacement draft receives no stale text.
- On Android, pause through repeated no-speech ends and try a provider that rejects
  continuous/injected audio. Verify the ordinary fallback runs after teardown,
  ordinary fatal errors stop recovery, and pauses do not impose a listening limit.
- Stop/cancel in the gap after end. Verify no new recording begins. Simulate a lost
  end callback and confirm recovery requires native inactive observations; an
  active recognizer must keep a second composer blocked.
- Test local STT and OpenAI STT, cancel an in-flight cloud transcription, and
  confirm the cancelled upload cannot append to a subsequent draft.
- During a local managed call, check background capture, consecutive turns,
  playback monitoring and permission revocation. Other composers stay blocked
  between turns and reservation release restores access.
- Background ordinary dictation and lock the app during preparation/listening/
  finishing. Unlock and dictate into a replacement draft; no old partials should
  appear. Exercise iOS interruption and Android microphone/service interruption.

Automated platform-boundary tests do not establish real provider/permission,
background, lock-screen or microphone behavior; complete this checklist on devices
before treating the migration as fully device-validated.
