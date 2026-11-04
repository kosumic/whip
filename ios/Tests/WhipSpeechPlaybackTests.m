#import <XCTest/XCTest.h>
#import <AVFoundation/AVFoundation.h>
#import "WhipSpeechPlayback.h"
#import "WhipVoiceCall.h"

// Script the Rust policy boundary; Rust's queue and lease races have their own
// tests. This fixture drives real adapter callbacks without audible OS output.
static uint64_t sequence, activeLease;
static uint8_t activeKind;
static NSString *activeOwner;
static NSString *activeRequest;
static NSMutableArray<NSString *> *waiting;
static NSMutableSet<NSString *> *valid;
static __weak WhipSpeechPlayback *fixturePlayer;

uint64_t whip_speech_claim(uint8_t kind, const char *owner, const char *request) {
  if (activeLease && kind != WhipSpeechChat && !(kind == WhipSpeechAnnouncement && activeKind == kind)) return 0;
  activeLease = ++sequence; activeKind = kind; activeOwner = @(owner); activeRequest = @(request); return activeLease;
}
bool whip_speech_is_current(uint64_t lease) { return lease && lease == activeLease; }
bool whip_speech_complete(uint64_t lease) {
  if (!whip_speech_is_current(lease)) return false;
  if (activeKind != WhipSpeechChat) activeLease = 0;
  return true;
}
bool whip_speech_stop(uint64_t lease) { if (!whip_speech_is_current(lease)) return false; activeLease = 0; return true; }
uint64_t whip_speech_timeout_ms(uint8_t kind, uint64_t units) { return 30000; }
uint64_t whip_speech_stop_owner(uint8_t kind, const char *owner) {
  if (activeKind != kind || ![activeOwner isEqualToString:@(owner)]) return 0;
  uint64_t lease = activeLease; activeLease = 0; return lease;
}
uint64_t whip_speech_cancel_request(uint8_t kind, const char *request) {
  if (activeKind != kind || ![activeRequest isEqualToString:@(request)]) return 0;
  uint64_t lease = activeLease; activeLease = 0; return lease;
}
char *whip_alert_speech_command(const char *command, const char *token, uint64_t observed) {
  NSString *action = @(command), *owner = @(token), *result = @"null";
  if ([action isEqualToString:@"register"] || [action isEqualToString:@"valid"]) result = [valid containsObject:owner] ? @"true" : @"false";
  else if ([action isEqualToString:@"clear"]) { [waiting removeAllObjects]; [valid removeAllObjects]; }
  else if ([action isEqualToString:@"finish"]) [valid removeObject:owner];
  else if ([action isEqualToString:@"take"] && waiting.count &&
           ((!activeLease && !observed) || (activeLease == observed && activeKind == WhipSpeechChat))) {
    NSString *next = waiting.firstObject; [waiting removeObjectAtIndex:0];
    activeLease = ++sequence; activeKind = WhipSpeechAnnouncement; activeOwner = next;
    NSDictionary *value = @{@"token": next, @"text": next, @"language": @"en-US", @"lease": @(activeLease)};
    result = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] encoding:NSUTF8StringEncoding];
  }
  return strdup(result.UTF8String);
}
void whip_alert_speech_free(char *value) { free(value); }
static NSMutableArray<NSDictionary *> *automaticWaiting;
static NSMutableArray<NSNumber *> *automaticCompleted;
static uint64_t automaticActive;
static BOOL automaticEnabled;
static BOOL automaticPaused;
void whip_automatic_speech_register(void (*wake)(void)) {}
char *whip_automatic_speech_command(const char *input) {
  NSDictionary *command = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:input] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  NSString *action = command[@"action"];
  id result = NSNull.null;
  if ([action isEqualToString:@"enable"]) automaticEnabled = [command[@"enabled"] boolValue];
  else if ([action isEqualToString:@"pause"]) {
    automaticPaused = [command[@"paused"] boolValue];
    if (automaticPaused) [automaticWaiting removeAllObjects];
  }
  else if ([action isEqualToString:@"valid"]) result = @(automaticEnabled && !automaticPaused && automaticActive == [command[@"id"] unsignedLongLongValue]);
  else if ([action isEqualToString:@"ended"]) automaticActive = 0;
  else if ([action isEqualToString:@"completed"]) {
    uint64_t identity = [command[@"id"] unsignedLongLongValue];
    result = @(automaticActive == identity);
    if (automaticActive == identity) { [automaticCompleted addObject:@(identity)]; automaticActive = 0; }
  } else if ([action isEqualToString:@"take"] && automaticEnabled && !automaticPaused && !automaticActive && automaticWaiting.count) {
    result = automaticWaiting.firstObject;
    automaticActive = [result[@"id"] unsignedLongLongValue];
    [automaticWaiting removeObjectAtIndex:0];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:nil];
  return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}
char *whip_speech_backend_command(const char *root, const char *action) { return strdup("{}"); }
void whip_speech_backend_free(char *value) { free(value); }
bool whip_phonon_enabled(const char *language) { return false; }
bool whip_speech_pcm_enabled(const char *language, bool local_only) { return false; }
bool whip_speech_network_selected(void) { return false; }
int32_t WhipReadOpenAiVoiceCredential(void *context, uint8_t *destination, size_t capacity) { return -1; }
void whip_phonon_set_supported(bool supported) {}
void whip_speech_pcm_playback_failed(void) {}
int32_t whip_phonon_speak(uint64_t lease, const char *text, WhipPcmCallback callback, void *context) { return 0; }
int32_t whip_speech_pcm_speak(uint64_t lease, const char *text, WhipPcmCallback callback, void *context,
                            WhipReadVoiceCredential reader, void *credential_context) { return 0; }

@implementation WhipVoiceCall
+ (instancetype)shared { static WhipVoiceCall *call; if (!call) call = [WhipVoiceCall new]; return call; }
- (BOOL)active { return NO; }
- (BOOL)owns:(NSString *)token { return NO; }
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)end:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)speaker:(NSString *)token enabled:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)invalidate {}
- (void)playSound:(NSString *)uri inCall:(BOOL)inCall resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(nil); }
- (void)stopSound {}
@end

@interface WhipSpeechPlayback (TestEngine) <AVSpeechSynthesizerDelegate>
@property(nonatomic, strong) AVSpeechUtterance *utterance;
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview;
- (void)watchShake;
- (void)drainAutomatic;
- (NSString *)alertCommand:(NSString *)action token:(NSString *)token lease:(uint64_t)lease;
@end
@interface TestSpeechPlayback : WhipSpeechPlayback
@property(nonatomic, strong) NSMutableArray<NSString *> *spoken;
@property(nonatomic, copy) void (^onPlay)(NSString *);
@end
@implementation TestSpeechPlayback
- (void)backendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(@"{}"); }
- (void)watchShake {}
- (NSString *)alertCommand:(NSString *)action token:(NSString *)token lease:(uint64_t)lease {
  return fixturePlayer == self ? [super alertCommand:action token:token lease:lease] : @"null";
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview {
  self.utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  [self.spoken addObject:text]; if (started) started(); if (self.onPlay) self.onPlay(text); return YES;
}
@end

@interface WhipSpeechPlaybackTests : XCTestCase
@property(nonatomic, strong) TestSpeechPlayback *player;
@property(nonatomic, strong) NSMutableArray<NSString *> *stopped;
@property(nonatomic, strong) id observer;
@end
@implementation WhipSpeechPlaybackTests
- (void)setUp {
  [super setUp]; activeLease = 0; activeOwner = nil;
  waiting = [NSMutableArray new]; valid = [NSMutableSet new];
  automaticWaiting = [NSMutableArray new]; automaticCompleted = [NSMutableArray new];
  automaticActive = 0; automaticEnabled = NO; automaticPaused = NO;
  self.player = [TestSpeechPlayback new]; fixturePlayer = self.player; self.player.spoken = [NSMutableArray new]; self.stopped = [NSMutableArray new];
  self.observer = [NSNotificationCenter.defaultCenter addObserverForName:WhipChatSpeechStopped object:self.player queue:nil usingBlock:^(NSNotification *event) {
    [self.stopped addObject:event.userInfo[@"token"]];
  }];
}
- (void)tearDown { [self.player stop]; fixturePlayer = nil; [NSNotificationCenter.defaultCenter removeObserver:self.observer]; [super tearDown]; }
- (RCTPromiseRejectBlock)unexpectedError {
  return ^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@ %@", code, message); };
}
- (void)queue:(NSString *)token { [waiting addObject:token]; [valid addObject:token]; }
- (void)finish { [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:self.player.utterance]; }

- (void)queueAutomatic:(uint64_t)identity text:(NSString *)text {
  [automaticWaiting addObject:@{@"id": @(identity), @"token": @"automatic-chat-speech", @"text": text,
    @"hostId": @"host", @"paneId": @"pane", @"label": @"Native automatic test"}];
}
- (void)testAutomaticAudioCompletionAdvancesWithoutJavaScriptAndIgnoresLateCallbacks {
  [self queueAutomatic:1 text:@"first automatic update"];
  [self queueAutomatic:2 text:@"second automatic update"];
  XCTestExpectation *second = [self expectationWithDescription:@"native completion starts next utterance"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"second automatic update"]) [second fulfill]; };
  [self.player automaticControl:@"enable" value:YES];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first automatic update"]));
  AVSpeechUtterance *old = self.player.utterance;
  [self.player detachPresentation];
  XCTAssertEqualObjects(activeOwner, @"automatic-chat-speech");
  [self finish]; [self waitForExpectations:@[second] timeout:2];
  XCTAssertEqualObjects(automaticCompleted, (@[@1]));
  [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:old];
  XCTestExpectation *fenced = [self expectationWithDescription:@"late native callback ignored"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqual(automaticActive, 2u);
    XCTAssertEqualObjects(automaticCompleted, (@[@1]));
    [fenced fulfill];
  });
  [self waitForExpectations:@[fenced] timeout:2];
  [self finish];
  XCTestExpectation *completed = [[XCTNSPredicateExpectation alloc] initWithPredicate:
    [NSPredicate predicateWithBlock:^BOOL(id object, NSDictionary *bindings) { return automaticCompleted.count == 2; }] object:nil];
  [self waitForExpectations:@[completed] timeout:2];
  XCTAssertEqualObjects(automaticCompleted, (@[@1, @2]));
}
- (void)testAutomaticPauseCancelsAudioAndLateCompletionCannotDrainQueuedSpeech {
  [self queueAutomatic:1 text:@"current update"];
  [self queueAutomatic:2 text:@"discard waiting update"];
  [self.player automaticControl:@"enable" value:YES];
  AVSpeechUtterance *old = self.player.utterance;
  [self.player automaticControl:@"pause" value:YES];
  XCTAssertEqual(activeLease, 0u);
  XCTAssertEqual(automaticWaiting.count, 0u);
  [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:old];
  [self queueAutomatic:3 text:@"fresh update"];
  [self.player automaticControl:@"pause" value:NO];
  XCTAssertEqualObjects(self.player.spoken, (@[@"current update", @"fresh update"]));
  XCTAssertEqual(automaticActive, 3u);
  XCTAssertEqual(automaticCompleted.count, 0u);
}

- (void)testChatChunkFinishesBeforeStatusAndContinuesAfterward {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  uint64_t oldChat = activeLease;
  XCTestExpectation *chunk = [self expectationWithDescription:@"held chat chunk completes"];
  [self.player speakChat:@"reader" text:@"chat one" resolve:^(id value) { [chunk fulfill]; } reject:self.unexpectedError];
  XCTestExpectation *statusStarted = [self expectationWithDescription:@"status starts at boundary"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"status"]) [statusStarted fulfill]; };
  [self queue:@"status"];
  XCTestExpectation *status = [self expectationWithDescription:@"status completes"];
  [self.player announceStatus:@"status" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"completed"); [status fulfill]; } reject:self.unexpectedError];
  XCTAssertEqualObjects(self.player.spoken, (@[@"chat one"]));
  [self finish]; [self waitForExpectations:@[statusStarted] timeout:2];
  XCTAssertEqual(self.stopped.count, 0u);
  XCTAssertFalse(whip_speech_complete(oldChat));
  XCTestExpectation *continued = [self expectationWithDescription:@"next chat chunk"];
  [self.player speakChat:@"reader" text:@"chat two" resolve:^(id value) { [continued fulfill]; } reject:self.unexpectedError];
  [self finish]; [self waitForExpectations:@[status, chunk] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"chat one", @"status", @"chat two"]));
  [self finish]; [self waitForExpectations:@[continued] timeout:2];
  XCTAssertEqual(self.stopped.count, 0u);
}

- (void)testClosingSuspendedReaderDoesNotCancelStatusOrResumeClosedChat {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  [self queue:@"status"];
  XCTestExpectation *status = [self expectationWithDescription:@"unrelated status completes"];
  [self.player announceStatus:@"status" resolve:^(id value) { [status fulfill]; } reject:self.unexpectedError];
  uint64_t statusLease = activeLease;
  XCTAssertTrue([self.player stopOwner:@"reader" kind:WhipSpeechChat]);
  XCTAssertTrue(whip_speech_is_current(statusLease));
  XCTAssertEqualObjects(self.stopped, (@[@"reader"]));
  [self finish]; [self waitForExpectations:@[status] timeout:2];
  __block BOOL rejected = NO;
  [self.player speakChat:@"reader" text:@"obsolete" resolve:^(id value) { XCTFail(@"Closed reader resumed"); }
                  reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
}

- (void)testScopedStatusCancellationDoesNotStopNextStatusOrDiscardReader {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  [self queue:@"first"]; [self queue:@"second"];
  XCTestExpectation *first = [self expectationWithDescription:@"first stopped"];
  [self.player announceStatus:@"first" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"stopped"); [first fulfill]; } reject:self.unexpectedError];
  XCTestExpectation *second = [self expectationWithDescription:@"second finishes"];
  [self.player announceStatus:@"second" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"completed"); [second fulfill]; } reject:self.unexpectedError];
  XCTestExpectation *secondStarted = [self expectationWithDescription:@"second starts"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"second"]) [secondStarted fulfill]; };
  XCTAssertTrue([self.player stopOwner:@"first" kind:WhipSpeechAnnouncement]);
  [self waitForExpectations:@[first, secondStarted] timeout:2];
  XCTAssertFalse([self.player stopOwner:@"first" kind:WhipSpeechAnnouncement]);
  XCTAssertEqual(self.stopped.count, 0u);
  [self finish]; [self waitForExpectations:@[second] timeout:2];
}
- (void)testDeviceCancellationReleasesWaitingStatusWithoutAnotherStatusEvent {
  [self.player speakDevice:@"tool" request:@"request" text:@"device output" language:@"en-US" rate:1
                  resolve:^(id value) {} reject:self.unexpectedError];
  [self queue:@"waiting status"];
  XCTestExpectation *status = [self expectationWithDescription:@"status finishes after tool cancellation"];
  [self.player announceStatus:@"waiting status" resolve:^(id reason) { [status fulfill]; } reject:self.unexpectedError];
  XCTAssertEqualObjects(self.player.spoken, (@[@"device output"]));
  XCTestExpectation *started = [self expectationWithDescription:@"waiting status starts"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"waiting status"]) [started fulfill]; };
  [self.player cancelDeviceRequest:@"request"];
  [self waitForExpectations:@[started] timeout:2];
  [self finish]; [self waitForExpectations:@[status] timeout:2];
}

- (void)testExplicitStopClearsWaitingSpeechAndDoesNotResumeSuspendedReader {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  [self queue:@"first"]; [self queue:@"second"];
  XCTestExpectation *first = [self expectationWithDescription:@"current status stopped"];
  XCTestExpectation *second = [self expectationWithDescription:@"waiting status stopped"];
  [self.player announceStatus:@"first" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"stopped"); [first fulfill]; } reject:self.unexpectedError];
  [self.player announceStatus:@"second" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"stopped"); [second fulfill]; } reject:self.unexpectedError];
  [self.player stop];
  [self waitForExpectations:@[first, second] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first"]));
  XCTAssertEqualObjects(self.stopped, (@[@"reader"]));
  XCTAssertEqual(activeLease, 0u);
}

@end
