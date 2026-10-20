# Native terminal frame delivery

Whip now delivers terminal batches from Rust directly to the native Android or
iOS WebView. Hermes does not carry normal output frames or xterm completion
credits. xterm.js remains the parser, renderer, terminal state, graphics,
scrollback, and search implementation. Herdr's wire protocol is unchanged.

## Architecture

Before:

```text
SSH / Herdr Rust decode -> UniFFI callback -> Hermes callback queue
  -> JS encoding where needed + injection string -> RN WebView command -> xterm
```

After:

```text
SSH / Herdr Rust decode -> bounded Rust mailbox -> native borrowed UTF-8 batch
  -> Android JNI / iOS WebKit -> WebView -> xterm.write
  -> native completion credit -> Rust
```

React Native configures the renderer identity and delivery generation once per
attachment. The bundled document completes a native handshake before output is
admitted to the native consumer. Android uses its owned WebView's public
`evaluateJavascript` API. iOS uses `callAsyncJavaScript` with structured arguments.
Android returns ordinary write credits through a small `@JavascriptInterface`
method with two IDs, without serializing JSON. iOS returns structured messages
through `WKScriptMessageHandler`.

The installed react-native-webview 13.16.1 does not expose an owned native view
handle through its public React ref. A small patch adds creation, navigation,
background/resume, and destruction hooks. Whip owns all transport code outside
the dependency. This avoids private Fabric/view-registry lookups, React tags,
swizzling, a custom renderer, and another network connection. Existing browser
patches are preserved. The combined dependency patch applies successfully with
patch-package to reconstructed clean dependency files.

A missing native hook can select the bounded Hermes fallback during the initial
handshake. `EXPO_PUBLIC_WHIP_TERMINAL_BRIDGE_JS=1` selects that fallback for
comparison. `EXPO_PUBLIC_WHIP_TERMINAL_BRIDGE_LEGACY=1` selects the original
per-frame transport. These are build-time flags; rebundle explicitly when
changing them. Normal builds use native delivery on Android and iOS.

Hermes still handles navigation, visibility, renderer configuration, user input,
resize, protocol/presentation events, snapshots, the first live-state notification,
and sequence-recovery notifications. Diagnostic input/resize traces request only
the next relevant native frame; their completion does not gate native delivery.
There is no frame payload in React state and no new normal keystroke FFI call.

## Bounds, ordering, and lifecycle

Each renderer admits at most 64 chunks and 1 MiB of encoded payload, including
in-flight data. Raw chunks are at most 48 KiB; a batch contains at most 32 chunks
and 64 KiB of base64 data, plus metadata. The first batch dispatches immediately,
without a timer. After its first xterm acknowledgement, two batches may be in
flight to hide the credit round trip. One admitted publisher preserves order.
Herdr's separate upstream queue remains bounded at 64 frames / 8 MiB, with its
existing protocol-bounded oversized-frame allowance.

ANSI, SSH bytes, Kitty protocol bytes, and bells share that queue. Rust performs
encoding once before the native transport. The old Hermes binary encoding and
large-payload JSON/injection construction disappear from the normal path.
WebView uses `Uint8Array.fromBase64` where supported, with a byte-preserving
fallback. This is bounded, copied transport, not zero-copy binary transport.
Native string transfer and WebView decoding remain.

AndroidX message ports can offer binary payloads on supported WebViews, but need
feature detection and a port lifecycle/handshake. This implementation first
removes the measured Hermes scheduling delay through public native calls on both
platforms. Android base64 encoding is 0.017 ms median and WebView decoding is
0.2 ms p95 in this workload. These measurements do not yet justify another binary
transport and its compatibility path. WK structured arguments still carry the
bounded encoded payload; this implementation does not claim shared binary memory.

Both ends verify renderer identity and a monotonic delivery generation. Native
binding also verifies the key and identity against Rust's route. IDs stay decimal
strings in WebView messages, preserving u64 bits. Native view tokens identify
actual view lifetimes. Transport epochs independently fence reconnects. A stale
producer, batch, credit, or detach cannot target a replacement renderer.

The existing TerminalFrameSequence implementation is embedded into the document,
not reimplemented. Chunk sequence/full/final metadata remains intact. A gap asks
React Native for a repaint; completing a full baseline clears recovery
suppression. Resets drain earlier xterm writes before resetting the parser, so an
incomplete OSC/DCS cannot consume the repaint. SSH retains its existing local
scrollback policy. WebView reload replaces the generation without closing the
host connection and requests a Herdr baseline.

Native adapters accept only the exact bundled terminal document. iOS also checks
that messages come from its main frame. WebView references are weak. Navigation,
eviction, closure, module invalidation, and destruction close registrations and
wake blocked producers. Backgrounding pauses native admission; foregrounding
resumes bounded queued work. SSH backpressure runs on a blocking worker, leaving
Tokio's SSH input/resize writer independent.

## Ownership

The C ABI lends the serialized batch only for the synchronous native callback.
Android copies it into JVM-owned storage and constructs the injection string
before queueing UI work. iOS copies it into NSString before queueing a WebKit
call. Neither queued operation retains a Rust pointer, RustBuffer, JS callback,
or strong WebView reference. Queue credits bound queued native operations.

The existing UniFFI TypeScript `finally` buffer releases remain intact. A further
teardown leak was reproduced: generated native callbacks returned without freeing
incoming RustBuffers when their JS callback had already been cleared. The
**generator template** now frees those transferred arguments on that branch.
Generated files are regenerated through the build scripts. A compiled probe runs
four actual generated callback entry points 1,000 times after teardown, exercises
live callbacks, and detects missing or duplicate frees. It failed before the fix
and passes on arm64 mini with zero outstanding buffers after the fix.

The iOS module now implements React invalidation, matching Android's Rust UI
detach hook. Both platform adapters are explicitly preserved by the generator's
`noOverwrite` configuration.

## Measurements

Device: Pixel 9 Pro, Android 17, WebView 155.0.8059.43. Upload-signed arm64 release
builds use the same frozen source/UI/database schema and local skip-R8 setting.
The paired workload uses a dedicated pane: 600 x 32-byte writes at 16 ms, then
600 x 64-KiB writes at 16 ms, then a chunked PNG Kitty fixture with Unicode/BEL.
Producer backpressure is honored. Herdr redraw/coalescing means producer bytes
are not bridge bytes or maximum terminal throughput.

The native path has separate Rust decode/serialization/dispatch, native script
construction, native UI queue, injection, WebView receive, base64, xterm write,
and two-rAF counters/spans. Existing tracing names remain for the legacy path.
WebView receive timing uses same-device epoch clocks with millisecond resolution;
it includes native/UI scheduling before reception. Callback acknowledgement queue
delays are reported separately on the legacy path. Two-rAF acknowledgement is a
presentation proxy, not compositor-confirmed photon/display latency.

Paired device results and trace filenames are recorded in
[the measurement report](terminal-bridge-measurements.json).

| Metric | Legacy Hermes transport | Native transport |
| --- | ---: | ---: |
| Frame receipt to two-rAF acknowledgement, median / p95 | 28.003 / 48.428 ms | 15.841 / 24.630 ms |
| Rust decode, median / p95 | 0.013 / 0.018 ms | 0.013 / 0.018 ms |
| Unambiguous native-to-JS queue, median / p95 | 0.648 / 20.213 ms | No terminal frame callback |
| Local delivery to WebView, median / p95 | 5 / 10 ms | 1 / 6 ms |
| Observed payload over the 65-second suite | 1.384 MiB | 1.466 MiB |
| JS thread CPU, 25-second capture | 29.34% | 33.99% |
| App + associated WebView CPU, same capture | 128.74% | 162.45% |
| App RSS peak / final-third mean | 852.60 / 777.05 MiB | 1261.88 / 1193.34 MiB |
| Associated WebView RSS peak / final-third mean | 211.40 / 209.36 MiB | 211.83 / 210.85 MiB |

Latency starts at JS receipt for legacy and native callback entry for native;
legacy acknowledgements also wait for Hermes. Those rows are useful phase
observations, not a common socket-to-display A/B. Native xterm write completion
itself is 0.399 ms median / 2.100 ms p95. Legacy receive/visible acknowledgements
spend 22 / 23 ms p95 respectively waiting to reenter Hermes. The measured
scheduling tail, rather than Rust decode or base64, justified the native bypass.

CPU uses scheduler running time; 100% means one full core. Neither CPU capture
contains Whip phase tracing. WebView process IDs were associated with Whip through
Android service bindings, not inferred from Chromium process names. The native
process had a longer lifetime and different retained application work. Its app
RSS starts at 1150.21 MiB, peaks at 1261.88 MiB and ends at 1202.20 MiB; the final
third fluctuates around 1193.34 MiB. **No whole-app CPU, allocation-rate, or
sustained-memory improvement is established.** A longer soak with matched process
history and attribution of the remaining JS/UI work is still needed. RenderThread
and `mqt_v_js` remain the largest app CPU consumers. Further work should profile
those consumers before adding another transport.

The final 12-second lifecycle capture completed 707 native batches with zero
terminal-frame UniFFI callbacks. Output resumed after one second on Home. Four
bridge reattachments took 823.063 ms median / 960.939 ms p95. This is attachment
timing, not reconnect-to-visible timing. Native tab-switch and full network
reconnect latency were not measured; replacement/reconnect and multi-terminal
isolation have regression coverage. The continuous producer completed 37.5 MiB
in 10.097 seconds, but Herdr coalescing prevents treating that as bridge capacity.

The physical PNG fixture did not display an image on either transport. Unicode
and output completion appeared on both. This matches the existing Herdr
attachment limitation described in [terminal images](terminal-images.md);
graphics byte ordering passes regression tests, but physical image rendering is
not verified by this fixture.

The initial fallback batching comparison was mixed and did not justify retaining
Hermes scheduling in the frame path. The native prototype concretely removes that
queue: its first 15-second smoke capture completed 792 native batches with no
UniFFI terminal-frame callback executions, at 15.99 ms median / 25.37 ms p95 from
native callback entry to the native two-rAF acknowledgement.

Captures where the phone was being used, where an old pane had entered a file
browser, or where the trace ring discarded process metadata are excluded from CPU
comparisons. A larger trace buffer preserves metadata in longer captures. Native
and legacy latency markers have different start/acknowledgement boundaries; do
not turn their ratio into a socket-inbound-to-visible speedup claim.

Per-frame heap allocation counts and compositor presentation are not measured.
The allocation ledgers prove ownership cleanup, not allocator rate or stable
whole-app RSS. iOS arm64 Rust, generated callbacks, the native WebKit module, and
the patched WebView target compile on mini. iOS device performance verification
was skipped at the user's request.

## Validation and reproduction

The isolated terminal-only commit passed 814 Rust library tests (3 ignored),
TypeScript checks, all 78 focused Jest tests, and the compiled native callback
ownership probe. Its bindings were regenerated from the isolated Rust source so
uncommitted chat/title APIs are excluded. A separate full workspace run passed
841 Rust tests (4 ignored). The final native mailbox
suite passes 7 tests, including native attachment, wrong renderer/token credits,
borrowed-buffer copying, pause/resume, blocked-producer wakeup, and replacement.
Production Rust Clippy passes. The focused final TypeScript/Jest suite passes 78
tests; earlier broader terminal compatibility suites passed 755 tests. These cover
sequence recovery, UTF-8 and escape boundaries with real xterm, graphics/BEL byte
ordering, reload/reconnect, input, clipboard, search, scrollback, eviction, and
UniFFI happy/error/reentrant cleanup. TypeScript and focused ESLint checks pass.
Android upload-signed arm64 APK builds and device installation pass. The generated
native ownership probe and both iOS native targets compile/run as described above.

```bash
nix develop -c npm run benchmark:terminal-bridge
nix develop -c scripts/capture-android-perfetto.sh 25 artifacts/perfetto/terminal.perfetto-trace
# CPU/RSS capture without per-frame phase instrumentation:
WHIP_PERFETTO_PHASE_TRACING=0 nix develop -c scripts/capture-android-perfetto.sh \
  25 artifacts/perfetto/terminal-cpu.perfetto-trace
nix develop -c node scripts/benchmark-terminal-bridge.ts \
  --trace artifacts/perfetto/terminal.perfetto-trace \
  --trace-processor /path/to/trace_processor_shell --webview-pid VERIFIED_PID
# On the remote host, in an idle disposable shell only:
node scripts/benchmark-terminal-bridge.ts --workload small
node scripts/benchmark-terminal-bridge.ts --workload continuous
node scripts/benchmark-terminal-bridge.ts --workload graphics
# From the repo, with a native C++ compiler:
node scripts/check-terminal-callback-cleanup.ts /path/to/clang++
```

Verify the WebView renderer's association with Whip using
`adb shell dumpsys activity services io.github.kaminarios.whip`; do not attribute
other applications' renderer processes by name alone. For normal CPU comparisons,
exclude Whip phase tracing, then verify its absence in the capture. Keep the same
geometry, fonts, pane, foreground state, renderer limits, and producer.
The capture script uses 512 MiB for durations above 45 seconds; override with
`WHIP_PERFETTO_BUFFER_KB` when needed. Retain scheduler/process metadata when
analyzing longer captures.

Primary platform references:

- [Android WebView native API and threading](https://developer.android.com/reference/android/webkit/WebView)
- [Android message ports/binary payload alternatives](https://developer.android.com/reference/androidx/webkit/WebMessageCompat)
- [WebKit structured JavaScript calls](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:))
- [WebKit message handlers](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler)
- [Kitty graphics protocol fixture format](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
