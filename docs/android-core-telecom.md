# Android system call integration (#458)

## Eligibility and rollout decision

Reviewed 2026-11-15 against the [Core-Telecom guide](https://developer.android.com/develop/connectivity/telecom/voip-app/telecom),
[1.1.0 release notes](https://developer.android.com/jetpack/androidx/releases/core#core-telecom),
[foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types#phone-call),
and [Google Play foreground-service requirements](https://support.google.com/googleplay/android-developer/answer/13392821).

Core-Telecom is for calling applications and supports custom meeting/application
addresses. Whip represents an explicitly user-started, outgoing, audio-only AI
conversation with a `whip://voice-call/<token>` address and a bot notification
person. It does not invent telephone numbers, request the default dialer role,
receive calls, or advertise hold, transfer, video, streaming or call logging.
The Android API has no documented human-recipient prerequisite. That establishes
technical feasibility, **not Google Play approval for AI conversations**.

Play lists calling through cellular/VoIP/Telecom APIs for `phoneCall`, but also
specifically lists virtual-assistant voice commands under `microphone`. It does
not explicitly decide Whip's AI use case. Store rollout therefore remains off:
only `WHIP_DISTRIBUTION_CHANNEL=github` enables Telecom by default. Other and
unspecified channels use the existing microphone/media fallback. Gradle
`-Pwhip.telecomEnabled=false` disables it for a GitHub build; an explicit `true`
is available for qualification or after eligibility/declaration review.
This is a build decision, with no new user permission prompt or UI preference.
Disabled builds remove Telecom's `BLUETOOTH_CONNECT`, `MANAGE_OWN_CALLS`,
`FOREGROUND_SERVICE_PHONE_CALL` and
the service's `phoneCall` type from the merged app manifest.

Before enabling a Play build, confirm eligibility with Play, update App content
FGS declarations, and supply a video showing the user initiating and ending
an active AI conversation and why interruption matters. This repository change
does not submit that declaration. `MANAGE_OWN_CALLS` satisfies Android's
`phoneCall` prerequisite without `ROLE_DIALER`. Keep `RECORD_AUDIO` authorization
and the microphone service type: call registration does not authorize capture.
Start from a visible user action, never from boot or as an unsolicited background
call. Existing supported OS versions are unchanged (voice requires Android 13+).

The 1.1.0 AAR requires minSdk 24, compile SDK 36.1 and Android Gradle Plugin
8.9.1 or later. The project retains minSdk 24 and compile SDK 37; dependency
metadata and Kotlin compilation pass without an SDK increase. The adapter's
API 26 requirement is annotated, and voice admission still requires API 33.

There is no full-screen intent, incoming-call screen, lock-screen activity, or
automatic app unlock. CallStyle presentation, notification visibility, OEM lock
screen banners and third-party wearable/car surfaces depend on system settings
and device support. Telecom cannot guarantee a full-screen lock-screen UI.

## Ownership and failure behavior

`VoiceCallService.Session` hosts one `VoiceTelecomCall` for the existing Rust
call token. This covers Local, Realtime and GPT-Live, global or agent-bound;
no provider-specific system call or second service is created. Rust admission
and native playback fencing from #434 still guard startup and every callback.
Provider reconnect/rotation (#378) never invokes a new system registration.
The 250 ms authority check tears down the native/system host when Rust revokes
the token, including when React is suspended.

The service posts its single existing CallStyle notification before addCall,
then reposts that notification as soon as the call scope arrives, within the
five-second notification deadline. Mute, hang-up and app-open PendingIntents
remain token-scoped. Registration upgrades the same service from
`microphone|mediaPlayback` to `microphone|phoneCall`; there is one notification
ID and one foreground-service owner. A user ending during registration revokes
Rust/audio immediately, and holds the native owner until the late registration
is disconnected (Core-Telecom setup timeout plus bounded cleanup). No stale
callback may start capture or mutate a replacement session.

Telecom sets the call active before native readiness admits capture/playout.
Active callbacks acknowledge the existing call; they never restart a provider.
Disconnect ends Rust/native ownership without waiting for JavaScript. Inactive/
hold requests end the call and throw an explicit unsupported-operation error:
Whip cannot preserve a held call while guaranteeing silent capture/playout.
This intentionally chooses termination over unsupported automatic resumption.
Provider startup and preflight may still fail after system call activation;
that terminal failure tears down the same call.

Unavailable or security-disallowed registration before admission uses the
working media service for that session. Other registration errors (including a
competing call), failed activation, and failures after admission end the call;
they cannot bypass Telecom arbitration by switching to media focus. A
system/service/process death is terminal (`START_NOT_STICKY`); the user must
start again. App hang-up drains/disconnects Telecom before service destruction;
unexpected destruction cancels the service scope and attempts bounded native
disconnect. No process-death recovery resurrects a call.

Android 13 uses Core-Telecom's manifest-provided legacy ConnectionService;
Android 14+ uses transactional Telecom by default. Registration uses baseline
capability and the library's default implementation selection. There is no
untested forced-legacy override for newer devices.

## Audio and mute

For managed calls, Telecom owns focus, communication mode and routing. The
service does not request independent media focus or set communication devices,
Bluetooth SCO, or AudioTrack device preferences. AudioTrack, system TTS, native
announcements and Local PCM use `USAGE_VOICE_COMMUNICATION`. Endpoint flows
drive speaker state, and app speaker actions request only an endpoint supplied
by `availableEndpoints` (speaker, wired, Bluetooth, then earpiece). Requests do
not optimistically invent a successful route. Private endpoint disappearance
ends the call to avoid unexpectedly playing a private conversation on speaker.
An explicit speaker selection while a headset is available is allowed.

The activity sends volume keys to `STREAM_VOICE_CALL` for managed calls and
does not intercept them for terminal shortcuts during a call. Fallback keeps
media attributes, music volume, media focus and existing track routing.

Core-Telecom 1.1.0 exposes mute observations but no CallControlScope mute setter.
App/Rust mute changes use `AudioManager.isMicrophoneMute` (with
`MODIFY_AUDIO_SETTINGS`) to project mute to Android. System observations feed
the same native mute command; equal observations do not reset Rust mute timers
or repeat announcements. Realtime/GPT-Live use their existing native controls;
Local now has a token-fenced Rust mute entrypoint, including deferred application
when its backend binds after service startup. Capture does not rely on React
receiving a notification event. Android controls global microphone mute, so
cross-app/device behavior still needs the physical competing-call checks below.

Realtime/GPT-Live retain the raw `VOICE_RECOGNITION` input and Rust software
AEC3 reference path; a second platform echo canceller is not enabled. Local
capture already selects `VOICE_COMMUNICATION` in communication mode and retains
its existing echo-cancellation configuration. Bluetooth SCO/LE input, route
changes, actual AEC and call-volume behavior require physical qualification;
mocked endpoint flows cannot verify them.

Core-Telecom declares `BLUETOOTH_CONNECT`; Whip does not request an additional
runtime Nearby Devices grant. The in-call endpoint API works with system
endpoints; legacy Telecom can expose a generic Bluetooth endpoint without the
grant, leaving specific-device choice to Android. Whip does not enumerate
pre-call Bluetooth endpoints or promise named-device selection. Verify both
permission-denied and permission-granted behavior when qualifying devices.

## Automated and physical verification

Run from the development shell (ARM64 is the only app/native target):

```bash
EXPO_SKIP_FINGERPRINT_EMBED=1 WHIP_DISTRIBUTION_CHANNEL=github nix develop --command \
  android/gradlew -p android :app:testDebugUnitTest \
  --tests io.github.kaminarios.whip.VoiceTelecomCallTest \
  --tests io.github.kaminarios.whip.VoiceMediaFocusTest \
  --tests io.github.kaminarios.whip.VoiceCallOwnerTest \
  -PreactNativeArchitectures=arm64-v8a
nix develop --command cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml voice_session::tests
```

Coroutine/Robolectric tests exercise the real adapter with a controllable
platform boundary: repeated startup, active callbacks, one notification
registration, cancellation before admission, late results, simultaneous
system/app hang-up, post-end observations, fallback vs concurrency rejection,
activation rejection, unsupported hold, mute observations, endpoint selection
success/failure and private-route loss. Rust tests check native Local mute
admission, backend binding and revoked-token isolation. These prove adapter
behavior, not Android Telecom or device audio behavior.

Use the signed GitHub ARM64 release installation instructions in AGENTS.md.
Never uninstall to resolve a signing mismatch. Repeat the existing
[#390 lock/app-security checks](voice-lock-lifecycle.md) plus this matrix on
Android 13 and representative Android 14–17 physical devices. Run each case
for global Realtime, agent Realtime, GPT-Live and Local. Use harmless test
conversations; provider use can incur charges.

| Case | Required evidence/result |
| --- | --- |
| Start, navigate, Home, lock for 1+ minute, wake/unlock | One token, one Telecom call (`adb shell dumpsys telecom`), one service/notification; unique spoken phrases are captured and replies audible while locked. No UI/authentication bypass. |
| Locked notification mute/unmute and hang-up | Rust/backend mute converges, native announcements occur once where supported; hang-up stops capture/playout and removes Telecom/notification without JS resuming. |
| App, system, headset, wearable/car controls | Supported controls converge on observed mute/endpoint state; no fabricated hold or answer support. Record unsupported surfaces as such. |
| Speaker/earpiece/wired/BT SCO/LE, unplug/disconnect, volume | Correct input AND output, no private speech spill, call volume keys, intelligible echo-free duplex audio and announcements. Explicit speaker choice works with headset still connected. |
| Cellular/other VoIP incoming and outgoing calls | Rejected registration/activation ends safely; interruption disconnects Whip rather than silently holding/continuing capture; no media-focus bypass or stale global mute in the competing call. |
| Provider reconnect and rotation (#378) | Same Rust token, same system call/notification, retained mute intent and endpoint; no extra capture owner. |
| Rapid start/end during addCall, preflight and active audio | Audio stops immediately; late admission is disconnected; new start waits for prior teardown. Repeat at least 20 times. |
| Denied mic/notifications, disabled Telecom, addCall failure | No unauthorized capture. Disabled/unavailable/disallowed registration has the documented fallback; concurrent-call denial has no fallback. Record notification settings and actual lock-screen presentation. |
| Service stop/process kill, relaunch and headset reconnect | System resources end, no sticky restart or automatic new call; fresh user start creates one new owner. |

### Results for this change

Automated checks on the development host passed: 11 Telecom adapter tests,
five audio-focus/attribute tests and two native-owner tests, plus 102 existing
JavaScript voice/security tests across five suites. Android app Kotlin and unit
test sources compiled against Core-Telecom 1.1.0. The GitHub merged manifest
contains the own-call/phone-call permissions and service type. These Android
unit checks used the independently running ARM64 Rust build rather than waiting
for it in each Gradle invocation; they do not exercise JNI or a physical call.
All nine Rust voice-session regressions also passed, including Local native
mute, stale-token fencing and teardown acknowledgements. The store-channel
fallback manifest was generated and checked: Bluetooth/own-call/phone-call
permissions are absent and the service retains `mediaPlayback|microphone`.
The same 18 Android tests also passed on the isolated PR checkout against
published main. Optional Expo debug fingerprint embedding was disabled for
that unit-test run to avoid hashing the shared dependency checkout; production
release fingerprint behavior is unchanged.

No physical Android device was attached to the development host (`adb devices
-l` returned an empty list). **Every physical matrix row above remains
unverified**, including Android 13 legacy behavior and Android 14–17 Telecom,
lock-screen controls, Bluetooth, competing calls, AEC and process-death cleanup.
Do not interpret passing automated tests as device acceptance. Record subsequent
runs with device/model, Android/API, revision, distribution/Telecom setting,
provider/scope, actions, observed results and redacted diagnostics here.
