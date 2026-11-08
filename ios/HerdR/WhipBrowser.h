#import <React/RCTBridgeModule.h>
#import <WebKit/WebKit.h>

// Called by our WebView patch before WKWebView is constructed.
@interface WhipBrowserRoute : NSObject
+ (WKWebsiteDataStore *)websiteDataStoreForRoute:(NSString *)route;
@end

@interface WhipBrowser : NSObject <RCTBridgeModule>
@end
