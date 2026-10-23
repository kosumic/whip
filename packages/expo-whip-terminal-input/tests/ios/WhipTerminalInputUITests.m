#import <XCTest/XCTest.h>

@interface WhipTerminalInputUITests : XCTestCase
@end

@implementation WhipTerminalInputUITests
- (XCUIApplication *)fixture {
  self.continueAfterFailure = NO;
  XCUIApplication *app = [[XCUIApplication alloc] initWithBundleIdentifier:@"io.github.kaminarios.whip.browser-test-host"];
  app.launchArguments = @[@"--terminal-input"];
  [app launch];
  XCTAssertTrue([app.keyboards.firstMatch waitForExistenceWithTimeout:10]);
  return app;
}
- (void)testRealKeyboardDeliversEveryCharacterWithoutEnter {
  XCUIApplication *app = [self fixture];
  XCUIElement *bytes = app.staticTexts[@"terminal-bytes"];
  [app.keys[@"more"] tap];
  [app.keys[@"/"] tap];
  XCTAssertEqualObjects(bytes.value, @"/");
  [app.keys[@"more"] tap];
  NSMutableString *expected = [NSMutableString stringWithString:@"/"];
  for (NSString *key in @[@"r", @"e", @"s", @"u", @"m", @"e"]) {
    [app.keys[key] tap];
    [expected appendString:key];
    NSPredicate *predicate = [NSPredicate predicateWithFormat:@"value == %@", expected];
    [self expectationForPredicate:predicate evaluatedWithObject:bytes handler:nil];
    [self waitForExpectationsWithTimeout:3 handler:nil];
  }
  XCTAttachment *screen = [XCTAttachment attachmentWithScreenshot:app.screenshot];
  screen.name = @"Native iOS input before Enter";
  screen.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:screen];
}
- (void)testQuickTypeSuggestionReplacesAlreadyDeliveredText {
  XCUIApplication *app = [self fixture];
  for (NSString *key in @[@"t", @"e", @"h"]) [app.keys[key] tap];
  XCUIElement *bytes = app.staticTexts[@"terminal-bytes"];
  XCTAssertEqualObjects(bytes.value, @"teh");
  XCUIElement *suggestion = app.otherElements[@"the"].firstMatch;
  XCTAssertTrue([suggestion waitForExistenceWithTimeout:5]);
  [suggestion tap];
  NSPredicate *corrected = [NSPredicate predicateWithFormat:@"value CONTAINS %@", @"\x7f\x7fhe"];
  [self expectationForPredicate:corrected evaluatedWithObject:bytes handler:nil];
  [self waitForExpectationsWithTimeout:5 handler:nil];
  // A second word exercises pruning and UIKit's updated correction offsets.
  if (![(NSString *)bytes.value hasSuffix:@" "]) [app.keys[@"space"] tap];
  for (NSString *key in @[@"t", @"e", @"h"]) [app.keys[key] tap];
  suggestion = app.otherElements[@"the"].firstMatch;
  XCTAssertTrue([suggestion waitForExistenceWithTimeout:5]);
  [suggestion tap];
  NSPredicate *secondCorrection = [NSPredicate predicateWithBlock:^BOOL(XCUIElement *element, NSDictionary *bindings) {
    return [[(NSString *)element.value componentsSeparatedByString:@"\x7f\x7fhe"] count] == 3;
  }];
  [self expectationForPredicate:secondCorrection evaluatedWithObject:bytes handler:nil];
  [self waitForExpectationsWithTimeout:5 handler:nil];
  XCTAttachment *screen = [XCTAttachment attachmentWithScreenshot:app.screenshot];
  screen.name = @"QuickType correction emitted immediately";
  screen.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:screen];
}
- (void)testKeyboardToggleReopensWithWorkingInput {
  XCUIApplication *app = [self fixture];
  [app.keys[@"a"] tap];
  [app.buttons[@"Toggle keyboard"] tap];
  NSPredicate *hidden = [NSPredicate predicateWithFormat:@"exists == NO"];
  [self expectationForPredicate:hidden evaluatedWithObject:app.keyboards.firstMatch handler:nil];
  [self waitForExpectationsWithTimeout:5 handler:nil];
  [app.buttons[@"Toggle keyboard"] tap];
  XCTAssertTrue([app.keyboards.firstMatch waitForExistenceWithTimeout:5]);
  [app.keys[@"b"] tap];
  XCTAssertEqualObjects(app.staticTexts[@"terminal-bytes"].value, @"ab");
}
@end
