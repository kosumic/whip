# Local voice chat

Open a live agent chat and tap the waveform in the empty composer. Voice chat
uses the existing agent connection and send queue. No speech API, API key, or
separate assistant session is involved. The agent still needs its usual remote
connection. Saved transcripts cannot start a voice conversation.

Speak normally. Earshot VAD detects speech on the device. Settings → Voice →
VAD sensitivity adjusts speech detection from 0–100%. Higher values pick up
softer speech; lower values reject more background noise. The saved setting
applies immediately to voice chat, including reply interruption. The default 50%
preserves the original detection thresholds. By default, 800 ms of silence after
speech finishes the turn. No model download is required.

Smart Turn is disabled in standard builds. Its ONNX runtime and feature
extraction dependencies are excluded, the model is never loaded or downloaded,
and Settings has no Smart Turn download option. Previously downloaded model
files are left untouched. Tap the orb to finish manually. Silence alone never
sends a prompt.

After local recognition finishes, Whip queues the nonempty transcript once.
It follows only the new matching user turn and feeds stable clauses/sentences
into the existing local speech queue as the transcript grows. A single native
player stays open through generation gaps; completion flushes the last fragment.
It does not replay history or already spoken prefixes when a transcript is edited.

Local conversations stay in the remote coding agent's existing history and
are excluded from **Settings → Saved voice chats**. That separate list retains
Realtime and GPT-Live calls. Waiting filler and earlier agent history are
excluded from the active voice transcript, and microphone audio is never stored.
Delegations and the matched agent turn's tools appear as expandable transcript
rows with status, bounded input and available results. The active Local call
uses the same chat renderer as cloud calls and saved cloud chats.
Tool details never enter the local speech queue.

Normal turn-taking resumes after generation and playback have both drained.
If the first reply takes more than two seconds, Whip speaks a short, randomly
selected filler such as “Hmm” or “One moment” using the selected local voice.
Further fillers are spaced at least 20 seconds apart without consecutive repeats.
They stay out of the transcript and never complete or skip the pending reply.
The actual reply, user interruption, Skip, or hang-up cuts them off. Filler audio
does not count toward response-latency diagnostics.
Idle prompt acknowledgements and gaps between assistant segments do not finish
a voice turn. The agent's final outcome completes generation, and the last
queued speech fragment must finish playing before listening resumes.
If a transcript subscription expires, the call keeps its pending reply while
the same conversation is rebound. If no replacement arrives within 30 seconds, the call
stops with a reconnect error.
With device echo cancellation, local capture continues while the agent is
thinking or speaking. Sustained user speech (about 256 ms) interrupts playback
and discards the old response's remaining speech, including later transcript
updates. The same recognizer retains the first words of the interruption and
submits the next prompt through the existing send queue. This does not issue an
agent cancellation command. Android enables an AcousticEchoCanceler on the shared
AudioRecord and selects `VOICE_COMMUNICATION` for monitored capture while keeping
media routing. That source enables the platform's communication preprocessing
without changing Android's global audio mode. See [Android's capture source documentation](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource#VOICE_COMMUNICATION).
iOS uses the existing voice-processing audio engine. Devices without
echo cancellation keep explicit Skip and ordinary local voice chat. Skip
suppresses the remainder of the selected response.

Native word/played-PCM callbacks also feed a bounded Rust echo guard. A recognized
first word or phrase matching current speaker output is discarded during playback
and its two-second echo tail, so it cannot interrupt or submit a self-reply.
Different speech remains eligible for interruption, including a user's phrase
that starts with the same word. Fillers use the same guard without transcript rows.

Local reply highlighting follows native system-voice word positions or the played
PCM cursor for Phonon, including the original chat while the call is minimized.
Speech chunks retain their original message/part IDs and prose offsets; call
transcript offsets are mapped separately. Each queued PCM chunk has its own clock,
so preparing lookahead cannot replace the clock of speech already playing.
The first word highlights at position zero after native
playback reports it. Queued chunks retain their offsets in the same reply;
completion, interruption and Skip clear the active word. No JS playback timer
advances the highlight.

Mute discards unfinished microphone input; muting during a reply lets the reply
finish and leaves the microphone muted afterward. Back, the down arrow, and
the transcript button minimize the voice screen while the call continues.
A floating orb above the composer follows the keyboard and reopens the same call.
The hang-up button or changing pane/binding ends the voice conversation.
Ending voice chat does not cancel work already submitted to the agent.

Routine transcript refreshes (`loading` / `stale`, including “Agent activity
resumed”) keep the same call connected. Snapshot resyncs for the same transcript
session preserve the pending turn. A different transcript session is treated as
a conversation replacement, so another conversation's replies cannot be spoken.
Stopping the speech player by shaking the phone or changing its route skips the
current reply and keeps the call available for the next turn. Speech-engine
errors remain visible without hanging up the system call.

The orb renders a local WebGL cloud field with flowing detail and microphone
level response, using the existing WebView dependency. Both its scale and cloud
deformation follow microphone and playback activity. Phonon meters played PCM;
system voices use their native word-timing callbacks. It loads no assets and
makes no network requests. Reduced Motion freezes the flow; hidden scenes stop
their animation loop. It does not own audio or conversation state.

Messages typed into the composer during a call use the same reply tracking and
are spoken through the selected voice. They are queued once by the composer;
voice chat does not resend them. A new typed message interrupts the current reply.
Pending turn IDs remain eligible when their user text arrives in a later update,
so an early turn placeholder cannot silently consume its response.

The transcript button returns to the existing chat with the call minimized.
Switching tabs keeps the call listening and speaking with its original agent;
returning to that tab restores the orb. Starting voice chat in another tab ends
the previous call before opening the new one. Closing the call's tab ends it.
Tool output and reasoning are not read as ordinary assistant prose. If the
agent is awaiting a permission or another interactive action, return to the
existing chat or terminal controls to handle it.

## Audio ownership

Android voice chat uses media audio focus and `USAGE_MEDIA` playback. Volume
buttons adjust media volume, including while listening between replies. It does
not register with Telecom or change Android's communication mode or volume
levels. A microphone/media foreground service retains the notification's mute
and end controls. System media routing selects connected wired/Bluetooth output
by default, otherwise the speaker. Native PCM players support choosing speaker
or a connected media headset without entering call-audio mode; System TTS uses
Android's media output controls. Removing an active headset ends the conversation
instead of unexpectedly playing private audio through the speaker.

Local reply and filler playback explicitly pass the owning call token to the
native player. Their individual speech tokens still fence cancellation and
callbacks, while they share the call's audio queue slot. Finishing or skipping
a speech chunk retains that slot until hang-up; unrelated audio waits for the
call to end. Speech startup rejects an ended or replaced call token.

iOS uses CallKit for activation, routing, system hang-up and mute. Repeated mute
notifications preserve capture and pending speech. No phone number is dialed.

An active conversation continues when Whip is backgrounded or the screen locks.
Android keeps an ongoing call notification and a microphone foreground service.
The call also holds a React Native background task so recognition restarts and
speech draining keep running while the activity is paused. Connection monitoring
stays enabled until both voice calls and any general monitoring service release it.
Listening segments check the microphone grant directly; only foreground call
setup requests permission through the activity.
Background voice prompts dispatch through the native submission queue without
waiting for a terminal viewport or editor acknowledgement. They retain the same
ordering, destination checks, and history as foreground composer submissions.
Herdr submission readiness follows the host connection; releasing its terminal
viewport in the background does not mark the native send queue offline.
iOS uses CallKit's activated audio session and the existing audio background mode.
Another call taking audio control ends the conversation. Start voice chat while
Whip is in the foreground, after granting microphone and speech permissions.

Platform references: [Android media volume](https://developer.android.com/media/platform/output),
[Android audio focus](https://developer.android.com/media/optimize/audio-focus)
and [Apple CallKit](https://developer.apple.com/documentation/callkit).

## Existing speech infrastructure

`composerSpeechInput.ts` remains the single microphone owner. Voice chat reserves
it across turns and uses the same Expo recognizer, permission handling, contextual
hints, final-result draining, and cancellation behavior as composer dictation.
Voice requests set `requiresOnDeviceRecognition: true`. Unsupported local
recognition fails visibly; there is no network-recognizer fallback. Ordinary
composer dictation keeps its existing behavior.

Android ends an injected-audio turn by closing its audio source and waiting for
`onEndOfSegmentedSession`, preserving final segments. Calling `stopListening`
instead interrupts Google's source reader and can produce `ERROR_CLIENT` after
valid recognition. A client cancellation during a deliberate local stop drains
the transcript without ending the call; active-capture failures still surface.
See [Android's audio-source session contract](https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_AUDIO_SOURCE).

The patch to `expo-speech-recognition` sends local voice PCM directly from its
existing microphone stream to the shared Rust ingress, using a fresh sink handle
for every recognizer cycle. PCM does not pass through JavaScript. UI and turn
transitions poll Rust at 20 Hz. See [native microphone ingress](audio-ingress.md)
for buffering, lifecycle fencing and validation status. Android needs Android
13 or later and an installed on-device recognition service/language. iOS requires
on-device recognition for the actual selected locale. The patch explicitly
rejects a locale that cannot honor that requirement. Capture is not persisted.

TTS uses the existing shared speech player and Settings voice. Phonon remains
Phonon; a selected installed system voice remains that voice. Android's local
conversation mode rejects network-required or missing voices instead of choosing
another voice. iOS uses installed AVSpeechSynthesizer voices. Phonon failures in
this mode surface an error rather than silently changing voices. No additional
voice setting is introduced.

## Model and ownership

Standard builds use Earshot VAD and finish speech after 800 ms of silence.
The retained Smart Turn implementation is opt-in through the Rust `smart-turn`
Cargo feature (`--features smart-turn`). Enabling it also requires restoring the
`SmartTurnSetting` entry in Settings to expose model installation. The model and
inference details below apply only to that optional build.

Smart Turn is an optional, explicit 32,411,198-byte download into the app cache;
the UI shows progress. Eviction of that cache requires downloading it again.
The download uses an immutable revision and is checked by size and SHA-256
before installation and loading. Interrupted downloads cannot become installed
models. Closing cancels the download; no microphone is held during setup.

- Repository: <https://huggingface.co/pipecat-ai/smart-turn-v3>
- Revision: `f766f81d3cfdf7737ac64aad813d91bbfd56bf93`
- Artifact: `smart-turn-v3.2-gpu.onnx`
- SHA-256: `ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be`

Despite its upstream filename, these FP32 weights run on the CPU through tract.
Earshot and feature extraction also run in Rust. The input window retains at
most eight seconds of audio. Recognition turns are bounded to 60 seconds of
speech; initial listening silence does not consume that limit. Inference runs
off the JavaScript thread while capture continues. Native startup/finalization
watchdogs do not impose a listening-silence timeout.

The Rust controller owns turn boundaries, mute, generation invalidation,
single prompt submission, response correlation, and speech ordering. The React
Native adapter orchestrates the existing STT/TTS I/O and observes the active
transcript binding. A disconnected or replaced transcript ends the conversation
instead of speaking catch-up output.

The Smart Turn feature extraction follows GymAmi at
`41f1ccffd480571eb81212f4a289cb2a7e07b39c`. Its synthetic counting fixture matches
the Whisper feature reference and ONNX Runtime completion probability
`0.9903487`. Rust tests cover those features, actual model inference (when the
model is supplied), silence, empty recognition, cancellation, repeated prompts,
history exclusion, completion gating, reconnects, and late results. Adapter
tests cover shared microphone ownership and strictly local options. Physical
device speech-service compatibility still needs device verification.

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml voice_chat
WHIP_SMART_TURN_MODEL=/absolute/path/to/smart-turn-v3.2-gpu.onnx \
  nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --features smart-turn smart_turn_matches_the_upstream_completion_probability -- --ignored
```

This feature changes native speech integration and the Rust bridge, so Metro
reloads alone are insufficient. Build arm64 with the GitHub distribution channel
and follow the release signing/install instructions in `AGENTS.md`.
When building inside a source overlay, use `--no-daemon` and
`-Pkotlin.compiler.execution.strategy=in-process`. A compiler daemon from another
mount namespace can otherwise read an older checkout at the same absolute path.
Invalidate affected Kotlin outputs if such a build has already cached stale
classes, and verify the APK's native code before installing it.

## Anthropic low-latency reference

Reviewed Anthropic's [ElevenLabs voice assistant](https://github.com/anthropics/anthropic-cookbook/blob/c43f56d0360b9b1f631bd090fd199231d4c880cc/third_party/ElevenLabs/stream_voice_assistant_websocket.py)
and [latency walkthrough](https://platform.claude.com/cookbook/third-party-elevenlabs-low-latency-stt-claude-tts).
That example records until Enter, transcribes the finished recording through
ElevenLabs, and streams Claude text into a TTS WebSocket while audio plays.
It supplies no automatic end-of-turn detector or mobile call integration.

Whip applies the main latency optimization: response generation overlaps local
synthesis. The Rust `ChatSpeechQueue` emits coherent stable prose before the
matched agent turn completes. Playback retains one session through gaps and
flushes unfinished prose at completion. Turn IDs and spoken-prefix tracking
prevent replay after edits, interruption, or reconnects. Voice interruption can
start the next input turn early; ordinary turn-taking waits for both drains.

The reference also shows why audio queueing matters: it prebuffers PCM and keeps
one output stream running. Whip already has bounded PCM playback and native
playback completion; preserve those instead of adopting per-chunk MP3 decoding,
discarded decode errors, byte-count drain thresholds, or a fixed post-playback
sleep. Local system TTS accepts utterances rather than an ElevenLabs-style
incremental text stream, so buffer coherent clauses/sentences to preserve prosody.

The local `VoiceChatDiagnostics response-latency` event records endpoint silence,
recognizer finalization, prompt-to-first-prose, prose-to-playback, TTS-to-playback,
and speech-end-to-playback durations. It uses the sample clock at the turn
boundary and a monotonic clock for subsequent stages. Playback is marked by
native TTS/PCM start callbacks, not by successful submission to the synthesizer.
Callback delivery and device output buffering still affect these measurements;
verify perceived speech-end-to-audio latency with real device playback. The sample's cloud timings are
illustrations and do not predict Whip's agent transport or local speech latency.
These lessons require no speech APIs or new voice settings.
