#import <XCTest/XCTest.h>
#import <WebKit/WebKit.h>
#import <Network/Network.h>
#import <Network/NSURLSession+Network.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>
#import <arpa/inet.h>
#import <ifaddrs.h>
#import <net/if.h>
#import "WhipBrowser.h"

@interface WhipBrowser (ProxyTesting)
+ (BOOL)supportsProxy;
- (NSDictionary *)constantsToExport;
- (void)configureProxy:(NSString *)runtime port:(double)port resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)prepare:(NSNumber *)tag runtimeId:(NSString *)runtime tunnelHostId:(NSString *)host resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)download:(NSNumber *)tag identifier:(NSString *)identifier url:(NSString *)url maxBytes:(NSNumber *)maxBytes resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)invalidate;
@end

// Real loopback SOCKS5 endpoint. Requests for .invalid can succeed only if
// WebKit sends the hostname to the proxy instead of resolving it on the phone.
@interface BrowserSOCKSFixture : NSObject
@property(nonatomic) int listener;
@property(nonatomic) uint16_t port;
@property(nonatomic) NSUInteger connections;
@property(nonatomic, strong) NSMutableArray<NSString *> *prefixes;
@property(nonatomic, strong) NSMutableArray<NSString *> *requests;
@property(nonatomic, strong) NSMutableArray<NSString *> *hosts;
@property(nonatomic, copy) NSString *redirectURL;
- (instancetype)initWithAddress:(NSString *)address;
@end
@implementation BrowserSOCKSFixture
static BOOL ReadBytes(int socket, void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(socket, (char *)buffer + offset, length - offset);
    if (count <= 0) return NO;
    offset += count;
  }
  return YES;
}
- (instancetype)init { return [self initWithAddress:@"127.0.0.1"]; }
- (instancetype)initWithAddress:(NSString *)host {
  BOOL ipv6 = [host containsString:@":"];
  if ((self = [super init])) {
    _requests = [NSMutableArray new]; _hosts = [NSMutableArray new]; _prefixes = [NSMutableArray new];
    _listener = socket(ipv6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
    if (ipv6) {
      struct sockaddr_in6 address = {.sin6_len = sizeof(address), .sin6_family = AF_INET6};
      inet_pton(AF_INET6, host.UTF8String, &address.sin6_addr);
      if (bind(_listener, (struct sockaddr *)&address, sizeof(address)) || listen(_listener, 16)) return nil;
      socklen_t size = sizeof(address); getsockname(_listener, (struct sockaddr *)&address, &size); _port = ntohs(address.sin6_port);
    } else {
      struct sockaddr_in address = {.sin_len = sizeof(address), .sin_family = AF_INET};
      inet_pton(AF_INET, host.UTF8String, &address.sin_addr);
      if (bind(_listener, (struct sockaddr *)&address, sizeof(address)) || listen(_listener, 16)) return nil;
      socklen_t size = sizeof(address); getsockname(_listener, (struct sockaddr *)&address, &size); _port = ntohs(address.sin_port);
    }
    int listener = _listener;
    __weak BrowserSOCKSFixture *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      for (;;) {
        int client = accept(listener, NULL, NULL);
        if (client < 0) break;
        @synchronized(weakSelf) { weakSelf.connections += 1; }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
          int yes = 1; setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
          struct timeval timeout = {.tv_sec = 10};
          setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
          [weakSelf serve:client]; close(client);
        });
      }
    });
  }
  return self;
}
- (void)serve:(int)client {
  uint8_t greeting[2], methods[255], head[4], length, host[255], port[2];
  if (!ReadBytes(client, greeting, 2)) return;
  @synchronized(self) { [self.prefixes addObject:[NSString stringWithFormat:@"%02x%02x", greeting[0], greeting[1]]]; }
  BOOL directHTTP = greeting[0] == 'G' && greeting[1] == 'E';
  if (directHTTP) {
    // A working HTTP destination makes a direct leak observable as a successful
    // response too, rather than inferring it only from a network error.
  } else if (greeting[0] == 'C') {
    NSMutableData *connect = [NSMutableData dataWithBytes:greeting length:2];
    uint8_t byte;
    while (connect.length < 32768 && ReadBytes(client, &byte, 1)) {
      [connect appendBytes:&byte length:1];
      if (connect.length >= 4 && !memcmp((const char *)connect.bytes + connect.length - 4, "\r\n\r\n", 4)) break;
    }
    NSString *request = [[NSString alloc] initWithData:connect encoding:NSUTF8StringEncoding];
    NSString *authority = [request componentsSeparatedByString:@" "][1];
    @synchronized(self) { [self.hosts addObject:[authority componentsSeparatedByString:@":"].firstObject]; }
    const char *response = "HTTP/1.1 200 Connection Established\r\n\r\n";
    write(client, response, strlen(response));
  } else {
    if (greeting[0] != 5 || !ReadBytes(client, methods, greeting[1])) return;
    write(client, (uint8_t[]){5, 0}, 2);
    if (!ReadBytes(client, head, 4) || head[0] != 5 || head[1] != 1) return;
    if (head[3] == 3) { if (!ReadBytes(client, &length, 1)) return; }
    else length = head[3] == 1 ? 4 : 16;
    if (!ReadBytes(client, host, length) || !ReadBytes(client, port, 2)) return;
    NSString *name = head[3] == 3 ? [[NSString alloc] initWithBytes:host length:length encoding:NSUTF8StringEncoding] : @"IP";
    @synchronized(self) { [self.hosts addObject:name ?: @""]; }
    write(client, (uint8_t[]){5, 0, 0, 1, 127, 0, 0, 1, 0, 80}, 10);
  }
  NSMutableData *data = directHTTP ? [NSMutableData dataWithBytes:greeting length:2] : [NSMutableData new];
  uint8_t byte;
  while (data.length < 32768 && ReadBytes(client, &byte, 1)) {
    // TLS probes measure the socket destination, not certificate validation.
    // Close immediately on ClientHello; this fixture intentionally has no TLS.
    if (data.length == 0 && byte == 0x16) return;
    [data appendBytes:&byte length:1];
    if (data.length >= 4 && !memcmp((const char *)data.bytes + data.length - 4, "\r\n\r\n", 4)) break;
  }
  NSString *request = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!request) return;
  @synchronized(self) { [self.requests addObject:request]; }
  NSString *body = directHTTP ? @"direct-leak" : @"through-ssh";
  NSString *extra = @"Content-Type: text/plain\r\n";
  NSString *status = @"200 OK";
  if ([request containsString:@"GET /escape "] && self.redirectURL) {
    status = @"302 Found"; extra = [NSString stringWithFormat:@"Location: %@\r\n", self.redirectURL]; body = @"";
  } else if ([request containsString:@"GET /start "]) {
    status = @"302 Found"; extra = @"Location: /page\r\nSet-Cookie: session=host-a; Path=/; HttpOnly\r\n"; body = @"";
  } else if ([request containsString:@"GET /page "]) {
    extra = @"Content-Type: text/html\r\n";
    body = @"<script>fetch('/resource').then(r=>r.text()).then(t=>document.title=t)</script>";
  } else if ([request containsString:@"GET /file "]) {
    extra = @"Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.txt\r\n";
  }
  NSData *response = [[NSString stringWithFormat:@"HTTP/1.1 %@\r\n%@Content-Length: %lu\r\nConnection: close\r\n\r\n%@",
    status, extra, (unsigned long)[body lengthOfBytesUsingEncoding:NSUTF8StringEncoding], body] dataUsingEncoding:NSUTF8StringEncoding];
  write(client, response.bytes, response.length);
}
- (void)dealloc { shutdown(_listener, SHUT_RDWR); close(_listener); }
@end

@interface ProxyTestRegistry : NSObject
@property(nonatomic, strong) WKWebView *browser;
@end
@implementation ProxyTestRegistry
- (UIView *)viewForReactTag:(NSNumber *)tag { return self.browser; }
@end

@interface WhipBrowserProxyTests : XCTestCase <WKNavigationDelegate>
@property(nonatomic, strong) WhipBrowser *adapter;
@property(nonatomic, strong) ProxyTestRegistry *registry;
@property(nonatomic, strong) BrowserSOCKSFixture *proxy;
@property(nonatomic, strong) XCTestExpectation *navigation;
@property(nonatomic) BOOL expectFailure;
@property(nonatomic) BOOL probing;
@property(nonatomic, strong) NSError *probeError;
@end
@implementation WhipBrowserProxyTests
- (void)setUp {
  self.adapter = [WhipBrowser new]; self.registry = [ProxyTestRegistry new];
  self.adapter.viewRegistry_DEPRECATED = (RCTViewRegistry *)self.registry;
  self.proxy = [BrowserSOCKSFixture new]; XCTAssertNotNil(self.proxy);
}
- (void)tearDown {
  self.registry.browser.navigationDelegate = nil;
  [self.adapter invalidate]; self.registry = nil; self.adapter = nil; self.proxy = nil;
}
- (void)configure:(NSString *)runtime port:(NSInteger)port {
  [self.adapter configureProxy:runtime port:port resolve:^(id result) {} reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
}
- (WKWebView *)browserForRuntime:(NSString *)runtime host:(NSString *)host {
  NSString *encoded = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:@[runtime, host ?: NSNull.null] options:0 error:nil] encoding:NSUTF8StringEncoding];
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.websiteDataStore = [WhipBrowserRoute websiteDataStoreForRoute:encoded];
  WKWebView *browser = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 400, 400) configuration:config];
  self.registry.browser = browser;
  browser.navigationDelegate = self;
  [self.adapter prepare:@42 runtimeId:runtime tunnelHostId:host resolve:^(id result) {} reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
  return browser;
}
- (void)waitForTitle:(WKWebView *)browser completion:(XCTestExpectation *)done attempts:(int)attempts {
  if ([browser.title isEqual:@"through-ssh"]) { [done fulfill]; return; }
  if (!attempts) { XCTFail(@"Proxied subresource did not complete: %@", browser.title); [done fulfill]; return; }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_MSEC * 100), dispatch_get_main_queue(), ^{ [self waitForTitle:browser completion:done attempts:attempts - 1]; });
}
- (void)testRedirectSubresourceRemoteDNSAndAuthenticatedDownloadUseSOCKS {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  [self configure:@"a" port:self.proxy.port];
  WKWebView *browser = [self browserForRuntime:@"a" host:@"saved-a"];
  self.navigation = [self expectationWithDescription:@"redirect through proxy"];
  [browser loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"http://ssh-only.invalid/start"]]];
  [self waitForExpectations:@[self.navigation] timeout:60];
  XCTestExpectation *resource = [self expectationWithDescription:@"subresource through proxy"];
  [self waitForTitle:browser completion:resource attempts:100];
  [self waitForExpectations:@[resource] timeout:15];
  XCTestExpectation *download = [self expectationWithDescription:@"authenticated download"];
  [self.adapter download:@42 identifier:NSUUID.UUID.UUIDString url:@"http://ssh-only.invalid/file" maxBytes:@1024 resolve:^(NSDictionary *result) {
    XCTAssertEqualObjects(result[@"bytes"], @11);
    NSString *body = [NSString stringWithContentsOfFile:result[@"local_path"] encoding:NSUTF8StringEncoding error:nil];
    XCTAssertEqualObjects(body, @"through-ssh");
    [[NSFileManager defaultManager] removeItemAtPath:result[@"local_path"] error:nil];
    [download fulfill];
  } reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); [download fulfill]; }];
  [self waitForExpectations:@[download] timeout:30];
  @synchronized(self.proxy) {
    XCTAssertTrue([self.proxy.hosts containsObject:@"ssh-only.invalid"]);
    NSPredicate *authenticated = [NSPredicate predicateWithBlock:^BOOL(NSString *request, NSDictionary *bindings) {
      return [request containsString:@"GET /file "] && [request containsString:@"session=host-a"];
    }];
    XCTAssertEqual([self.proxy.requests filteredArrayUsingPredicate:authenticated].count, 1);
  }
}
- (void)testRetiredStoreNeverReactivatesAndHostsDoNotShareState {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  [self configure:@"a" port:self.proxy.port];
  WKWebView *a = [self browserForRuntime:@"a" host:@"saved-a"];
  WKWebsiteDataStore *old = a.configuration.websiteDataStore;
  NSHTTPCookie *credential = [NSHTTPCookie cookieWithProperties:@{NSHTTPCookieName:@"credential",
    NSHTTPCookieValue:@"host-a-only", NSHTTPCookieDomain:@"ssh-only.invalid", NSHTTPCookiePath:@"/"}];
  XCTestExpectation *saved = [self expectationWithDescription:@"host A cookie saved"];
  [old.httpCookieStore setCookie:credential completionHandler:^{ [saved fulfill]; }];
  [self waitForExpectations:@[saved] timeout:10];
  WKWebView *remounted = [self browserForRuntime:@"a" host:@"saved-a"];
  XCTAssertEqual(old, remounted.configuration.websiteDataStore);
  [self assertCredentialCount:1 inStore:remounted.configuration.websiteDataStore];
  [self configure:@"" port:-1];
  [self configure:@"b" port:self.proxy.port];
  WKWebView *b = [self browserForRuntime:@"b" host:@"saved-b"];
  XCTAssertNotEqual(old, b.configuration.websiteDataStore);
  [self assertCredentialCount:0 inStore:b.configuration.websiteDataStore];
  XCTAssertFalse(nw_proxy_config_get_failover_allowed(old.proxyConfigurations.firstObject));
  [self configure:@"a" port:self.proxy.port];
  WKWebView *newA = [self browserForRuntime:@"a" host:@"saved-a"];
  XCTAssertNotEqual(old, newA.configuration.websiteDataStore);
  [self assertCredentialCount:0 inStore:newA.configuration.websiteDataStore];
  // A stale view cannot be prepared again, even for the same host/runtime.
  self.registry.browser = a;
  __block BOOL rejected = NO;
  [self.adapter prepare:@42 runtimeId:@"a" tunnelHostId:@"saved-a" resolve:^(id value) { XCTFail(@"Stale renderer reactivated"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
}
- (void)assertCredentialCount:(NSUInteger)count inStore:(WKWebsiteDataStore *)store {
  XCTestExpectation *read = [self expectationWithDescription:@"isolated cookie read"];
  [store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    NSPredicate *credential = [NSPredicate predicateWithBlock:^BOOL(NSHTTPCookie *cookie, NSDictionary *bindings) {
      return [cookie.name isEqual:@"credential"];
    }];
    XCTAssertEqual([cookies filteredArrayUsingPredicate:credential].count, count);
    [read fulfill];
  }];
  [self waitForExpectations:@[read] timeout:10];
}
- (void)testUnavailableProxyAllowsDirectNumericIPRequest {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  // The HTTP destination is reachable locally, but the configured proxy is dead.
  BrowserSOCKSFixture *unused = [BrowserSOCKSFixture new];
  uint16_t deadPort = unused.port; unused = nil;
  [self configure:@"a" port:deadPort];
  WKWebView *browser = [self browserForRuntime:@"a" host:@"saved-a"];
  self.expectFailure = YES;
  self.probing = YES;
  self.navigation = [self expectationWithDescription:@"direct IP fallback"];
  NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%u/", self.proxy.port];
  [browser loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];
  [self waitForExpectations:@[self.navigation] timeout:60];
  @synchronized(self.proxy) { XCTAssertGreaterThan(self.proxy.connections, 0); }
  XCTAssertNil(self.probeError);
}
- (void)assertProxyRoutingWithProxied:(NSUInteger)proxied direct:(NSUInteger)direct numericIP:(BOOL)numericIP context:(NSString *)context {
  // No observed socket is inconclusive, not evidence of fail-closed routing.
  // Keep this assertion outside the known-bypass expectation.
  XCTAssertGreaterThan(proxied + direct, 0, @"%@: inconclusive probe; neither fixture observed a connection", context);
  if (numericIP) {
    // #394 varies by OS and address: e.g. the hosted runner proxies its LAN IP
    // while loopback bypasses. A routed probe need not reproduce the bug, but
    // every observed leak must still be recorded as an expected failure.
    XCTExpectFailureWithOptionsInBlock(@"#394: numeric IP destinations can bypass the public proxy API",
      XCTExpectedFailureOptions.nonStrictOptions, ^{
        XCTAssertEqual(direct, 0, @"%@ must not bypass its proxy", context);
      });
  } else {
    XCTAssertGreaterThan(proxied, 0, @"%@ must reach its proxy", context);
    XCTAssertEqual(direct, 0, @"%@ must not bypass its proxy", context);
  }
}
- (void)testPublicWebKitProxyRoutingMatrix {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  self.probing = YES;
  NSMutableArray *cases = [@[
    @[@"socks", @"127.0.0.1", @"127.0.0.1", @[]],
    @[@"connect", @"127.0.0.1", @"127.0.0.1", @[@"127.0.0.1"]],
    @[@"relay", @"127.0.0.1", @"127.0.0.1", @[]],
    @[@"tls-connect", @"127.0.0.1", @"127.0.0.1", @[]],
    @[@"socks", @"127.0.0.1", @"[::1]", @[]],
    @[@"socks", @"127.0.0.1", @"localhost", @[]],
    @[@"socks", @"127.0.0.1", @"ssh-only.invalid", @[]]
  ] mutableCopy];
  NSString *lan = [self localLANAddress];
  if (lan) [cases addObject:@[@"socks", @"127.0.0.1", lan, @[]]];
  for (NSString *scheme in @[@"http", @"https"]) {
    for (NSArray *probe in cases) {
      BrowserSOCKSFixture *target = [[BrowserSOCKSFixture alloc] initWithAddress:[probe[2] isEqual:@"[::1]"] ? @"::1" : [probe[2] isEqual:lan] ? lan : @"127.0.0.1"];
      XCTAssertNotNil(target);
      NSUInteger before;
      @synchronized(self.proxy) { before = self.proxy.connections; }
      nw_endpoint_t endpoint = nw_endpoint_create_host([probe[1] UTF8String], [@(self.proxy.port).stringValue UTF8String]);
      nw_proxy_config_t proxy;
      if ([probe[0] isEqual:@"relay"]) proxy = nw_proxy_config_create_relay(nw_relay_hop_create(nil, endpoint, nil), nil);
      else if ([probe[0] isEqual:@"tls-connect"]) proxy = nw_proxy_config_create_http_connect(endpoint, nw_tls_create_options());
      else proxy = [probe[0] isEqual:@"socks"] ? nw_proxy_config_create_socksv5(endpoint) : nw_proxy_config_create_http_connect(endpoint, nil);
      nw_proxy_config_set_failover_allowed(proxy, false);
      for (NSString *match in probe[3]) nw_proxy_config_add_match_domain(proxy, match.UTF8String);
      WKWebViewConfiguration *config = [WKWebViewConfiguration new];
      config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
      config.websiteDataStore.proxyConfigurations = @[proxy];
      config.processPool = [WKProcessPool new];
      WKWebView *browser = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 400, 400) configuration:config];
      self.registry.browser = browser;
      browser.navigationDelegate = self;
      self.probeError = nil;
      self.navigation = [self expectationWithDescription:@"raw proxy probe"];
      [browser loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[NSString stringWithFormat:@"%@://%@:%u/", scheme, probe[2], target.port]] cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:3]];
      [self waitForExpectations:@[self.navigation] timeout:60];
      @synchronized(self.proxy) { @synchronized(target) {
        BOOL hostname = [probe[2] isEqual:@"localhost"] || [probe[2] isEqual:@"ssh-only.invalid"];
        NSLog(@"PROXY_DIAGNOSTIC scheme=%@ kind=%@ host=%@ proxied=%lu direct=%lu prefixes=%@ error=%ld", scheme, probe[0], probe[2],
          (unsigned long)(self.proxy.connections - before), (unsigned long)target.connections, target.prefixes, (long)self.probeError.code);
        [self assertProxyRoutingWithProxied:self.proxy.connections - before direct:target.connections numericIP:!hostname
          context:[NSString stringWithFormat:@"WebKit %@ %@ %@", scheme, probe[0], probe[2]]];
      }}
      browser.navigationDelegate = nil;
      [browser stopLoading];
    }
  }
}
- (void)testPublicURLSessionProxyRouting {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  for (NSString *kind in @[@"network", @"dictionary"]) {
    for (NSString *host in @[@"127.0.0.1", @"localhost", @"ssh-only.invalid"]) {
      BrowserSOCKSFixture *target = [BrowserSOCKSFixture new];
      XCTAssertNotNil(target);
      NSUInteger before;
      @synchronized(self.proxy) { before = self.proxy.connections; }
      NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
      configuration.timeoutIntervalForRequest = 3;
      configuration.timeoutIntervalForResource = 5;
      if ([kind isEqual:@"network"]) {
        nw_endpoint_t endpoint = nw_endpoint_create_host("127.0.0.1", @(self.proxy.port).stringValue.UTF8String);
        nw_proxy_config_t proxy = nw_proxy_config_create_socksv5(endpoint);
        nw_proxy_config_set_failover_allowed(proxy, false);
        configuration.proxyConfigurations = @[proxy];
      } else {
        configuration.connectionProxyDictionary = @{@"SOCKSEnable":@YES, @"SOCKSProxy":@"127.0.0.1", @"SOCKSPort":@(self.proxy.port),
          @"ExceptionsList":@[], @"ExcludeSimpleHostnames":@NO};
      }
      NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
      XCTestExpectation *done = [self expectationWithDescription:@"URLSession proxy probe"];
      NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://%@:%u/", host, target.port]];
      [[session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        @synchronized(self.proxy) { @synchronized(target) {
          NSLog(@"URLSESSION_DIAGNOSTIC kind=%@ host=%@ proxied=%lu direct=%lu error=%ld", kind, host,
            (unsigned long)(self.proxy.connections - before), (unsigned long)target.connections, (long)error.code);
        }}
        [done fulfill];
      }] resume];
      [self waitForExpectations:@[done] timeout:10];
      [session invalidateAndCancel];
      @synchronized(self.proxy) { @synchronized(target) {
        [self assertProxyRoutingWithProxied:self.proxy.connections - before direct:target.connections numericIP:[host isEqual:@"127.0.0.1"]
          context:[NSString stringWithFormat:@"URLSession %@ %@", kind, host]];
      }}
    }
  }
}
- (void)testPublicNetworkFrameworkProxyRouting {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  for (NSString *host in @[@"127.0.0.1", @"localhost", @"ssh-only.invalid"]) {
    BrowserSOCKSFixture *target = [BrowserSOCKSFixture new];
    XCTAssertNotNil(target);
    NSUInteger before;
    @synchronized(self.proxy) { before = self.proxy.connections; }
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_privacy_context_t privacy = nw_privacy_context_create("whip-proxy-diagnostic");
    nw_endpoint_t endpoint = nw_endpoint_create_host("127.0.0.1", @(self.proxy.port).stringValue.UTF8String);
    nw_proxy_config_t proxy = nw_proxy_config_create_socksv5(endpoint);
    nw_proxy_config_set_failover_allowed(proxy, false);
    nw_privacy_context_add_proxy(privacy, proxy);
    nw_parameters_set_privacy_context(parameters, privacy);
    nw_connection_t connection = nw_connection_create(nw_endpoint_create_host(host.UTF8String, @(target.port).stringValue.UTF8String), parameters);
    XCTestExpectation *done = [self expectationWithDescription:@"Network proxy probe"];
    __block BOOL finished = NO;
    __block nw_connection_state_t lastState = nw_connection_state_invalid;
    __block nw_error_t lastError = nil;
    void (^finish)(void) = ^{
      if (finished) return; finished = YES;
      @synchronized(self.proxy) { @synchronized(target) {
        NSLog(@"NETWORK_DIAGNOSTIC host=%@ proxied=%lu direct=%lu state=%u error=%@", host,
          (unsigned long)(self.proxy.connections - before), (unsigned long)target.connections, (unsigned int)lastState, lastError);
      }}
      [done fulfill]; nw_connection_set_state_changed_handler(connection, nil); nw_connection_cancel(connection);
    };
    nw_connection_set_queue(connection, dispatch_get_main_queue());
    nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
      lastState = state; lastError = error;
      if (state == nw_connection_state_ready) {
        const char *request = "GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n";
        dispatch_data_t data = dispatch_data_create(request, strlen(request), dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
        nw_connection_send(connection, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t error) {
          if (error) { lastError = error; finish(); return; }
          // Sending is not proof that the fixture's accept queue has run. Wait
          // for its response instead of sampling connection counts after 200ms.
          nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            lastError = error; finish();
          });
        });
      } else if (state == nw_connection_state_failed) finish();
    });
    nw_connection_start(connection);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ finish(); });
    [self waitForExpectations:@[done] timeout:15];
    @synchronized(self.proxy) { @synchronized(target) {
      [self assertProxyRoutingWithProxied:self.proxy.connections - before direct:target.connections numericIP:[host isEqual:@"127.0.0.1"]
        context:[NSString stringWithFormat:@"Network.framework %@", host]];
    }}
  }
}
- (NSString *)localLANAddress {
  struct ifaddrs *interfaces;
  if (getifaddrs(&interfaces)) return nil;
  NSString *host = nil;
  for (struct ifaddrs *item = interfaces; item; item = item->ifa_next) {
    if (!item->ifa_addr || item->ifa_addr->sa_family != AF_INET || !(item->ifa_flags & IFF_UP)
        || (item->ifa_flags & IFF_LOOPBACK)) continue;
    const struct sockaddr_in *address = (const struct sockaddr_in *)item->ifa_addr;
    char buffer[INET_ADDRSTRLEN];
    if (inet_ntop(AF_INET, &address->sin_addr, buffer, sizeof(buffer))) {
      host = [NSString stringWithUTF8String:buffer]; break;
    }
  }
  freeifaddrs(interfaces);
  return host;
}
- (void)testHostnameUsesProxyAndFallsBackWhenProxyIsUnavailable {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  BrowserSOCKSFixture *target = [BrowserSOCKSFixture new];
  [self configure:@"a" port:self.proxy.port];
  WKWebView *browser = [self browserForRuntime:@"a" host:@"saved-a"];
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://localhost:%u/", target.port]];
  self.navigation = [self expectationWithDescription:@"hostname goes through proxy"];
  [browser loadRequest:[NSURLRequest requestWithURL:url]];
  [self waitForExpectations:@[self.navigation] timeout:15];
  @synchronized(self.proxy) { XCTAssertTrue([self.proxy.hosts containsObject:@"localhost"]); }
  @synchronized(target) { XCTAssertEqual(target.connections, 0); }
  [self configure:@"" port:-1];
  BrowserSOCKSFixture *unused = [BrowserSOCKSFixture new];
  uint16_t port = unused.port; unused = nil;
  [self configure:@"a" port:port];
  browser = [self browserForRuntime:@"a" host:@"saved-a"];
  self.expectFailure = NO;
  self.probeError = nil;
  self.navigation = [self expectationWithDescription:@"hostname falls back directly"];
  [browser loadRequest:[NSURLRequest requestWithURL:url]];
  [self waitForExpectations:@[self.navigation] timeout:15];
  @synchronized(target) { XCTAssertGreaterThan(target.connections, 0); }
  XCTAssertNil(self.probeError);
}
- (void)testHostnameNavigationRedirectAllowsDirectNumericIP {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  BrowserSOCKSFixture *target = [BrowserSOCKSFixture new];
  self.proxy.redirectURL = [NSString stringWithFormat:@"http://127.0.0.1:%u/", target.port];
  [self configure:@"a" port:self.proxy.port];
  WKWebView *browser = [self browserForRuntime:@"a" host:@"saved-a"];
  self.probing = YES;
  self.navigation = [self expectationWithDescription:@"redirect finishes"];
  [browser loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"http://ssh-only.invalid/escape"]]];
  [self waitForExpectations:@[self.navigation] timeout:15];
  @synchronized(self.proxy) { XCTAssertTrue([self.proxy.hosts containsObject:@"ssh-only.invalid"]); }
  @synchronized(target) { XCTAssertGreaterThan(target.connections, 0); }
  XCTAssertNil(self.probeError);
}
- (void)testHostnameDownloadRedirectAllowsDirectNumericIP {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  BrowserSOCKSFixture *target = [BrowserSOCKSFixture new];
  self.proxy.redirectURL = [NSString stringWithFormat:@"http://127.0.0.1:%u/file", target.port];
  [self configure:@"a" port:self.proxy.port];
  [self browserForRuntime:@"a" host:@"saved-a"];
  XCTestExpectation *done = [self expectationWithDescription:@"download redirect finishes"];
  __block NSString *body;
  [self.adapter download:@42 identifier:NSUUID.UUID.UUIDString url:@"http://ssh-only.invalid/escape" maxBytes:@1024 resolve:^(NSDictionary *result) {
    body = [NSString stringWithContentsOfFile:result[@"local_path"] encoding:NSUTF8StringEncoding error:nil];
    [[NSFileManager defaultManager] removeItemAtPath:result[@"local_path"] error:nil]; [done fulfill];
  } reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); [done fulfill]; }];
  [self waitForExpectations:@[done] timeout:15];
  @synchronized(self.proxy) { XCTAssertTrue([self.proxy.hosts containsObject:@"ssh-only.invalid"]); }
  @synchronized(target) { XCTAssertGreaterThan(target.connections, 0); }
  XCTAssertEqualObjects(body, @"direct-leak");
}
- (void)testProductionCapabilityFollowsOSAndPreservesUntunneledStore {
  if (@available(iOS 17.0, *)) {
    XCTAssertEqualObjects(self.adapter.constantsToExport[@"supportsProxy"], @YES);
    [self configure:@"*" port:0];
    WKWebView *direct = [self browserForRuntime:@"a" host:nil];
    XCTAssertEqual(direct.configuration.websiteDataStore, WKWebsiteDataStore.defaultDataStore);
    [self configure:@"a" port:self.proxy.port];
    WKWebView *tunnel = [self browserForRuntime:@"a" host:@"saved-a"];
    XCTAssertNotEqual(tunnel.configuration.websiteDataStore, WKWebsiteDataStore.defaultDataStore);
    XCTAssertEqual(WKWebsiteDataStore.defaultDataStore.proxyConfigurations.count, 0);
    XCTAssertTrue(nw_proxy_config_get_failover_allowed(tunnel.configuration.websiteDataStore.proxyConfigurations.firstObject));
  } else {
    XCTAssertEqualObjects(self.adapter.constantsToExport[@"supportsProxy"], @NO);
    __block BOOL rejected = NO;
    [self.adapter configureProxy:@"a" port:self.proxy.port resolve:^(id value) { XCTFail(@"Unsupported proxy enabled"); }
      reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
    XCTAssertTrue(rejected);
    self.registry.browser = [[WKWebView alloc] initWithFrame:CGRectZero];
    [self.adapter prepare:@42 runtimeId:@"a" tunnelHostId:nil resolve:^(id value) {}
      reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"Untunneled browsing rejected"); }];
    rejected = NO;
    [self.adapter prepare:@42 runtimeId:@"a" tunnelHostId:@"saved-a" resolve:^(id value) { XCTFail(@"Unsupported tunnel prepared"); }
      reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
    XCTAssertTrue(rejected);
  }
}
- (void)webView:(WKWebView *)browser didFinishNavigation:(WKNavigation *)navigation {
  // Retiring a route blanks old views asynchronously. Those callbacks must
  // not complete a newer renderer's expectation or look like direct fallback.
  if (browser != self.registry.browser || !self.navigation) return;
  if (!self.probing && self.expectFailure) XCTFail(@"Request escaped unavailable proxy");
  [self.navigation fulfill]; self.navigation = nil;
}
- (void)webView:(WKWebView *)browser didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (browser != self.registry.browser || !self.navigation) return;
  self.probeError = error;
  if (!self.probing && !self.expectFailure) XCTFail(@"%@", error);
  [self.navigation fulfill]; self.navigation = nil;
}
@end
