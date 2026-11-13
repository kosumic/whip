#import <XCTest/XCTest.h>
#import "ENRMSpeechRanges.h"

@interface WhipSpeechPresentationTests : XCTestCase
@end
@implementation WhipSpeechPresentationTests
- (void)testMissingCurrentWordRetainsHeardBoundaryAndDimsEntireUnspokenSuffix {
  NSMutableAttributedString *source = [[NSMutableAttributedString alloc] initWithString:@"Hello unspoken suffix"];
  [source addAttribute:ENRMSpeechSourceAttribute value:@{@"start":@0, @"end":@(source.length)} range:NSMakeRange(0, source.length)];
  UIColor *heard = UIColor.whiteColor, *upcoming = UIColor.grayColor;
  for (NSString *phase in @[@"preparing", @"speaking", @"buffering"]) {
    NSDictionary *config = @{@"phase":phase, @"spokenEnd":@5, @"currentWord":NSNull.null};
    NSAttributedString *painted = ENRMSpeechPaintRanges(source, config, heard, upcoming, nil);
    XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:2 effectiveRange:nil], heard);
    XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:10 effectiveRange:nil], upcoming);
    XCTAssertEqualObjects(painted.string, source.string);
  }
  XCTAssertEqualObjects(ENRMSpeechPaintRanges(source, nil, heard, upcoming, nil), source);
}
- (void)testCurrentWordHasIndependentEmphasisAndDoesNotBrightenTheSuffix {
  NSMutableAttributedString *source = [[NSMutableAttributedString alloc] initWithString:@"One two three"];
  [source addAttribute:ENRMSpeechSourceAttribute value:@{@"start":@0, @"end":@13} range:NSMakeRange(0,13)];
  [source addAttribute:NSFontAttributeName value:[UIFont systemFontOfSize:14] range:NSMakeRange(0,13)];
  NSDictionary *config = @{@"spokenEnd":@3, @"currentWord":@{@"start":@4,@"end":@7}};
  NSAttributedString *painted = ENRMSpeechPaintRanges(source, config, UIColor.whiteColor, UIColor.grayColor,
    ^UIFont *(UIFont *font) { return [UIFont boldSystemFontOfSize:font.pointSize]; });
  XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:5 effectiveRange:nil], UIColor.whiteColor);
  XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:9 effectiveRange:nil], UIColor.grayColor);
  UIFont *word = [painted attribute:NSFontAttributeName atIndex:5 effectiveRange:nil];
  XCTAssertTrue(word.fontDescriptor.symbolicTraits & UIFontDescriptorTraitBold);
  XCTAssertEqualObjects(config[@"spokenEnd"], @3);
}
@end
