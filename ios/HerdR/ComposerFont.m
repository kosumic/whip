#import <React/RCTBackedTextInputViewProtocol.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <UIKit/UIKit.h>

// Shared implementation supplied by our enriched-markdown patch. Its header is
// private to the pod; keep coverage and font selection in that implementation.
extern void ENRMApplyChatCjkFont(NSMutableAttributedString *string, NSRange range);

static NSString *const WhipComposerFontError = @"E_COMPOSER_FONT";

/** Style attributes in place without replacing text, selection or marked text. */
@interface WhipComposerFontBinding : NSObject <NSTextStorageDelegate>
@property (nonatomic, weak) UITextView *input;
@property (nonatomic, weak) id<NSTextStorageDelegate> originalDelegate;
@property (nonatomic) BOOL applying;
- (instancetype)initWithInput:(UITextView *)input;
- (BOOL)matchesInput:(UITextView *)input;
- (void)detach;
@end

@implementation WhipComposerFontBinding
- (instancetype)initWithInput:(UITextView *)input
{
  if ((self = [super init])) {
    _input = input;
    _originalDelegate = input.textStorage.delegate;
    input.textStorage.delegate = self;
    [self applyFont:YES];
  }
  return self;
}

- (void)applyFont:(BOOL)batchEdits
{
  if (self.applying || !self.input) return;
  UITextView *input = self.input;
  UIFont *baseFont = [(id<RCTBackedTextInputViewProtocol>)input defaultTextAttributes][NSFontAttributeName];
  if (!baseFont) baseFont = input.font;
  if (!baseFont) return;

  self.applying = YES;
  NSTextStorage *storage = input.textStorage;
  NSRange range = NSMakeRange(0, storage.length);
  if (batchEdits) [storage beginEditing];
  // Reset inherited UKai attributes before styling CJK, so Latin typed after an
  // ideograph keeps the composer's original face. Only font attributes change.
  [storage addAttribute:NSFontAttributeName value:baseFont range:range];
  ENRMApplyChatCjkFont(storage, range);
  if (batchEdits) [storage endEditing];
  self.applying = NO;
}

- (void)textStorage:(NSTextStorage *)storage willProcessEditing:(NSTextStorageEditActions)editedMask
             range:(NSRange)editedRange changeInLength:(NSInteger)delta
{
  if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate textStorage:storage willProcessEditing:editedMask
                               range:editedRange changeInLength:delta];
  }
  // NSTextStorage already batches attribute edits made by this delegate.
  [self applyFont:NO];
}

- (BOOL)respondsToSelector:(SEL)selector
{
  return [super respondsToSelector:selector] || [self.originalDelegate respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector
{
  return [self.originalDelegate respondsToSelector:selector] ? self.originalDelegate
    : [super forwardingTargetForSelector:selector];
}

- (BOOL)matchesInput:(UITextView *)input { return self.input == input; }

- (void)detach
{
  if (self.input.textStorage.delegate == self) self.input.textStorage.delegate = self.originalDelegate;
}
@end

@interface ComposerFont : NSObject <RCTBridgeModule, RCTInvalidating>
@property (nonatomic, strong) NSMutableDictionary<NSString *, WhipComposerFontBinding *> *bindings;
@end

@implementation ComposerFont
RCT_EXPORT_MODULE(ComposerFont)
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (UITextView *)inputInView:(UIView *)view
{
  if ([view isKindOfClass:UITextView.class]) return (UITextView *)view;
  for (UIView *child in view.subviews) {
    UITextView *input = [self inputInView:child];
    if (input) return input;
  }
  return nil;
}

RCT_EXPORT_METHOD(attachInput:(NSNumber *)tag token:(NSString *)token
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  UITextView *input = [self inputInView:[self.viewRegistry_DEPRECATED viewForReactTag:tag]];
  if (!input) {
    reject(WhipComposerFontError, @"Could not find the composer input", nil);
    return;
  }
  if (!self.bindings) self.bindings = [NSMutableDictionary new];
  for (NSString *key in self.bindings.allKeys) {
    if ([self.bindings[key] matchesInput:input] || [key isEqualToString:token]) {
      [self.bindings[key] detach];
      [self.bindings removeObjectForKey:key];
    }
  }
  self.bindings[token] = [[WhipComposerFontBinding alloc] initWithInput:input];
  resolve(nil);
}

RCT_EXPORT_METHOD(detachInput:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self.bindings[token] detach];
  [self.bindings removeObjectForKey:token];
  resolve(nil);
}

- (void)invalidate
{
  dispatch_async(dispatch_get_main_queue(), ^{
    for (WhipComposerFontBinding *binding in self.bindings.allValues) [binding detach];
    [self.bindings removeAllObjects];
  });
}
@end
