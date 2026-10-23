#import <React/RCTViewManager.h>
#import "WhipTerminalInputView.h"

@interface WhipTerminalInputManager : RCTViewManager
@end

@implementation WhipTerminalInputManager
RCT_EXPORT_MODULE(WhipTerminalInput)
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (UIView *)view { return [WhipTerminalInputView new]; }
RCT_EXPORT_VIEW_PROPERTY(binding, NSString)
RCT_EXPORT_VIEW_PROPERTY(inputEnabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onTerminalInput, RCTDirectEventBlock)

- (WhipTerminalInputView *)input:(NSNumber *)tag {
  UIView *view = [self.viewRegistry_DEPRECATED viewForReactTag:tag];
  // Fabric returns its interop component wrapper for the React tag.
  return [WhipTerminalInputView inputInView:view];
}
RCT_EXPORT_METHOD(enabled:(NSNumber *)tag value:(BOOL)value) { [self input:tag].inputEnabled = value; }
RCT_EXPORT_METHOD(modifiedInput:(NSNumber *)tag value:(BOOL)value) { [self input:tag].modifiedInput = value; }
RCT_EXPORT_METHOD(focus:(NSNumber *)tag) { [[self input:tag] focusInput]; }
RCT_EXPORT_METHOD(blur:(NSNumber *)tag) { [[self input:tag] blurInput]; }
RCT_EXPORT_METHOD(reset:(NSNumber *)tag) { [[self input:tag] resetEditor]; }
RCT_EXPORT_METHOD(barrier:(NSNumber *)tag binding:(NSString *)binding commandId:(NSNumber *)commandId) {
  [[self input:tag] barrier:binding commandId:commandId];
}
RCT_EXPORT_METHOD(cursorKeys:(NSNumber *)tag value:(BOOL)value) { [self input:tag].applicationCursorKeys = value; }
RCT_EXPORT_METHOD(kittyKeyboard:(NSNumber *)tag value:(BOOL)value) { [self input:tag].kittyKeyboardReportAll = value; }
@end
