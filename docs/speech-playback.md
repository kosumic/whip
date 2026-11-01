# Speech playback

Chat read-aloud, agent announcements, and the reverse-control `device.speak`
tool share one native player per platform. `SpeechPlayback.kt` and
`WhipSpeechPlayback.m` own the speech engine, audio session, accelerometer, and
watchdog. `speech_playback.rs` owns admission, session ownership, and deadlines;
`chat_speech.rs` selects, formats, and queues chat prose.

Explicitly starting chat replaces the previous speaker and reserves playback
between replies. Announcements may replace earlier announcements, but skip
speech when chat or a device tool owns playback. Device speech may replace an
utterance from the same reverse-control session; other owners receive
`device_unavailable`. Notifications still arrive when their announcement skips
speech.

Agent status announcements use the current conversation's cached session title,
for example, "Fix keyboard latency finished" or "Fix keyboard latency needs attention".
Without a title for that exact host, pane, terminal, and session, they retain the
tab-and-agent announcement. Reading the cache does not open or load a transcript.

Every admitted session receives a new Rust lease. Native initialization,
utterance callbacks, and targeted cancellation validate that lease or owner.
Closing an old reverse-control session or completing an older announcement
cannot stop a newer speaker. Device tools still acknowledge speech when it
starts and retain ownership until completion or cancellation.

A firm phone shake stops every speech kind directly in native code, including
while JavaScript is busy. Shaking during an announcement also cancels pending
agent alerts when JavaScript resumes, so the announcement is not replaced by
ringing. Headphone disconnection and audio interruptions stop the current
session. Dictation waits for all playback to release its audio resources.
Android's foreground notification exposes a Stop action for every speech kind.

The small C ABI in `WhipSpeechPolicy.h` lets native events synchronously update
Rust ownership without depending on the JavaScript runtime. Its kind values
must agree with `SpeechPolicy.kt` and `SpeechKind` in Rust. Expo Speech is no
longer used.

## Optional local speech (#263)

Settings → Voice → Speech backend defaults to **System**. Voice also contains
the voice announcements toggle. Choosing **Download
Phonon** explicitly installs Phonon 31M English and one default voice. Opening
settings, starting the app, or opening chat never downloads model weights.
Download progress, cancellation, retry/resume, selection, and removal are
available in the same control. Selection persists in Rust-owned app-private
storage; model files are excluded from backup. Other languages use system
speech, and an unavailable model or a load failure before any audio also falls
back to system speech. The settings status explains the fallback. Errors after
partial playback stop that utterance instead of repeating its beginning.

Voice contains separate pickers for installed system TTS voices and Phonon
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
Preview uses the shared native playback policy, stops on selection changes or
leaving Voice, and cannot displace an active chat or device-tool speech lease.
Backend choices are grouped together, with the selected backend's voice picker
visually nested below them. Preview text is an editable input prefilled with
the default sample on first use. User edits, including an empty input, persist
in the Rust speech preferences. Preview speaks exactly the input's contents;
an empty or whitespace-only input disables playback. Previews retain
announcement admission but use Rust's text-sized speech deadline, so a longer
sample can finish beyond the ten-second status-announcement limit.

Android arm64 uses `ptts = 0.6.0`, with the `hf` tokenizer feature and without
`hub`, CLI, or audio-file features. CPU Q8 files are pinned to Hugging Face
revision `8c64b55ec301728e2d1695bfea87a08a267d0c2d`; all four artifacts total
65,049,306 bytes. A native audio worker reuses the loaded model and consumes
`Synth::stream` directly. JNI transfers at most 1,920 Float32 samples per
callback, never through JS. `AudioTrack` uses mono 24 kHz streaming PCM, a
bounded platform buffer, blocking-write backpressure, and platform resampling.
The speech promise resolves after the playback head consumes the final frame.

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
