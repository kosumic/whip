# Composer image paste: expo-paste-input evaluation

Decision for [Whip #322](https://github.com/kosumic/whip/issues/322),
2026-11-03: **reject expo-paste-input 0.2.2 as a replacement**. Keep Whip's
existing interception and upload lifecycle. The candidate fails source-level
lifecycle and performance requirements before native compatibility can be
approved. This is an evaluation result, not an SDK 58 compatibility claim.

## Evaluated versions and provenance

- Whip main: `2b13b4405a5f65a99abcef01ed16d8784dd7f91f`;
  Expo `~58.0.22`, React Native `0.88.1`, React `19.3.0`.
- Upstream: [v0.2.2 / 1f3e3b34](https://github.com/arunabhverma/expo-paste-input/tree/1f3e3b34ea99250c68e483c71f1217307874f12a).
  The npm artifact's Android and iOS view sources match this checkout byte for
  byte. npm SHA-1: `4313141e28c378b9625fff2196458a2dc3f24824`.
- Upstream's latest commit at evaluation is the June 13, 2026 version bump.
  Its [example](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/example/package.json)
  uses Expo 54 and RN 0.81.5. Wildcard peer dependencies accept Whip's versions
  during dependency resolution; they provide no evidence of native compatibility.
- The package declares no production npm dependencies. It requires native
  rebuilding, ExpoModulesCore on iOS, and Expo's Android module build tooling.
  [MIT licensing](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/LICENSE)
  is not an adoption blocker; a future adoption must include its copyright and
  license in Whip's bundled dependency notices.

## Blocking findings

### No native job identity or explicit file ownership handoff

The [public payload](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/src/TextInputWrapper.types.ts)
contains only text, image URIs, or `unsupported`. There is no operation token,
target generation, take/release acknowledgement, cancellation method, or
unclaimed-file registry.

On iOS, [`emitImagesAsync`](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/ios/ExpoPasteInputView.swift#L553)
queues file creation, then queues an event on the main thread. Neither completion
checks the original input, monitoring state, or generation. If the wrapper dies
after files are written, the weak-self early return leaves those files behind.
If the wrapper survives while its composer target changes, the event has no
origin information with which the new callback could reject it. Detach/deinit
restores input associations and observers, but does not cancel queued work or
delete unclaimed files. These are source-derived failure paths; they were not
reproduced on an iOS device.

Whip's current [`composerImagePaste.ts`](../src/services/composerImagePaste.ts)
uses a fresh native binding token, takes ownership before staging, and rejects
late callbacks. Both native implementations delete unclaimed files on detach
and reject completed copies for retired bindings. `ComposerInput` also fences
callbacks against `pasteTargetKey`, while uploads capture their original SSH
runtime. These protections must survive a replacement.

A JS callback could dispose of a URI it receives and infer its filename/MIME
type, then use `stageClipboardAttachment`. It cannot dispose of a file whose
event was never delivered, or recover the originating session from a URI-only
event. Keying/remounting the entire wrapper by target would also remount its
input, violating the focus/selection/IME requirement. Fixing these gaps needs
upstream native lifecycle changes, rather than another Whip native wrapper.

Android also lacks unclaimed-file cleanup: an exception after earlier files
have been written changes the result to `unsupported`, losing their URIs. GIF
copy failures similarly leave any partial destination unmanaged.

### Android changes bytes and performs image work on the UI thread

Both the receive-content listener and ActionMode callback synchronously call
[`processMultipleImagePaste`](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/android/src/main/java/expo/modules/pasteinput/ExpoPasteInputView.kt#L415).
It decodes static images at full resolution, then writes PNG or JPEG quality
80. This adds UI-thread decoding, compression, and I/O where Whip's composer
currently stream-copies original bytes on an executor. It can degrade photos,
flatten animated non-GIF images, and discard EXIF orientation. Its `Exception`
handler does not catch `OutOfMemoryError`; allocation/crash risk follows from
the code, not a measured device crash or latency benchmark.

Upstream [#8](https://github.com/arunabhverma/expo-paste-input/issues/8) documents
the image-work problem; [PR #10](https://github.com/arunabhverma/expo-paste-input/pull/10)
addresses orientation but remains unmerged and retains the full-resolution
decode. These are corroboration, not fixes present in 0.2.2.

### Ordinary text and mixed paste acquire extra behavior

Android consumes the entire receive-content payload when any image is found,
dropping other items. Whip partitions out images and returns the remaining
content for native text insertion. iOS's image paste branch likewise skips
the original paste call when media is present. Upstream
[#9](https://github.com/arunabhverma/expo-paste-input/issues/9) reports mixed
text/image loss on both platforms.

On Android a 500 ms suppression window consumes subsequent receive-content
payloads without inspecting them. Two independent pastes close together can
therefore lose the second payload. Clipboard metadata reads (`getType`,
`coerceToText`, and the ActionMode clipboard read) are outside the image-processing
exception handler, unlike Whip's guarded provider queries.

On iOS the package installs class-wide paste/action/adaptive-glyph swizzles that
remain after detach. A `UITextView.textDidChangeNotification` observer
[`enumerates attributes across the whole text`](https://github.com/arunabhverma/expo-paste-input/blob/1f3e3b34ea99250c68e483c71f1217307874f12a/ios/ExpoPasteInputView.swift#L501)
on ordinary changes, including a second adaptive-glyph pass on iOS 18+.
This introduces native work during typing even though it adds no JS event per
keystroke. Media sanitization rewrites `attributedText` and selection without
a marked-text guard; IME and CJK font parity require device tests. Do not
claim that those behaviors are preserved simply because JS leaves the input
uncontrolled.

## Isolated wrapper prototype

[`scripts/evaluate-expo-paste-input.cjs`](../scripts/evaluate-expo-paste-input.cjs)
loads the published wrapper and Whip's actual `ComposerInput`. Native host
components, `findNodeHandle`, and font/paste services are mocked. The existing
image-paste binding is disabled in this prototype, so the candidate is the
only paste path. Nothing imports the candidate in the application.

Observed with React / react-test-renderer 19.3.0:

- Four text edits kept one input host, the same forwarded input ref, the
  original `defaultValue`, and no `value` prop. The existing text callback ran
  once per edit; the wrapper emitted no paste event during typing.
- The CJK font service received input tag 42 on layout and again on target
  rebinding, rather than receiving the wrapper's ref.
- Switching targets A to B retained that input. Delivering a modeled late
  URI-only event for A invoked B's current callback. This demonstrates the
  API's missing origin information in JS; it is not a UIKit race reproduction.
- Unmount cleared the forwarded ref. No custom native image-paste watcher was
  enabled alongside the wrapper.

Reproduce from the Whip checkout after installing its locked dependencies:

```sh
mkdir -p artifacts/expo-paste-input/package
npm pack expo-paste-input@0.2.2 --pack-destination artifacts/expo-paste-input
tar -xzf artifacts/expo-paste-input/expo-paste-input-0.2.2.tgz \
  -C artifacts/expo-paste-input/package --strip-components=1
node scripts/evaluate-expo-paste-input.cjs artifacts/expo-paste-input/package
```

The renderer cannot verify Fabric view discovery, real native refs, focus,
selection, keyboard suggestions, dictation, font application, or IME preedit.
It must not be used as an Android/iOS integration compatibility test.

## Behavior and compatibility disposition

| Requirement / scenario | Result for 0.2.2 |
| --- | --- |
| Expo 58 / RN 0.88 Android and iOS native builds | Not verified; upstream example targets 54 / 0.81.5. |
| Stable input / uncontrolled text / ref | JS prototype passes; native Fabric/ref discovery unverified. |
| Ordinary text paste and cursor selection | Native text insertion is delegated in common text-only paths; extra paste events and suppression behavior preclude assuming parity. Device selection tests not run. |
| Single/multiple image paste | Supported by source; Android static bytes change, partial failures can orphan files. |
| Mixed text/images | Source rejects parity: images consume the text remainder. |
| GIFs / stickers | GIF bytes copied; media lists put GIFs before static images rather than preserving mixed order. Sticker sanitization and animated formats need native testing. |
| Android Chinese/Japanese preedit | Not device-tested; no adoption claim. |
| iOS suggestions/dictation/CJK fonts | Not device-tested; per-change attribute scanning and media rewriting add interaction risk. |
| Unmount, cancellation, target replacement, backgrounding | No native generation/handoff/cancellation contract; unclaimed-file and late-event paths block adoption. |
| Upload failure/success, previews, SSH queue | Whip's existing staging/upload/dispose path is retained. URI adaptation alone cannot solve the earlier ownership gap. |

Native builds, device IME checks, and native integration/regression coverage
for the candidate were not performed. The rejection does not depend on them:
the published implementation already fails required behavior. If reconsidered,
both platform builds and every device-only row above remain mandatory; do not
mark the issue's adoption acceptance checkboxes complete from this report.

## Size and runtime comparison

`npm pack expo-paste-input@0.2.2 --json` reports **145,181 compressed bytes**,
**1,006,691 unpacked bytes**, and **170 files**. The tarball contains Android
`.gradle` and `build` products, including classes and dex files. These inflate
installation size; they are not evidence that those files enter an APK.

The two upstream native view files plus module definitions total **52,327 source
bytes** (1,581 lines). Whip's two existing clipboard module files total **22,200
bytes** (543 lines), including explicit clipboard attachment picking that the
wrapper does not replace. These source counts describe maintenance footprint,
not a binary-size estimate. Deleting the whole Whip clipboard modules would
also break `hasAttachment`/`copyAttachment` and iOS copy-feedback integration;
only interception-specific code could ever be removed.

The candidate adds a native container per input, hierarchy lookup, a wrapper
render when its parent renders, iOS per-change scans, and Android
decode/compression work. No new ordinary-typing JS callback was found in the
wrapper. No APK/IPA size delta, native memory
profile, or timing measurement was taken. The reject change adds **zero app
dependencies, native views, JS runtime imports, or binary payload**.

## Validation and reconsideration

The isolated prototype passed, as did its ESLint and Node syntax checks and
`git diff --check`. Seven existing suites passed: **161 tests**, comprising
50 tests across six composer/attachment suites and 111 composer keyboard tests.
These validate the retained Whip path, not compatibility of upstream native code.

```sh
npm test -- --runInBand --silent --runTestsByPath \
  __tests__/messageComposer.test.tsx \
  __tests__/composerImagePaste.test.ts \
  __tests__/terminalComposerKeyboard.test.tsx \
  __tests__/attachmentPaste.test.ts \
  __tests__/clipboardAttachments.test.ts \
  __tests__/attachmentPasteSheet.test.tsx \
  __tests__/terminalAttachmentUpload.test.ts
```

Reconsider a future version only after it provides native operation generations,
explicit ownership transfer and unclaimed-file cleanup, safe off-thread
byte-preserving copies, text remainder handling without a timed suppression
window, and acceptable typing overhead. Then run Android/iOS builds, native
paste/lifecycle integration tests, real-device IME/dictation/font checks, and
APK/IPA/runtime comparisons before removing Whip's handler. Do not add a fork
or a second native adapter just to force adoption.
