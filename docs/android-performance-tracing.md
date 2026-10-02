# Android terminal latency tracing

Whip emits correlated Android app async trace slices that Perfetto records only
while tracing is enabled. When Perfetto is inactive, passive inbound frames do
only a JS timestamp/branch and probe native `Trace.isEnabled()` at most once per
second; they create no timers, cookies, or slices. Once a capture is detected,
every inbound frame is traced until the native trace probe reports disabled.

Capture a trace with one authorized Android device connected:

```bash
nix develop -c scripts/capture-android-perfetto.sh 20
```

For a repeatable physical-device capture that injects cold/warm input, rotates
the phone, analyzes both paths, and publishes a GitHub Actions summary, see
[Android terminal latency action](android-performance-action.md).

For passive inbound tracing, start continuous output in a real or disposable
Herdr terminal and leave the phone untouched:

```bash
while true; do date +%s%3N; sleep 0.05; done
```

Open the resulting
`artifacts/perfetto/*.perfetto-trace` file in <https://ui.perfetto.dev>.

The app-defined slices divide perceived latency into these intervals:

Startup and application-work slices:

- `Whip startup to first tab`: storage hydration through the first selected tab's
  committed mount.
- `Whip startup storage hydration`: the shared multi-get plus host metadata and
  preferences required to leave the loading screen.
- `Whip startup store: multi-get`: the single AsyncStorage bridge call that
  fetches every startup key.
- `Whip startup store: <store>`: parsing or applying hosts, preferences, known
  hosts, live-host IDs, terminal history, credential status, or the versioned
  credential-backup migration. Noncritical stores begin after the first tab.
- `Whip startup restore live hosts`: reconnecting all persisted live hosts and
  restoring their snapshots and terminal state.
- `Whip startup restore: <stage>`: overlapping per-host credential, jump-host,
  SSH, initial-snapshot, terminal-state, event-stream, and reconciliation work;
  biometric approval is traced once when required.
- `Whip first tab mount: <tab>`: the first committed mount of each lazily loaded
  primary tab.
- `Whip host snapshot refresh`: a complete coordinated host snapshot request and
  application pass.
- `Whip transcript initial parse`: resolving, streaming, and normalizing the
  initial Codex rollout history.

Terminal interaction slices:

- `Whip terminal tab selection to renderer entry`: starts immediately before
  `SessionScreen.chooseTab()` or `choosePane()` publishes the selected terminal
  into React state and ends when `TerminalRendererHost.ensureEntry()` reaches
  that terminal. It is
  present on cold and warm selections and isolates selection/state propagation
  from renderer and bridge work.
- `Whip terminal renderer readiness`: cold-only; starts when a previously unseen
  `RendererEntry` is created and ends only after both `terminal-ready` and the
  first usable size message have arrived.
- `Whip terminal xterm creation`: cold-only; entry creation through the embedded
  terminal's `terminal-ready` message. It includes the terminal asset's font-ready
  wait (or its 1.5-second fallback), xterm/addon construction, `terminal.open()`,
  and the WebView-to-React Native ready callback.
- `Whip terminal initial size measurement`: cold-only; entry creation through the
  first fit/xterm size received by `TerminalRendererHost`.
- `Whip terminal bridge attach`: cold-only; starts immediately before
  `HerdrClient.openTerminal()` begins its unretained `attachTerminal()` task and
  ends when that task settles after the initial resize enqueue.
- `Whip Herdr bridge channel open`: cold-only; the native
  `openLengthPrefixedUnixSocketChannel()` call, including the SSH streamlocal
  channel open, until the channel is ready.
- `Whip Herdr bridge hello to welcome`: cold-only; starts before enqueueing Herdr
  Hello and ends when a valid Welcome is decoded (or negotiation fails).
- `Whip Herdr terminal attach`: cold-only; the Herdr Attach frame's local/native
  enqueue. The protocol has no Attach acknowledgement, so remote Attach handling
  remains combined with the following initial-frame/initial-resize intervals.
- `Whip Herdr terminal initial resize`: cold-only; the explicit Resize enqueue
  performed after the cold bridge has completed Attach.
- `Whip terminal cold input to writable`: cold-only per input; starts at
  `TerminalRendererHost.enqueueInput()` when the entry is not writable and ends
  immediately after `waitForWritable()` resolves, before takeover resize or input
  send. Multiple characters typed during the same cold wait produce multiple
  correlated samples, including their input-queue ordering delay.
- `Whip terminal input to native dispatch`: React Native handling through creation
  of the Rust/SSH write promise. This is local app overhead and does not await the
  transport operation.
- `Whip terminal app pre-native wait`: app-owned terminal bridge readiness and JS
  scheduling between creation of the write promise and entry into native code.
  Retained bridges bypass the asynchronous readiness path.
- `Whip terminal native enqueue`: Whip's call through the JSI/UniFFI fast path,
  including Rust validation, length-prefix framing, and enqueueing the bytes for
  russh. It ends before russh performs the network write.
- `Whip terminal native queue to response`: time after the Rust queue accepts the
  input until the first terminal response reaches Whip's `HerdrClient`. This
  intentionally treats russh as a black box and therefore contains the russh
  write/read, network RTT, remote processing, inbound FFI callback, and private
  Herdr frame decoding.
- `Whip terminal native response to renderer`: Whip's synchronous delivery of the
  decoded frame from `HerdrClient` through the React Native renderer callback and
  WebView injection call.
- `Whip terminal input to first frame`: input handling until the first SSH terminal
  output reaches the renderer. This contains transport RTT and remote processing.
- `Whip terminal frame to visible`: React Native frame handling, WebView injection,
  xterm parsing, and two animation-frame boundaries.
- `Whip terminal input to visible`: the complete measured user-visible path.

Resize interaction slices:

- `Whip terminal resize request`: every cold or warm resize message, from entry
  into the React Native `TerminalRendererHost` handler until immediately before
  Whip attempts the resize or deliberately filters it. The matching instant-sized
  `Whip terminal resize event: #<n> <source> <cols>x<rows> ...` marker carries the
  capture-local sequence, source, dimensions, cell pixels, WebView-to-host queue
  delay, and (for `fit`) the measured local `fit.fit()` duration. Add the latter
  two values to this slice when investigating the decision-to-attempt interval.
- `Whip terminal resize: fit` and `Whip terminal resize: xterm`: preserve the two
  existing sources and span the complete React Native handling of each request.
  A resize synchronously emitted by xterm while Whip is already running
  `fit.fit()` is suppressed because the following `fit` message carries the
  same dimensions plus cell size and local-fit timing. Genuine xterm-driven
  resizes outside that fit call remain visible. Comparing the remaining counts
  and chronological detail markers exposes distinct `fit -> xterm -> fit -> ...`
  bursts.
- `Whip terminal resize wait for writable`: starts as `HerdrClient` receives the
  resize. On a retained bridge it ends immediately before native dispatch. On a
  cold bridge it remains open across channel open, Hello/Welcome, and Attach, and
  ends immediately before the post-Attach initial Resize dispatch.
- `Whip terminal resize native dispatch`: the call into `resizeShell()` or
  `herdrBridgeResize()` through completion of its native enqueue promise.
- `Whip terminal resize to first frame`: starts immediately before the native
  resize call and ends when the first later terminal frame reaches the renderer.
  It intentionally combines native enqueue, SSH/network time, remote PTY resize
  processing, and inbound decode because Herdr has no resize acknowledgement.
- `Whip terminal resize frame to visible`: first renderer-bound response frame
  through WebView delivery, xterm parsing, and the existing two
  `requestAnimationFrame` callbacks.
- `Whip terminal resize to visible`: native resize call through the same visible
  acknowledgement. Together with request/local-fit/queue/writable-wait slices it
  gives the total perceived resize path without counting superseded requests as
  native sends.
- `Whip terminal resize superseded`: instant marker for a cold resize request
  replaced by newer dimensions before any native Resize was dispatched. Compare
  request/source samples, superseded count, and native-dispatch samples to decide
  whether first activation sent redundant resizes or merely calculated them.
- `Whip terminal resize deduplicated`: instant marker for a request whose full
  normalized tuple (`columns`, `rows`, cell width, and cell height) exactly
  matches the last resize already dispatched for that terminal. It ends the
  request without a native call. Ordinary fit requests use this filter. Fits
  with unchanged effective geometry are acknowledged inside the renderer
  without emitting a resize request. Explicit sequence recovery and ownership
  takeover still bypass the filter to request a full frame or reassert sizing.

Resize-to-frame correlation is FIFO per renderer because the Herdr terminal
protocol has no resize request ID or acknowledgement. Capture an otherwise idle
terminal when attributing a returned frame to a particular resize; unsolicited
output can end the response slice early, just as it can for input tracing.

Passive inbound terminal slices (these do not require an input event):

- `Whip terminal inbound Rust frame received`: an instant-sized synchronous
  slice emitted immediately after Rust finishes a length-prefixed frame. It
  ends before the bounded delivery queue can await capacity.
- `Whip terminal inbound Rust frame delivery`: runs on the owned-buffer delivery
  worker and includes synchronous event-sink delivery.
- `Whip terminal inbound native to JS`: the generated UniFFI C++ call around
  `invokeBlocking`; a spike here is direct evidence that the socket task is
  waiting for JS callback entry or synchronous JS callback work.
- `Whip terminal inbound JS receive`: an instant-sized marker at the first JS
  instruction reached by `unix_socket_channel_data`.
- `Whip terminal inbound JS decode`: event dispatch plus Herdr binary decode.
- `Whip terminal inbound renderer dispatch`: decoded frame delivery to
  `TerminalRendererHost`.
- `Whip terminal inbound WebView injection`: the synchronous
  `injectJavaScript()` call itself.
- `Whip terminal inbound WebView delivery`: injection start until React Native
  receives the WebView acknowledgement emitted on entry into `herdrWrite` or
  `herdrWriteBase64Chunk`. This includes WebView-to-RN message scheduling.
- `Whip terminal inbound xterm write`: the write-entry acknowledgement until
  React Native receives the acknowledgement emitted by `xterm.write`'s
  completion callback. This can also include RN callback scheduling.
- `Whip terminal inbound xterm to visible`: xterm completion through the two
  existing `requestAnimationFrame` boundaries.
- `Whip terminal inbound frame to visible`: the correlated end-to-end JS/WebView
  span. Its cookie is carried with the frame without copying terminal bytes.
- `Whip exec inbound Rust chunk received`: an instant-sized slice immediately
  after a persistent SSH exec channel reads a chunk. Codex transcript streams
  use this path rather than the terminal Unix-socket path.
- `Whip exec inbound Rust chunk delivery`: synchronous delivery of an owned
  exec-channel chunk to the UniFFI event sink.
- `Whip exec inbound native to JS`: the generated UniFFI blocking callback wait
  for `exec_channel_data`. A burst here can occupy the JS thread and delay an
  otherwise decoupled terminal delivery worker.

Background-work correlation slices:

- `Whip host latency state apply`: starts when a completed RTT probe publishes
  its low-priority React state update and ends after that state commits. Terminal
  callbacks should remain short even when this slice spans a long transition.
- `Whip terminal offline cache serialize`: covers xterm serialization after an
  output burst or at a lifecycle boundary. It starts from the WebView's
  pre-serialization message and ends when React Native receives the bounded,
  OSC-sanitized snapshot, so spikes include serialization and bridge delivery.
- `Whip terminal sequence recovery`: covers the event-driven same-size resize
  request used to obtain a full visible repaint after a terminal frame gap.
  Normal connected operation performs no recurring `pane.read` cache refresh.

The native callback markers are documented diagnostic edits in generated
`packages/react-native-whip-ssh/cpp/generated/whip_ssh.cpp`, because the
current UniFFI generator exposes no callback wrapper/template hook. Regenerating
the binding must reapply the small `AndroidTraceSection` wrappers around method
1 (`unix_socket_channel_data`) and method 2 (`exec_channel_data`). They
intentionally retain `invokeBlocking` and their RustBuffer lifetime semantics.

For the debug-only render-drop A/B experiment, rebuild the debug app with:

```bash
EXPO_PUBLIC_WHIP_TERMINAL_RENDER_DROP=1 nix develop -c npm run android
```

This still receives and decodes terminal frames and crosses into the WebView,
but acknowledges the trace without calling `xterm.write()`. The switch is false
by default and is ignored in release builds. Rebuild without the variable for
normal rendering.

## Cold-versus-warm reproduction

1. Connect to a host and leave the SSH/Herdr connection alive.
2. Ensure several remote tabs already exist. Pick one Whip has never visited
   during this connection; do not create a new tab.
3. Start a 20-second capture:

   ```bash
   nix develop -c scripts/capture-android-perfetto.sh 20
   ```

4. Open the untouched existing tab, immediately type `aaaaa`, and immediately
   rotate the device, change the available terminal size, or trigger Whip's fit
   path. Wait until the terminal is clearly live.
5. Switch away and return to the same tab, type `bbbbb`, and repeat the same
   resize operation before the capture ends.

To write to a fixed output path for repeatable analysis:

```bash
nix develop -c scripts/capture-android-perfetto.sh 20 artifacts/perfetto/cold-warm.perfetto-trace
```

Open the trace at <https://ui.perfetto.dev>, open **Query (SQL)**, and paste the
contents of `scripts/analyze-android-perfetto.sql`. With an installed Perfetto
`trace_processor_shell`, the equivalent command is:

```bash
trace_processor_shell -q scripts/analyze-android-perfetto.sql artifacts/perfetto/cold-warm.perfetto-trace
```

The SQL reports samples, timeout and capture-incomplete counts, p50, p95,
average, minimum, and maximum for terminal/cold-open/resize phases, followed by
a chronological resize-event ledger containing source and dimensions.
Ten-second timeout sentinel slices are excluded from latency percentiles and
counted separately. The capture also includes Android FrameTimeline data for
checking missed application and SurfaceFlinger frames around slow samples.
If the local write and frame-to-visible slices are each around one display frame
or less while input-to-first-frame is near the measured 70–150 ms host RTT, the
network dominates. If either local slice is repeatedly tens of milliseconds,
inspect its JS, WebView, CPU scheduling, and frame-timeline tracks before treating
the app cost as negligible.

The passive diagnostic adds Android-only markers to the merged Whip Rust core
at frame completion and at the generated callback boundary. The callback itself
retains its blocking buffer-ownership contract.

Inbound callback delivery is decoupled from socket I/O. Each Unix-socket
channel splits its read and write halves, queues complete owned frames in order,
and invokes the existing blocking UniFFI callback from a delivery worker. The
queue is bounded to 64 frames and 8 MiB of completed-frame data; a frame larger
than 8 MiB reserves the entire byte budget until its callback returns. When the
queue fills, only the inbound reader backpressures. Outbound input, resize, and
close commands continue on the independent writer task. `invokeBlocking` is
retained so RustBuffer ownership remains valid through callback return.

The terminal protocol cannot identify which PTY output byte was caused by a
specific input byte. The trace therefore pairs each input with the first subsequent
terminal frame. Capture on an otherwise idle terminal for an accurate interaction
measurement; unsolicited agent output can end a slice early.
