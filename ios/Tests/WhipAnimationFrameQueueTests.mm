#import <XCTest/XCTest.h>
#import <UIKit/UIKit.h>
#import <worklets/apple/AnimationFrameQueue.h>

@interface WhipAnimationFrameQueueTests : XCTestCase
@end

@implementation WhipAnimationFrameQueueTests
- (void)testPendingFramesSuspendWhileInactiveAndResumeWithoutJavaScript
{
  AnimationFrameQueue *queue = [AnimationFrameQueue new];
  int calls = 0;
  [[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationWillResignActiveNotification object:nil];
  [queue requestAnimationFrame:[&](double timestamp) { calls++; }];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  XCTAssertEqual(calls, 0, @"Inactive UI runtimes do not tick even when a frame is queued");
  for (int i = 0; i < 10; i++) {
    [[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationDidBecomeActiveNotification object:nil];
  }
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  XCTAssertEqual(calls, 1, @"Native foregrounding drains pending work exactly once without JS");
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  XCTAssertEqual(calls, 1, @"No extra animation loop remains after the queue drains");
  [queue invalidate];
}

- (void)testActiveFramesAndInvalidationWhileResumeIsPending
{
  AnimationFrameQueue *queue = [AnimationFrameQueue new];
  [[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationDidBecomeActiveNotification object:nil];
  int calls = 0;
  [queue requestAnimationFrame:[&](double timestamp) { calls++; }];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  XCTAssertEqual(calls, 1);
  [[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationWillResignActiveNotification object:nil];
  [queue requestAnimationFrame:[&](double timestamp) { calls++; }];
  [queue invalidate];
  [[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationDidBecomeActiveNotification object:nil];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
  XCTAssertEqual(calls, 1, @"A destroyed runtime cannot resume pending work");
}
@end
