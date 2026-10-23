#import "WhipTerminalInputView.h"
#import "WhipTerminalKeyEncoder.h"

static const NSUInteger WhipMaximumInputContext = 1024;
static NSString *const WhipBackspace = @"\x7f";
static NSString *const WhipLeft = @"\x1b[D";
static NSString *const WhipRight = @"\x1b[C";

// Compare Unicode scalars, never individual UTF-16 surrogate halves.
static NSArray<NSString *> *WhipScalars(NSString *text) {
  NSMutableArray *result = [NSMutableArray new];
  for (NSUInteger index = 0; index < text.length;) {
    NSUInteger length = CFStringIsSurrogateHighCharacter([text characterAtIndex:index]) &&
      index + 1 < text.length && CFStringIsSurrogateLowCharacter([text characterAtIndex:index + 1]) ? 2 : 1;
    [result addObject:[text substringWithRange:NSMakeRange(index, length)]];
    index += length;
  }
  return result;
}

static NSString *WhipRepeat(NSString *value, NSUInteger count) {
  return [@"" stringByPaddingToLength:value.length * count withString:value startingAtIndex:0];
}

@class WhipTerminalTextView;
@interface WhipTerminalInputView ()
@property(nonatomic, strong) WhipTerminalTextView *terminalEditor;
- (void)emit:(NSString *)data;
- (void)sendControl:(NSString *)data;
@end

/** UIKit owns selection, marked ranges, autocorrection and dictation. We keep
 * only the current correction word/preedit, and stream every change immediately.
 * Replacing this editor at boundaries rejects callbacks from a retired IME. */
@interface WhipTerminalTextView : UITextView
@property(nonatomic, weak) WhipTerminalInputView *owner;
@property(nonatomic, strong) id<UITextViewDelegate> terminalDelegate;
@property(nonatomic, copy) NSString *sentText;
@property(nonatomic) NSInteger terminalCursor;
@property(nonatomic) NSUInteger mutationDepth;
@property(nonatomic) BOOL suppressChanges;
- (void)reconcile;
- (BOOL)active;
@end

// Keyboard Controller forwards unhandled delegate selectors. A self-delegating
// UITextView also responds to UIKit's internal input selectors, which UIKit can
// send back to its delegate recursively. Expose only the actual delegate API.
@interface WhipTerminalTextViewDelegate : NSObject <UITextViewDelegate>
@end

@implementation WhipTerminalTextViewDelegate
- (void)textViewDidChange:(UITextView *)textView { [(WhipTerminalTextView *)textView reconcile]; }
- (void)textViewDidChangeSelection:(UITextView *)textView { [(WhipTerminalTextView *)textView reconcile]; }
- (void)textViewDidEndEditing:(UITextView *)textView {
  WhipTerminalTextView *editor = (WhipTerminalTextView *)textView;
  if (editor.active) [editor.owner resetEditor];
}
@end

@implementation WhipTerminalTextView
- (instancetype)initWithOwner:(WhipTerminalInputView *)owner {
  if ((self = [super initWithFrame:CGRectMake(0, 0, 1, 1) textContainer:nil])) {
    _owner = owner;
    _sentText = @"";
    _terminalDelegate = [WhipTerminalTextViewDelegate new];
    self.delegate = _terminalDelegate;
    self.backgroundColor = UIColor.clearColor;
    self.textColor = UIColor.clearColor;
    self.tintColor = UIColor.clearColor;
    self.clipsToBounds = YES;
    self.scrollEnabled = NO;
    self.accessibilityElementsHidden = YES;
    self.autocorrectionType = UITextAutocorrectionTypeYes;
    self.spellCheckingType = UITextSpellCheckingTypeYes;
    self.autocapitalizationType = UITextAutocapitalizationTypeNone;
    self.smartQuotesType = UITextSmartQuotesTypeNo;
    self.smartDashesType = UITextSmartDashesTypeNo;
    self.smartInsertDeleteType = UITextSmartInsertDeleteTypeNo;
    self.keyboardType = UIKeyboardTypeDefault;
    self.returnKeyType = UIReturnKeyDefault;
  }
  return self;
}

- (BOOL)active { return self.owner.inputEnabled && self.owner.terminalEditor == self; }
- (BOOL)canBecomeFirstResponder { return self.active && [super canBecomeFirstResponder]; }
- (BOOL)hasText { return self.active || [super hasText]; }

- (NSString *)moveCursor:(NSInteger)position {
  NSInteger delta = position - self.terminalCursor;
  self.terminalCursor = position;
  return WhipRepeat(delta < 0 ? WhipLeft : WhipRight, labs(delta));
}

- (void)reconcile {
  if (!self.active || self.suppressChanges || self.mutationDepth) return;
  NSString *next = self.text ?: @"";
  NSArray *oldPoints = WhipScalars(self.sentText);
  NSArray *newPoints = WhipScalars(next);
  NSUInteger prefix = 0, suffix = 0;
  while (prefix < MIN(oldPoints.count, newPoints.count) && [oldPoints[prefix] isEqual:newPoints[prefix]]) prefix++;
  while (suffix < MIN(oldPoints.count, newPoints.count) - prefix &&
         [oldPoints[oldPoints.count - suffix - 1] isEqual:newPoints[newPoints.count - suffix - 1]]) suffix++;
  NSMutableString *data = [NSMutableString new];
  if (![self.sentText isEqual:next]) {
    [data appendString:[self moveCursor:oldPoints.count - suffix]];
    [data appendString:WhipRepeat(WhipBackspace, oldPoints.count - suffix - prefix)];
    NSString *inserted = [[newPoints subarrayWithRange:NSMakeRange(prefix, newPoints.count - suffix - prefix)] componentsJoinedByString:@""];
    inserted = [[inserted stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\r"] stringByReplacingOccurrencesOfString:@"\n" withString:@"\r"];
    [data appendString:inserted];
    self.terminalCursor = newPoints.count - suffix;
  }
  self.sentText = next;
  NSUInteger selection = MIN(NSMaxRange(self.selectedRange), next.length);
  [data appendString:[self moveCursor:WhipScalars([next substringToIndex:selection]).count]];
  if (data.length) [self.owner emit:data];
  if (next.length > WhipMaximumInputContext) {
    [self.owner resetEditor];
    return;
  }
  [self compactContext];
}

- (void)compactContext {
  // Never edit a live marked range: UIKit keeps it intact until unmarkText.
  if (self.markedTextRange) return;
  NSString *text = self.text;
  NSUInteger selection = MIN(self.selectedRange.location, text.length), boundary = 0;
  for (NSUInteger index = 0; index < selection; index++) {
    unichar c = [text characterAtIndex:index];
    if (c == '\n' || c == '\r' || c == '\t') boundary = index + 1;
  }
  NSCharacterSet *space = NSCharacterSet.whitespaceAndNewlineCharacterSet;
  NSUInteger end = selection;
  while (end > boundary && [space characterIsMember:[text characterAtIndex:end - 1]]) end--;
  NSUInteger start = end;
  while (start > boundary && ![space characterIsMember:[text characterAtIndex:start - 1]]) start--;
  if (!start) return;
  NSRange selected = self.selectedRange;
  self.suppressChanges = YES;
  [self.inputDelegate textWillChange:self];
  [self.inputDelegate selectionWillChange:self];
  [self.textStorage deleteCharactersInRange:NSMakeRange(0, start)];
  self.selectedRange = NSMakeRange(selected.location - start, selected.length);
  self.sentText = [self.sentText substringFromIndex:start];
  self.terminalCursor -= WhipScalars([text substringToIndex:start]).count;
  [self.inputDelegate selectionDidChange:self];
  [self.inputDelegate textDidChange:self];
  self.suppressChanges = NO;
  [self.undoManager removeAllActions];
}

- (void)insertText:(NSString *)text {
  if (!self.active) return;
  if ([text isEqual:@"\t"]) { [self.owner sendControl:text]; return; }
  self.mutationDepth++;
  [super insertText:text];
  self.mutationDepth--;
  [self reconcile];
}

- (void)setMarkedText:(NSString *)markedText selectedRange:(NSRange)selectedRange {
  if (!self.active) return;
  self.mutationDepth++;
  [super setMarkedText:markedText selectedRange:selectedRange];
  self.mutationDepth--;
  [self reconcile];
}

- (void)unmarkText {
  if (!self.active) return;
  self.mutationDepth++;
  [super unmarkText];
  self.mutationDepth--;
  [self reconcile];
}

- (void)replaceRange:(UITextRange *)range withText:(NSString *)text {
  if (!self.active || !range) return;
  NSInteger start = [self offsetFromPosition:self.beginningOfDocument toPosition:range.start];
  NSInteger end = [self offsetFromPosition:self.beginningOfDocument toPosition:range.end];
  if (start < 0 || end < start || end > self.text.length) return;
  self.mutationDepth++;
  [super replaceRange:range withText:text];
  self.mutationDepth--;
  [self reconcile];
}

- (void)deleteBackward {
  if (!self.active) return;
  if (!NSMaxRange(self.selectedRange) && !self.markedTextRange) {
    [self.owner sendControl:WhipBackspace];
    return;
  }
  self.mutationDepth++;
  [super deleteBackward];
  self.mutationDepth--;
  [self reconcile];
}

- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  NSMutableSet *remaining = [presses mutableCopy];
  for (UIPress *press in presses) {
    UIKey *key = press.key;
    if (!key || !self.active) continue;
    NSString *data = WhipTerminalKeySequence(key.keyCode, key.modifierFlags, key.characters,
      key.charactersIgnoringModifiers, self.owner.applicationCursorKeys, self.owner.kittyKeyboardReportAll);
    if (!data) continue;
    [remaining removeObject:press];
    [self.owner sendControl:data];
  }
  if (remaining.count) [super pressesBegan:remaining withEvent:event];
}
@end

@implementation WhipTerminalInputView
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _binding = @"";
    self.clipsToBounds = YES;
    self.accessibilityElementsHidden = YES;
    [self resetEditor];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(blurInput)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (UITextView *)editor { return self.terminalEditor; }
// Disabling UIView interaction also prevents UIKit keyboard focus. Let touch
// hit testing pass through while keeping the editor eligible for first responder.
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event { return NO; }
- (void)setBinding:(NSString *)binding {
  if ([_binding isEqual:binding]) return;
  _binding = [binding copy];
  [self resetEditor];
}
- (void)setInputEnabled:(BOOL)enabled {
  _inputEnabled = enabled;
  if (enabled) [self focusInput]; else [self blurInput];
}
- (void)setModifiedInput:(BOOL)modifiedInput {
  if (_modifiedInput == modifiedInput) return;
  _modifiedInput = modifiedInput;
  [self resetEditor];
}
- (void)focusInput {
  if (self.inputEnabled && self.window && UIApplication.sharedApplication.applicationState != UIApplicationStateBackground)
    [self.terminalEditor becomeFirstResponder];
}
- (void)blurInput {
  self.terminalEditor.owner = nil;
  [self.terminalEditor resignFirstResponder];
  [self resetEditor];
}
- (void)resetEditor {
  WhipTerminalTextView *old = self.terminalEditor;
  BOOL focused = old.isFirstResponder;
  old.owner = nil; // Resigning can finish composing; stale edits must not escape.
  [old resignFirstResponder];
  [old removeFromSuperview];
  self.terminalEditor = [[WhipTerminalTextView alloc] initWithOwner:self];
  if (self.modifiedInput) self.terminalEditor.autocorrectionType = UITextAutocorrectionTypeNo;
  [self addSubview:self.terminalEditor];
  if (focused) [self focusInput];
}
- (void)emit:(NSString *)data {
  if (self.inputEnabled && data.length && self.onTerminalInput)
    self.onTerminalInput(@{@"binding":self.binding, @"data":data});
}
- (void)sendControl:(NSString *)data {
  [self resetEditor];
  [self emit:data];
}
- (void)barrier:(NSString *)binding commandId:(NSNumber *)commandId {
  if (![self.binding isEqual:binding]) return;
  [self resetEditor];
  if (self.onTerminalInput) self.onTerminalInput(@{@"binding":binding, @"commandId":commandId});
}
- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (!self.window) [self blurInput];
}
@end
