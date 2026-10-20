# Composer voice input

Tap the microphone below Send to start dictation. Tap the stop icon to finish,
review the draft, and press Send. Dictation stays active through pauses and
multiple utterances on both Android and iOS until you stop it or cancel it.
The expanded composer has the same microphone control. The Compose toolbar
button closes the composer.

Partial recognition appears above the text field. Each finalized speech segment
is appended to the current draft, preserving existing text, attachments, and
edits made while listening. On manual stop, Whip waits for the final result;
if none arrives, it keeps the last partial instead. A finalized segment clears
its partial, so stopping does not append that text again. Repeated utterances
are preserved. Send is disabled until recognition ends; dictation never sends
a message automatically. Leaving the pane, changing the chat binding, closing
the composer, or backgrounding the app cancels the unconfirmed partial result.

Recognition hints are frozen when the microphone is tapped. They come from the
existing composer text and the last ten messages in the active chat or the last
hundred lines available in the terminal renderer. Rust counts phrases and words
case-insensitively across these sources and selects up to 100 unique hints in
descending frequency order. Ties prefer composer text, then recent context.
These hints are passed as `contextualStrings` to `expo-speech-recognition`.
Unavailable context falls back to draft hints. Hints influence recognition;
they are not added to the message.

The recognizer uses the device's speech locale and platform speech service, which
may use the network. Audio recordings are not persisted. Context hinting requires
Android 13 or later. On Android 13+, Whip first requests continuous recognition.
Expo implements this with a separate `AudioRecord` stream, passed through
[`EXTRA_AUDIO_SOURCE` and `EXTRA_SEGMENTED_SESSION`](https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_SEGMENTED_SESSION).
Android documents that support depends on the recognition service. A provider
that ignores the injected audio may compete for the microphone and return empty
segments, no-speech results, or client/audio-capture errors. Whip treats these
as compatibility failures and falls back while keeping dictation active.

Whip falls back to ordinary recognition when continuous mode produces an empty
final/`nomatch`, a no-speech/client/audio-capture error, fails to start, or ends
without a manual stop. The fallback lets the speech service own the microphone
and restarts recognition after each native `end`, retaining all finalized
segments in the same composer session. Android 12 and earlier use this path from
the start. A failed continuous path is remembered for subsequent microphone
taps during the app process. Empty fallback sessions and native speech timeouts
restart with a short, capped backoff; they do not finish dictation or show a
no-speech error. There can be brief gaps in audio capture between fallback
sessions, and the speech service may play its normal start/stop sounds.

There is no application silence timer or listening-duration limit. The ten-second
watchdogs guard missing native startup and manual-stop completion events only.
If manual stop times out or recognition fails while stopping, the last pending
partial is still retained. Network, permission, unsupported-language, and other
terminal recognition failures show feedback and end dictation while preserving
the draft and previously finalized segments. Ordinary recognition's client/audio
failures are terminal too; Whip does not retry them indefinitely.

iOS uses continuous dictation until stopped. Chat read-aloud and spoken alerts
are suspended while recording. Read-aloud resumes for the current binding after
recognition ends.

The Expo plugin, Android manifest, and iOS Info.plist declare microphone/speech
permissions. This native dependency requires a rebuilt app; a Metro reload is
insufficient. Build only arm64 and follow the signing/device-install instructions
in `AGENTS.md`.

`composer_dictation.rs` owns hint extraction, recognition state, partial/final
handling (including draining the last partial on manual stop), and draft joining.
`composerSpeechInput.ts` adapts Expo events and owns one process-wide microphone.
Cancellation waits for the native `end` event before
accepting another recording because native recognition events contain no session
identifier. Fallback restarts also wait for `end`, and preserve microphone ownership and
playback suspension between native sessions. Stopping, cancelling, or
backgrounding during a restart gap cancels the pending restart. Cancellation
discards unconfirmed text even if a manual stop was already in progress.

Regression coverage lives in `composer_dictation.rs` and
`__tests__/composerSpeechInput.test.ts`: long pauses, multiple and repeated
utterances, edits during recording, manual-stop final/partial draining, errors,
continuous-mode fallback, restart gaps, backgrounding, and late native events.
The native state-machine tests exercise transcript retention; the adapter tests
use a mocked recognizer to exercise event ordering and timers. They do not prove
that a particular device speech service supports segmented audio. For a device
check, dictate several utterances separated by long pauses, stop during a
partial, and repeat with a service that rejects continuous input. Verify that
the draft contains each segment once and the microphone remains active through
pauses. `adb logcat -s ExpoSpeechService ExpoAudioRecorder SpeechRecognizer` can
distinguish empty segmented results from service errors; transcripts and context
hints can appear in these native debug logs.
