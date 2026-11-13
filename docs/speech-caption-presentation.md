# Read-aloud caption presentation (#428)

The false “already spoken” suffix was a presentation transition. In the original
`ChatSpeechText`, a new caption ID reset the cached highlighted Markdown. When
`chat_speech_highlight` returned the original source at an unavailable/end cursor,
`speechOriginal` became undefined. `MarkdownText` stopped supplying `readAloud`,
so the native renderer exposed the ordinary bright text color for the entire
unspoken suffix. Both native painters also discarded presentation when a current
word marker was absent. This did not require a jump in acknowledged PCM frames.

A replay against the original component confirmed the transition: a row first
received `Hello` with a valid word, then a different caption ID with an end cursor
and no valid marker. The original row removed `speechOriginal` while the suffix
was still unspoken. The new regressions exercise explicit state through that same
handoff, including a missing word, buffering, remounts and streaming extensions.

## Ownership and coordinates

The existing Rust `speech_captions` subsystem owns one immutable presentation
snapshot. It includes the speech lease, monotonic caption/utterance generation,
owner/session, host/pane/bindings/message/part identity, phase, acknowledged PCM
frames, `spokenEndUtf16`, an independent optional `currentWordRangeUtf16`, and end
reason. Local-call display offsets and original-chat offsets are normalized here.

Native players bind the source when an utterance is admitted. System TTS sends
both original UTF-16 range endpoints; PCM sends actual consumed source frames to
the existing pacing clock. Generated duration alone cannot advance presentation.
Only a confirmed drained utterance enters `buffering` and confirms the complete
chunk. The next admitted chunk retains the previous confirmed boundary and word
for the same lease and source. Punctuation without a new word retains the last
confirmed word. Old generations, backward ranges and expired leases are ignored.
Clear/Stop/shake/replacement/interruption use the native teardown's end reason and
clear the Rust presentation. Removing a row only removes its subscription.

JavaScript subscribes to native wake-ups and reads the current Rust snapshot;
event payload arrival order cannot resurrect an older caption. React caches only
parsed immutable JSON for `useSyncExternalStore` referential stability. The local
voice UI consumes that same snapshot. There is no JS caption retention authority
or previous-highlight cache.

Rust projects normalized speech positions into original Markdown UTF-16 ranges.
A source mismatch retains active upcoming styling with no heard/current range.
React adapts coordinates through complete Markdown normalization, image URL
rewrites and diagram splitting. An unavailable mapping remains conservative.
The shared native Markdown parser carries source ranges into the existing text
runs, including links, inline code and UTF-16/CJK text. Kotlin and Objective-C
paint those runs without inserting `==` into Markdown. Formulas, code and link
syntax remain intact. Caption ticks repaint attributed text without reparsing
Markdown; renderer reuse and clearing remove the speech-specific paint.

## Regression checks

Run in `nix develop`:

```bash
cargo test --locked --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml speech_captions --lib
npx jest __tests__/speechCaptions.test.tsx __tests__/markdownText.test.tsx __tests__/speechPlayback.test.ts __tests__/voiceConversation.test.ts --runInBand
bash scripts/test-native-markdown-parser.sh
android/gradlew -p android :react-native-enriched-markdown:testDebugUnitTest --tests com.swmansion.enriched.markdown.SpeechPresentationTest -PreactNativeArchitectures=arm64-v8a
```

`SpeechCaptionPresentationTest` adds real JNI/Rust instrumentation coverage for
range independence, drain/handoff and stale callbacks. Run it on an idle Android
device. The Android Robolectric painter tests inspect actual foreground spans of
the entire unspoken suffix, with and without a current word, and after recycling.

On mini, `nix develop -c ruby scripts/test-ios-speech.rb` includes the iOS adapter
and equivalent attributed-text painter tests. During this change, mini's full
disk prevented Xcode test execution. Arm64 syntax checks of the updated adapter
and painter test passed. No app was installed/uninstalled and no unrelated build
cache or source was removed. Physical-device/instrumentation playback remains a
follow-up validation, including System/Phonon/OpenAI backends.

Rust diagnostics record caption generation, session lease, confirmed boundary,
current-word range, acknowledged frames, phase and end reason. They do not log
transcript content or source text.
