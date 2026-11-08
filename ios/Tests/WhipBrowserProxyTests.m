#import <XCTest/XCTest.h>
#import <WebKit/WebKit.h>
#import <Network/Network.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>
#import "WhipBrowser.h"

@interface WhipBrowser (ProxyTesting)
+ (BOOL)supportsProxy;
- (NSDictionary *)constantsToExport;
- (void)configureProxy:(NSString *)runtime port:(double)port resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)prepare:(NSNumber *)tag runtimeId:(NSString *)runtime tunnelHostId:(NSString *)host resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)download:(NSNumber *)tag identifier:(NSString *)identifier url:(NSString *)url maxBytes:(NSNumber *)maxBytes resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)invalidate;
@end

// Exercise the candidate behind the production capability gate. This override
// is compiled only into the standalone XCTest target, never into Whip.
@interface ProxyCandidateAdapter : WhipBrowser
@end
@implementation ProxyCandidateAdapter
+ (BOOL)supportsProxy { return YES; }
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
- (instancetype)init {
  if ((self = [super init])) {
    _requests = [NSMutableArray new]; _hosts = [NSMutableArray new]; _prefixes = [NSMutableArray new];
    _listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {.sin_len = sizeof(address), .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    if (bind(_listener, (struct sockaddr *)&address, sizeof(address)) || listen(_listener, 16)) return nil;
    socklen_t size = sizeof(address);
    getsockname(_listener, (struct sockaddr *)&address, &size);
    _port = ntohs(address.sin_port);
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
  if (greeting[0] == 'C') {
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
  NSMutableData *data = [NSMutableData new];
  uint8_t byte;
  while (data.length < 32768 && ReadBytes(client, &byte, 1)) {
    [data appendBytes:&byte length:1];
    if (data.length >= 4 && !memcmp((const char *)data.bytes + data.length - 4, "\r\n\r\n", 4)) break;
  }
  NSString *request = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!request) return;
  @synchronized(self) { [self.requests addObject:request]; }
  NSString *body = @"through-ssh";
  NSString *extra = @"Content-Type: text/plain\r\n";
  NSString *status = @"200 OK";
  if ([request containsString:@"GET /start "]) {
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
@end
@implementation WhipBrowserProxyTests
- (void)setUp {
  self.adapter = [ProxyCandidateAdapter new]; self.registry = [ProxyTestRegistry new];
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
- (void)testUnavailableProxyDoesNotFallBackEvenForLoopback {
  if (@available(iOS 17.0, *)) {} else { XCTSkip(@"Requires public iOS 17 proxy API"); return; }
  // The HTTP destination is reachable locally, but the configured proxy is dead.
  BrowserSOCKSFixture *unused = [BrowserSOCKSFixture new];
  uint16_t deadPort = unused.port; unused = nil;
  [self configure:@"a" port:deadPort];
  WKWebView *browser = [self browserForRuntime:@"a" host:@"saved-a"];
  self.expectFailure = YES;
  self.navigation = [self expectationWithDescription:@"no direct fallback"];
  NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%u/", self.proxy.port];
  [browser loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];
  [self waitForExpectations:@[self.navigation] timeout:60];
  XCTExpectFailureInBlock(@"#394: public WebKit proxy configuration bypasses loopback; production iOS proxy capability must remain disabled", ^{
    @synchronized(self.proxy) { XCTAssertEqual(self.proxy.connections, 0, @"prefixes: %@, hosts: %@, dead: %u, destination: %u", self.proxy.prefixes, self.proxy.hosts, deadPort, self.proxy.port); }
  });
}
- (void)testProductionCapabilityRejectsTunnelingAndPreservesUntunneledBrowsing {
  WhipBrowser *production = [WhipBrowser new];
  production.viewRegistry_DEPRECATED = (RCTViewRegistry *)self.registry;
  XCTAssertEqualObjects(production.constantsToExport[@"supportsProxy"], @NO);
  __block BOOL rejected = NO;
  [production configureProxy:@"a" port:self.proxy.port resolve:^(id value) { XCTFail(@"Unsafe proxy capability enabled"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.websiteDataStore = [WhipBrowserRoute websiteDataStoreForRoute:@"[\"a\",null]"];
  XCTAssertEqual(config.websiteDataStore, WKWebsiteDataStore.defaultDataStore);
  self.registry.browser = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
  [production prepare:@42 runtimeId:@"a" tunnelHostId:nil resolve:^(id value) {}
    reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"Untunneled browsing rejected"); }];
  rejected = NO;
  [production prepare:@42 runtimeId:@"a" tunnelHostId:@"saved-a" resolve:^(id value) { XCTFail(@"Tunnel silently became direct browsing"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
}
- (void)webView:(WKWebView *)browser didFinishNavigation:(WKNavigation *)navigation {
  if (self.expectFailure) XCTFail(@"Request escaped unavailable proxy");
  [self.navigation fulfill]; self.navigation = nil;
}
- (void)webView:(WKWebView *)browser didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (!self.expectFailure) XCTFail(@"%@", error);
  [self.navigation fulfill]; self.navigation = nil;
}
@end
