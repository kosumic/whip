# iOS SSH browser tunneling (#394)

**Status: blocked; the production iOS `supportsProxy` capability is false.**
The candidate implementation is exercised only through a test adapter subclass.
Do not enable it merely because an OS exposes `proxyConfigurations`. The
loopback regression below must pass without an expected failure first.
This PR does not complete #394's feature-parity acceptance criteria.

## Public APIs and deployment target

Whip supports iOS 16.4. Public per-data-store proxy configuration requires
**iOS 17.0**. The candidate uses:

- [`WKWebsiteDataStore.proxyConfigurations`](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations)
  before constructing WKWebView, so redirects, page resources and WebKit-owned
  downloads use the same data store.
- [`nw_proxy_config_create_socksv5`](<https://developer.apple.com/documentation/network/nw_proxy_config_create_socksv5(_:)>)
  pointing to the existing Rust SOCKS5 listener on 127.0.0.1. Rust passes domain
  names to SSH `direct-tcpip`; it does not resolve destination names locally.
- [`nw_proxy_config_set_failover_allowed`](<https://developer.apple.com/documentation/network/nw_proxy_config_set_failover_allowed(_:_:)>)
  explicitly set to false.
- [`NSURLSessionConfiguration.proxyConfigurations`](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/proxyconfigurations)
  for native favicon fetching. No image URL is handed to React Native's direct
  image loader. Cookies and stored credentials are disabled for these requests.

These are public WebKit/Network APIs; there is no private selector, global
proxy change, VPN entitlement, NSURLProtocol interception, or TLS interception.
Apple describes these APIs together in [WWDC23: Ready, set, relay](https://developer.apple.com/videos/play/wwdc2023/10002/).
The iOS 16.4 path retains ordinary untunneled browsing and rejects tunnel setup.

## Blocking result: loopback bypass

On the arm64 **iOS 26.5 simulator, built with Xcode 27.1**, a WKWebView with a
SOCKS proxy configured before creation, with failover disabled, connected
**directly to 127.0.0.1** when its proxy was unavailable. The regression uses a
local destination trap: four connections began with `47 45` (`GE`, from an HTTP
GET), rather than a SOCKS handshake. This is a bypass, not just an error message
or an inability to resolve a remote host.

The same test also reproduced the bypass with public HTTP CONNECT proxy
configuration. Explicit `localhost`, `127.0.0.1`, and `::1` match domains,
combined with either an empty suffix or `*`, did not prevent it. HTTP CONNECT
therefore does not justify changing the existing Rust transport.

`testUnavailableProxyDoesNotFallBackEvenForLoopback` records the exact
zero-direct-connections assertion as a **strict expected failure**, scoped only
to that assertion. If WebKit stops bypassing the proxy, the test reports an
unexpected success and prompts a review of the capability gate. Other failures
are not masked. The production capability/rejection test is an ordinary passing
regression and verifies that untunneled preparation still works.

No claim is made that other iOS versions share this behavior, or that any
version has been validated safe. API availability alone cannot establish that.
A connected iPhone XR reported iOS 18.7.11 with Developer Mode enabled, but
`devicectl` could not mount its developer disk image. Physical-device validation
has not been completed; no Whip installation or app data was removed.

## Candidate lifecycle and state

The WebView patch passes an app-owned `[runtimeId, tunnelHostId]` descriptor to
the native factory **before WKWebView initialization**. `prepare` verifies the
created data store against the active native route before JS supplies a source
or restores history. Other WebViews do not opt into this factory.

Tunnel data stores are nonpersistent and shared only by tabs of the same
runtime and saved host during the active route. Remounting/reopening a tab on
that route retains its cookies and storage. A route change or reconnect retires
the store permanently: old stores keep a dead, non-failing-over proxy and are
never pointed at another host's listener. Active downloads and favicon sessions
are cancelled; saved interaction states are discarded; old documents are
stopped and blanked. A new route gets a fresh tunnel store. Consequently,
**tunnel cookies and storage do not survive switching routes or reconnecting**.
This candidate behavior differs from Android's persistent host profiles and
must be communicated in the iOS setting before enabling the capability.

Untunneled production browsing keeps its existing default data store. The
candidate direct route has a separate persistent data store; it cannot inherit
a tunnel store. Site-data inspection and clearing cover native stores without
exposing cookie values to JS. Native downloads remain WKDownload operations,
including redirects and authentication; they are not restarted using a direct
URLSession.

## Validation and remaining work

Run the standalone arm64 simulator suite on macOS:

```sh
nix develop -c ruby scripts/test-ios-browser.rb
```

The proxy fixture successfully exercises remote `.invalid` hostnames, redirects,
fetch subresources, a cookie-authenticated WKDownload, remount isolation, and
permanently retired stores. It does not replace SSH/device end-to-end testing.
Shared Jest routing tests also cover native setup failures and disconnects
while native route setup is pending. Android's existing routing and proxy paths
remain in place; its generated WebView setter for the iOS-only descriptor is a
no-op.

Before enabling iOS support:

1. Find a public API/configuration that passes the loopback trap without any
   direct connections, including IPv6, localhost aliases, and redirected or
   subresource destinations. Retest older supported versions explicitly.
2. Validate HTTPS certificate handling, WSS/WS, authenticated/redirected
   downloads, WebKit media and worker traffic, and DNS leakage on a real device
   using the Rust SSH proxy and endpoints reachable only from the SSH host.
   UDP/WebRTC/QUIC routing is not established by a TCP SOCKS proxy.
3. Test disconnect/reconnect, switching two SSH hosts, reopened tabs, cookies,
   local storage, history, screenshots, JS evaluation and ongoing downloads.
4. Update iOS session-lifetime copy and remove the capability gate only after
   these security and feature-parity checks pass. Leave #394 open until then.
