# Reverse Control Browser and Device Tools

A Codex or OpenCode (v1 or v2) launch can opt into Reverse Control in the command launcher. The toggle
starts off; unsupported agent commands do not offer it. Open Browser appears for the
pane associated with that launch. Closing the browser hides its presentation;
it does not close its tabs. Terminal web links use the same controller when that
pane has Reverse Control, and the same browser subsystem for ordinary previews.

## Ownership and transport

`HostRuntime` owns a Rust `ReverseControl` manager. It binds an HTTP MCP listener
to a random **phone loopback** port, then requests a random **remote loopback**
port using reverse TCP forwarding over the existing SSH connection. One listener
and forward are shared by opted-in agent launches on that host. No additional remote
executable, Node.js installation, temporary files or permanent configuration are
needed. The SSH server must permit reverse TCP forwarding (`AllowTcpForwarding`).

Each launch gets an unpredictable session id/token and configuration for
`http://127.0.0.1:<remote-port>/mcp/<session-id>`, with a per-launch Authorization
header. Codex receives inline `codex -c` overrides. OpenCode receives
`OPENCODE_CONFIG_CONTENT` through `env`, scoped to the launched process. Its
`whip` MCP entry uses the remote transport, bearer headers, disabled
OAuth and a 25-second timeout. Global/project configuration and integration
plugins still load normally; an existing inline environment override is replaced
for that process.

The agent also receives its host-side MCP URL, bearer authorization, session id,
and negotiated protocol version in the server's initialization instructions and
the `browser.list_tabs` tool description. Both include a shell-quoted `curl`
example so the agent can call `tools/list` and `tools/call` from scripts on the
SSH host using the already initialized session. Script requests share the
agent's authorization and lifetime; they must use unique ids for concurrent
calls and must not DELETE the shared session when a script finishes. These
credentials stay out of webpage JavaScript and are returned only to authenticated
clients with `Cache-Control: no-store`; the manager still stores only token hashes.

Rust detects `opencode --version` through the host login shell using the same
version parser as Chat View. V1 uses its normal local process. V2 receives
`--standalone` to create a server owned by that launch, ensuring its inline
configuration is applied and keeping credentials out of a shared service.
V2 normalizes the v1 MCP configuration shape into `mcp.servers`. Unknown versions
and attach/server options are rejected. Herdr's `agent.start` API has no
environment field, so OpenCode launches through shell-quoted pane input and
uses Herdr's normal OpenCode detection and installed integrations. Codex keeps
the managed `agent.start` path. Session cleanup matches the launched agent kind
and original terminal identity.

Both agents speak Streamable HTTP MCP directly:

```text
Agent → remote loopback port → existing SSH connection
      → phone loopback HTTP MCP listener → browser controller → WebView
```

Rust authenticates each request with a constant-time token-hash comparison and
checks the MCP session identity. It rejects browser Origin headers, unexpected
Host headers and ambiguous authorization/session headers. Body sizes, read
times, pending actions and concurrent connections are bounded. Initialize and
tool calls return JSON; notifications return 202, GET returns 405 (no SSE), and
authenticated DELETE terminates only that launch. There are no server-initiated
MCP requests. RPC ids are scoped per launch, including concurrent calls from two
agents using the same JSON-RPC id.

`src/browser/registry.ts` binds the authorized launch to a `BrowserController`.
`BrowserSurface` under AppShell keeps WebViews mounted for all live tabs. Browser
UI actions and MCP actions use the same controller and WebView handles; changing
hosts or closing the browser surface does not swap the underlying browser.

AppShell supplies browser runtimes for both `connected` and `ready` SSH hosts.
Herdr snapshot refreshes temporarily change a connected host from `ready` to
`connected`; filtering on `ready` alone incorrectly called `closeHost`, hid the
browser, and recreated an empty tab when readiness returned. The browser surface
regression exercises this refresh with a visible YouTube tab and verifies that
its controller, driver, URL and visibility survive, while an SSH reconnect still
disposes them. This follows OpenMinis's stable ViewModel-owned browser pool and
separate sheet dismissal, inspected at commit
`b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c` in `ChatViewModel.kt` and
`ChatViewModelUiStateExt.kt`.

The shared Rust, controller, registry and DOM layers do not depend on Android.
`BrowserDriver` is the platform boundary. Android currently implements it using
`WhipBrowserModule`, which resolves a React Native WebView handle, evaluates the
fixed DOM program, draws a viewport screenshot and clears site data. iOS uses
`ios/HerdR/WhipBrowser.m` against the existing WKWebView, resolving the enclosing
Fabric view through React Native's view registry. Both adapters expose the same
JSON evaluation and bounded JPEG screenshot contract, enabling the existing
launch/UI capability gate without changes to the SSH/MCP protocol.

iOS retains the installed WebKit user agent for Mobile and its engine version
with a Mac platform for Desktop. Content-process termination follows the shared
renderer recovery path. The WebKit-only App Transport Security exemption allows
user-selected HTTP websites and SSH-forwarded previews; other networking retains
its existing ATS policy. See [Apple's web-content ATS documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloadsinwebcontent).

Navigation uses the native WebView load operation, including from the address
bar. The address bar accepts search terms as well as URLs. More → Browser saves
the search engine (Google by default, DuckDuckGo, Bing or Brave). Only submitted
queries navigate to the provider; typing does not request search suggestions.
Search operators and Unicode/punctuation are encoded as query text. Blank input
does nothing, and unsafe/credential-bearing URLs are rejected rather than sent
to search. Agent `browser.navigate` retains its URL-only behavior.
Bare domains receive HTTPS; bare localhost/private addresses receive HTTP
and use SSH preview forwarding. Unsupported schemes and credential-bearing URLs
are rejected. A new blank tab is usable immediately after its driver mounts;
actions do not depend on the UI loading indicator. Navigation waits for the new
document to become interactive rather than for every subresource to finish,
and checks document identity so an old blank-page completion cannot resolve it.
Driver attachment waits for native layout, because React effects can run before
the native WebView is mounted. Preparation failures wake waiting actions with a
recoverable renderer error; Reload retries preparation on the same tab.
WebView load errors and action timeouts are reported separately from cancellation.

## Device tools

The same authenticated MCP server also exposes phone tools to opted-in launches:

| Tool | Arguments | Result |
| --- | --- | --- |
| `device.info` | `{}` | Platform, OS version, model, manufacturer, app version, locale and time zone; no unique device identifiers. |
| `device.battery` | `{}` | `level` from 0 to 1 (or null when unknown), `state` (`unknown`, `unplugged`, `charging`, `full`), and `low_power_mode`. |
| `device.location` | `{}` | One fix with `latitude`, `longitude`, `accuracy_m`, and `timestamp_ms` (Unix milliseconds). |
| `device.haptic` | `{ "style": "light" }` | One short haptic; styles are `light`, `medium`, `heavy`. The OS may suppress physical feedback. |
| `device.clipboard_read` | `{ "max_chars": 16384 }` (optional) | Foreground clipboard text and a `truncated` flag; read limits are 1–16384 characters. |
| `device.clipboard_write` | `{ "text": "..." }` | Replaces foreground clipboard text, up to 16384 characters. Empty text clears it. |
| `device.notify` | `{ "title": "Build finished", "body": "All checks passed" }` | One immediate local notification; returns `notification_id`. Title/body limits are 160/4096 characters. Tapping returns to the originating pane. |
| `device.speak` | `{ "text": "Build finished", "language": "en-US", "rate": 1 }` | Starts speech and returns `{started:true}`. Language is optional; rate defaults to 1 and accepts 0.5–2. Text is bounded to 2000 characters. |
| `device.stop_speaking` | `{}` | Stops only speech owned by this launch; returns whether speech was stopped. |
| `device.network` | `{}` | Connection type, connected, internet reachability, expensive/metered status and low-data mode. |
| `device.sensor_snapshot` | `{ "sensor": "accelerometer" }` | One accelerometer, gyroscope, magnetometer or barometer reading. Returns `sensor`, `timestamp_ms`, `unit` and `reading`. |

| `device.motion` | `{}` | One Expo DeviceMotion snapshot: orientation, attitude/rotation, rotation rate, acceleration, acceleration including gravity and timestamps. |

Device calls return structured `{kind: "device.<tool>", value: ...}` content and
use the existing authorization, request quotas, 20-second deadline and MCP
cancellation path. They do not require a browser tab. Rust validates arguments
and results; React Native dispatches native operations. Android and iOS adapters
read battery/device metadata and obtain location using platform APIs. Haptics use
the existing Expo adapter. Clipboard and notifications reuse existing packages;
speech, networking and raw sensor sampling use platform APIs. DeviceMotion uses
the SDK-compatible `expo-sensors` package.

Clipboard reads may show the platform's paste permission sheet. Clipboard text
is bounded without splitting surrogate pairs. Notifications request OS permission
when needed; a permission prompt requires Whip foregrounded, while posting with
an existing grant works in the background. Notifications use a separate ordinary
Android channel and the existing app presentation handler. Cancellation before
posting prevents delivery; if cancellation races delivery, Whip cancels/dismisses
that notification. An alert already seen cannot be undone.

Speech has a dedicated native synthesizer and one owner across reverse-control
launches. Another launch cannot stop or replace the owner's speech. A completed
utterance releases ownership; explicit stop, session teardown and a 60-second
limit also stop it. Android waits for engine initialization before acknowledging
start, and cancellation during initialization prevents late playback. These
operations do not call the shared Expo speech player's stop function.

Network results expose no SSID, IP addresses or credentials. Android reports
internet reachability from the system's validated-network capability; iOS reports
null because a satisfied network path alone does not establish internet access.
Unsupported low-data-mode checks are null. Connection types include `offline`,
`wifi`, `cellular`, `ethernet`, `vpn`, `other`, `unknown`; iOS may classify VPN paths
by their underlying interface.

Sensor snapshots require the foreground, stop after the first sample, and time
out after five seconds. Backgrounding, cancellation and session closure remove
listeners. Missing hardware returns `sensor_unavailable`; denied permissions
return `permission_denied`. Vector readings contain `x`, `y`, `z`: accelerometer
specific force includes gravity in `m/s2`, gyroscope uses `rad/s`, and magnetometer
uses `uT`. Barometer readings contain `pressure` in `hPa`. iOS normalizes native
acceleration and pressure units and declares the motion usage description.

DeviceMotion uses `expo-sensors` and checks availability and OS motion permission
before subscribing. It waits for gravity and attitude fields to be populated, then
removes only its own subscription. Backgrounding, cancellation, timeout and session
closure also unsubscribe. It does not change the shared sensor update interval.
The result preserves Expo field names: `acceleration`, `accelerationIncludingGravity`,
`rotation`, `rotationRate`, `orientation`; unavailable optional components are null.
Acceleration uses `m/s2`, attitude uses radians, rotation rate uses degrees/second,
and screen orientation is 0, 90, 180 or -90 degrees. Component `timestamp` values
are seconds since boot; `timestamp_ms` is the Unix capture time. `interval_ms` is
normalized to milliseconds because Expo 57 emits seconds on iOS and milliseconds
on Android. These are Expo coordinate conventions, separate from the raw sensor
snapshot conventions.

Location requires Whip in the foreground and requests OS permission on first
use. Android requests coarse and fine access together and accepts approximate
access; iOS requests When In Use access and respects reduced accuracy. Denial
returns `permission_denied`; disabled/unavailable providers return
`location_unavailable`. A fix waits at most ten seconds (inside the overall MCP
deadline). Cancellation, session closure or backgrounding stops the native
request. There is no background location permission or continuous tracking.
Android queries Google Play services' fused current-location API when available,
alongside enabled platform fused/network/GPS providers. Recent platform fixes may
be reused only when at most ten seconds old (measured with the monotonic clock).
The Google request uses the same age limit. Devices without Google Play services
retain the platform fallback. Timeout errors identify the requested providers;
`WhipDevice` Android logs record provider, accuracy and fix age, without coordinates.
Battery and sensor success does not imply location availability: a position needs
a provider fix. If location times out, keep Whip visible, check Location Accuracy,
compare with a current Maps fix, or retry outdoors for GPS reception.
The launch toggle describes browser/device access, including location.

The MCP server is named `whip` in both agent launch configuration and server
initialization. `browser.*` and `device.*` are peer tool namespaces beneath it,
so agents display calls such as `whip browser.navigate` and `whip device.location`.
`tools/list` discovers both namespaces. Device APIs remain separate from page
JavaScript and `browser.eval`. Existing agent processes keep their launch-time
configuration; start a new Reverse Control launch to pick up the server name.

Initialization instructions explain when to choose Whip, distinguish phone state
from SSH-host state, and give concrete browser/device examples. Each device tool
also describes its use case, foreground/permission requirements, input limits and
result contract. Motion guidance distinguishes fused DeviceMotion readings from
raw sensor snapshots.

Shared device tests cover strict arguments, result validation, session isolation,
cancellation and permission errors. React Native tests cover approximate/denied
permission, cancellation during the permission sheet, background cleanup and
launch authorization without browser tabs.

## Browser tools

Rust owns the public protocol in
`packages/react-native-whip-ssh/rust/src/reverse_control/browser/`: serde action,
argument, result, target and error types; request validation; session/tab checks;
per-session serialization; deadlines; navigation and wait polling; and generation
of fixed DOM programs. The existing UniFFI event callback carries typed low-level
operations as JSON. React Native resolves mounted WebViews and executes
`evaluate`, `document_state`, navigation/history, screenshot and tab primitives.
It also retains UI presentation, renderer lifecycle, global view admission and
SSH-preview mapping. No second automation stack or browser dependencies are added.

Available tools: `navigate`, `snapshot`, `find`, `get`, `extract`, `click`,
`type`, `keys`, `select`, `check`, `uncheck`, `scroll`, `wait`,
`screenshot`, `eval`, `back`, `forward`, `reload`, `list_tabs`,
`new_tab`, `close_tab`. `wait_for_dom` remains a compatibility alias.

Use `snapshot/find → get/click/type → wait → snapshot/extract`.
`find` accepts `role`, `name`, `label`, `text`, `test_id`, optional
`css` fallback, `exact` and `limit`. Semantic properties take priority;
CSS fallback runs only if they match nothing. Targets for interactions and reads
use `{target:{role:"button",name:"Save"}}` or an observed
`{target:{ref:"..."}}`; the existing top-level `ref` shorthand still works.
Reads and writes reject ambiguous targets with compact candidates.

`snapshot` returns public URL, title, page generation, and up to 200 visible
interactive elements with compact refs, accessible names and relevant
checked/selected/disabled/editable state. `find` returns up to 50 rendered
matches without requiring a snapshot. Refs are shared between find and snapshot,
and annotated screenshots reuse current refs while allocating missing ones.
Navigation, SPA URL changes, DOM mutation, manual input, scrolling, writes and
subsequent snapshots invalidate earlier refs. `stale_ref` requires observing
again. In-flight operations keep a tab lease across Rust polling, so idle
suspension cannot discard their renderer.

`get` supports `text`, `value`, `attributes`, sanitized visible `html`,
page `title` and `url`, with `max_chars` (default 4,000, maximum 16,000).
Standard observations omit passwords, hidden DOM, arbitrary data attributes,
cookies and URL queries/fragments. `extract` prefers main, article, then body,
omits navigation/forms/scripts/styles, and emits headings, lists and readable
text. `chunk_size` defaults to 4,000 and is capped at 12,000 characters; collection
is capped at 262,144. Continue with `start:next_start` and the prior
`generation`; changed content returns `stale_content`. Cursors count Unicode
characters, so chunk boundaries do not split surrogate pairs.

`wait` accepts `condition`: `selector`, `target` (semantic locator),
`text`, `url` (substring), `url_change`, or `stable`.
`url_change` compares the complete URL, including query/fragment, without
exporting it. The baseline defaults to the URL at wait start; `previous_url`
can provide an explicit baseline. Stability defaults to 300 ms. Wait defaults
to 5 seconds and is capped at 10 seconds. Navigation can satisfy a wait in the
same owned tab. `keys` dispatches keyboard events and emulates common activation,
focus, selection and deletion defaults. Events remain untrusted browser events.
`select` supports a single-choice native select by unique option label/value;
`check/uncheck` are idempotent native checkbox operations, with radio checking
supported. To change a radio group, check another radio.

`screenshot({annotate:true})` returns a bounded JPEG and a ref legend.
Android Canvas and iOS image rendering overlay labels after capture without
mutating the page DOM. The controller and Rust runtime verify that the page and
refs remained valid through capture.

`eval({js,tab_id?})` is intentionally unrestricted **page-context JavaScript**,
including async expressions and statement bodies with an explicit return:

```js
await fetch('/api/data').then(r => r.json())
performance.getEntriesByType('resource')
  .filter(x => ['fetch', 'xmlhttprequest'].includes(x.initiatorType))
  .map(x => x.name)
localStorage.setItem('example', 'value'); return localStorage.getItem('example');
document.querySelector('button')?.click()
```

For data-heavy sites, use snapshot, discover relevant resource URLs with eval,
then fetch a small API page using eval. WebView cookies/session state naturally
apply to page fetches. Eval can read or mutate any browser state available to
the webpage, including hidden DOM and storage. Whip does not automatically
export cookies, passwords or credentials alongside results. Page scripts receive
no Whip native API or reverse-control message handler.

Rust starts async evaluation and polls the result through native evaluation;
no page-to-native callback is installed. Undefined results become JSON null.
Non-serializable/cyclic/BigInt results fail with `not_serializable`; page failures
return `eval_failed`; oversized results return `result_too_large`.
Eval JSON is capped at 65,536 UTF-8 bytes. Typed arguments are capped at 64 KiB;
text result payloads at 128 KiB; screenshot payloads at 2 MiB. Complete calls,
including queue time, have a Rust 20-second deadline. Cancellation prevents
further bridge work and ignores late replies. It cannot undo page side effects
or stop synchronous JavaScript already running in the WebView.

`tab_id` targets an explicit owned tab; omission captures the selected tab when
the call arrives. Each launch has up to three tabs, enforced in Rust, with the
existing process-wide cap of nine WebViews enforced at UI admission. Tab creation
selects the new tab. Zero tabs is valid; create a tab to continue.
Successes have a typed `kind` and structured MCP content; errors expose
`error.code`, `error.message` and optional `error.details`. Arguments and
page results are never logged. Page content remains untrusted.

Design reference: [OpenCLI browser skill](https://github.com/jackwener/OpenCLI/blob/main/skills/opencli-browser/SKILL.md),
semantic target resolver, DOM snapshot and content extraction source. Whip adapts
the observation/action loop and bounded envelopes to its WebView architecture;
refs fail closed instead of reidentifying a replacement write target.

## Lifetime and settings

Rust revokes authorization on authenticated MCP DELETE, explicit terminal close,
pane removal/agent disappearance, launch failure, or host transport loss.
Pane close also revokes that pane's session. Outstanding requests are cancelled
and WebViews removed. An ordinary HTTP connection closing does not end a browser
session or cancel a tool call; MCP cancellation notifications cancel calls.
Reconnection does not silently restore an old launch's authorization; launch a
new opted-in Codex session.
A lost SSH connection closes both listeners and active forwarded streams.
The last browser agent closing also stops the shared HTTP listener and cancels
the remote forward. Cancelled startup releases any late remote port allocation.

Remote localhost/private-address navigation uses Whip's existing SSH web-preview
API. Forwards are reused per origin within a tab and retained while needed for
WebView back/forward history. Tab/session teardown and idle suspension release
them, and late forward completions are immediately stopped after cancellation.

More → Browser follows OpenMinis's Android settings, with Whip's presentation:

- A saved search engine for the combined address/search bar: Google, DuckDuckGo,
  Bing or Brave. An icon dropdown shows the current choice and marks the selected
  engine in its menu. The selector and menu use Whip's shared glass surface and
  follow the app's glass preference. The provider SVG icons are bundled locally;
  opening the menu makes no network requests. Selecting an engine saves it and
  closes the menu.
  Settings from before this field was added retain their previous
  browser preferences and default to Google.
- Mobile Chrome, Desktop Chrome and Custom profiles, with full user-agent previews.
  Chrome profiles use the installed engine's version. Mobile removes WebView
  branding rather than copying OpenMinis's fixed Chrome version.
- The default viewport automatically fills the available browser area for every
  user-agent profile and follows layout changes, including phone rotation.
  This differs from OpenMinis's fixed defaults at the user's request.
  The Custom editor has Phone, Phone Pro, Tablet, Laptop, Desktop and Full HD
  presets, dimension clamping from 200 to 4096 px, and UA mismatch warnings at
  the 768 px breakpoint. Unapplied dimensions remain a draft.
- An editable idle timeout from 1 to 240 minutes, default 15. The earlier Never
  setting migrates to one minute.
- A searchable visited-domain list, deletion by domain and a confirmed Clear
  All action. Native cookie values and attributes never leave native code.
  Android's public CookieManager can enumerate cookies matching a URL, not all
  paths for a domain. Domain deletion expires cookies on recorded visited paths,
  including Secure/HttpOnly and Domain cookies; Clear All removes all cookies
  and site data. Per-domain deletion requires GET_COOKIE_INFO support in the
  installed WebView. Visited locations are bounded and omit URL credentials,
  queries and fragments.
  iOS enumerates domains directly from WKHTTPCookieStore and deletes all cookies
  for the selected cookie domain, including unvisited paths and HttpOnly cookies.
  It does not keep a separate visited-location history. Parent-domain cookies are
  listed under their owning domain; deleting a subdomain does not delete its
  parent's or siblings' cookies.

Viewports scale to fit the available UI, retaining the requested page dimensions.
Clear All also clears caches and releases mounted renderers, clearing their
history, forms and session state. URLs remain available for an explicit Reload;
clearing data does not immediately reload pages and repopulate their storage.
Each platform's cookie store is shared by the browser tabs; per-launch isolation covers tool
identity, tab handles, refs and page state, **not a separate cookie profile**.

Loading and navigation updates do not rerender unrelated WebViews. Renderer
instances have their own generation, so late callbacks from an old instance
cannot detach or modify a restored one. Renderer failure leaves the tab and URL
in place; Reload restores that page in a new WebView. Idle suspension skips the
visible tab and in-flight actions. Reopening a suspended tab, or an agent action
on it, resumes it before observing the DOM. Suspension and renderer recovery
reload the saved address; they cannot preserve a failed renderer's DOM/history.

Page locations and the selected tab are saved for process-death recovery under
More → Browser. Recovery records strip URL credentials, queries and fragments;
they contain no MCP tokens, DOM or field values. Restoring requires the original
host connection and creates a user browser, without restoring agent privileges.
Normal session/host teardown removes its recovery record. UI hide/reopen retains
the same WebView immediately; it does not trigger suspension or cleanup.

Android's unused view-hierarchy saved state is removed before the activity's
Binder transaction; React already restores through its own stores and starts
the activity with null saved state. Browser WebViews also opt out of hierarchy
saving. This prevents large text/browser trees from causing
TransactionTooLargeException when leaving the activity.

The react-native-webview patch scopes pending source updates to each native
view and prevents iframe redirects from entering its top-level event/load
fallback. Native device tests exercise interleaved source transactions, iframe
navigation and saving an activity containing a large text editor.

## Limits and verification

The semantic observer currently handles the main document's visible DOM;
cross-origin frames and closed shadow DOM are not traversed. Canvas-only controls
and trusted native input requirements may need manual interaction. Screenshots
are a viewport fallback, not a coordinate-control interface. File downloads,
permission prompts and external app schemes are outside the MCP surface.
Continuous DOM mutation can make refs stale; take a new snapshot and retry.
Hidden active tabs retain a laid-out WebView, but Android may throttle page
timers while the app is backgrounded. Process recovery restores page locations,
not form input, scroll positions, history or the previous renderer's DOM.

Behavior tests cover launch gating/off routing, Open Browser visibility,
session/tab isolation and quotas, presentation lifetime, cancellation,
navigation generations, semantic refs and framework-compatible typing, and
preview cleanup.

iOS native tests use real WKWebView instances, the installed React Native export
headers, and a test tag registry. They cover adapter registration and nested view
lookup, stale handles, JSON evaluation and errors, visible and hidden viewport
screenshots, annotations that do not modify the DOM, native URL validation,
cookie metadata, per-domain deletion and Clear All. On macOS:

```sh
nix develop -c ruby scripts/test-ios-browser.rb
# Override WHIP_IOS_TEST_DESTINATION to select another arm64 iOS simulator.
# Full app build, after npm ci and pod install:
nix develop -c bash scripts/build-ios-app.sh --unsigned
```

The iOS adapter passed eight native WebKit tests on an arm64 iPhone simulator,
including the Rust-owned DOM runtime and asynchronous page results. The full
unsigned iOS Release app built successfully and its executable was verified as
thin arm64. The shared browser suite passed 97 tests; TypeScript and focused
ESLint passed. Physical-device installation has not been validated for this
change.

Shared behavior and Android validation:

```sh
nix develop -c npm test -- --runInBand
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
nix develop -c npx tsc --noEmit
nix develop -c npm run lint
nix develop -c bash scripts/build-android-rust.sh
nix develop -c android/gradlew -p android :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
nix develop -c android/gradlew -p android :app:assembleRelease :app:assembleReleaseAndroidTest -PreactNativeArchitectures=arm64-v8a -Pwhip.skipR8=true -Pwhip.testBuildType=release
# Install the upload-signed APK in place, followed by its matching test APK.
nix develop -c adb install -r android/app/build/outputs/apk/release/app-release.apk
nix develop -c adb install -r android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
nix develop -c adb shell am instrument -w -e class io.github.kaminarios.whip.BrowserWebViewTest,io.github.kaminarios.whip.BrowserSiteCookiesTest io.github.kaminarios.whip.test/androidx.test.runner.AndroidJUnitRunner
```

Reference architecture inspected: OpenMinis BrowserTabPool/Registry,
BrowserUseManager, BrowserActionGuard, BrowserSheet/WebView, BrowserUseJS and
BrowserUseTool. Whip uses its own session authorization, existing russh channels,
semantic ref protocol and React Native presentation instead of their sandbox
browser CLI or implementation.

Transport tests use real HTTP requests and an in-process SSH server with remote
loopback listeners. They cover two-agent isolation with identical RPC ids,
authorization, Origin and protocol validation, cancellation, late allocations,
host disconnect, and removal of both ports after the last agent exits.
JavaScript regression coverage includes renderer recovery, stale renderer
callbacks, idle suspension, viewport/UA settings, recovery storage and hydration
races. Settings tests cover all six presets, profile previews, dimension limits,
draft warnings, idle clamping, domain filtering and cookie-clear confirmation.
The full JavaScript suite passed 169 suites / 1,828 tests. TypeScript and full
ESLint passed.
The subsequent automatic-fit change passed 19 relevant browser tests,
TypeScript, focused ESLint and the upload-signed arm64 release build. Its
viewport regression covers phone rotation, UA changes, fixed presets, and
returning to the automatically fitted browser area.
The address/search-bar update passed 83 browser, controller, settings and
preference tests, TypeScript, focused ESLint and the arm64 release build. Its
tests cover direct URL and SSH-preview routing, Unicode and search operators,
engine persistence and legacy settings migration, and rejection of unsafe URLs
without sending them to a search provider.
The icon dropdown passed 15 relevant settings/preferences tests, TypeScript,
focused ESLint and the arm64 release build. The settings interaction test covers
opening/closing the menu, provider icons, saving each choice and dismissing the
menu after selection.

Device validation: the upload-signed arm64 release and matching test APK were
installed in place on the connected Pixel 9 Pro. All five native instrumentation
tests passed, including Secure/HttpOnly/path-cookie deletion, preservation of
another site's cookies, rejection of unvisited domains, and sanitized domain
history recovery. Cookie tests use unique .invalid domains and never clear the
user's global cookie store. The temporary test APK was removed afterward.
The user manually tested the earlier tab fixes and reported that they worked.
The release build passed. The preceding transport implementation also passed
license checks and 464 Rust tests (two ignored); this settings update does not
change Rust or the MCP transport.

Settings reference: OpenMinis Android BrowserSettingsSheet and BrowserTabPool at
commit b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c. The controls, defaults, presets
and supported ranges follow that source, except the default viewport fits the
device instead of selecting a fixed size by UA. Chrome UA versions follow the
installed engine and domain deletion uses full cookie metadata instead of an
empty cookie.

Protocol references: [Codex HTTP MCP configuration](https://developers.openai.com/codex/mcp/),
[per-run CLI overrides](https://developers.openai.com/codex/config-advanced/),
[OpenCode inline configuration](https://opencode.ai/docs/config/),
[OpenCode remote MCP](https://opencode.ai/docs/mcp-servers/),
[OpenCode v2 standalone server](https://github.com/anomalyco/opencode/blob/7878744505/packages/cli/src/services/server-connection.ts),
[v2 MCP configuration normalization](https://github.com/anomalyco/opencode/blob/7878744505/packages/core/src/config/normalize.ts), and
[Streamable HTTP MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
