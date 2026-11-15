#import <XCTest/XCTest.h>
#import "WhipCallPlaybackBoundary.h"

@interface WhipCallPlaybackBoundaryTests : XCTestCase
@end
@implementation WhipCallPlaybackBoundaryTests
- (void)testCueWaitsForActualDeviceCompletionIncludingTheLastPartialBuffer {
  WhipCallPlaybackBoundary clock;
  clock.reset(1);
  auto first = clock.schedule(480);
  auto tail = clock.schedule(123);
  XCTAssertFalse(clock.drained());
  XCTAssertTrue(clock.complete(1, first));
  XCTAssertFalse(clock.drained());
  XCTAssertTrue(clock.complete(1, tail));
  XCTAssertTrue(clock.drained());
}
- (void)testSilenceDoesNotAcknowledgeUnplayedAssistantAudio {
  WhipCallPlaybackBoundary clock;
  clock.reset(1);
  auto silence = clock.schedule(0);
  auto speech = clock.schedule(480);
  XCTAssertTrue(clock.complete(1, silence));
  XCTAssertFalse(clock.drained());
  XCTAssertTrue(clock.complete(1, speech));
  XCTAssertTrue(clock.drained());
}
- (void)testLateCompletionsAfterSkipOrProviderRotationCannotDrainNewSpeech {
  WhipCallPlaybackBoundary clock;
  clock.reset(1);
  auto old = clock.schedule(960);
  clock.reset(2); // Player has stopped and discarded epoch 1.
  auto fresh = clock.schedule(480);
  XCTAssertFalse(clock.complete(1, old));
  XCTAssertFalse(clock.complete(2, old));
  XCTAssertFalse(clock.drained());
  XCTAssertTrue(clock.complete(2, fresh));
  XCTAssertTrue(clock.drained());
}
@end
