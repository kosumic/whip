#import <React/RCTBridgeModule.h>
#import <React/RCTSurfaceHostingProxyRootView.h>
#import <React/RCTUtils.h>

@interface WhipLaunchScreen : NSObject <RCTBridgeModule>
@end

@implementation WhipLaunchScreen

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD(hide)
{
  UIView *view = RCTKeyWindow().rootViewController.view;
  if ([view isKindOfClass:RCTSurfaceHostingProxyRootView.class]) {
    RCTSurfaceHostingProxyRootView *rootView = (RCTSurfaceHostingProxyRootView *)view;
    [rootView disableActivityIndicatorAutoHide:NO];
    [rootView.loadingView removeFromSuperview];
  }
}

@end
