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

## Debugged result: numeric IP destinations bypass the proxy

On the arm64 **iOS 26.5 simulator, built with Xcode 27.1**, requests to
`localhost` and `ssh-only.invalid` went through the configured proxy. Requests
to literal `127.0.0.1`, `[::1]`, and a reachable IPv4 LAN address connected
**directly to the destination**. This happened with a healthy proxy too: the
proxy received zero connections for those IP requests. Disabling failover does
not prevent this bypass; the hostname control does fail closed when its proxy
is unavailable.

Independent controls bypass Whip's route manager and React Native entirely:

| Client / configuration | Hostname destination | Numeric IPv4 destination |
| --- | --- | --- |
| Fresh WKWebView / SOCKS5, HTTP and HTTPS | Proxy used | Direct connection |
| Fresh WKWebView / HTTP CONNECT, explicit IP match | Not probed in this variant | Direct connection |
| Fresh WKWebView / HTTP CONNECT with TLS to proxy | Not probed in this variant | Direct connection |
| Fresh WKWebView / secure HTTP/2 relay configuration | Not probed in this variant | Direct connection |
| URLSession / Network proxy configuration | Proxy used | Direct connection |
| URLSession / legacy SOCKS dictionary, empty exceptions | Proxy used | Direct connection |
| Raw Network.framework TCP / privacy context with SOCKS5 | Proxy used | Direct connection |

The SOCKS WebKit matrix also checks IPv6 loopback and the local LAN address for
both HTTP and HTTPS. The destination trap records HTTP GET bytes (`47 45`) or
TLS ClientHello bytes (`16 03`). It now serves a distinguishable successful
HTTP response on direct connections, so the result does not depend on treating
a navigation error as a leak. HTTPS probes inspect the socket destination;
the fixture intentionally closes TLS handshakes and **does not validate HTTPS
page loading or certificate behavior**.

Changing the proxy endpoint from `127.0.0.1` to `localhost` or an alternate
loopback address did not fix numeric-IP routing. Explicit match domains and
wildcard variants did not fix it either. The bypass reproduces without a
preexisting connection pool or changes to a live data store. It is therefore
not explained by Whip's route transitions or the separate WebKit connection
pool reuse issue described in [Safari Technology Preview 256 release notes](https://webkit.org/blog/18602/release-notes-for-safari-technology-preview-256/).

The observations locate the problem in the tested Apple networking stack,
below WebKit. An IP endpoint skipping hostname-based proxy selection is a
possible explanation, **not a verified account of Apple's internal code**.
They do not prove that all iOS versions or physical devices behave identically.
No public configuration tested so far enforces the required route for both
hostnames and numeric IPs.

### Security regression coverage

The native tests include raw API controls, a working `localhost` tunnel, a
hostname request with an unavailable proxy, and a hostname redirect to a numeric
IP for both navigation and WKDownload. Only the exact zero-direct-connections
assertions for known native bypasses use **strict expected failures**. Other
failures are not masked. If a platform fixes those paths, unexpected successes
force a review of the capability gate. The production capability/rejection test
remains an ordinary regression.

Run the focused raw WebKit reproduction on macOS:

```sh
nix develop -c ruby scripts/test-ios-browser.rb \
  -only-testing:BrowserTests/WhipBrowserProxyTests/testPublicWebKitProxyRoutingMatrix
```

Simply replacing a user's `127.0.0.1` URL with `localhost` cannot make arbitrary
browsing safe: a hostname page can redirect or download from a numeric IP.
Hostname-only support would need native enforcement across every request path,
including subresources, redirects, downloads and workers. That restricted
feature has not been implemented or substituted for #394's requirements.

The connected iPhone XR reports iOS 18.7.11. The detailed CoreDevice error
identifies a **locked device** (error 10003), nested inside the generic DDI mount
error 12040; the available developer image itself is marked usable. Physical
validation was not performed because the user requested simulator-only
continuation. No Whip installation or app data was removed.

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
