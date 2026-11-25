#import <AVFoundation/AVFoundation.h>
#import <XCTest/XCTest.h>
#import "WhipVoiceCall.h"
#import "WhipRealtimeVoice.h"
#import "WhipSpeechPlayback.h"

// The simulator supplies the real audio session. Only the Rust session authority,
// playback queue and realtime transport are replaced in this test bundle.
static NSString *currentToken;
static NSString *endedReason;
static id realtimeTurn;
bool whip_voice_session_current(const char *token) { return [currentToken isEqualToString:@(token)]; }
void whip_voice_session_end_reason(const char *token, const char *reason) {
  if (whip_voice_session_current(token)) {
    endedReason = reason ? @(reason) : nil;
    currentToken = nil;
  }
}

// Only the selectors used by the adapter are part of these fixtures.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wincomplete-implementation"
@implementation WhipSpeechPlayback
+ (instancetype)shared { static WhipSpeechPlayback *player; if (!player) player = [self new]; return player; }
- (BOOL)deferPlayback:(id)turn block:(dispatch_block_t)block { return NO; }
- (void)startPlayback:(id)turn {}
- (void)cancelPlayback:(id)turn {}
- (void)finishPlayback:(id)turn {}
- (void)stopLocalChatForTurn:(id)turn {}
@end

@implementation WhipRealtimeVoice
+ (instancetype)shared { static WhipRealtimeVoice *voice; if (!voice) voice = [self new]; return voice; }
- (id)playbackKey { return realtimeTurn; }
- (void)mute:(NSString *)token muted:(BOOL)muted {}
- (void)stop:(NSString *)token {}
@end
#pragma clang diagnostic pop

@interface WhipVoiceCallTests : XCTestCase
@end
@implementation WhipVoiceCallTests
- (void)tearDown {
  [WhipVoiceCall.shared invalidate];
  currentToken = nil;
  endedReason = nil;
  realtimeTurn = nil;
  [super tearDown];
}
- (RCTPromiseRejectBlock)unexpectedError {
  return ^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@ %@", code, message); };
}
- (void)start:(NSString *)token {
  currentToken = token;
  __block BOOL ready = NO;
  [WhipVoiceCall.shared start:token label:@"Agent" resolve:^(id value) { ready = YES; } reject:self.unexpectedError];
  XCTAssertTrue(ready);
  XCTAssertFalse(WhipVoiceCall.shared.active);
}
- (void)activate:(NSString *)token {
  [WhipVoiceCall.shared activateAudio:token resolve:^(id value) {} reject:self.unexpectedError];
  XCTAssertTrue(WhipVoiceCall.shared.active);
  XCTAssertEqualObjects(AVAudioSession.sharedInstance.category, AVAudioSessionCategoryPlayAndRecord);
  XCTAssertEqualObjects(AVAudioSession.sharedInstance.mode, AVAudioSessionModeVoiceChat);
}
- (void)testInAppMuteAndEndAcrossConsecutiveVoiceSessions {
  WhipVoiceCall *voice = WhipVoiceCall.shared;
  [self start:@"first"];
  [voice mute:@"first" muted:YES resolve:^(id value) {} reject:self.unexpectedError];
  [self activate:@"first"];
  XCTAssertTrue(voice.muted);
  [voice mute:@"first" muted:NO resolve:^(id value) {} reject:self.unexpectedError];
  XCTAssertFalse(voice.muted);
  [voice end:@"first" resolve:^(id value) {} reject:self.unexpectedError];
  XCTAssertFalse(voice.active);
  [self start:@"second"];
  [self activate:@"second"];
  [voice end:@"first" resolve:^(id value) {} reject:self.unexpectedError];
  XCTAssertTrue([voice owns:@"second"]);
  XCTAssertTrue(voice.active);
}
- (void)testInterruptionEndsLocalAudioOnlyAfterActivation {
  [self start:@"local"];
  NSDictionary *began = @{AVAudioSessionInterruptionTypeKey: @(AVAudioSessionInterruptionTypeBegan)};
  [NSNotificationCenter.defaultCenter postNotificationName:AVAudioSessionInterruptionNotification object:AVAudioSession.sharedInstance userInfo:began];
  XCTAssertTrue([WhipVoiceCall.shared owns:@"local"]);
  [self activate:@"local"];
  [NSNotificationCenter.defaultCenter postNotificationName:AVAudioSessionInterruptionNotification object:AVAudioSession.sharedInstance userInfo:began];
  XCTAssertFalse(WhipVoiceCall.shared.active);
  XCTAssertNotNil(endedReason);
  XCTAssertNil(currentToken);
}
- (void)testRealtimeKeepsItsReservationThroughAnInterruptionAndEndsOnMediaReset {
  [self start:@"live"];
  realtimeTurn = [WhipVoiceCall.shared playbackKey:@"live"];
  [self activate:@"live"];
  [NSNotificationCenter.defaultCenter postNotificationName:AVAudioSessionInterruptionNotification object:AVAudioSession.sharedInstance
      userInfo:@{AVAudioSessionInterruptionTypeKey: @(AVAudioSessionInterruptionTypeBegan)}];
  XCTAssertTrue([WhipVoiceCall.shared owns:@"live"]);
  [NSNotificationCenter.defaultCenter postNotificationName:AVAudioSessionMediaServicesWereResetNotification object:AVAudioSession.sharedInstance];
  XCTAssertFalse(WhipVoiceCall.shared.active);
  XCTAssertNil(currentToken);
  XCTAssertNotNil(endedReason);
}
@end
