# Composer voice input

Tap the microphone below Send to start dictation. Tap the stop icon to finish,
or pause to finish automatically on Android, review the draft, and press Send.
The expanded composer has the same microphone
control. The Compose toolbar button closes the composer.

Partial recognition appears above the text field. Only final recognition results
are appended to the current draft, preserving existing text, attachments, and
edits made while listening. Send is disabled until recognition ends. Leaving the
pane, changing the chat binding, closing the composer, or backgrounding the app
cancels the unconfirmed partial result.

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
Android 13 or later. Android uses single-utterance recognition so the speech
service owns the microphone directly; continuous mode's separate audio stream
can produce empty results on some services. An empty session shows the no-speech
message and releases the microphone for another attempt. iOS uses continuous
dictation until stopped. Chat read-aloud and spoken alerts are suspended
while recording. Read-aloud resumes for the current binding after recognition
ends.

The Expo plugin, Android manifest, and iOS Info.plist declare microphone/speech
permissions. This native dependency requires a rebuilt app; a Metro reload is
insufficient. Build only arm64 and follow the signing/device-install instructions
in `AGENTS.md`.

`composer_dictation.rs` owns hint extraction, recognition state, partial/final
handling, and draft joining. `composerSpeechInput.ts` adapts Expo events and owns
one process-wide microphone. Cancellation waits for the native `end` event before
accepting another recording because native recognition events contain no session
identifier.
