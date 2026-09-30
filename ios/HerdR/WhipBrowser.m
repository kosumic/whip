#import "WhipBrowser.h"
#import <WebKit/WebKit.h>

static const CGFloat WhipBrowserScreenshotLimit = 1024;
static const CGFloat WhipBrowserJPEGQuality = 0.75;
static NSString *const WhipBrowserUnavailable = @"BROWSER_UNAVAILABLE";
static NSString *const WhipBrowserEvaluation = @"BROWSER_EVALUATE";
static NSString *const WhipBrowserScreenshot = @"BROWSER_SCREENSHOT";
static NSString *const WhipBrowserInvalidURL = @"BROWSER_URL";

/** Native operations are reachable only from React Native, never a webpage bridge. */
@implementation WhipBrowser
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;

RCT_EXPORT_MODULE(WhipBrowser)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (WKWebView *)browserInView:(UIView *)view
{
  if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
  for (UIView *child in view.subviews) {
    WKWebView *browser = [self browserInView:child];
    if (browser) return browser;
  }
  return nil;
}

- (void)withBrowser:(NSNumber *)tag
            reject:(RCTPromiseRejectBlock)reject
            action:(void (^)(WKWebView *))action
{
  // RCTViewRegistry resolves Fabric tags in the bridgeless app. The supplied
  // tag belongs to our non-collapsible container, not WebView's JS wrapper.
  WKWebView *browser = [self browserInView:[self.viewRegistry_DEPRECATED viewForReactTag:tag]];
  if (!browser) {
    reject(WhipBrowserUnavailable, @"Browser tab is no longer mounted", nil);
    return;
  }
  action(browser);
}

RCT_EXPORT_METHOD(prepare:(NSNumber *)tag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    browser.allowsBackForwardNavigationGestures = YES;
    resolve(nil);
  }];
}

RCT_EXPORT_METHOD(defaultUserAgent:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.defaultWebpagePreferences.preferredContentMode = WKContentModeMobile;
  WKWebView *browser = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration];
  [browser evaluateJavaScript:@"navigator.userAgent" completionHandler:^(id value, NSError *error) {
    // Keep the temporary view alive until WebKit completes the request.
    (void)browser;
    if (error || ![value isKindOfClass:NSString.class])
      reject(WhipBrowserUnavailable, @"Could not read browser user agent", error);
    else resolve(value);
  }];
}

RCT_EXPORT_METHOD(navigate:(NSNumber *)tag
                  url:(NSString *)url
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSURLComponents *address = [NSURLComponents componentsWithString:url];
  if (!([address.scheme isEqualToString:@"http"] || [address.scheme isEqualToString:@"https"]) ||
      !address.host.length || address.user != nil || address.password != nil || !address.URL) {
    reject(WhipBrowserInvalidURL, @"Only valid HTTP and HTTPS links without credentials can be opened", nil);
    return;
  }
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser loadRequest:[NSURLRequest requestWithURL:address.URL]];
    resolve(nil);
  }];
}

RCT_EXPORT_METHOD(evaluate:(NSNumber *)tag
                  script:(NSString *)script
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
      if (error) {
        reject(WhipBrowserEvaluation, @"Could not evaluate browser action", error);
        return;
      }
      // Android returns JSON-encoded evaluateJavascript results. Preserve that
      // contract, including a DOM program that itself returns a JSON string.
      NSData *encoded = [NSJSONSerialization dataWithJSONObject:value ?: NSNull.null
                                                       options:NSJSONWritingFragmentsAllowed
                                                         error:&error];
      if (!encoded) reject(WhipBrowserEvaluation, @"Browser action returned an unsupported value", error);
      else resolve([[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding]);
    }];
  }];
}

RCT_EXPORT_METHOD(screenshot:(NSNumber *)tag
                  annotations:(NSDictionary *)annotations
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    CGSize size = browser.bounds.size;
    if (size.width <= 0 || size.height <= 0) {
      reject(WhipBrowserScreenshot, @"Browser has no drawable viewport", nil);
      return;
    }
    CGFloat scale = MIN(1, WhipBrowserScreenshotLimit / MAX(size.width, size.height));
    CGSize outputSize = CGSizeMake(MAX(1, floor(size.width * scale)), MAX(1, floor(size.height * scale)));
    WKSnapshotConfiguration *configuration = [WKSnapshotConfiguration new];
    configuration.rect = browser.bounds;
    configuration.snapshotWidth = @(outputSize.width);
    [browser takeSnapshotWithConfiguration:configuration completionHandler:^(UIImage *image, NSError *error) {
      if (!image || error) {
        reject(WhipBrowserScreenshot, @"Could not capture browser viewport", error);
        return;
      }
      // WebKit may return a Retina image. Normalize to bounded pixel dimensions.
      UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
      format.scale = 1;
      format.opaque = YES;
      UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:outputSize format:format];
      UIImage *bounded = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        [UIColor.whiteColor setFill];
        [context fillRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
        [image drawInRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
        if (annotations) {
          CGFloat viewportWidth = [annotations[@"viewport_width"] doubleValue];
          CGFloat viewportHeight = [annotations[@"viewport_height"] doubleValue];
          if (viewportWidth > 0 && viewportHeight > 0) {
            CGContextRef cg = context.CGContext;
            CGContextSaveGState(cg);
            CGContextScaleCTM(cg, outputSize.width / viewportWidth, outputSize.height / viewportHeight);
            NSDictionary *attributes = @{NSFontAttributeName: [UIFont systemFontOfSize:11],
                                         NSForegroundColorAttributeName: UIColor.whiteColor};
            NSArray *elements = annotations[@"elements"];
            for (NSDictionary *item in [elements subarrayWithRange:NSMakeRange(0, MIN(elements.count, 200))]) {
              NSString *label = item[@"ref"];
              label = [label substringToIndex:MIN(label.length, 256)];
              CGFloat width = [label sizeWithAttributes:attributes].width + 6;
              CGFloat x = MAX(0, MIN([item[@"x"] doubleValue], viewportWidth - width));
              CGFloat y = MAX(0, MIN([item[@"y"] doubleValue], viewportHeight - 17));
              [[UIColor colorWithRed:18.0/255 green:64.0/255 blue:148.0/255 alpha:1] setFill];
              UIRectFill(CGRectMake(x, y, width, 17));
              [label drawAtPoint:CGPointMake(x + 3, y + 1) withAttributes:attributes];
            }
            CGContextRestoreGState(cg);
          }
        }
      }];
      NSData *jpeg = UIImageJPEGRepresentation(bounded, WhipBrowserJPEGQuality);
      if (!jpeg) reject(WhipBrowserScreenshot, @"Could not encode browser viewport", nil);
      else resolve([jpeg base64EncodedStringWithOptions:0]);
    }];
  }];
}

// WKHTTPCookieStore enumerates domains directly; no visited URL history or
// cookie values need to cross the native boundary or be persisted separately.
RCT_EXPORT_METHOD(recordSite:(NSString *)url) {}

RCT_EXPORT_METHOD(siteData:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [[WKWebsiteDataStore defaultDataStore].httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    NSMutableSet<NSString *> *domains = [NSMutableSet new];
    for (NSHTTPCookie *cookie in cookies) {
      NSString *domain = cookie.domain.lowercaseString;
      if ([domain hasPrefix:@"."]) domain = [domain substringFromIndex:1];
      if (domain.length) [domains addObject:domain];
    }
    resolve(@{@"hasCookies": @(cookies.count > 0), @"canClearDomains": @YES,
              @"domains": [domains.allObjects sortedArrayUsingSelector:@selector(compare:)]});
  }];
}

RCT_EXPORT_METHOD(clearDomainCookies:(NSString *)domain
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  WKHTTPCookieStore *store = [WKWebsiteDataStore defaultDataStore].httpCookieStore;
  [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    dispatch_group_t deletions = dispatch_group_create();
    for (NSHTTPCookie *cookie in cookies) {
      NSString *cookieDomain = cookie.domain.lowercaseString;
      if ([cookieDomain hasPrefix:@"."]) cookieDomain = [cookieDomain substringFromIndex:1];
      if (![cookieDomain isEqualToString:domain.lowercaseString]) continue;
      dispatch_group_enter(deletions);
      [store deleteCookie:cookie completionHandler:^{ dispatch_group_leave(deletions); }];
    }
    dispatch_group_notify(deletions, dispatch_get_main_queue(), ^{ resolve(nil); });
  }];
}

RCT_EXPORT_METHOD(clearSiteData:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [[WKWebsiteDataStore defaultDataStore] removeDataOfTypes:[WKWebsiteDataStore allWebsiteDataTypes]
                                          modifiedSince:NSDate.distantPast
                                      completionHandler:^{ resolve(nil); }];
}

RCT_EXPORT_METHOD(clearTabData:(NSNumber *)tag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser stopLoading];
    NSSet *caches = [NSSet setWithObjects:WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeDiskCache, nil];
    [browser.configuration.websiteDataStore removeDataOfTypes:caches
                                              modifiedSince:NSDate.distantPast
                                          completionHandler:^{ resolve(nil); }];
    // The shared controller disposes the renderer to clear history, form and
    // session state. WKWebView has no public API to clear its back-forward list.
  }];
}
@end
