#import <XCTest/XCTest.h>
#include <initializer_list>
#import "WhipAudioInterruption.h"

@interface WhipAudioInterruptionTests : XCTestCase
@end
@implementation WhipAudioInterruptionTests
- (void)testCallKitAndInterruptionMayRecoverInEitherOrder {
  for (bool activationFirst : {false, true}) {
    WhipAudioInterruption state;
    state.reset(true);
    state.begin(); state.begin(); state.authorized = false;
    XCTAssertFalse(state.canResume());
    if (activationFirst) state.authorized = true; else state.ended(true);
    XCTAssertFalse(state.canResume());
    if (activationFirst) state.ended(true); else state.authorized = true;
    XCTAssertTrue(state.canResume());
  }
}
- (void)testActivationCannotOverrideDeniedRecovery {
  WhipAudioInterruption state;
  state.reset(true); state.begin(); state.ended(false); state.authorized = true;
  XCTAssertFalse(state.canResume());
}
- (void)testCallKitDeactivationWithoutInterruptionRequiresActivation {
  WhipAudioInterruption state;
  state.reset(false);
  XCTAssertFalse(state.canResume());
  state.authorized = true;
  XCTAssertTrue(state.canResume());
  state.authorized = false;
  XCTAssertFalse(state.canResume());
}
@end
