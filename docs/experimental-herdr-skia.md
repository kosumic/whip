# Experimental Herdr Skia renderer

This is a default-off, single-pane Endpoint Protocol v1 prototype. The arm64 iOS simulator build and live SSH rendering have been verified on `mini`.
Physical-device rendering and comparative device performance remain unverified.

[Verified iOS simulator screenshot](assets/herdr-skia-ios-simulator.png)

[Current iOS simulator comparison](herdr-renderer-performance-dirty-regions-ios-simulator.md):
retained pixels, changed-span delivery, and cached shaping reduce continuous-redraw
client CPU from 84.5% to 24.7% of one core and picture preparation from 48.5 to
9.52 ms. Memory increases from 184.8 to 203.5 MiB. The typing proxy is essentially
unchanged, and Skia submits fewer updates than xterm. Keep xterm.js
as the default. The [original baseline](herdr-renderer-performance-ios-simulator.md)
remains available with its measurements.

## Architecture and integration boundary

Research used Whip's terminal host/screen, Rust codec, direct terminal lifecycle,
agent-view observer, UniFFI/JSI delivery, and performance tracing. Herdr was
refreshed to `2713feb` (`herdrdev/herdr`, master). The reference files were
`protocol/{endpoint,wire,surface_delta,surface_reuse,surface_scroll}.rs`,
`client/handshake.rs`, `client/shell/surface_patch.rs`, and
`server/headless/{render,surface_interest,endpoint_requests}.rs`.

The minimum integration consists of a new logical `Surface` SSH stream, a Rust
screen/connection object exported through the existing UniFFI JSI module, a
renderer selector, and one developer preference. The agent-order observer's
implementation and lifecycle are unchanged. Workspace control, agent operations,
event subscriptions, transcript collection, and session persistence continue to
use their existing paths. Ordinary SSH shells always select xterm.js.

`HerdrSurface` obtains the current HostRuntime's `HerdrConnection`, including its
authenticated SSH transport and socket discovery. It opens an independent,
long-lived length-prefixed client socket. The named `endpoint.hello.v1` control
negotiates generation 1 and exactly `shell.snapshot.v1`, `shell.surface.v1`,
`shell.input.semantic.v1`, and `shell.blob.v1`. The connection requests an active
surface; optional delta/reuse/scroll codecs are not offered. These codecs are
separate from the private direct-terminal protocol version.

Rust validates the welcome, snapshot boot/projection, complete frames, and core
`PaneSurfacePatch` messages. The decoder bounds frame bytes (2 MiB), dimensions
(1–1024), total cells (262144), grapheme bytes, hyperlinks, and patch collections.
Patch validation finishes before grid mutation. Patches require matching boot,
projection, base revision, and exactly the next surface revision. Errors freeze
input and expose recovery; they never recreate or close a remote pane.

The grid, Unicode symbols, packed colors, modifier bits, hyperlink table, cursor,
and revisions live in Rust. Presentation ticks pull accumulated dirty **cell spans**
through synchronous JSI at up to 30 Hz. Idle ticks return no payload. Multiple
patches can coalesce before a pull. Rust compares incoming full frames and patches
with the current cells, suppresses identical updates, and preserves revision
validation even when no presentation update is needed. Spans include adjacent
glyphs and wide-cell continuations so erasing text does not leave old ink.
Only initial attachment, geometry changes, or a new surface identity reset the
entire grid. Hyperlink metadata accompanies updates.

Skia retains a device-pixel-sized raster surface, replaces the pixels in damaged
spans, and presents a snapshot plus a separate cursor through its imperative view
API. Unchanged text is not repainted; cursor-only updates reuse the same snapshot.
The platform still composites the completed image, and raster snapshot
copy-on-write or texture upload may touch the full buffer. A bounded LRU cache
(2048 paragraphs and 64K UTF-16 key units) reuses shaped graphemes, and adjacent
backgrounds of the same color are painted together. There is no React component
per cell and no grid state in React. Skia paragraphs shape whole cell graphemes with
platform font fallback; backgrounds precede text so wide glyphs can span their
continuation cells. Font metrics and resize geometry are rounded to physical
pixels. Named/indexed ANSI and RGB colors, bold/italic/underline/inverse/hidden/
strike styles, and block/bar/underline cursors are supported. The renderer shares
xterm's Tokyo Night palette, transparent background, line-height setting, and
bundled JetBrains Mono, Nerd Fonts, Unicode-symbol and CJK faces. Its native
canvas preserves the normal Whip background, glass controls, tab rails, and
composer. Font loading completes before attachment, and mixed-script paragraphs
align to a common cell baseline. Blink and exact font parity still need device
validation.

The existing native keyboard and composer are reused. Rust classifies their
VT-shaped input events into semantic TextCommit/Key/Paste events; Herdr encodes
those events for the child application's keyboard protocol. Whip does not
synthesize child ANSI sequences. Unsupported key sequences return an error.
Composer paste parts remain separate paste events with spaces and one Enter.
External edits cross the same native IME barrier used by the existing renderer.
Scrollbar spans are validated against their own geometry as well as terminal rows.

Connection epochs reject late callbacks after detach/replacement. The shared
transport also guards SSH-generation callbacks. Polling detects replaced SSH
streams; transport errors retry with backoff, up to five failed attempts.
Background/hidden surfaces detach, and foreground surfaces attach anew. Switching
renderer does not report a transcript eviction. A visible fallback action returns
to xterm.js without uninstalling, replacing, or deleting the session.

## Shared-session behavior

An active endpoint is not a passive observer. Current Herdr promotes it to
foreground and may claim unowned tab geometry or resize shared runtime geometry.
Deactivation/detach can hand control back to another client. The developer setting
states this behavior. Use a dedicated single-pane test session first.

This prototype sends no pane-focus, tab-focus, layout, or terminal takeover
requests. It only accepts the pane ID already focused in the endpoint snapshot,
and refuses multiple panes/popups. Selecting a different pane in Whip does not
cause this endpoint to focus that pane on the server; attach reports an explicit
error instead. Active-client foreground/geometry effects remain a limitation of
this prototype, rather than a claim of fully isolated multi-client rendering.

## Enable and test

Build the GitHub distribution channel so developer options are available. A new
native build is required for Skia and the generated Rust bindings; a JavaScript
update alone is insufficient. Skia is pinned to `@shopify/react-native-skia`
2.14.0. Its published peer requirements match Whip's Expo 58 / React Native 0.88 /
React 19.3 / Reanimated 4.7 / Worklets 0.13 configuration. See the
[Skia installation documentation](https://shopify.github.io/react-native-skia/docs/getting-started/installation/).

1. Open **More → Settings → Developer**, enable developer options, and choose
   **Experimental Herdr Renderer → Skia**. The default is **xterm.js**.
2. Connect to a Herdr server supporting Endpoint v1. Start with a dedicated
   session whose active tab contains one focused pane; open that pane in Whip.
3. Type, use the special-key rail, paste from the composer, rotate, and
   background/foreground the app. Disconnect/reconnect the network. Check that
   the same pane and its contents survive.
4. On error, use **Retry Skia** or **Use xterm.js**. Selecting xterm.js in Settings
   disables the experiment persistently. Turning developer options off also
   forces the normal renderer.

Android developer build (upload signing configuration is required):

```bash
nix develop -c bash -c 'WHIP_DISTRIBUTION_CHANNEL=github android/gradlew -p android :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true'
```

For iOS, reuse `/Users/kosumi/repos/whip-ios-device` on `mini`, preserve its edits,
and run `scripts/install-ios-device.sh` through `ssh -A -t mini`. Use the GitHub
channel and set `WHIP_IOS_DEVICE` if necessary. The script installs in place and
never uninstalls. The task's original affected source files were backed up under
`build/skia-endpoint-source-backup` in that persistent worktree before merging.
The large original native framework backup was subsequently archived locally at
`.codex-skia-mini-framework-original/WhipSsh.xcframework` to free build space.
For simulator builds, follow the [README capture notes](../assets/screenshots/ios/README.md)
and retain the existing simulated Keychain group so saved-host authentication
remains usable. Build arm64 with the GitHub channel.

Offline checks:

```bash
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --offline herdr_surface
nix develop -c npx jest --runInBand __tests__/herdrSurface.test.ts __tests__/herdrSurfaceRenderer.test.tsx __tests__/skiaTerminalSurface.test.ts __tests__/herdrRendererBenchmark.test.ts __tests__/devicePreferences.test.ts __tests__/terminalRendererHost.test.tsx
nix develop -c npx tsc --noEmit
```

Optional real-server check creates and kills its own isolated temporary Herdr
server, with separate config/socket/runtime paths:

```bash
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --offline live_isolated_endpoint_roundtrip -- --ignored --nocapture
```

## Validation and measurements

On 2026-10-27, the isolated test passed against installed Herdr 0.9.5: generation 1
handshake, full surface, semantic paste/Enter, colored Unicode output, live patch
application, resize, detach, and reconnect to the same pane. This test uses a local
Unix socket. Ten deterministic surface tests and twelve existing codec tests pass.
The focused JavaScript suites pass 152 tests, including shared palette and inverse
color checks; TypeScript and targeted ESLint checks
also pass.

The retained-pixel and corrected-input pass additionally verifies thirteen Rust
surface tests and 67 focused JavaScript tests. The current benchmark requires
standalone output markers and a successful seq exit. It fixes swapped Ctrl/Alt
bits in the original prototype; the old Skia seq measurement is invalid and is
annotated in the baseline report and JSON.

The iOS Release app was built thin arm64 on an Apple M4 Mac mini using Xcode
27.1 and installed in place on an iPhone 17 Pro simulator running iOS 26.5.
A separate smoke app identifier preserved the normal app sandbox. The production
Skia component and Rust/UniFFI transport connected to a dedicated Herdr 0.9.1
server through a loopback SSH daemon with an ephemeral key. XCTest verified
native keyboard typing, semantic composer paste completion, resize, detach/reattach,
and zero WebViews. Visual inspection confirmed colors, cursor, CJK, combining
accent, and emoji rendering (see screenshot). Server readback confirmed `echo hello` and colored output
containing CJK, combining accents, and a joined skin-tone emoji. The fixture shell
needed a UTF-8 locale; macOS readline in the C locale interpreted Unicode bytes
as edit commands. The normal app was also built and launched with xterm.js as its
default. These initial checks validated the renderer/transport vertical slice
through an isolated harness.

A follow-up arm64 Release build exercised the normal saved mini host, developer
setting, terminal rails, and native composer with the README preview's saved
waterfall background and glass appearance. The live surface displayed the shared
JetBrains Mono font, ANSI colors, CJK, combining accents, and emoji. XCTest
verified composer submission, no WebViews, no renderer error, and dismissal of
the connection banner. A separate native key-tap check entered `echo ready` and
confirmed its output visually, with the keyboard and composer closed for capture.
This caught a missing connection-status callback: Skia
now reports connected after submitting its first picture, enabling the normal
keyboard controls, and reports cursor geometry for keyboard viewport adjustment.
The screenshot above shows this normal app, rather than the initial debug
harness. The successful normal-app results remain in the mini worktree at
`build/skia-ui/normal-native-v6.xcresult` (composer) and
`build/skia-ui/normal-keyboard-v8.xcresult` (direct keyboard).
Physical-device behavior remains unverified.

A subsequent XCTest stress run passed `seq 1 100000` and finite continuous output
(100 lines at 50 ms intervals), checking completion markers through the management
API. It also exercised vim enter/exit, four rapid viewport changes, landscape and
portrait orientation, and actual SSH loss/recovery by killing only authenticated
sshd sessions on the dedicated fixture port. No WebView was present and the same
pane remained attached. Explicit HostRuntime.disconnect ends a runtime; it is not
a valid simulation of transient network loss.

The simulator exposed and helped fix native-path issues: ParagraphBuilder has no
native `dispose()` in Skia 2.14; scrollbar cell patches occur outside the pane
inner rectangle; and keyboard commands must wait until Expo registers the Fabric
input view. Each keyboard attachment has a unique binding. Transport recovery
notifies readiness again, and typing during attach/backoff does not cancel that
connection attempt. Detailed native error reasons are preserved for visible
errors and transport retry classification.

A same-pane integration check also passed switching Skia → xterm.js → Skia,
including an xterm composer submission and server readback. The existing WebView
was present for xterm and absent after returning to Skia; the remote pane was
retained. This is functional baseline validation, not a performance comparison.

The reproducible microbenchmark is:

```bash
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --offline benchmark_surface_model -- --ignored --nocapture
```

Historical measurements before changed-span delivery, on an AMD Ryzen 7 8845H,
x86_64 Linux 6.18.56, Rust debug test build,
80×24 synthetic fixture, with the repository's allocation-counting allocator:

| Model operation | Time | Allocations | Allocated bytes | Peak live increase |
| --- | ---: | ---: | ---: | ---: |
| Original full decode/apply/dirty-row serialization | 7.395 ms | 1303 | 624380 | 362364 B |
| 1000 one-cell patches, including fixture generation and dirty-row serialization | 238.273 ms total | 17751 | 16606064 | 8318 B |

Those patches comprised 34002 encoded payload bytes and 7049896 bytes of bridge
JSON. They identified amplification for isolated cell changes in the original
row bridge; the current implementation sends changed spans instead. The
benchmark excludes SSH, server rendering, React Native, Skia,
GPU/compositor presentation, and device CPU/memory costs.

The following table concerns physical devices. See the separate simulator
comparison above for measured host-process counters and presentation proxies.

| Physical-device metric | xterm.js | Skia |
| --- | --- | --- |
| First visible frame latency | Not measured | Not measured |
| Input-to-visible latency | Not measured | Not measured |
| Sustained FPS | Not measured | Not measured; presentation pulls capped at 30 Hz |
| JS thread CPU | Not measured | Not measured |
| Native CPU | Not measured | Not measured |
| Memory consumption | Not measured | Not measured |
| Network bandwidth | Not measured | Not measured |

No Android device was attached locally. `mini` was reachable, but its physical
Apple devices were listed as unavailable; connected entries were simulators.
No physical-device performance results are claimed. The arm64 Android native
compilation also succeeded, but APK packaging failed with a Java heap exhaustion
in Gradle; no successful Android install is claimed.

Before the font-parity follow-up, one warmed simulator typing/paste/resize run recorded 18 picture submissions,
33.44 ms total picture-recording time (9.45 ms maximum), 284990 bridge UTF-16
code units, and 30054 inbound protocol payload bytes. Rust reported 4 full frames,
14 patches, 246 µs cumulative decode/apply time, and 73.607 ms to the first model
frame. These are an instrumented smoke-run sample, not steady-state FPS, network
usage, compositor-visible latency, server CPU, or a comparison with xterm.js.

Simulator XCTest results are retained on `mini` in
`build/skia-ui/validation-clean.xcresult` (all three integration tests) within the
persistent iOS worktree. The stress interval recorded 118 submissions,
1320.14 ms cumulative picture recording (17.43 ms maximum), and 4462677 bridge
code units. Its last logged native attachment recorded 110631 payload bytes,
11 full frames, 114 patches, and 4502 µs decode/apply time. Layout/app-state
changes create attachment boundaries, so those native counters do not represent
the entire stress run.

The renderer emits existing Android performance-trace slices named `Whip Skia
attach to first picture submitted` and `Whip Skia input to next picture submitted`.
The latter ends on the next surface presentation submission; it does not prove
that a particular key's echo was presented. On detach, `[Whip Skia metrics]`
logs aggregate picture-recording time/count, bridge string length (UTF-16 code
units), and Rust payload bytes/full frames/patches/decode-apply time/first-model-
frame time. Native picture submission is not compositor-visible completion.

For a real comparison, use the same device, font/grid, SSH connection and test
session for both renderers, record device/OS/build/thermal state, and exercise:
idle; interactive typing; `seq 1 100000`; sustained output; vim/htop; combining,
CJK and emoji output; rapid orientation/tab changes; and network loss/reconnect.
Use the existing `scripts/capture-android-perfetto.sh` and performance tracing for
Android, and Instruments for iOS. Record remote Herdr CPU/RSS separately from app
CPU/RSS, plus socket/network bytes, so server rendering cost is not attributed
to the client. Run production-optimized builds for the eventual performance
comparison; local `whip.skipR8` installs are for development only.

## Scope and recommendation

Deferred: mouse/gesture parity, scrollback/navigation, selection/clipboard copy,
hyperlink activation (metadata is retained), image/Kitty graphics, multiple panes,
popups, search/link scanning, dictation context, cursor blinking, and optional
surface codecs. Skia font fallback, wide/emoji appearance, rapid orientation,
keyboard behavior, and reconnect still need physical-device inspection. Rapid
switching among real saved-host tabs and complete mobile gesture parity remain
untested. Dirty rows
reduce cell shaping work, but the composed picture still redraws the viewport;
this is not GPU damage-region rendering or a zero-copy native grid bridge.

Keep xterm.js as the default. The endpoint protocol provides a viable rendering
boundary, and live protocol/model validation supports continuing the experiment.
Migration is premature until a physical device passes the vertical slice, shared
geometry behavior is acceptable, missing interactions are covered, and measured
latency/CPU/memory/bandwidth justify the extra native dependency. The current
row-serialization amplification is a concrete reason to evaluate a more compact
bridge before interpreting any FPS improvement as an overall win.

## Changed source groups

- `rust/src/herdr_surface.rs` and `herdr_surface/{model,input,tests}.rs`: connection,
  bounded model/patch decoder, semantic input, deterministic/live tests, benchmark.
- `rust/src/{herdr_codec,herdr_connection,host_runtime,lib}.rs`: shared codec access,
  surface stream kind/current-generation check, connection accessor, exports.
- `react-native-whip-ssh/src/index.ts`, generated TypeScript and C++ bindings:
  exports through the existing JSI module.
- `src/components/{TerminalRenderer,SkiaTerminalRenderer}.tsx` and
  `src/lib/{herdrSurface,skiaTerminalFonts,terminalAppearance}.ts`:
  selection/recovery, native picture rendering, shared fonts and colors.
- `scripts/sync-terminal-assets.ts` and `assets/terminal-fonts`: shared xterm/Skia
  appearance constants and native versions of the existing bundled font faces.
- `TerminalRendererHost.tsx`, `TerminalScreen.tsx`, `AppShell.tsx`,
  `SettingsScreen.tsx`, `devicePreferences.ts`: small integration/flag/input hooks.
- `package.json`, `package-lock.json`: pinned Skia dependency.
- `__tests__/{herdrSurface.test.ts,herdrSurfaceRenderer.test.tsx,devicePreferences.test.ts}`:
  surface/selection/recovery and preference regression coverage.
- `ARCHITECTURE.md`, this document, and `docs/assets/herdr-skia-ios-simulator.png`:
  integration summary, validation, limitations, measurements, and simulator evidence.
