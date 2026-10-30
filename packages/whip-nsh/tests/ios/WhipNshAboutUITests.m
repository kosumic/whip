// SPDX-License-Identifier: AGPL-3.0-or-later
#import <XCTest/XCTest.h>
#import <objc/runtime.h>

static Method animationIdleMethod;
static IMP originalAnimationIdle;
static IMP testAnimationIdle;

@interface NshAboutUITests : XCTestCase
@property(nonatomic, strong) XCUIApplication *app;
@end

@implementation NshAboutUITests
+ (void)setUp {
  [super setUp];
  // Test-runner-only private XCTest adaptation, also used by WebDriverAgent:
  // https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Categories/XCUIApplicationProcess%2BFBQuiescence.m
  // Keep process-idle checks and all real UI animations; exclude animation
  // completion from XCTest's idle gate. This host otherwise incurs repeated
  // 60-second "animations complete notification not received" timeouts.
  Class processClass = NSClassFromString(@"XCUIApplicationProcess");
  SEL selector = NSSelectorFromString(@"waitForQuiescenceIncludingAnimationsIdle:isPreEvent:");
  animationIdleMethod = class_getInstanceMethod(processClass, selector);
  if (animationIdleMethod && method_getNumberOfArguments(animationIdleMethod) == 4) {
    originalAnimationIdle = method_getImplementation(animationIdleMethod);
    testAnimationIdle = imp_implementationWithBlock(^(id process, BOOL animations, BOOL preEvent) {
      ((void (*)(id, SEL, BOOL, BOOL))originalAnimationIdle)(process, selector, NO, preEvent);
    });
  } else {
    selector = NSSelectorFromString(@"waitForQuiescenceIncludingAnimationsIdle:");
    animationIdleMethod = class_getInstanceMethod(processClass, selector);
    if (animationIdleMethod && method_getNumberOfArguments(animationIdleMethod) == 3) {
      originalAnimationIdle = method_getImplementation(animationIdleMethod);
      testAnimationIdle = imp_implementationWithBlock(^(id process, BOOL animations) {
        ((void (*)(id, SEL, BOOL))originalAnimationIdle)(process, selector, NO);
      });
    }
  }
  XCTAssertTrue(testAnimationIdle != NULL, @"Update the test-only XCTest idle adapter for this Xcode version.");
  if (testAnimationIdle) method_setImplementation(animationIdleMethod, testAnimationIdle);
}

+ (void)tearDown {
  if (testAnimationIdle) {
    method_setImplementation(animationIdleMethod, originalAnimationIdle);
    imp_removeBlock(testAnimationIdle);
  }
  [super tearDown];
}

- (void)setUp {
  self.continueAfterFailure = NO;
  self.app = [[XCUIApplication alloc] initWithBundleIdentifier:@"io.github.kaminarios.whip"];
  // Isolate native presentation/animation state without reinstalling or
  // clearing the app's database, credentials or preferences.
  [self.app terminate];
  [self.app launch];
  XCUIApplication *springboard = [[XCUIApplication alloc] initWithBundleIdentifier:@"com.apple.springboard"];
  XCUIElement *deny = springboard.buttons[@"Don’t Allow"];
  if ([deny waitForExistenceWithTimeout:1]) [deny tap];
  [self dismissShareSheet];
  [self restoreAutomaticLanguage];
  [self.app.buttons[@"More"] tap];
  XCUIElement *toggle = self.app.buttons[@"about-toggle"];
  BOOL reference = [NSStringFromSelector(self.invocation.selector) isEqualToString:@"testAboutReference"];
  if (reference && !toggle.exists) {
    toggle = [self.app.buttons matchingPredicate:[NSPredicate predicateWithFormat:
      @"label == %@ OR label == %@", @"Expand About", @"Collapse About"]].firstMatch;
  }
  XCTAssertTrue([toggle waitForExistenceWithTimeout:10], @"Install with NSH_ABOUT_EXPERIMENT=1 and use English. %@", self.app.debugDescription);
  [self reveal:toggle];
  if ([toggle.label isEqualToString:@"Expand About"]) [toggle tap];
  if (!reference) XCTAssertTrue([self.app.otherElements[@"about-content"] waitForExistenceWithTimeout:5]);
}

- (void)restoreAutomaticLanguage {
  XCUIElement *automatic = [self.app.buttons matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"Automatique, "]].firstMatch;
  if (automatic.exists) { [self waitForStableFrame:automatic]; [automatic tap]; return; }
  XCUIElement *langue = [self.app.buttons matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"Langue, "]].firstMatch;
  if (!langue.exists) return;
  [self reveal:langue];
  [langue tap];
  [self waitForStableFrame:automatic];
  [automatic tap];
}

- (void)waitForStableFrame:(XCUIElement *)element {
  __block CGRect previous = CGRectNull;
  __block NSTimeInterval stableSince = 0;
  NSPredicate *stable = [NSPredicate predicateWithBlock:^BOOL(id object, NSDictionary *bindings) {
    if (!element.exists || !element.hittable) return NO;
    CGRect frame = element.frame;
    NSTimeInterval now = NSDate.timeIntervalSinceReferenceDate;
    if (!CGRectEqualToRect(previous, frame)) { previous = frame; stableSince = now; return NO; }
    return now - stableSince >= 0.4;
  }];
  [self expectationForPredicate:stable evaluatedWithObject:element handler:nil];
  [self waitForExpectationsWithTimeout:5 handler:nil];
}

- (void)tearDown {
  if (self.app.state != XCUIApplicationStateRunningForeground) [self.app activate];
  [self dismissShareSheet];
  [self restoreAutomaticLanguage];
  [super tearDown];
}

- (void)dismissShareSheet {
  if (!self.app.otherElements[@"ActivityListView"].exists) return;
  XCUIElement *dismiss = self.app.otherElements[@"PopoverDismissRegion"];
  if (dismiss.exists) [dismiss tap];
  else [self.app.buttons[@"Close"] tap];
}

// Scroll only the existing RN parent; NSH deliberately has no nested scroll view.
- (void)reveal:(XCUIElement *)element {
  XCUIElement *scroll = self.app.scrollViews.firstMatch;
  for (int attempt = 0; attempt < 24; attempt++) {
    CGRect frame = element.frame;
    CGFloat bottom = self.app.frame.size.height * 0.78;
    if (element.exists && element.hittable && CGRectGetMidY(frame) > 100 && CGRectGetMaxY(frame) < bottom) return;
    BOOL below = CGRectGetMidY(frame) >= bottom;
    XCUICoordinate *start = [scroll coordinateWithNormalizedOffset:CGVectorMake(0.5, below ? 0.70 : 0.25)];
    XCUICoordinate *end = [scroll coordinateWithNormalizedOffset:CGVectorMake(0.5, below ? 0.25 : 0.70)];
    [start pressForDuration:0.05 thenDragToCoordinate:end];
  }
  XCTFail(@"Cannot reveal %@. %@", element, self.app.debugDescription);
}

- (void)attach:(NSString *)name {
  XCTAttachment *attachment = [XCTAttachment attachmentWithScreenshot:self.app.screenshot];
  attachment.name = name;
  attachment.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:attachment];
}

- (void)testExpandCollapseAndParentScrolling {
  XCUIElement *toggle = self.app.buttons[@"about-toggle"];
  CGFloat expandedHeight = self.app.otherElements[@"about-content"].frame.size.height;
  CGFloat expandedNextY = self.app.buttons[@"Whipping time"].frame.origin.y;
  [toggle tap];
  XCTAssertTrue([self.app.buttons[@"Expand About"] waitForExistenceWithTimeout:5]);
  XCTAssertFalse(self.app.otherElements[@"about-content"].exists);
  XCTAssertGreaterThan(expandedNextY - self.app.buttons[@"Whipping time"].frame.origin.y, expandedHeight - 5);
  [toggle tap];
  XCUIElement *protocol = [self.app.staticTexts matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"Protocol "]].firstMatch;
  [self reveal:protocol];
  XCTAssertTrue(protocol.hittable);
  XCTAssertTrue(self.app.staticTexts[@"JetBrains Mono"].exists);
  XCTAssertTrue(self.app.staticTexts[@"iOS system monospace"].exists);
  [self attach:@"Rust protocol and terminal font data"];
  [self reveal:self.app.links[@"GoVue"]];
  XCTAssertTrue(self.app.links[@"GoVue"].hittable);
  [self reveal:toggle];
  [self attach:@"Native Shell About expanded"];
}

// Run this case alone against either feature-flag value (or an intentionally
// invalid NSH bundle). It captures the same installed app for visual comparison
// and verifies that native load errors return to the original RN implementation.
- (void)testAboutReference {
  XCUIElement *github = [self.app.links matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"GitHub"]].firstMatch;
  // RN's shared Button supplies role="button", overriding accessibilityRole.
  if (!github.exists) github = [self.app.buttons matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"GitHub"]].firstMatch;
  XCTAssertTrue([github waitForExistenceWithTimeout:5]);
  XCTAssertGreaterThanOrEqual(github.frame.size.height, 44);
  NSLog(@"ABOUT_RENDERER %@", self.app.buttons[@"about-toggle"].exists ? @"Native Shell" : @"React Native");
  [self attach:@"About reference"];
}

- (void)testNativeShareLinksUpdatesAndLicenses {
  XCUIElement *share = self.app.buttons[@"Share Whip on GitHub"];
  [self reveal:share];
  [share tap];
  XCUIElement *copy = [[self.app descendantsMatchingType:XCUIElementTypeAny] matchingIdentifier:@"Copy"].firstMatch;
  XCTAssertTrue([copy waitForExistenceWithTimeout:10], @"%@", self.app.debugDescription);
  XCUIElement *caption = [self.app.otherElements matchingPredicate:[NSPredicate predicateWithFormat:
    @"label CONTAINS %@", @"View Whip on GitHub: https://github.com/kosumic/whip"]].firstMatch;
  XCTAssertTrue(caption.exists);
  [self attach:@"Native repository share sheet"];
  [self dismissShareSheet];

  XCUIElement *check = self.app.buttons[@"Check for updates"];
  [self reveal:check];
  [check tap];
  XCTAssertTrue([check waitForExistenceWithTimeout:20]);
  XCUIElement *result = [self.app.staticTexts matchingPredicate:[NSPredicate predicateWithFormat:
    @"label == %@ OR label == %@ OR (label BEGINSWITH %@ AND label ENDSWITH %@)",
    @"You’re using the latest version.", @"Could not check for updates. Please try again.", @"Whip ", @" is available."]].firstMatch;
  XCTAssertTrue([result waitForExistenceWithTimeout:20], @"%@", self.app.debugDescription);
  NSLog(@"NSH_UPDATE_RESULT %@", result.label);
  [self attach:@"GitHub update result"];

  XCUIElement *licenses = self.app.buttons[@"Open source software licenses"];
  [self reveal:licenses];
  [licenses tap];
  XCTAssertTrue([self.app.buttons[@"Back"] waitForExistenceWithTimeout:5]);
  XCTAssertTrue([self.app.staticTexts matchingIdentifier:@"Open-source software"].firstMatch.exists);
  [self.app.buttons[@"Back"] tap];
  XCTAssertTrue([self.app.buttons[@"about-toggle"] waitForExistenceWithTimeout:5]);
}

- (void)testExternalWebsiteAndReturn {
  [self.app.links[@"Herdr website"] tap];
  XCUIApplication *safari = [[XCUIApplication alloc] initWithBundleIdentifier:@"com.apple.mobilesafari"];
  XCTAssertTrue([safari waitForState:XCUIApplicationStateRunningForeground timeout:10]);
  [self.app activate];
  XCTAssertTrue(self.app.buttons[@"about-toggle"].exists);
}

- (void)testLiveThemeAndLocale {
  XCUIElement *dark = self.app.buttons[@"Dark"];
  [self reveal:dark];
  [dark tap];
  XCTAssertTrue(dark.selected);
  [self reveal:self.app.buttons[@"about-toggle"]];
  XCTAssertTrue(self.app.otherElements[@"about-content"].exists);
  [self attach:@"Live dark appearance"];
  [self reveal:self.app.buttons[@"System"]];
  [self.app.buttons[@"System"] tap];
  XCUIElement *language = [self.app.buttons matchingPredicate:[NSPredicate predicateWithFormat:@"label BEGINSWITH %@", @"Language, "]].firstMatch;
  [self reveal:language];
  [language tap];
  [self waitForStableFrame:self.app.buttons[@"Français"]];
  [self.app.buttons[@"Français"] tap];
  XCTAssertTrue([self.app.buttons[@"Réduire À propos"] waitForExistenceWithTimeout:5]);
  [self reveal:self.app.buttons[@"about-toggle"]];
  XCTAssertTrue(self.app.otherElements[@"about-content"].exists);
  XCTAssertTrue(self.app.links[@"Site de Herdr"].exists);
  [self attach:@"Live French locale"];
  [self restoreAutomaticLanguage];
  XCTAssertTrue([self.app.buttons[@"Collapse About"] waitForExistenceWithTimeout:5]);
  [self reveal:self.app.buttons[@"about-toggle"]];
}
@end
