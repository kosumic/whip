#if WHIP_NSH_ABOUT
#import <React/RCTViewManager.h>
#import <React/RCTComponent.h>
#import <UIKit/UIKit.h>
#import "nsh/include/nsh.h"

extern "C" void whip_nsh_initialize(void);

@interface WhipNativeShellAboutView : UIView
@property(nonatomic, copy) RCTDirectEventBlock onContentHeight;
@property(nonatomic, copy) RCTDirectEventBlock onOpenLicenses;
@property(nonatomic, copy) RCTDirectEventBlock onFailure;
@property(nonatomic, copy) NSString *environment;
@end

@interface WhipNshHandler : NSObject
@property(nonatomic, weak) WhipNativeShellAboutView *view;
@property(nonatomic, copy) NSString *name;
@end
@implementation WhipNshHandler
@end

static void releaseHandler(void *context) { CFBridgingRelease(context); }
static void consumeError(char *error) {
  if (error) { NSLog(@"Whip NSH: %s", error); nsh_string_free(error); }
}

@implementation WhipNativeShellAboutView {
  NshApp *_app;
  BOOL _loaded;
  WhipNshHandler *_errorHandler;
}

- (void)fail {
  __weak WhipNativeShellAboutView *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    WhipNativeShellAboutView *view = weakSelf;
    if (view.onFailure) view.onFailure(@{});
  });
}

- (UIViewController *)presenter {
  UIResponder *responder = self;
  while (responder && ![responder isKindOfClass:UIViewController.class]) responder = responder.nextResponder;
  UIViewController *controller = (UIViewController *)responder;
  while (controller.presentedViewController) controller = controller.presentedViewController;
  return controller;
}

- (void)handle:(NSString *)name data:(NSDictionary *)data call:(NshHostCall *)call {
  if ([name isEqualToString:@"haptic"]) {
    [[[UISelectionFeedbackGenerator alloc] init] selectionChanged];
  } else if ([name isEqualToString:@"height"]) {
    double height = [data[@"height"] doubleValue];
    if (isfinite(height) && height > 0 && self.onContentHeight) self.onContentHeight(@{@"height": @(height)});
  } else if ([name isEqualToString:@"licenses"]) {
    if (self.onOpenLicenses) self.onOpenLicenses(@{});
  } else if ([name isEqualToString:@"openURL"]) {
    NSURL *url = [NSURL URLWithString:data[@"url"]];
    if (![url.scheme isEqualToString:@"https"]) {
      if (call) nsh_host_call_reject(call, "Invalid external URL");
      return;
    }
    [UIApplication.sharedApplication openURL:url options:@{} completionHandler:^(BOOL opened) {
      if (!call) return;
      if (opened) nsh_host_call_resolve(call, NULL);
      else nsh_host_call_reject(call, "Cannot open URL");
    }];
    return;
  } else if ([name isEqualToString:@"share"]) {
    UIViewController *presenter = self.presenter;
    if (!presenter) {
      if (call) nsh_host_call_reject(call, "Share sheet unavailable");
      return;
    }
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[data[@"message"] ?: @""] applicationActivities:nil];
    sheet.title = data[@"title"];
    sheet.popoverPresentationController.sourceView = self;
    sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.bounds), 32, 1, 1);
    sheet.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *error) {
      if (!call) return;
      if (error) nsh_host_call_reject(call, error.localizedDescription.UTF8String);
      else nsh_host_call_resolve(call, NULL);
    };
    [presenter presentViewController:sheet animated:YES completion:nil];
    return;
  } else if ([name isEqualToString:@"alert"]) {
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:data[@"title"] message:data[@"message"] preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:NSLocalizedString(@"OK", nil) style:UIAlertActionStyleDefault handler:nil]];
    [self.presenter presentViewController:alert animated:YES completion:nil];
  }
  if (call) nsh_host_call_resolve(call, NULL);
}

static void hostCall(void *context, const char *json, NshHostCall *call) {
  WhipNshHandler *handler = (__bridge WhipNshHandler *)context;
  WhipNativeShellAboutView *view = handler.view;
  if (!view) { if (call) nsh_host_call_reject(call, "View disposed"); return; }
  NSData *bytes = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
  id data = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  [view handle:handler.name data:[data isKindOfClass:NSDictionary.class] ? data : @{} call:call];
}

static void appError(void *context, const char *message) {
  WhipNshHandler *handler = (__bridge WhipNshHandler *)context;
  NSLog(@"Whip NSH: %s", message);
  [handler.view fail];
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    whip_nsh_initialize();
    _app = nsh_app_create(self.bounds, false);
    [self addSubview:nsh_app_view(_app)];
    for (NSString *name in @[@"height", @"licenses", @"openURL", @"share", @"alert", @"haptic"]) {
      WhipNshHandler *handler = [WhipNshHandler new];
      handler.view = self; handler.name = name;
      nsh_app_set_host_handler(_app, name.UTF8String, hostCall, (__bridge_retained void *)handler, releaseHandler);
    }
    // Own the context until after nsh_app_destroy. The pinned C API captures
    // its raw callback fields separately and drops its release guard early.
    // Supplying no release callback uses the API's caller-owned context mode.
    _errorHandler = [WhipNshHandler new]; _errorHandler.view = self;
    nsh_app_set_error_handler(_app, appError, (__bridge void *)_errorHandler, NULL);
  }
  return self;
}

- (void)setEnvironment:(NSString *)environment {
  _environment = [environment copy];
  NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[environment dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  consumeError(nsh_app_set_locale(_app, [value[@"locale"] UTF8String]));
  nsh_app_set_font_scale(_app, [value[@"fontScale"] floatValue]);
  if (_loaded) {
    consumeError(nsh_app_send_host_event(_app, "environment", environment.UTF8String));
    return;
  }
  consumeError(nsh_app_set_host_params(_app, environment.UTF8String));
  NSURL *resourceURL = [[NSBundle bundleForClass:self.class] URLForResource:@"WhipNshAbout" withExtension:@"bundle"]
    ?: [NSBundle.mainBundle URLForResource:@"WhipNshAbout" withExtension:@"bundle"];
  NSBundle *resources = resourceURL ? [NSBundle bundleWithURL:resourceURL] : nil;
  NSString *path = [resources pathForResource:@"bundle" ofType:@"nshc" inDirectory:@"whip-nsh"];
  if (!path) { [self fail]; return; }
  char *error = nsh_app_load_bundle(_app, path.UTF8String);
  if (error) { consumeError(error); [self fail]; }
  else _loaded = YES;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  nsh_app_view(_app).frame = self.bounds;
}
- (void)dealloc { nsh_app_destroy(_app); }
@end

@interface WhipNativeShellAboutManager : RCTViewManager
@end
@implementation WhipNativeShellAboutManager
RCT_EXPORT_MODULE(WhipNativeShellAbout)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (UIView *)view { return [WhipNativeShellAboutView new]; }
RCT_EXPORT_VIEW_PROPERTY(environment, NSString)
RCT_EXPORT_VIEW_PROPERTY(onContentHeight, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onOpenLicenses, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onFailure, RCTDirectEventBlock)
@end
#endif
