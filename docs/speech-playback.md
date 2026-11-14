# Speech playback

Chat read-aloud, agent announcements, and the Phone Use `device.speak`
tool share one native player per platform. `SpeechPlayback.kt` and
`WhipSpeechPlayback.m` own the speech engine, audio session, accelerometer, and
watchdog. `speech_playback.rs` owns admission, session ownership, and deadlines;
`chat_speech.rs` selects, formats, and queues chat prose.

Speech deadlines are contention budgets sized like chat read-aloud: 250 ms per
UTF-16 text unit, capped at ten minutes. The minimum budgets are ten seconds for
announcements, sixty seconds for Phone Use `device.speak`, and thirty seconds for
chat. Long announcements and device readings therefore get the same time as
equally long chat text. When the budget expires with no other playback unit
waiting, the active speech keeps playing until completion. Native players recheck
the Rust queue every second after that budget, yielding if another unit arrives.
Cancelled waiting requests
do not cause a cutoff, and an alert's own pending ringtone does not count as a
competing unit. An alert still retains its turn through its ringtone. Engine and
model initialization retain their hard watchdogs; shake and explicit stop still
cancel immediately.

Automatic read-aloud and the response read button highlight the current word in
the original chat response, only while that prose row is visible. Reading never
opens a caption panel, switches chats, or scrolls to a hidden response. Native
events carry host, pane, message, part, and normalized UTF-16 chunk offsets, so
repeated words and tab-name prefixes cannot highlight a different response.
System voices supply word ranges; Phonon uses acknowledged PCM and the same
Rust pacing clock as voice chat. Phonon word timing is an estimate, refined by
the final audio duration. Between audio chunks the last word stays highlighted
and upcoming prose stays dim until the next chunk advances. Session completion,
cancellation and replacement clear the highlight. Markdown links, formatting
and code blocks retain their original content; a rewritten response is left
unhighlighted rather than using stale positions.

The in-chat presentation matches voice captions: spoken text stays bright, the
current word uses semibold, and upcoming text is dim. Native Markdown rendering
tags the added speech marker by comparing parsed trees with the original text;
existing highlights and `==` inside code cannot select the wrong word. Styling
decorates rendered text rather than changing its links, content or block layout,
and is removed when playback stops or the response leaves view.

The dependency-free [`mobile-speech`](../crates/mobile-speech/README.md) crate
owns reusable playback admission, leases, and completion-driven plain-text
queueing. It contains no Whip, React Native, transcript, model, or OS dependency.
Whip configures its queue limits and class priorities, interprets normalized
agent transcripts, and adapts its existing native system/Phonon player. Other
applications can use the crate directly with ordinary text and their own backend.

Automatic read-aloud consumes authoritative Rust transcript revisions and
changed messages in `automatic_speech.rs`, before presentation delivery. Initial
loads, source replacement, reconnects, and muted/paused updates advance silent
baselines in Rust. A process-lifetime native wake callback schedules platform
work; playback completion advances the Rust queue directly, including after
Phonon PCM drain and status-announcement handoff. Utterance IDs fence late
callbacks in addition to the existing native playback leases. JavaScript sends
preferences, pause/resume controls, and cached binding labels, and receives
focus/error feedback. It neither re-encodes transcript histories for automatic
selection nor drives an automatic speech drain loop.

Live-admitted reply prose and questions remain eligible for playback when a
transcript read, discovery, or rebind temporarily fails. The local queue can
finish its active utterance, remaining chunks, and waiting updates without a
remote fetch. Retry operation epochs fence transcript callbacks independently
of native utterance IDs. Recovery of the same authoritative session advances
silent cursors without cancelling admitted audio or replaying it. Cached
history and reconnect catch-up never create a speech backlog. Confirmed source
replacement/truncation, session or agent changes, explicit close/unbind, and
the usual Stop, disable, input, lock, and voice-call policies still cancel or
suppress playback. Queue bounds and competing-update expiry still apply;
agent status alerts remain independent of transcript availability.

Disabled readers retain only binding metadata, without inspecting message
payloads or retaining spoken-prefix indexes. Enabling prepares full baselines
from weak Rust transcript owners on the existing runtime's blocking worker;
generation checks discard preparation after a newer toggle. Paused enabled
readers keep their baselines current. Loading preferences after a React remount
does not become an explicit disable or undo native Stop.

UniFFI presentation callbacks can wait for JavaScript. A dedicated presentation
delivery worker keeps that wait off transcript ingestion and the existing Rust
runtime's executor threads. Each bound source retains at most four undelivered
updates; overload replaces them with a lazy authoritative snapshot, rather than
retaining an unbounded history of deltas. Native speech and native transcript
rows advance before that delivery. There is still one Rust runtime and player.

React presentation detach releases only its listeners, leaving the enabled
reader with Rust/native. An explicit setting change disables it; repeating
enable on remount does not undo native Stop. **Read aloud while locked** defaults
off. When off, native lock notifications pause automatic speech and discard
waiting audio. When on, automatic reading continues through screen lock and can
read new replies received while locked. Turning it off while locked stops that
reading; enabling it does not replay replies received while it was off. It still
requires **Voice announcements** to be enabled. Native playback still depends on
OS execution limits; process suspension or termination cannot guarantee speech.

Chat speech also reads structured agent questions from question tools and
question notices, including while the agent is waiting for an answer. It reads
the question and its options in order, joining options with "or" and including
their descriptions. Questions that allow multiple selections also say "Choose
one or more."
Automatic speech suppresses historical questions and repeated snapshots; manual
read-aloud can replay a response containing only questions. Routine tool output
and reasoning remain excluded.

The shared voice setting reads new updates from every ready, bound transcript,
across hosts and screens, even when its chat viewport is closed. Initial loads,
reconnect catchup, and cached/stale snapshots stay silent. Switching between
speaking chats announces the tab name, such as "Debug tab: ". When chats compete, updates share
a FIFO queue with at most four unstarted waiting chunks and 800 UTF-16 units in total.
Content chunks contain at most 300 UTF-16 units before the tab prefix. They prefer
sentence boundaries, then clause boundaries for long sentences. Without punctuation,
word boundaries are balanced to avoid a short trailing utterance. An oversized word
is split only at Unicode scalar boundaries. Overload
drops the oldest unstarted waiting chunks; competing waiting speech expires after 15 seconds.
Once an update starts, its remaining chunks and streamed continuations finish
before other waiting updates. They are excluded from waiting limits and expiry,
so time spent speaking the beginning cannot discard the ending.
A single speaking chat can finish without trimming or expiry, even if other ready
chats are idle. A new competing speaker brings unstarted backlog under the limits.
Manual read-aloud and dictation
flush automatic backlog and resume with fresh baselines. Shaking dismisses the
currently spoken update, including its remaining chunks, then pauses for one
second before reading other queued or future updates. It preserves automatic
reading and the rest of the queue. Native Stop silences automatic reading until
the voice setting is toggled again. Internal cancellation (input takeover,
backend/credential changes, owner cleanup, and service teardown) reports
`replaced`, preserving automatic reading of future replies. Dictation marks
input active and awaits automatic pause and manual playback release before
global cancellation; internal cancellation remains safe if it arrives first.
Speech engine failures and audio interruptions
discard the affected playback backlog, then allow new replies to start a fresh
player without toggling the voice setting. Existing transcript content is
baselined during recovery so a partially heard reply is not replayed.

Rust `automatic_speech` diagnostics record control state, admission/suppression,
source epoch/revision and baseline decisions, native request IDs, end reasons,
and stale callbacks. They contain no transcript text, binding labels, or credentials.

On Android and iOS, new speech requests wait for the current speech or alert unit to
finish. A unit holds playback through synthesis preparation and audio drain;
an idle chat lease does not hold the playback queue. A selected response keeps
all its chunks in one turn, releasing playback after the complete response.
Manual playback pauses automatic selection after the ongoing automatic utterance
drains. Selecting another response lets the previous response finish; explicit
Stop and recording still stop audio immediately. Automatic reading releases
playback when its queue empties. Agent status speech waits for the current
utterance to finish. `local_alerts.rs` owns a queue shared across hosts and panes:
one waiting entry per pane, at most four waiting entries, and a 15-second waiting
expiry before native preparation. Prepared atomic units keep their speech while
another unit plays and enter Rust's shared FIFO playback queue. Overload
drops the oldest entry in the lowest priority tier. A pane's new status replaces
its waiting entry and promptly stops its own obsolete announcement. Other panes
and device-tool speech are never stopped by a status transition.

Both native players ask Rust for the next valid announcement at completion,
before allowing chat's next chunk to drain. They hold the completed chat promise
and restore the reader with a new lease after the whole alert unit finishes. This works
with suspended JavaScript and prevents starvation behind a growing chat backlog.
Voice-call output retains its explicit priority. Snapshot updates revalidate
host/runtime incarnation, pane, tab, terminal/session identity, status, freshness,
and voice preferences; dismissal, suppression and disconnect discard matching
entries. Native Stop and dictation discard waiting speech. Shaking dismisses
the currently playing unit. Other queued alerts remain queued. Notification
scheduling remains independent of playback; its sound waits for admission.

Android and iOS alerts are atomic playback units: their announcement plays first, then
their ringtone. No other speech, alert, or voice call can play between those
stages. Alerts without announcements contain only the ringtone; silent alerts
end after their announcement. Notifications use no independent system sound, so
the channel cannot bypass this ordering. Android preserves channel volume,
mute, DND, routing, and vibration preferences. Brief ringtones play once; persistent
ringtones hold the unit until dismissal or timeout. A shake during either the
announcement or ringtone dismisses the whole active alert, removes its pending
audio, and releases the next queued unit. It does not dismiss other alerts.
Android switches shake detection from the speech engine to the alert adapter
for ringing; iOS uses the same motion owner for both stages. Playback
watchdogs start after queue admission. This coordination runs natively while
JavaScript is suspended.

iOS uses a cancellable app tone rather than an independent system notification
sound. App notification sound permissions apply. Brief tones use ambient audio;
persistent tones use playback audio so the alert can continue while locked.
These categories follow Apple's [audio-session behavior](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/AudioSessionCategoriesandModes/AudioSessionCategoriesandModes.html).
Simulator regressions compile the real speech, voice-call, and React bridge
adapters and verify ordering and cancellation without playing audible output.

Device speech waits for the ongoing playback unit, including speech from the
same Phone Use session. Request-scoped cancellation removes waiting speech.

Agent status announcements use the current conversation's cached session title,
for example, "Fix keyboard latency finished" or "Fix keyboard latency needs attention".
Without a title for that exact host, pane, terminal, and session, they retain the
tab-and-agent announcement. Reading the cache does not open or load a transcript.

Every admitted session receives a new Rust lease. Native initialization,
utterance callbacks, and targeted cancellation validate that lease or owner.
Closing an old Phone Use session or completing an older announcement
cannot stop a newer speaker. Device tools still acknowledge speech when it
starts and retain ownership until completion or cancellation.

A firm phone shake stops every speech kind directly in native code, including
while JavaScript is busy. Android requires two distinct acceleration impulses
within 700 ms, separated by a release, so a single impact does not cancel speech.
Shaking during an announcement also cancels pending
agent alerts when JavaScript resumes, so the announcement is not replaced by
ringing. Headphone disconnection and audio interruptions stop the current
session. Dictation waits for all playback to release its audio resources.
Android's foreground notification exposes a Stop action for every speech kind.

The small C ABI in `WhipSpeechPolicy.h` lets native events synchronously update
Rust ownership without depending on the JavaScript runtime. Its kind values
must agree with `SpeechPolicy.kt` and `SpeechKind` in Rust. Expo Speech is no
longer used. Native status adapters retain only effect callbacks and a suspended
chat session; queue selection and validity remain in the Rust coordinator. The
`whip_alert_speech_command` result is owned by its caller and freed with
`whip_alert_speech_free`.

Coordinator and lease races run with `cargo test --lib local_alerts` and
`cargo test --lib speech_playback` in the Rust crate. TypeScript delivery tests
are in `__tests__/alerts.test.ts`. `nix develop -c ruby scripts/test-ios-speech.rb`
runs standalone arm64 simulator adapter tests on macOS without model downloads
or a simulator Rust build. Android's `StatusSpeechTest` uses real playback and a
scripted admission boundary; run it only on an idle device after compiling the
arm64 app and test APK. These adapter suites cover safe boundaries, restoration,
and owner-scoped cancellation; queue and lease decisions are covered in Rust.

## Optional local speech (#263)

Settings has a separate **OpenAI TTS** card with its own expansion state, voice
picker, API key controls, and preview. **Use OpenAI TTS** selects the backend;
System and Phonon remain in the **Speech backend** card. OpenAI TTS uses the
[OpenAI Speech API](https://developers.openai.com/api/docs/guides/text-to-speech)
with `gpt-4o-mini-tts`, 13 built-in voices, and streaming 24 kHz PCM. The default
voice is Marin. Voice and backend selections persist independently. The API key
controls edit the same protected credential as conversation settings. Only the
entered draft and credential presence pass through JS; saved keys go directly
from native credential storage to Rust. Speech text is sent to OpenAI and API
charges apply. Local-only conversations keep their offline speech policy.
OpenAI failures stop the utterance rather than silently choosing another voice.

OpenAI speech and conversation share a native memory cache of the saved credential, held in a zeroing Rust buffer. Android warms it from the existing encrypted slot at native-module initialization and after credential changes, so background and screen-locked announcements can read it immediately. Replacement or deletion first clears the old cache and blocks credential admission until the vault mutation finishes; missing or failed reads are not cached. Temporary request copies and evicted cached keys are cleared after use. No saved key is returned to JS or logged, and no new plaintext file is written. Android can also refill the cache while backgrounded or screen-locked, subject to Android Keystore access rules; iOS vault access rules are unchanged.

OpenAI TTS requests, including read-aloud and previews, now appear in Usage &
costs under Text to speech. The native adapter requests SSE and decodes audio
deltas directly to PCM. Final provider token usage is saved with the model's
versioned price snapshot; generated audio and input text are never stored in
this history. A cancelled or disconnected stream without a usage report stays
unknown. A raw-audio response from a server that ignores SSE also stays unknown;
duration is never substituted for billable tokens. No earlier usage is backfilled.
Native accounting writes share the application database worker. Storage failures
retain ordered events for retry without interrupting playback; opening Usage &
costs flushes pending records and reports storage errors. Process recovery runs
once before new activity, so opening the panel cannot mark an active native
request as interrupted. The open panel refreshes native activity every two
seconds, and positive costs below display precision use a less-than amount.

Rust's `speech_backend` module owns common preferences and provider dispatch.
`openai_tts` owns the Speech API adapter; `phonon` owns Phonon artifacts and
inference. Both feed the existing bounded native PCM players and share speech
leases, cancellation, and playback completion. Shared OpenAI credential
admission lives in `voice_credentials`. Replacing or deleting the key stops
OpenAI playback and invalidates pending synthesis. The legacy `phonon` storage
directory is retained so existing backend preferences and downloads survive.

Settings → Speech backend defaults to **System**. Voice also contains
the voice announcements toggle. Choosing **Download
Phonon** explicitly installs Phonon 31M English and one default voice. Opening
settings, starting the app, or opening chat never downloads model weights.
Download progress, cancellation, retry/resume, selection, and removal are
available in the same control. Selection persists in Rust-owned app-private
storage; model files are excluded from backup. Other languages use system
speech, and an unavailable model or a load failure before any audio also falls
back to system speech. The settings status explains the fallback. Errors after
partial playback stop that utterance instead of repeating its beginning.

Speech backend contains separate pickers for installed system TTS voices and Phonon
voices. System choices come from the platform speech engine and retain their
language and network requirement. The saved system voice applies to chat and
announcements; an explicit device-tool language still takes precedence when
the saved voice speaks another language. If a saved system voice disappears,
playback uses the language default.

Phonon's picker includes its model default and 37 English catalog voices,
including US, UK, and character voices. The catalog is bundled and pinned to
`gradium/phonon-voices` revision `0ee17205f254b5abc43b266c8a0f215565c352f7`.
Selecting an additional voice explicitly downloads only its 256,136-byte
embedding, verifies its pinned SHA-256, and atomically installs it. Progress,
cancel/resume, individual voice removal, and missing/corrupt-voice recovery use
the same Rust manager as the model. Voice choices persist independently of
backend selection. No voice catalog or embedding is fetched on app startup.
Preview uses the shared native playback policy, stops on selection changes,
collapsing its active card, or leaving Settings, and cannot displace an active
chat or device-tool speech lease.
Backend choices are grouped together, with the selected backend's voice picker
visually nested below them. Preview text is an editable input prefilled with
the default sample on first use. User edits, including an empty input, persist
in the Rust speech preferences. Preview speaks exactly the input's contents;
an empty or whitespace-only input disables playback. Previews retain
announcement admission but use the chat budget's thirty-second minimum before
yielding to competing playback.

Android arm64 uses `ptts = 0.6.0`, with the `hf` tokenizer feature and without
`hub`, CLI, or audio-file features. CPU Q8 files are pinned to Hugging Face
revision `8c64b55ec301728e2d1695bfea87a08a267d0c2d`; all four artifacts total
65,049,306 bytes. The loaded model retains an upstream `Session` for the selected
voice and consumes `Session::stream` directly. Phonon already supplies bounded
background synthesis/decode workers; Whip does not implement another model
generation engine. A voice change replaces the primed session after the previous
stream has finished or been dropped. JNI transfers at most 1,920 Float32 samples
per callback, never through JS.

Android voice chat admits at most two utterances: the current one and one
following fragment. A bounded standard-library `ArrayBlockingQueue` hands PCM
from synthesis to a separate output worker, with at most twenty 80 ms packets.
This is in addition to Phonon's own bounded internal queues. One mono 24 kHz
`AudioTrack` remains open across fragments and transcript gaps. It uses at least
six seconds of platform buffer, blocking-write backpressure, and platform
resampling on a dedicated audio-priority output thread. Voice chat starts with a
250 ms reserve; read-aloud starts with 4.5 seconds (or the completed short
utterance). After starvation, the reserve grows by 1.5 seconds up to six seconds;
read-aloud retains that larger reserve across subsequent chunks in the process.
This trades startup time for protection against slower local synthesis on a busy
or thermally throttled phone. Empty drained
tracks pause rather than running through silence; a pending fragment that runs
out of PCM is counted as a starvation in diagnostics. Buffering cannot guarantee
uninterrupted playback when synthesis remains slower than real time.

On 2026-11-09, the upload-signed GitHub-channel arm64 build passed all seven
`PcmSpeechPlaybackTest` and `PhononSpeechTest` checks on a Pixel 9 Pro. These cover
eight seconds of PCM generated over twelve seconds, 2.4-second gaps between
network-style bursts, cancellation during prefill, short completed utterances,
Phonon playback, lookahead, and voice-setting restoration. A separate sustained
Phonon rerun also verified zero starvation events and zero platform underruns
while audio remained to be heard. The final drain can increment Android's raw
underrun counter after the last frame; the active-speech check excludes that
completed tail.

Each speech promise resolves after the playback head consumes that utterance's
final frame, even when the next fragment is already generating or playing. Stop,
Skip, hangup, and lease replacement discard prepared PCM and settle queued
promises; callbacks from the old lease cannot complete a replacement. The native
`enqueueChatSpeech` capability enables lookahead. Older builds and iOS retain
serial `speakChat` compatibility, and Android system voices retain their selected
backend.

On Android, draining a chat chunk settles its promise before yielding to a queued
alert. The next chunk still waits for the alert's complete playback turn. Silent
or cancelled alerts do not suspend the chat session, so they must never be made
responsible for resolving the drained chunk through chat resumption. Holding that
promise stranded the automatic reader on its old active chunk and suppressed new
replies while the notification continued to say it was listening.

Android PCM read-aloud also has a 60-second inactivity deadline, owned by Rust's
playback policy. Only advancing consumed frames refresh it; generated audio,
repeated progress callbacks and callbacks for another turn do not. A stalled
reader fails through normal native teardown, clears captions and settles pending
speech promises even when no competing audio is queued. Advancing speech can
continue beyond its ordinary duration budget. The PCM deadline is removed if an
unstarted local utterance falls back to system speech. `PcmSpeechPlaybackTest`
includes a producer that emits initial audio and then stalls without an end event;
run this acceptance test on an idle Android device with Phonon installed.

On iOS 18+, the official 0.6.0 Core ML engine is pinned through `ptts-ffi` in
Cargo.lock and linked into Whip's existing Rust archive. Only the platform's
137,300,815-byte Core ML archive downloads; the Android GGUF is not fetched.
Installation authenticates the archive, then extracts/verifies the model files
and one default voice against its authenticated `bundle.json`. Core ML compiles
beside the models in writable Application Support. Settings reserves 600 MB for
the archive, extracted files, and compiled models. iOS 16.4–17 retains system
speech with no deployment-target increase. `AVAudioEngine` converts the output
format; at most three 80 ms buffers are scheduled, with backpressure and
`AVAudioPlayerNodeCompletionDataPlayedBack` controlling the final drain.

Rust stages interrupted downloads separately, verifies exact sizes and SHA-256
digests, and atomically renames only complete installations. Network operations
observe cancellation every 50 ms; incomplete files remain resumable. A resumed
response must identify the exact requested byte range. A server that ignores
Range restarts the file instead of appending a second copy. Removing a model
first selects system speech, cancels playback, and waits on the settings worker
for inference to release model files.

Growing Claude/OpenCode prose commits stable sentences and retains the mutable
tail until completion. A subsequent part flushes the previous part's tail in
order. Codex currently supplies finalized response items within a growing turn;
these remain immediately speakable without freezing the progress of the whole
part. Baselines suppress historical prose; repeated snapshots and rewrites of
already spoken prefixes cannot replay speech. Existing dictation suspension,
ownership, shake, interruption, route-change, and session cancellation paths
flush native audio and invalidate the Rust lease before another turn starts.
Cold model initialization has a separate 60-second watchdog; ordinary Rust
speaking deadlines begin at the first native audio output.

### Physical Android acceptance check

`PhononSpeechTest` exercises explicit download/cancel/resume, language fallback,
actual streamed output before drain, consecutive turns, replacement fencing,
and cached inference. The test downloads weights only when the explicit
`installPhonon` runner argument is provided. It restores the previous backend
selection and retains downloaded test weights for later offline checks.

```bash
nix develop -c env WHIP_DISTRIBUTION_CHANNEL=github android/gradlew -p android \
  :app:assembleRelease :app:assembleReleaseAndroidTest \
  -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true -Pwhip.testBuildType=release
nix develop -c adb install -r android/app/build/outputs/apk/release/app-release.apk
nix develop -c adb install -r android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
nix develop -c adb shell am instrument -w \
  -e class io.github.kaminarios.whip.PhononSpeechTest -e installPhonon true \
  io.github.kaminarios.whip.test/androidx.test.runner.AndroidJUnitRunner
```

Capture `PhononAcceptance` and `Phonon` in logcat for cold/warm time to the first
consumed output frame, unthrottled generation/audio duration, replacement
latency, and sampled peak process PSS. Rust also reports model-load duration,
time to first PCM, and generation with playback backpressure. Repeat without
`installPhonon` and with networking disabled to check offline synthesis. iOS
requires the equivalent physical-device checks; compilation alone does not
establish Neural Engine performance, cancellation latency, or audio-route behavior.

Pixel 9 Pro (arm64), 2026-11-01: the upload-signed GitHub release passed
`PhononSpeechTest`, including download/cancel/resume and stale-lease fencing.
Cold first consumed audio was 1,611 ms; warm first audio was 563 ms. Unthrottled
generation produced 4,320 ms of audio in 2,385 ms (1.81× playback speed).
Cancellation to replacement audio took 466 ms. Sampled process PSS rose from
41,879 KiB to a peak of 255,536 KiB. The cold measurement includes loading,
generation, and native output; model loading alone was not separately measured.
The cancellation measurement includes generating the replacement utterance.
The test restored System and retained the explicitly downloaded model. Physical
iOS, offline, shake, interruption, and audio-route checks remain outstanding.

The follow-up voice-picker check passed both physical tests on the same Pixel
on 2026-11-01. It explicitly downloaded and selected Zoey, then exercised actual
streamed playback, drain, and replacement fencing: cold first output 1,579 ms,
warm first output 592 ms, generation 1.89× playback speed, cancellation to
replacement output 707 ms, and peak sampled PSS 278,432 KiB. The system picker
returned 134 voices and successfully applied `en-GB-language`. Both tests
restored the original backend and voice choices. These measurements include
the instrumentation process and native engine initialization.

## Streaming implementation choice

The gap investigation compared the pinned Phonon source with Android playback
solutions. Phonon already provides bounded streaming and reusable voice sessions;
its [upstream implementation](https://github.com/gradium-ai/xn-ptts/blob/main/ptts/src/synth.rs)
uses separate bounded synthesis and decode workers on CPU.
[Oboe's FAQ](https://github.com/google/oboe/blob/main/docs/FAQ.md) also identifies
`AudioTrack` as an appropriate Java/Kotlin playback option. This change keeps the
existing output and call routing rather than adding another audio library.

`VoiceConversation` tests cover one-fragment lookahead, newly arriving streamed
prose, waiting for all played fragments, failures, and cancellation. The device
`queuedSpeechKeepsOrderAndCancelsPreparedAudio` acceptance test checks ordered
playback, rejection beyond capacity, and cancellation of prepared output before
replacement. `stream_opened`, `playback_finished`, and `stream_closed` Phonon
diagnostics correlate audio-session reuse, cumulative underruns, and starvation
counts. Device acceptance changes speech ownership and must run after an active
user call has ended.

Live-call verification on Pixel 9 Pro used the upload-signed arm64 build with
SHA-256 `fac7dbf8b24c52039c663fb2379e62f1b0e52b42a4137eb3a5561a2d17acc4e0`.
A sustained 82.56-second PCM reply completed with no starvation events and no
underruns reported at completion. The call stayed active during profiling.
The device acceptance APK compiled, but its execution was intentionally skipped
when the call guard detected an active call and the user chose passive profiling.
These live replies each used one native text utterance; cross-utterance
lookahead and cancellation are covered by adapter regressions, while the
compiled device regression remains available for a later idle-phone check.

## Extraction validation (#352)

The standalone core passes eight behavioral tests, its README doctest, strict
Clippy, the plain-text navigation example, and package verification without
mobile SDKs. The integration passes 63 Rust speech regressions, 89 transcript/
session regressions, 145 JavaScript regressions, TypeScript, and scoped ESLint.
Seven arm64 iOS simulator adapter tests passed; the final focus-restoration
change also passed a build-only check (`scripts/test-ios-speech.rb --build-only`).
These checks used an isolated snapshot based on `1d5399a6` to exclude concurrent
realtime voice/caption changes.

The GitHub-channel arm64 Android release and acceptance-test APKs built
successfully. Both signatures verify with upload certificate SHA-256
`4dea5dc20cbe8f9bdfaa4ba6d2bacf99ed4c9ce86f086df11d0e3823a98c067e`;
the app contains only `arm64-v8a` native libraries. The local release uses
`whip.skipR8=true`, is 127,108,543 bytes, and has APK SHA-256
`d47eb7bcf4c3751bcb4347a6dd5252d8fb8753c9207feb94aca76dc7c658725d`.
This developer build's size is not a before/after comparison or an optimized
CI release measurement.

On 2026-11-04 the user authorized installation. The upload-signed release and
test APKs updated the Pixel 9 Pro in place without clearing app data.
`StatusSpeechTest` passed all three cases in 21.665 seconds with cached Phonon:
two automatic utterances completed after presentation detach, status speech
waited for a chat chunk and returned a new lease, and closing a suspended reader
preserved an unrelated announcement. This adapter suite scripts the Rust queue
boundary while exercising the real player and native completion callbacks.
The same three cases passed with System TTS in 19.540 seconds. Across both
backends and the Phonon suite below, all nine device test executions passed
without skips. The original Phonon/Zoey selection was restored afterwards.

`PhononSpeechTest` passed all three cases in 37.207 seconds without requesting
downloads. It covered streamed audio/drain, stale-lease cancellation, ordered
lookahead, bounded admission, replacement, and system voice selection/restoration
(134 installed voices). Cold first consumed output was 1,703 ms; warm output was
697 ms; cancellation to replacement output took 577 ms. Generation produced
4,480 ms of audio in 2,216 ms (2.02 times playback speed). The queued callback
gap was 39 ms. Sampled PSS was 56,174 KiB initially and 272,322 KiB at its peak;
these are backend acceptance measurements, not idle-memory regression results.

The normal app also loaded this task's live Codex transcript over SSH. Fresh
assistant updates produced native Phonon output without pressing read-aloud,
and new updates played and drained after pressing Home (the launcher was
verified as the foreground activity). The voice-announcements toggle was
exercised off/on and returned to its original enabled value. These observations
cover the live transcript path beyond the scripted adapter boundary, but not
OS process suspension/termination or every provider and audio route.

A [synthetic bridge report](benchmarks/mobile-speech-bridge-2026-11-04.json)
compares 1,000 revisions editing one of 100 completed assistant messages:

| Automatic selection work | Before | After |
| --- | ---: | ---: |
| JS-to-Rust calls | 2,000 | 0 |
| Message records converted in JS | 100,000 | 0 |
| JSON payload-size proxy | 46,347,890 bytes | 0 bytes |
| Synthetic service time | 88.92 ms | 0.75 ms |

This measures the removed automatic-selection bridge path using the actual
service code and a native queue stub. It excludes ordinary UI presentation
traffic and is not a device FFI or first-audio latency measurement. Physical
iOS, additional audio routes/background scenarios, transcript-to-first-audio
latency, idle CPU/memory comparisons, and a comparable before/after APK-size
measurement remain pending. Issue #352 remains open until its remaining
acceptance checks are complete.
