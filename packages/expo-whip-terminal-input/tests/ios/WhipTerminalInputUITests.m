#import <XCTest/XCTest.h>

static const NSTimeInterval WhipInputTimeout = 5;
static const NSTimeInterval WhipInteractionTimeout = 10;

@interface WhipTerminalInputUITests : XCTestCase
@end

@implementation WhipTerminalInputUITests
- (void)waitForBytes:(NSString *)expected fromElement:(XCUIElement *)bytes {
  NSPredicate *predicate = [NSPredicate predicateWithFormat:@"value == %@", expected];
  [self expectationForPredicate:predicate evaluatedWithObject:bytes handler:nil];
  [self waitForExpectationsWithTimeout:WhipInputTimeout handler:nil];
}
- (void)tapElement:(XCUIElement *)element {
  NSPredicate *hittable = [NSPredicate predicateWithFormat:@"hittable == YES"];
  [self expectationForPredicate:hittable evaluatedWithObject:element handler:nil];
  [self waitForExpectationsWithTimeout:WhipInteractionTimeout handler:nil];
  [element tap];
}
- (XCUIApplication *)fixture {
  self.continueAfterFailure = NO;
  XCUIApplication *app = [[XCUIApplication alloc] initWithBundleIdentifier:@"io.github.kaminarios.whip.browser-test-host"];
  app.launchArguments = @[@"--terminal-input"];
  [app launch];
  XCTAssertTrue([app.keyboards.firstMatch waitForExistenceWithTimeout:WhipInteractionTimeout]);
  return app;
}
- (void)testRealKeyboardDeliversEveryCharacterWithoutEnter {
  XCUIApplication *app = [self fixture];
  XCUIElement *bytes = app.staticTexts[@"terminal-bytes"];
  [self tapElement:app.keys[@"more"]];
  [self tapElement:app.keys[@"/"]];
  [self waitForBytes:@"/" fromElement:bytes];
  [self tapElement:app.keys[@"more"]];
  NSMutableString *expected = [NSMutableString stringWithString:@"/"];
  for (NSString *key in @[@"r", @"e", @"s", @"u", @"m", @"e"]) {
    [self tapElement:app.keys[key]];
    [expected appendString:key];
    [self waitForBytes:expected fromElement:bytes];
  }
  XCTAttachment *screen = [XCTAttachment attachmentWithScreenshot:app.screenshot];
  screen.name = @"Native iOS input before Enter";
  screen.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:screen];
}
- (void)testQuickTypeSuggestionReplacesAlreadyDeliveredText {
  XCUIApplication *app = [self fixture];
  for (NSString *key in @[@"t", @"e", @"h"]) [self tapElement:app.keys[key]];
  XCUIElement *bytes = app.staticTexts[@"terminal-bytes"];
  [self waitForBytes:@"teh" fromElement:bytes];
  XCUIElement *suggestion = app.otherElements[@"the"].firstMatch;
  [self tapElement:suggestion];
  NSPredicate *corrected = [NSPredicate predicateWithFormat:@"value CONTAINS %@", @"\x7f\x7fhe"];
  [self expectationForPredicate:corrected evaluatedWithObject:bytes handler:nil];
  [self waitForExpectationsWithTimeout:WhipInputTimeout handler:nil];
  // A second word exercises pruning and UIKit's updated correction offsets.
  if (![(NSString *)bytes.value hasSuffix:@" "]) [self tapElement:app.keys[@"space"]];
  for (NSString *key in @[@"t", @"e", @"h"]) [self tapElement:app.keys[key]];
  suggestion = app.otherElements[@"the"].firstMatch;
  [self tapElement:suggestion];
  NSPredicate *secondCorrection = [NSPredicate predicateWithBlock:^BOOL(XCUIElement *element, NSDictionary *bindings) {
    return [[(NSString *)element.value componentsSeparatedByString:@"\x7f\x7fhe"] count] == 3;
  }];
  [self expectationForPredicate:secondCorrection evaluatedWithObject:bytes handler:nil];
  [self waitForExpectationsWithTimeout:WhipInputTimeout handler:nil];
  XCTAttachment *screen = [XCTAttachment attachmentWithScreenshot:app.screenshot];
  screen.name = @"QuickType correction emitted immediately";
  screen.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:screen];
}
- (void)testKeyboardToggleReopensWithWorkingInput {
  XCUIApplication *app = [self fixture];
  XCUIElement *bytes = app.staticTexts[@"terminal-bytes"];
  [self tapElement:app.keys[@"a"]];
  [self waitForBytes:@"a" fromElement:bytes];
  [self tapElement:app.buttons[@"Toggle keyboard"]];
  NSPredicate *hidden = [NSPredicate predicateWithFormat:@"exists == NO"];
  [self expectationForPredicate:hidden evaluatedWithObject:app.keyboards.firstMatch handler:nil];
  [self waitForExpectationsWithTimeout:WhipInteractionTimeout handler:nil];
  [self tapElement:app.buttons[@"Toggle keyboard"]];
  XCTAssertTrue([app.keyboards.firstMatch waitForExistenceWithTimeout:WhipInteractionTimeout]);
  [self tapElement:app.keys[@"b"]];
  [self waitForBytes:@"ab" fromElement:bytes];
}
@end
