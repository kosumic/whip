# Reverse Control Browser v1

A Codex launch can opt into Reverse Control in the command launcher. The toggle
starts off; other agent commands do not offer it. Open Browser appears for the
pane associated with that launch. Closing the browser hides its presentation;
it does not close its tabs. Terminal web links use the same controller when that
pane has Reverse Control, and the same browser subsystem for ordinary previews.

## Ownership and transport

`HostRuntime` owns a Rust `ReverseControl` manager. It binds an HTTP MCP listener
to a random **phone loopback** port, then requests a random **remote loopback**
port using reverse TCP forwarding over the existing SSH connection. One listener
and forward are shared by opted-in Codex launches on that host. No remote
executable, Node.js installation, temporary files or permanent configuration are
needed. The SSH server must permit reverse TCP forwarding (`AllowTcpForwarding`).

Each launch gets an unpredictable session id/token and inline `codex -c`
configuration for `http://127.0.0.1:<remote-port>/mcp/<session-id>`, with a
per-launch Authorization header. Codex speaks Streamable HTTP MCP directly:

```text
Codex → remote loopback port → existing SSH connection
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
fixed DOM program, draws a viewport screenshot and clears site data. An iOS
adapter can implement these operations against the existing WKWebView. Adapter
availability then enables the launch/UI capability gate on iOS without changing
the SSH/MCP protocol.
Android is the enabled and build-validated platform in v1.

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

## Browser tools

`browser.navigate`, `snapshot`, `click`, `type`, `scroll`, `screenshot`, `back`,
`forward`, `reload`, `list_tabs`, `new_tab`, `close_tab`, and `wait_for_dom`.

Use snapshot first, then click/type with its ref. `tab_id` targets an explicit
owned tab; omission captures the user's selected tab **when the call arrives**.
Tab creation selects the new tab. Each launch has up to three tabs, with a
process-wide cap of nine WebViews; admission fails rather than evicting another
agent's browser. Zero tabs is valid; create a tab to continue.

Refs carry page and snapshot identity. Navigation, DOM mutation, manual input,
scrolling, and a subsequent snapshot invalidate previous refs. Stale calls fail
and ask the agent to take a fresh snapshot. Actions serialize per browser
session. Renderer calls and waits are bounded; navigation during observation is
reported rather than returning a result for the wrong page. Modern input uses
native DOM value setters and bubbling beforeinput/input/change events.

No execute_js tool is provided. Pages have no browser-command message handler or
native Whip API. Snapshots omit field values, cookies, hidden elements and URL
query/fragment/credentials. Names/title and snapshots are bounded. Results and
arguments are not logged by this subsystem. Page content remains untrusted.
Screenshots expose the visible page just as the user sees it; use semantic
snapshots as the normal observation path.

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
  All action. Native cookie values and attributes never leave Android code.
  Android's public CookieManager can enumerate cookies matching a URL, not all
  paths for a domain. Domain deletion expires cookies on recorded visited paths,
  including Secure/HttpOnly and Domain cookies; Clear All removes all cookies
  and site data. Per-domain deletion requires GET_COOKIE_INFO support in the
  installed WebView. Visited locations are bounded and omit URL credentials,
  queries and fragments.

Viewports scale to fit the available UI, retaining the requested page dimensions.
Clear All also clears mounted caches/history. Android's
cookie store is shared by the browser tabs; per-launch isolation covers tool
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
preview cleanup. Run:

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
ESLint passed. iOS was not built; it still requires its native adapter.
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
[per-run CLI overrides](https://developers.openai.com/codex/config-advanced/), and
[Streamable HTTP MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
