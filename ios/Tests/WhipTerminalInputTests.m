#import <XCTest/XCTest.h>
#import "WhipTerminalInputView.h"
#import "WhipTerminalKeyEncoder.h"

@interface WhipTerminalInputTests : XCTestCase
@property(nonatomic, strong) WhipTerminalInputView *input;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *events;
@end

@implementation WhipTerminalInputTests
- (void)setUp {
  [super setUp];
  self.events = [NSMutableArray new];
  self.input = [WhipTerminalInputView new];
  self.input.binding = @"pane-1";
  self.input.inputEnabled = YES;
  NSMutableArray *events = self.events;
  self.input.onTerminalInput = ^(NSDictionary *event) { [events addObject:event]; };
}
- (NSString *)bytes {
  NSMutableString *result = [NSMutableString new];
  for (NSDictionary *event in self.events) if (event[@"data"]) [result appendString:event[@"data"]];
  return result;
}
- (UITextRange *)range:(NSRange)range in:(UITextView *)editor {
  return [editor textRangeFromPosition:[editor positionFromPosition:editor.beginningOfDocument offset:range.location]
                           toPosition:[editor positionFromPosition:editor.beginningOfDocument offset:NSMaxRange(range)]];
}
- (void)testEachCharacterArrivesBeforeEnter {
  for (NSString *letter in @[@"/", @"r", @"e", @"s", @"u", @"m", @"e"]) {
    NSUInteger previous = self.events.count;
    [self.input.editor insertText:letter];
    XCTAssertEqual(self.events.count, previous + 1);
    XCTAssertEqualObjects(self.events.lastObject[@"data"], letter);
  }
  XCTAssertEqualObjects(self.bytes, @"/resume");
}
- (void)testSuggestionReplacesIndividuallyCommittedLettersImmediately {
  for (NSString *letter in @[@"t", @"e", @"h"]) [self.input.editor insertText:letter];
  XCTAssertEqualObjects(self.bytes, @"teh");
  [self.input.editor replaceRange:[self range:NSMakeRange(0, 3) in:self.input.editor] withText:@"the"];
  XCTAssertEqualObjects(self.bytes, @"teh\x7f\x7fhe");
  XCTAssertEqualObjects(self.input.editor.text, @"the");
}
- (void)testFollowingWordKeepsOnlyItsCorrectionContext {
  [self.input.editor insertText:@"first "];
  [self.input.editor insertText:@"teh"];
  XCTAssertEqualObjects(self.input.editor.text, @"teh");
  [self.input.editor replaceRange:[self range:NSMakeRange(0, 3) in:self.input.editor] withText:@"the "];
  XCTAssertTrue([self.bytes hasSuffix:@"\x7f\x7fhe "]);
  XCTAssertFalse([self.input.editor.text containsString:@"first"]);
}
- (void)testMarkedTextStreamsBeforeUnmarkAndDoesNotDuplicateOnCommit {
  [self.input.editor setMarkedText:@"n" selectedRange:NSMakeRange(1, 0)];
  XCTAssertEqualObjects(self.bytes, @"n");
  [self.input.editor setMarkedText:@"ni" selectedRange:NSMakeRange(2, 0)];
  XCTAssertEqualObjects(self.bytes, @"ni");
  [self.input.editor setMarkedText:@"你" selectedRange:NSMakeRange(1, 0)];
  XCTAssertEqualObjects(self.bytes, @"ni\x7f\x7f你");
  [self.input.editor unmarkText];
  XCTAssertEqualObjects(self.bytes, @"ni\x7f\x7f你");
}
- (void)testPhraseCompositionKeepsItsMarkedRange {
  [self.input.editor setMarkedText:@"two words" selectedRange:NSMakeRange(9, 0)];
  XCTAssertEqualObjects(self.input.editor.text, @"two words");
  XCTAssertNotNil(self.input.editor.markedTextRange);
  [self.input.editor unmarkText];
  XCTAssertEqualObjects(self.input.editor.text, @"words");
}
- (void)testDeletingEmojiNeverSplitsASurrogate {
  [self.input.editor insertText:@"🙂"];
  [self.input.editor deleteBackward];
  XCTAssertEqualObjects(self.bytes, @"🙂\x7f");
  XCTAssertEqualObjects(self.input.editor.text, @"");
}
- (void)testBackspaceCanDeleteUnknownRemoteText {
  [self.input.editor deleteBackward];
  XCTAssertEqualObjects(self.bytes, @"\x7f");
}
- (void)testEnterIsImmediateAndRetiresPreviousPromptContext {
  [self.input.editor insertText:@"ls"];
  [self.input.editor insertText:@"\n"];
  XCTAssertEqualObjects(self.bytes, @"ls\r");
  XCTAssertEqualObjects(self.input.editor.text, @"");
}
- (void)testSelectionReplacementPreservesSuffix {
  [self.input.editor insertText:@"abc"];
  [self.input.editor replaceRange:[self range:NSMakeRange(1, 1) in:self.input.editor] withText:@"X"];
  XCTAssertEqualObjects(self.input.editor.text, @"aXc");
  XCTAssertTrue([self.bytes containsString:@"\x1b[D\x7fX"]);
}
- (void)testBarrierRejectsEditsFromRetiredEditorBeforeAcknowledging {
  UITextView *old = self.input.editor;
  [old setMarkedText:@"old" selectedRange:NSMakeRange(3, 0)];
  [self.input barrier:@"pane-1" commandId:@7];
  XCTAssertEqualObjects(self.events.lastObject, (@{@"binding":@"pane-1", @"commandId":@7}));
  NSUInteger count = self.events.count;
  [old insertText:@"stale"];
  [old unmarkText];
  [old deleteBackward];
  XCTAssertEqual(self.events.count, count);
  [self.input.editor insertText:@"new"];
  XCTAssertEqualObjects(self.events.lastObject[@"data"], @"new");
}
- (void)testPaneChangeRejectsOldInputAndWrongBarrier {
  UITextView *old = self.input.editor;
  self.input.binding = @"pane-2";
  [old insertText:@"wrong"];
  [self.input barrier:@"pane-1" commandId:@8];
  XCTAssertEqual(self.events.count, 0);
  [self.input.editor insertText:@"right"];
  XCTAssertEqualObjects(self.events.lastObject[@"binding"], @"pane-2");
}
- (void)testDisabledInputCannotEmitAndReenabledInputWorks {
  UITextView *old = self.input.editor;
  self.input.inputEnabled = NO;
  [old insertText:@"old"];
  [self.input.editor insertText:@"disabled"];
  XCTAssertEqual(self.events.count, 0);
  self.input.inputEnabled = YES;
  [self.input.editor insertText:@"live"];
  XCTAssertEqualObjects(self.bytes, @"live");
}
- (void)testLongPreeditIsEmittedThenRetired {
  NSString *longText = [@"x" stringByPaddingToLength:1025 withString:@"x" startingAtIndex:0];
  UITextView *old = self.input.editor;
  [old setMarkedText:longText selectedRange:NSMakeRange(1025, 0)];
  XCTAssertEqualObjects(self.bytes, longText);
  XCTAssertNotEqual(old, self.input.editor);
  XCTAssertEqualObjects(self.input.editor.text, @"");
}
- (void)testUIKitKeyboardTraitsAllowCorrections {
  XCTAssertEqual(self.input.editor.autocorrectionType, UITextAutocorrectionTypeYes);
  XCTAssertEqual(self.input.editor.keyboardType, UIKeyboardTypeDefault);
  XCTAssertFalse(self.input.editor.secureTextEntry);
  self.input.modifiedInput = YES;
  XCTAssertEqual(self.input.editor.autocorrectionType, UITextAutocorrectionTypeNo);
}
- (void)testCommandsFindNativeInputInsideAFabricWrapper {
  UIView *wrapper = [UIView new];
  UIView *content = [UIView new];
  [wrapper addSubview:content];
  [content addSubview:self.input];
  XCTAssertEqual([WhipTerminalInputView inputInView:wrapper], self.input);
  XCTAssertEqual([WhipTerminalInputView inputInView:self.input], self.input);
  XCTAssertNil([WhipTerminalInputView inputInView:[UIView new]]);
  XCTAssertNil([WhipTerminalInputView inputInView:nil]);
}
- (void)testHardwareControlsAreImmediateTerminalSequences {
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardUpArrow, 0, @"", @"", NO, NO), @"\x1b[A");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardUpArrow, 0, @"", @"", YES, NO), @"\x1bOA");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardTab, 0, @"\t", @"\t", NO, NO), @"\t");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardTab, UIKeyModifierShift, @"\t", @"\t", NO, NO), @"\x1b[Z");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardC, UIKeyModifierControl, @"c", @"c", NO, NO), @"\x03");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardDeleteForward, 0, @"", @"", NO, NO), @"\x1b[3~");
  XCTAssertNil(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardE, 0, @"e", @"e", NO, NO));
}
- (void)testModifiedAndKittyKeysKeepNegotiatedProtocol {
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardLeftArrow, UIKeyModifierControl, @"", @"", NO, NO), @"\x1b[1;5D");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardReturnOrEnter, 0, @"\r", @"\r", NO, YES), @"\x1b[13;1:1u");
  XCTAssertEqualObjects(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardC, UIKeyModifierControl, @"c", @"c", NO, YES), @"\x1b[99;5:1u");
  XCTAssertNil(WhipTerminalKeySequence(UIKeyboardHIDUsageKeyboardC, UIKeyModifierCommand, @"c", @"c", NO, NO));
}
- (void)testFocusHandoffDoesNotDismissAnotherEditor {
  UIWindow *window = UIApplication.sharedApplication.delegate.window;
  UITextView *composer = [[UITextView alloc] initWithFrame:CGRectMake(0, 100, 100, 40)];
  [window.rootViewController.view addSubview:self.input];
  [window.rootViewController.view addSubview:composer];
  XCTAssertFalse([self.input pointInside:CGPointZero withEvent:nil]);
  XCTAssertTrue(self.input.userInteractionEnabled);
  [self.input focusInput];
  XCTAssertTrue(self.input.editor.isFirstResponder);
  [composer becomeFirstResponder];
  [self.input blurInput];
  XCTAssertTrue(composer.isFirstResponder);
  [composer resignFirstResponder];
  [composer removeFromSuperview];
  [self.input removeFromSuperview];
}
@end
