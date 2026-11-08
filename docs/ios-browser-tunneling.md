# iOS SSH browser tunneling (#394)

**Enabled on iOS 17 and later with direct fallback allowed.** iOS uses the
selected host's SSH proxy when WebKit applies it, and permits a request to use
the device network if the proxy fails. Tested numeric-IP destinations can also
bypass the proxy while it is healthy. Websites, redirects, downloads and icons
therefore have no guarantee of staying inside SSH. Android retains its existing
proxy policy and host profiles.

The iOS setting explains direct fallback and numeric-IP bypass. This feature
provides access through SSH where supported; it is not a VPN or a privacy
boundary. iOS 16.4 remains supported for ordinary browsing and reports tunneling
unavailable because the public proxy APIs require iOS 17.

## Public APIs

- [`WKWebsiteDataStore.proxyConfigurations`](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations)
  is set before constructing WKWebView. Navigation, redirects, subresources and
  WebKit-owned downloads use that store.
- [`nw_proxy_config_create_socksv5`](<https://developer.apple.com/documentation/network/nw_proxy_config_create_socksv5(_:)>)
  points at the existing Rust SOCKS5 listener on 127.0.0.1. Rust passes domain
  names to SSH `direct-tcpip`; it does not resolve those names locally.
- [`nw_proxy_config_set_failover_allowed`](<https://developer.apple.com/documentation/network/nw_proxy_config_set_failover_allowed(_:_:)>)
  is true for active proxy ports. Retired or unconfigured stores use a dead
  proxy with fallback disabled, rather than intentionally reactivating stale
  documents. Numeric-IP bypass is still an OS limitation on those stores.
- [`NSURLSessionConfiguration.proxyConfigurations`](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/proxyconfigurations)
  applies the same active-route fallback policy to favicon fetching. Icons use
  an ephemeral session without cookies or stored credentials and return image
  data to React Native.

These are public WebKit/Network APIs. There are no private selectors, global
proxy changes, VPN entitlements, NSURLProtocol interception or TLS interception.
Apple describes these APIs in [WWDC23: Ready, set, relay](https://developer.apple.com/videos/play/wwdc2023/10002/).

## Lifecycle and browsing state

The WebView patch supplies an app-owned `[runtimeId, tunnelHostId]` descriptor to
the native factory before WKWebView initialization. `prepare` verifies the data
store against the active native route before JS supplies a source or restores
history. Other app WebViews do not opt into this factory.

Tunnel stores are nonpersistent and shared only by tabs of the same runtime and
saved host during the active route. Remounting or reopening a tab on that route
retains cookies and storage. Switching hosts, changing tunneling or reconnecting
creates a new tunnel store and clears that session. Retired stores are never
pointed at another host's live proxy. Untunneled browsing continues to use the
existing default store, preserving its cookies and storage; this store is never
proxied or quarantined by Whip's routing code.

Route transitions cancel downloads and icon sessions, discard saved interaction
states, and stop and blank old documents. The shared route controller still
blocks document activation during setup, SSH startup failure, disconnect and
reconnect. **Fail open applies to network requests on an active native route**;
it does not automatically open a new direct browsing route when host setup
fails. Android's transition behavior is unchanged.

Native downloads remain WKDownload operations, including redirects and
cookie-based authentication. A fallback request continues using its isolated
WebKit store; isolation does not enforce a network route. Site-data inspection
and clearing cover the native stores without exposing cookie values to JS.

## Native API investigation

On the arm64 **iOS 26.5 simulator, built with Xcode 27.1**, `localhost` and
`ssh-only.invalid` requests used the configured proxy. Literal `127.0.0.1`,
`[::1]`, and a reachable LAN IPv4 address connected directly, even with a healthy
proxy and failover explicitly disabled. The proxy received zero connections for
those numeric-IP requests.

Independent controls omit Whip's route manager and React Native entirely:

| Client / configuration                                  | Hostname destination       | Numeric IPv4 destination |
| ------------------------------------------------------- | -------------------------- | ------------------------ |
| Fresh WKWebView / SOCKS5, HTTP and HTTPS                | Proxy used                 | Direct connection        |
| Fresh WKWebView / HTTP CONNECT, explicit IP match       | Not probed in this variant | Direct connection        |
| Fresh WKWebView / HTTP CONNECT with TLS to proxy        | Not probed in this variant | Direct connection        |
| Fresh WKWebView / secure HTTP/2 relay configuration     | Not probed in this variant | Direct connection        |
| URLSession / Network proxy configuration                | Proxy used                 | Direct connection        |
| URLSession / legacy SOCKS dictionary, empty exceptions  | Proxy used                 | Direct connection        |
| Raw Network.framework TCP / privacy context with SOCKS5 | Proxy used                 | Direct connection        |

The SOCKS WebKit matrix also checks IPv6 loopback and a LAN address for both
HTTP and HTTPS. The destination trap serves a distinguishable successful HTTP
response on direct connections. HTTPS probes record the TLS ClientHello's
socket destination and intentionally close the handshake: they do not validate
successful HTTPS page loading or certificate behavior.

Changing the proxy endpoint to `localhost` or an alternate loopback address,
explicit match domains, and wildcard variants did not fix numeric-IP routing.
The bypass reproduces with fresh stores and connection pools. It is not
explained by Whip route transitions or the separate connection-pool reuse issue
in [Safari Technology Preview 256 release notes](https://webkit.org/blog/18602/release-notes-for-safari-technology-preview-256/).

This locates the observed behavior below WebKit in the tested Apple networking
stack. An IP endpoint skipping hostname-based proxy selection is a possible
explanation, not a verified account of Apple's internal code. These results do
not establish behavior on every iOS version or physical device. Replacing only
an address-bar IP with `localhost` would not constrain redirects, subresources
or downloads, so it is not used as a route guarantee.

## Validation

Run the standalone arm64 native suite on macOS:

```sh
nix develop -c ruby scripts/test-ios-browser.rb
```

Production-adapter tests cover capability reporting, live hostname proxying,
direct hostname fallback when a proxy is unavailable, numeric-IP browsing,
direct redirects and downloaded content, host/remount cookie isolation, store
retirement and preservation of the untunneled default store. Shared Jest tests
cover the enabled iOS setting, fallback/session copy, Android copy, adapter
arguments and serialized route lifecycle.

Raw API controls deliberately retain strict expected-failure assertions for
zero direct connections with **failover disabled**. They document the native
API limitation independently of Whip's enabled fail-open policy. Production
fallback and direct-download tests use ordinary assertions, not expected
failures.

Focused native reproduction:

```sh
nix develop -c ruby scripts/test-ios-browser.rb \
  -only-testing:BrowserTests/WhipBrowserProxyTests/testPublicWebKitProxyRoutingMatrix
```

Physical-device testing was not performed: detailed CoreDevice diagnostics
identified a locked iPhone XR (error 10003 inside DDI mount error 12040), and the
user chose simulator-only continuation. No app was uninstalled. End-to-end
SSH/device HTTPS, WS/WSS, media, worker and DNS behavior remain to be validated;
a TCP SOCKS proxy does not establish UDP/WebRTC/QUIC routing. The original
fail-closed guarantees in #394 are superseded by the requested iOS fail-open
policy, not fulfilled by this implementation.
