#import <XCTest/XCTest.h>
#import <WebKit/WebKit.h>
#import "WhipBrowser.h"

// The standalone runner uses the real React Native headers and export macros.
// Replace only registration and tag lookup; all browser operations use WebKit.
static Class registeredModule;
void RCTRegisterModule(Class module) { registeredModule = module; }

@interface WhipBrowser (Testing)
- (void)prepare:(NSNumber *)tag resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)defaultUserAgent:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)evaluate:(NSNumber *)tag script:(NSString *)script resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)navigate:(NSNumber *)tag url:(NSString *)url resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)screenshot:(NSNumber *)tag annotations:(NSDictionary *)annotations resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)siteData:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)clearDomainCookies:(NSString *)domain resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)clearSiteData:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
@end

@interface BrowserTestRegistry : NSObject
@property (nonatomic, strong) UIView *view;
@end
@implementation BrowserTestRegistry
- (UIView *)viewForReactTag:(NSNumber *)tag { return [tag isEqual:@42] ? self.view : nil; }
@end

@interface WhipBrowserTests : XCTestCase <WKNavigationDelegate>
@property (nonatomic, strong) WhipBrowser *adapter;
@property (nonatomic, strong) BrowserTestRegistry *registry;
@property (nonatomic, strong) WKWebView *browser;
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) XCTestExpectation *navigation;
@property (nonatomic, strong) NSURL *requestedURL;
@property (nonatomic) BOOL interceptNavigation;
@end

@implementation WhipBrowserTests
- (NSDictionary *)pageResult:(NSString *)script
{
  NSString *encoded = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter evaluate:@42 script:script resolve:resolve reject:reject];
  }];
  id value = [NSJSONSerialization JSONObjectWithData:[encoded dataUsingEncoding:NSUTF8StringEncoding]
                                            options:NSJSONReadingFragmentsAllowed error:nil];
  if ([value isKindOfClass:NSString.class])
    value = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  return value;
}

- (void)testRustDOMRuntimeAndAsyncPageResults
{
  NSString *path = [[NSBundle bundleForClass:self.class] pathForResource:@"dom" ofType:@"js"];
  XCTAssertNotNil(path);
  NSString *runtime = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
  NSDictionary *found = [self pageResult:[NSString stringWithFormat:
    @"(() => { %@; return JSON.stringify(domRuntime('native-test','find',{role:'button',name:'Continue'},'doc-1')); })()", runtime]];
  XCTAssertEqualObjects(found[@"matches"], @1);
  NSString *reference = found[@"elements"][0][@"ref"];
  NSString *quoted = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:reference
                                      options:NSJSONWritingFragmentsAllowed error:nil] encoding:NSUTF8StringEncoding];
  [self pageResult:[NSString stringWithFormat:@"(() => { %@; return JSON.stringify(domRuntime('native-test','click',{ref:%@},'doc-1')); })()", runtime, quoted]];
  NSDictionary *stale = [self pageResult:[NSString stringWithFormat:
    @"(() => { %@; try { domRuntime('native-test','click',{ref:%@},'doc-1'); return '{}'; } catch(e) {return JSON.stringify({code:e.code});} })()", runtime, quoted]];
  XCTAssertEqualObjects(stale[@"code"], @"stale_ref");
  NSDictionary *started = [self pageResult:@"(() => { window.testResult=null; Promise.resolve({page:true,native:typeof window.WhipBrowser}).then(value => window.testResult=value); return JSON.stringify({started:true}); })()"];
  XCTAssertEqualObjects(started[@"started"], @YES);
  NSDictionary *result = [self pageResult:@"JSON.stringify(window.testResult)"];
  XCTAssertEqualObjects(result[@"page"], @YES);
  XCTAssertEqualObjects(result[@"native"], @"undefined");
}
- (id)resultOf:(void (^)(RCTPromiseResolveBlock, RCTPromiseRejectBlock))operation
{
  XCTestExpectation *done = [self expectationWithDescription:@"native promise"];
  __block id result;
  operation(^(id value) {
    result = value;
    [done fulfill];
  }, ^(NSString *code, NSString *message, NSError *error) {
    XCTFail(@"%@ %@ %@", code, message, error);
    [done fulfill];
  });
  [self waitForExpectations:@[done] timeout:15];
  return result;
}

- (void)assertRedViewport:(UIImage *)image
{
  XCTAssertNotNil(image);
  uint8_t pixel[4] = {0};
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(pixel, 1, 1, 8, 4, colorSpace,
                                               (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGContextDrawImage(context, CGRectMake(0, 0, 1, 1), image.CGImage);
  CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  // The page is red. A correctly sized but blank snapshot must fail this test.
  XCTAssertGreaterThan(pixel[0], 200);
  XCTAssertLessThan(pixel[1], 60);
  XCTAssertLessThan(pixel[2], 60);
}

- (void)setUp
{
  [super setUp];
  self.adapter = [WhipBrowser new];
  [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter clearSiteData:resolve reject:reject];
  }];
  self.browser = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 1600, 1200)];
  self.browser.navigationDelegate = self;
  self.registry = [BrowserTestRegistry new];
  self.registry.view = [[UIView alloc] initWithFrame:self.browser.bounds];
  UIView *wrapper = [[UIView alloc] initWithFrame:self.browser.bounds];
  [wrapper addSubview:self.browser];
  [self.registry.view addSubview:wrapper];
  self.adapter.viewRegistry_DEPRECATED = (RCTViewRegistry *)self.registry;
  UIWindowScene *scene = nil;
  for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes)
    if ([candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
  self.window = scene ? [[UIWindow alloc] initWithWindowScene:scene]
                      : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.frame = scene ? scene.coordinateSpace.bounds : UIScreen.mainScreen.bounds;
  UIViewController *controller = [UIViewController new];
  self.window.rootViewController = controller;
  // Match BrowserSurface: keep the CSS viewport large and scale its enclosing
  // native container to fit the visible window.
  self.registry.view.transform = CGAffineTransformMakeScale(0.2, 0.2);
  self.registry.view.frame = CGRectMake(0, 0, 320, 240);
  [controller.view addSubview:self.registry.view];
  [self.window makeKeyAndVisible];
  [self.window layoutIfNeeded];
  self.navigation = [self expectationWithDescription:@"page loaded"];
  [self.browser loadHTMLString:@"<html><body style='background:red'><button id='button'>Continue</button></body></html>"
                      baseURL:[NSURL URLWithString:@"https://example.test/"]];
  [self waitForExpectations:@[self.navigation] timeout:15];
}

- (void)tearDown
{
  [self.browser stopLoading];
  self.browser.navigationDelegate = nil;
  self.window.hidden = YES;
  self.window = nil;
  self.registry = nil;
  self.browser = nil;
  self.adapter = nil;
  [super tearDown];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
  [self.navigation fulfill];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler
{
  if (self.interceptNavigation) {
    self.requestedURL = action.request.URL;
    decisionHandler(WKNavigationActionPolicyCancel);
    [self.navigation fulfill];
  } else decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)testRegistrationAndNestedFabricContainer
{
  XCTAssertEqual(registeredModule, WhipBrowser.class);
  [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter prepare:@42 resolve:resolve reject:reject];
  }];
  XCTAssertTrue(self.browser.allowsBackForwardNavigationGestures);
  self.registry.view = nil;
  XCTestExpectation *done = [self expectationWithDescription:@"unmounted tag rejected"];
  [self.adapter prepare:@42 resolve:^(id value) { XCTFail(@"Unmounted browser resolved"); [done fulfill]; }
                 reject:^(NSString *code, NSString *message, NSError *error) {
    XCTAssertEqualObjects(code, @"BROWSER_UNAVAILABLE");
    [done fulfill];
  }];
  [self waitForExpectations:@[done] timeout:5];
}

- (void)testEvaluationEncodingAndFailure
{
  for (NSString *script in @[@"({ok:true, value:document.querySelector('#button').textContent})",
                             @"JSON.stringify({ok:true, value:'Continue'})"]) {
    NSString *encoded = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
      [self.adapter evaluate:@42 script:script resolve:resolve reject:reject];
    }];
    id value = [NSJSONSerialization JSONObjectWithData:[encoded dataUsingEncoding:NSUTF8StringEncoding]
                                             options:NSJSONReadingFragmentsAllowed error:nil];
    if ([value isKindOfClass:NSString.class])
      value = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    XCTAssertEqualObjects(value, (@{@"ok": @YES, @"value": @"Continue"}));
  }
  XCTestExpectation *done = [self expectationWithDescription:@"JavaScript failure"];
  [self.adapter evaluate:@42 script:@"throw new Error('test')"
                  resolve:^(id value) { XCTFail(@"Script failure resolved"); [done fulfill]; }
                   reject:^(NSString *code, NSString *message, NSError *error) {
    XCTAssertEqualObjects(code, @"BROWSER_EVALUATE");
    [done fulfill];
  }];
  [self waitForExpectations:@[done] timeout:15];
}

- (void)testUserAgentAndBoundedViewportScreenshot
{
  XCTAssertEqual(self.browser.window, self.window);
  XCTAssertFalse(self.window.hidden);
  NSString *color = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter evaluate:@42 script:@"getComputedStyle(document.body).backgroundColor" resolve:resolve reject:reject];
  }];
  XCTAssertEqualObjects(color, @"\"rgb(255, 0, 0)\"");
  NSString *agent = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter defaultUserAgent:resolve reject:reject];
  }];
  XCTAssertTrue([agent containsString:@"AppleWebKit/"]);
  NSString *encoded = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter screenshot:@42 annotations:nil resolve:resolve reject:reject];
  }];
  NSData *jpeg = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
  UIImage *image = [UIImage imageWithData:jpeg];
  XCTAssertNotNil(image);
  XCTAttachment *capture = [XCTAttachment attachmentWithImage:image];
  capture.name = @"Browser viewport";
  capture.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:capture];
  XCTAssertEqual(CGImageGetWidth(image.CGImage), 1024u);
  XCTAssertEqual(CGImageGetHeight(image.CGImage), 768u);
  XCTAssertLessThan(jpeg.length, 1024u * 1024u);
  [self assertRedViewport:image];
}

- (void)testHiddenBrowserScreenshotRetainsPageContent
{
  // BrowserSurface keeps hidden tabs mounted under a transparent parent.
  self.registry.view.alpha = 0;
  NSString *encoded = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter screenshot:@42 annotations:nil resolve:resolve reject:reject];
  }];
  UIImage *image = [UIImage imageWithData:[[NSData alloc] initWithBase64EncodedString:encoded options:0]];
  [self assertRedViewport:image];
}

- (void)testScreenshotAnnotationsDoNotModifyThePage
{
  NSString *before = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter evaluate:@42 script:@"document.body.innerHTML" resolve:resolve reject:reject];
  }];
  NSDictionary *annotations = @{
    @"viewport_width": @1600, @"viewport_height": @1200, @"generation": @"test",
    @"elements": @[@{@"ref": @"tab:1", @"x": @20, @"y": @20}]
  };
  NSString *encoded = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter screenshot:@42 annotations:annotations resolve:resolve reject:reject];
  }];
  UIImage *image = [UIImage imageWithData:[[NSData alloc] initWithBase64EncodedString:encoded options:0]];
  XCTAssertNotNil(image);
  CGImageRef sample = CGImageCreateWithImageInRect(image.CGImage, CGRectMake(14, 20, 1, 1));
  uint8_t pixel[4] = {0};
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(pixel, 1, 1, 8, 4, colorSpace,
                                               (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGContextDrawImage(context, CGRectMake(0, 0, 1, 1), sample);
  CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  CGImageRelease(sample);
  XCTAssertGreaterThan(pixel[2], pixel[0]);
  XCTAssertGreaterThan(pixel[2], pixel[1]);
  NSString *after = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter evaluate:@42 script:@"document.body.innerHTML" resolve:resolve reject:reject];
  }];
  XCTAssertEqualObjects(before, after);
}

- (void)testNavigationRejectsCredentialsAndNonWebSchemes
{
  for (NSString *url in @[@"file:///etc/passwd", @"javascript:alert(1)", @"https:///",
                          @"https://user:secret@example.test/", @"https://@example.test/"]) {
    XCTestExpectation *done = [self expectationWithDescription:@"unsafe URL rejected"];
    [self.adapter navigate:@42 url:url resolve:^(id value) { XCTFail(@"Unsafe URL resolved"); [done fulfill]; }
                    reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"BROWSER_URL");
      [done fulfill];
    }];
    [self waitForExpectations:@[done] timeout:5];
  }
  self.interceptNavigation = YES;
  self.navigation = [self expectationWithDescription:@"native request"];
  [self.adapter navigate:@42 url:@"http://127.0.0.1:54321/page?q=preview"
                  resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) {
    XCTFail(@"%@ %@", code, message);
  }];
  [self waitForExpectations:@[self.navigation] timeout:15];
  XCTAssertEqualObjects(self.requestedURL.absoluteString, @"http://127.0.0.1:54321/page?q=preview");
}

- (void)testCookieMetadataAndDeletionStayNative
{
  WKHTTPCookieStore *store = WKWebsiteDataStore.defaultDataStore.httpCookieStore;
  for (NSString *domain in @[@".example.test", @"sibling.example.test"]) {
    NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:@{
      NSHTTPCookieName: @"credential", NSHTTPCookieValue: @"never-export-this",
      NSHTTPCookieDomain: domain, NSHTTPCookiePath: @"/private", NSHTTPCookieSecure: @"TRUE",
      @"HttpOnly": @"TRUE"
    }];
    XCTestExpectation *done = [self expectationWithDescription:@"cookie stored"];
    [store setCookie:cookie completionHandler:^{ [done fulfill]; }];
    [self waitForExpectations:@[done] timeout:15];
  }
  NSDictionary *metadata = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter siteData:resolve reject:reject];
  }];
  XCTAssertEqualObjects(metadata, (@{@"hasCookies": @YES, @"canClearDomains": @YES,
                                     @"domains": @[@"example.test", @"sibling.example.test"]}));
  [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter clearDomainCookies:@"example.test" resolve:resolve reject:reject];
  }];
  metadata = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter siteData:resolve reject:reject];
  }];
  XCTAssertEqualObjects(metadata[@"domains"], (@[@"sibling.example.test"]));
  [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter clearSiteData:resolve reject:reject];
  }];
  metadata = [self resultOf:^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
    [self.adapter siteData:resolve reject:reject];
  }];
  XCTAssertEqualObjects(metadata[@"hasCookies"], @NO);
  XCTAssertEqualObjects(metadata[@"domains"], @[]);
}
@end
