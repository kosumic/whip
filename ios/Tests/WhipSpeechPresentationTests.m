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
  NSArray *themes = @[
    @[UIColor.whiteColor, [UIColor colorWithWhite:163.0/255.0 alpha:1]],
    @[[UIColor colorWithRed:36.0/255.0 green:41.0/255.0 blue:47.0/255.0 alpha:1],
      [UIColor colorWithWhite:102.0/255.0 alpha:1]],
  ];
  for (NSArray<UIColor *> *theme in themes) {
    UIColor *heard = theme[0], *upcoming = theme[1];
    [source addAttribute:NSForegroundColorAttributeName value:heard range:NSMakeRange(0, source.length)];
    NSAttributedString *painted = ENRMSpeechPaintRanges(source, config, heard, upcoming,
      ^UIFont *(UIFont *font) { return [UIFont systemFontOfSize:font.pointSize weight:UIFontWeightSemibold]; });
    XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:1 effectiveRange:nil], heard);
    XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:5 effectiveRange:nil], heard);
    XCTAssertEqualObjects([painted attribute:NSForegroundColorAttributeName atIndex:9 effectiveRange:nil], upcoming);
    XCTAssertEqualObjects([painted attribute:NSFontAttributeName atIndex:5 effectiveRange:nil],
                          [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold]);
    XCTAssertEqualObjects(painted.string, source.string);
    XCTAssertEqualObjects(config[@"spokenEnd"], @3);
    NSAttributedString *cleared = ENRMSpeechPaintRanges(source, nil, heard, upcoming, nil);
    XCTAssertEqualObjects(cleared, source);
    XCTAssertEqualObjects([cleared attribute:NSForegroundColorAttributeName atIndex:9 effectiveRange:nil], heard);
    XCTAssertEqualObjects([cleared attribute:NSFontAttributeName atIndex:5 effectiveRange:nil], [UIFont systemFontOfSize:14]);
  }
}
@end
