#import <XCTest/XCTest.h>
#import <AVFoundation/AVFoundation.h>
#import "WhipSpeechPlayback.h"
#import "WhipVoiceCall.h"
#import "WhipRealtimeVoice.h"

// Script the Rust policy boundary; Rust's queue and lease races have their own
// tests. This fixture drives real adapter callbacks without audible OS output.
static NSMutableArray<NSDictionary *> *captionCommands;
static uint64_t sequence, activeLease;
static uint8_t activeKind;
static NSString *activeOwner;
static NSString *activeRequest;
static NSMutableArray<NSString *> *waiting;
static NSMutableSet<NSString *> *valid;
static __weak WhipSpeechPlayback *fixturePlayer;
static uint64_t turnSequence, turnOwner;
static NSMutableArray<NSNumber *> *turnWaiting;

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
uint64_t whip_speech_caption_start(const char *text, uintptr_t prefix_utf16) { return 1; }
char *whip_speech_caption_command(const char *json) {
  NSDictionary *command = [NSJSONSerialization JSONObjectWithData:[@(json) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  [captionCommands addObject:command];
  return strdup("null");
}
uintptr_t whip_speech_caption_progress(uint64_t id, uintptr_t played, uintptr_t samples, bool complete) { return 0; }
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
  if ([action hasPrefix:@"playback-"]) {
    NSString *operation = [action substringFromIndex:@"playback-".length];
    uint64_t key = owner.longLongValue;
    if ([operation isEqualToString:@"id"]) result = [NSString stringWithFormat:@"%llu", ++turnSequence];
    else if ([operation isEqualToString:@"active"]) result = turnOwner ? @"true" : @"false";
    else if ([operation isEqualToString:@"timeout-delay-ms"]) result = turnWaiting.count ? @"0" : @"1000";
    else if ([operation isEqualToString:@"owns"]) result = turnOwner == key ? @"true" : @"false";
    else if ([operation isEqualToString:@"start"]) {
      BOOL admitted = !turnOwner || turnOwner == key;
      if (admitted) turnOwner = key;
      result = admitted ? @"true" : @"false";
    } else if ([operation isEqualToString:@"defer"]) {
      BOOL deferred = turnOwner != key && (turnOwner || turnWaiting.count);
      if (deferred && ![turnWaiting containsObject:@(key)]) [turnWaiting addObject:@(key)];
      result = deferred ? @"true" : @"false";
    } else if ([operation isEqualToString:@"cancel"]) [turnWaiting removeObject:@(key)];
    else if ([operation isEqualToString:@"finish"]) { BOOL current = turnOwner == key; if (current) turnOwner = 0; result = current ? @"true" : @"false"; }
    else if ([operation isEqualToString:@"next"] && !turnOwner && turnWaiting.count) {
      turnOwner = turnWaiting.firstObject.unsignedLongLongValue; [turnWaiting removeObjectAtIndex:0];
      result = [NSString stringWithFormat:@"%llu", turnOwner];
    }
    return strdup(result.UTF8String);
  }
  if ([action isEqualToString:@"effect-alert"]) {
    NSDictionary *info = @{@"token": owner, @"speech": @YES, @"silent": @NO, @"persistent": @NO, @"timeoutMs": @1000};
    return strdup([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:info options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
  }
  if ([action isEqualToString:@"alert-valid"]) return strdup([valid containsObject:owner] ? "true" : "false");
  if ([action isEqualToString:@"dismiss-alert"]) { [valid removeObject:owner]; [waiting removeObject:owner]; return strdup("null"); }
  if ([action isEqualToString:@"register"] || [action isEqualToString:@"valid"]) result = [valid containsObject:owner] ? @"true" : @"false";
  else if ([action isEqualToString:@"clear"]) { [waiting removeAllObjects]; [valid removeAllObjects]; }
  else if ([action isEqualToString:@"finish"]) [valid removeObject:owner];
  else if (([action isEqualToString:@"take"] || [action isEqualToString:@"take-token"]) && waiting.count &&
           ((!activeLease && !observed) || (activeLease == observed && activeKind == WhipSpeechChat))) {
    NSString *next = [action isEqualToString:@"take-token"] ? owner : waiting.firstObject;
    if (![waiting containsObject:next]) return strdup("null");
    [waiting removeObject:next];
    activeLease = ++sequence; activeKind = WhipSpeechAnnouncement; activeOwner = next;
    NSDictionary *value = @{@"token": next, @"text": next, @"language": @"en-US", @"lease": @(activeLease)};
    result = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] encoding:NSUTF8StringEncoding];
  }
  return strdup(result.UTF8String);
}
void whip_alert_speech_free(char *value) { free(value); }
static NSMutableArray<NSDictionary *> *automaticWaiting;
static NSMutableArray<NSNumber *> *automaticCompleted;
static NSMutableArray<NSDictionary *> *automaticEndings;
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
  else if ([action isEqualToString:@"ended"]) {
    [automaticEndings addObject:command];
    if (automaticActive == [command[@"id"] unsignedLongLongValue]) automaticActive = 0;
  }
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
bool whip_voice_credentials_prepare(WhipReadVoiceCredential reader, void *context) { return false; }
void whip_phonon_set_supported(bool supported) {}
void whip_speech_pcm_playback_failed(void) {}
int32_t whip_phonon_speak(uint64_t lease, const char *text, WhipPcmCallback callback, void *context) { return 0; }
int32_t whip_speech_pcm_speak(uint64_t lease, const char *text, uint64_t caption_id, WhipPcmCallback callback, void *context,
                            WhipReadVoiceCredential reader, void *credential_context) { return 0; }

static BOOL voiceCallActive;
static id voiceCallTurn;
static NSString *voiceCallToken;
@implementation WhipVoiceCall
+ (instancetype)shared { static WhipVoiceCall *call; if (!call) call = [WhipVoiceCall new]; return call; }
- (BOOL)active { return voiceCallActive; }
- (BOOL)owns:(NSString *)token { return NO; }
- (id)playbackKey:(NSString *)token { return !token || [token isEqualToString:voiceCallToken] ? voiceCallTurn : nil; }
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)end:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)syncMuted:(NSString *)token muted:(BOOL)muted {}
- (void)speaker:(NSString *)token enabled:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)invalidate {}
- (void)playSound:(NSString *)uri inCall:(BOOL)inCall resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(nil); }
- (void)stopSound {}
@end

@implementation WhipRealtimeVoice
+ (instancetype)shared { static WhipRealtimeVoice *voice; if (!voice) voice = [WhipRealtimeVoice new]; return voice; }
- (id)playbackKey { return nil; }
- (BOOL)shake { return NO; }
- (void)invalidate {}
- (void)credentialsUpdating:(BOOL)updating {}
- (void)prepare:(BOOL)enabled {}
- (void)start:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)preview:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {}
- (void)stop:(NSString *)token {}
- (void)stop:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve { resolve(nil); }
- (void)mute:(NSString *)token muted:(BOOL)muted {}
- (void)control:(NSString *)token action:(uint8_t)action {}
- (BOOL)submitted:(NSString *)token text:(NSString *)text { return NO; }
- (NSString *)view:(NSString *)token { return @"{}"; }
@end

@interface WhipSpeechPlayback (TestEngine) <AVSpeechSynthesizerDelegate>
+ (NSData *)alertRingtoneData;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) NSMutableDictionary *caption;
@property(nonatomic) NSInteger captionPrefix;
@property(nonatomic) uint64_t captionClock;
@property(nonatomic, copy) NSString *systemVoice;
- (id)newCallAnnouncement;
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview;
- (void)watchShake;
- (void)drainAutomatic;
- (NSString *)alertCommand:(NSString *)action token:(NSString *)token lease:(uint64_t)lease;
- (void)playAlertRingtone:(NSString *)token;
- (void)armSpeechTimeout:(NSTimeInterval)interval initialization:(BOOL)initialization;
@end
@interface TestCallAnnouncement : NSObject
@property(nonatomic) uint64_t lease;
@property(nonatomic, copy) NSString *text;
@property(nonatomic, copy) NSString *voice;
@property(nonatomic, copy) dispatch_block_t completed;
@property(nonatomic) BOOL cancelled;
- (void)start:(uint64_t)lease text:(NSString *)text voice:(NSString *)voice completed:(dispatch_block_t)completed;
- (void)cancel;
@end
@implementation TestCallAnnouncement
- (void)start:(uint64_t)lease text:(NSString *)text voice:(NSString *)voice completed:(dispatch_block_t)completed
{ self.lease = lease; self.text = text; self.voice = voice; self.completed = completed; }
- (void)cancel { self.cancelled = YES; self.completed = nil; }
@end
@interface TestSpeechPlayback : WhipSpeechPlayback
@property(nonatomic, strong) NSMutableArray<NSString *> *spoken;
@property(nonatomic, copy) void (^onPlay)(NSString *);
@property(nonatomic, strong) NSMutableArray<NSString *> *ringtones;
@property(nonatomic) BOOL holdRingtone;
@property(nonatomic, copy) void (^onRingtone)(NSString *);
@property(nonatomic, strong) NSMutableArray<TestCallAnnouncement *> *callAnnouncements;
@end
@implementation TestSpeechPlayback
- (id)newCallAnnouncement {
  TestCallAnnouncement *announcement = [TestCallAnnouncement new];
  [self.callAnnouncements addObject:announcement];
  return announcement;
}
- (void)backendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(@"{}"); }
- (void)watchShake {}
- (void)playAlertRingtone:(NSString *)token {
  [self.ringtones addObject:token]; if (self.onRingtone) self.onRingtone(token);
  if (!self.holdRingtone) [self finishAlert:token reason:@"completed"];
}
- (NSString *)alertCommand:(NSString *)action token:(NSString *)token lease:(uint64_t)lease {
  return fixturePlayer == self ? [super alertCommand:action token:token lease:lease] : @"null";
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview {
  self.utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  [self armSpeechTimeout:30 initialization:NO];
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
  [super setUp]; captionCommands = [NSMutableArray new]; activeLease = 0; activeOwner = nil;
  waiting = [NSMutableArray new]; valid = [NSMutableSet new];
  turnSequence = 0; turnOwner = 0; turnWaiting = [NSMutableArray new];
  automaticWaiting = [NSMutableArray new]; automaticCompleted = [NSMutableArray new];
  automaticEndings = [NSMutableArray new];
  automaticActive = 0; automaticEnabled = NO; automaticPaused = NO;
  voiceCallActive = NO;
  voiceCallTurn = nil; voiceCallToken = nil;
  self.player = [TestSpeechPlayback new]; fixturePlayer = self.player; self.player.spoken = [NSMutableArray new]; self.stopped = [NSMutableArray new];
  self.player.ringtones = [NSMutableArray new];
  self.player.callAnnouncements = [NSMutableArray new];
  self.observer = [NSNotificationCenter.defaultCenter addObserverForName:WhipChatSpeechStopped object:self.player queue:nil usingBlock:^(NSNotification *event) {
    [self.stopped addObject:event.userInfo[@"token"]];
  }];
}
- (void)tearDown { [self.player cancelCallAnnouncement]; [self.player stop]; fixturePlayer = nil; [NSNotificationCenter.defaultCenter removeObserver:self.observer]; [super tearDown]; }
- (RCTPromiseRejectBlock)unexpectedError {
  return ^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@ %@", code, message); };
}
- (void)queue:(NSString *)token {
  [waiting addObject:token]; [valid addObject:token];
  [self.player prepareAlertNotification:token effect:token];
}
- (void)finish { [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:self.player.utterance]; }

- (void)queueAutomatic:(uint64_t)identity text:(NSString *)text {
  [automaticWaiting addObject:@{@"id": @(identity), @"token": @"automatic-chat-speech", @"text": text,
    @"hostId": @"host", @"paneId": @"pane", @"label": @"Native automatic test"}];
}

- (void)testLocalRepliesAndFillersPlayWithinTheCallAndRetainItsAudioUntilHangup {
  voiceCallActive = YES; voiceCallToken = @"voice-chat:1"; voiceCallTurn = [NSObject new];
  [self.player startPlayback:voiceCallTurn];
  __block NSUInteger ready = 0, completed = 0;
  [self queue:@"status-after-call"];
  [self.player announceStatus:@"status-after-call" resolve:^(id value) {} reject:self.unexpectedError];
  for (NSString *owner in @[@"voice-chat:1:filler:1", @"voice-chat:1:speech:2", @"voice-chat:1:speech:3"]) {
    XCTestExpectation *chunk = [self expectationWithDescription:owner];
    [self.player startLocalChat:owner label:@"Codex" callToken:voiceCallToken resolve:^(id value) { ready++; } reject:self.unexpectedError];
    XCTAssertEqual(ready, self.player.spoken.count + 1);
    [self.player speakChat:owner text:owner resolve:^(id value) { completed++; [chunk fulfill]; } reject:self.unexpectedError];
    XCTAssertEqualObjects(self.player.spoken.lastObject, owner);
    [self finish];
    [self waitForExpectations:@[chunk] timeout:2];
    [self.player stopOwner:owner kind:WhipSpeechChat];
    XCTAssertNotEqual(turnOwner, 0u);
  }
  XCTAssertEqual(ready, 3u); XCTAssertEqual(completed, 3u);
  [self.player finishAlert:@"status-after-call" reason:@"dismissed"];
  XCTestExpectation *drained = [self expectationWithDescription:@"other audio waits until hangup"];
  [self.player announce:@"other" text:@"After hangup" language:@"en-US" resolve:^(id value) { [drained fulfill]; } reject:self.unexpectedError];
  XCTAssertEqual(self.player.spoken.count, 3u);
  id callTurn = voiceCallTurn;
  voiceCallActive = NO; voiceCallTurn = nil; voiceCallToken = nil;
  [self.player finishPlayback:callTurn];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqualObjects(self.player.spoken.lastObject, @"After hangup");
    [self finish];
  });
  [self waitForExpectations:@[drained] timeout:2];
}

- (void)testLocalSpeechFromAnEndedCallCannotJoinItsReplacement {
  voiceCallActive = YES; voiceCallToken = @"voice-chat:2"; voiceCallTurn = [NSObject new];
  [self.player startPlayback:voiceCallTurn];
  __block BOOL rejected = NO;
  [self.player startLocalChat:@"voice-chat:1:speech:3" label:@"Codex" callToken:@"voice-chat:1"
    resolve:^(id value) { XCTFail(@"Ended call started speech"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected); XCTAssertEqual(self.player.spoken.count, 0u); XCTAssertNotEqual(turnOwner, 0u);
  [self.player finishPlayback:voiceCallTurn]; voiceCallTurn = nil;
}

- (void)testCallAnnouncementsUseTheCurrentConfiguredVoiceOnEveryRequestAndRetainCallOwnership {
  uint64_t lease = whip_speech_claim(WhipSpeechChat, "openai-realtime", "");
  __block NSUInteger completions = 0;
  self.player.systemVoice = @"selected-voice-a";
  [self.player speakCallAnnouncement:lease text:@"Muted" completed:^{ completions++; }];
  TestCallAnnouncement *first = self.player.callAnnouncements.lastObject;
  XCTAssertEqual(first.lease, lease);
  XCTAssertEqualObjects(first.text, @"Muted");
  XCTAssertEqualObjects(first.voice, @"selected-voice-a");
  first.completed();
  XCTAssertEqual(completions, 1u);
  XCTAssertEqual(activeLease, lease);
  self.player.systemVoice = @"selected-voice-b";
  [self.player speakCallAnnouncement:lease text:@"Muted" completed:^{ completions++; }];
  XCTAssertTrue(first.cancelled);
  XCTAssertEqual(self.player.callAnnouncements.count, 2u);
  TestCallAnnouncement *second = self.player.callAnnouncements.lastObject;
  XCTAssertEqualObjects(second.text, @"Muted");
  XCTAssertEqualObjects(second.voice, @"selected-voice-b");
  XCTAssertEqual(second.lease, lease);
  [self.player cancelCallAnnouncement];
  XCTAssertTrue(second.cancelled);
  XCTAssertNil(second.completed);
  XCTAssertEqual(completions, 1u);
  XCTAssertEqual(activeLease, lease);
}

- (void)testLongAnnouncementContinuesBeyondBudgetWhenNothingElseIsWaiting {
  XCTestExpectation *completed = [self expectationWithDescription:@"long reading finishes naturally"];
  [self.player announce:@"gettysburg" text:@"A long reading" language:@"en-US" resolve:^(id value) {
    XCTAssertEqualObjects(value, @"completed"); [completed fulfill];
  } reject:self.unexpectedError];
  AVSpeechUtterance *utterance = self.player.utterance;
  for (NSUInteger check = 0; check < 3; check++) {
    [self.player.timer fire];
    XCTAssertEqual(self.player.utterance, utterance);
    XCTAssertTrue(self.player.timer.valid);
  }
  [self finish]; [self waitForExpectations:@[completed] timeout:2];
  XCTAssertNil(self.player.timer);
}

- (void)testLongDeviceSpeechYieldsWhenSpeechArrivesAfterItsBudget {
  XCTestExpectation *ack = [self expectationWithDescription:@"device speech acknowledged"];
  [self.player speakDevice:@"phone-use" request:@"reading" text:@"A long reading" language:@"en-US" rate:1 resolve:^(id value) {
    [ack fulfill];
  } reject:self.unexpectedError];
  [self waitForExpectations:@[ack] timeout:2];
  [self.player.timer fire];
  XCTAssertEqualObjects(self.player.utterance.speechString, @"A long reading");
  XCTestExpectation *next = [self expectationWithDescription:@"waiting speech starts after expired reading"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"Next speech"]) [next fulfill]; };
  XCTestExpectation *completed = [self expectationWithDescription:@"next speech completes"];
  [self.player announce:@"next" text:@"Next speech" language:@"en-US" resolve:^(id value) {
    XCTAssertEqualObjects(value, @"completed"); [completed fulfill];
  } reject:self.unexpectedError];
  XCTAssertEqual(self.player.spoken.count, 1u);
  [self.player.timer fire];
  [self waitForExpectations:@[next] timeout:2];
  [self finish]; [self waitForExpectations:@[completed] timeout:2];
}

- (void)testCancelledWaitingSpeechDoesNotCutOffAnExpiredReading {
  XCTestExpectation *completed = [self expectationWithDescription:@"active reading finishes naturally"];
  [self.player announce:@"reading" text:@"A long reading" language:@"en-US" resolve:^(id value) {
    XCTAssertEqualObjects(value, @"completed"); [completed fulfill];
  } reject:self.unexpectedError];
  XCTestExpectation *cancelled = [self expectationWithDescription:@"waiting speech cancelled"];
  [self.player speakDevice:@"waiting" request:@"cancel-me" text:@"Cancelled speech" language:@"en-US" rate:1 resolve:^(id value) {
    XCTFail(@"Cancelled speech must never start");
  } reject:^(NSString *code, NSString *message, NSError *error) { [cancelled fulfill]; }];
  [self.player cancelDeviceRequest:@"cancel-me"];
  [self waitForExpectations:@[cancelled] timeout:2];
  [self.player.timer fire];
  XCTAssertEqualObjects(self.player.utterance.speechString, @"A long reading");
  [self finish]; [self waitForExpectations:@[completed] timeout:2];
}

- (void)testEngineInitializationStillTimesOutWithAnEmptyQueue {
  XCTestExpectation *failed = [self expectationWithDescription:@"stalled engine rejected"];
  [self.player announce:@"stalled" text:@"Not started" language:@"en-US" resolve:^(id value) {
    XCTFail(@"Initialization must fail");
  } reject:^(NSString *code, NSString *message, NSError *error) {
    XCTAssertTrue([message containsString:@"timed out"]); [failed fulfill];
  }];
  [self.player armSpeechTimeout:60 initialization:YES];
  [self.player.timer fire];
  [self waitForExpectations:@[failed] timeout:2];
  XCTAssertNil(self.player.utterance);
}

- (void)testExpiredAlertSpeechStillPlaysItsRingtoneBeforeWaitingSpeech {
  self.player.holdRingtone = YES;
  [self queue:@"alert"];
  XCTestExpectation *expired = [self expectationWithDescription:@"contended alert speech reaches its budget"];
  [self.player announceStatus:@"alert" resolve:^(id value) { XCTFail(@"Speech should reach its budget"); }
    reject:^(NSString *code, NSString *message, NSError *error) { [expired fulfill]; }];
  XCTestExpectation *started = [self expectationWithDescription:@"other speech starts after the whole alert"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"Other speech"]) [started fulfill]; };
  XCTestExpectation *completed = [self expectationWithDescription:@"other speech completes"];
  [self.player announce:@"other" text:@"Other speech" language:@"en-US" resolve:^(id value) {
    [completed fulfill];
  } reject:self.unexpectedError];
  [self.player.timer fire];
  [self waitForExpectations:@[expired] timeout:2];
  XCTAssertEqualObjects(self.player.ringtones, (@[@"alert"]));
  XCTAssertEqualObjects(self.player.spoken, (@[@"alert"]));
  [self.player finishAlert:@"alert" reason:@"completed"];
  [self waitForExpectations:@[started] timeout:2];
  [self finish]; [self waitForExpectations:@[completed] timeout:2];
}

- (void)testAutomaticReaderDoesNotTakeSpeechDuringGlobalOrAgentCalls {
  for (NSString *scope in @[@"global", @"agent-bound"]) {
    voiceCallActive = YES;
    [self queueAutomatic:1 text:scope];
    [self.player automaticControl:@"enable" value:YES];
    XCTAssertEqual(automaticActive, 0u);
    XCTAssertEqual(self.player.spoken.count, 0u);
    // Rust's call baseline owns discarding call-time updates. Native never
    // consumes that queue to provide voice-model context.
    [automaticWaiting removeAllObjects];
  }
  voiceCallActive = NO;
  [self.player automaticControl:@"pause" value:NO];
  XCTAssertEqual(self.player.spoken.count, 0u);
  [self queueAutomatic:2 text:@"Fresh update after hangup"];
  [self.player automaticControl:@"pause" value:NO];
  XCTAssertEqualObjects(self.player.spoken, (@[@"Fresh update after hangup"]));
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

- (void)testInternalCancellationBeforePauseDoesNotReportUserStopOrAcceptLateAudio {
  [self queueAutomatic:1 text:@"interrupted update"];
  [self.player automaticControl:@"enable" value:YES];
  AVSpeechUtterance *old = self.player.utterance;
  XCTAssertFalse([self.player stopOwner:@"unrelated-owner" kind:WhipSpeechChat]);
  XCTAssertEqual(automaticActive, 1u);
  [self.player cancel];
  XCTAssertEqual(activeLease, 0u);
  XCTAssertEqualObjects(automaticEndings.lastObject[@"reason"], @"replaced");
  XCTAssertEqualObjects(automaticEndings.lastObject[@"failed"], @NO);
  [self.player automaticControl:@"pause" value:YES];
  [self.player automaticControl:@"pause" value:NO];
  [self queueAutomatic:2 text:@"fresh update"];
  [self.player drainAutomatic];
  [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:old];
  XCTestExpectation *fenced = [self expectationWithDescription:@"old callback cannot finish fresh audio"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqual(automaticActive, 2u);
    XCTAssertEqual(automaticCompleted.count, 0u);
    XCTAssertEqualObjects(self.player.spoken, (@[@"interrupted update", @"fresh update"]));
    // The native user Stop still publishes the distinct, intentional reason.
    [self.player stop];
    XCTAssertEqualObjects(automaticEndings.lastObject[@"reason"], @"stopped");
    [fenced fulfill];
  });
  [self waitForExpectations:@[fenced] timeout:2];
}

- (void)testInternalCancellationOfAutomaticSpeechWaitingForAudioAdmission {
  NSObject *otherAudio = [NSObject new];
  [self.player startPlayback:otherAudio];
  [self queueAutomatic:1 text:@"waiting automatic update"];
  [self.player automaticControl:@"enable" value:YES];
  XCTAssertEqual(automaticActive, 1u);
  XCTAssertEqual(self.player.spoken.count, 0u);
  [self.player cancel];
  XCTAssertEqualObjects(automaticEndings.lastObject[@"reason"], @"replaced");
  [self.player finishPlayback:otherAudio];
  XCTestExpectation *drained = [self expectationWithDescription:@"cancelled admission cannot play later"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqual(self.player.spoken.count, 0u);
    [self queueAutomatic:2 text:@"fresh update"];
    [self.player drainAutomatic];
    XCTAssertEqualObjects(self.player.spoken, (@[@"fresh update"]));
    [drained fulfill];
  });
  [self waitForExpectations:@[drained] timeout:2];
}

- (void)testAutomaticEngineInterruptionReleasesAudioAndAllowsFreshReplies {
  [self queueAutomatic:1 text:@"interrupted update"];
  [self.player automaticControl:@"enable" value:YES];
  AVSpeechUtterance *old = self.player.utterance;
  [self.player speechSynthesizer:[AVSpeechSynthesizer new] didCancelSpeechUtterance:old];
  XCTestExpectation *recovered = [self expectationWithDescription:@"fresh audio after native interruption"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqual(activeLease, 0u);
    XCTAssertEqualObjects(automaticEndings.lastObject[@"reason"], @"interrupted");
    [self queueAutomatic:2 text:@"fresh update"];
    [self.player drainAutomatic];
    XCTAssertEqual(automaticActive, 2u);
    XCTAssertEqualObjects(self.player.spoken, (@[@"interrupted update", @"fresh update"]));
    [recovered fulfill];
  });
  [self waitForExpectations:@[recovered] timeout:2];
}

- (void)testSystemRangesForwardBothEndsToRustAndRetainCaptionAcrossChunkCompletion {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  NSString *prefix = @"Long, paused 👋 debug tab: ";
  [self.player speakChat:@"reader" text:[prefix stringByAppendingString:@"One two three."] resolve:^(id value) {} reject:self.unexpectedError];
  AVSpeechUtterance *utterance = self.player.utterance;
  self.player.captionClock = 42;
  [captionCommands removeAllObjects];
  AVSpeechSynthesizer *engine = [AVSpeechSynthesizer new];
  // Rust receives original utterance coordinates, including the prefix. Native
  // code must not independently estimate or rewrite the cumulative boundary.
  [self.player speechSynthesizer:engine willSpeakRangeOfSpeechString:NSMakeRange(prefix.length + 4, 3) utterance:utterance];
  XCTestExpectation *range = [self expectationWithDescription:@"both UTF-16 range ends reach Rust"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqualObjects(captionCommands.lastObject, (@{@"action":@"range", @"id":@42,
      @"start":@(prefix.length + 4), @"end":@(prefix.length + 7)}));
    [range fulfill];
  });
  [self waitForExpectations:@[range] timeout:2];
  [self.player speechSynthesizer:engine didFinishSpeechUtterance:utterance];
  XCTestExpectation *buffer = [self expectationWithDescription:@"drained chunk enters buffering rather than clearing"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqualObjects(captionCommands.lastObject[@"action"], @"buffer");
    XCTAssertEqualObjects(captionCommands.lastObject[@"id"], @42);
    [buffer fulfill];
  });
  [self waitForExpectations:@[buffer] timeout:2];
  [self.player stop];
  XCTAssertEqualObjects(captionCommands.lastObject[@"action"], @"clear");
  XCTAssertEqualObjects(captionCommands.lastObject[@"reason"], @"stopped");
  NSUInteger count = captionCommands.count;
  [self.player speechSynthesizer:engine willSpeakRangeOfSpeechString:NSMakeRange(prefix.length + 8, 5) utterance:utterance];
  XCTestExpectation *stopped = [self expectationWithDescription:@"late word cannot restore stopped caption"];
  dispatch_async(dispatch_get_main_queue(), ^{ XCTAssertEqual(captionCommands.count, count); [stopped fulfill]; });
  [self waitForExpectations:@[stopped] timeout:2];
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

- (void)testSpeechWaitsForEarlierSpeechWithoutReplacingIt {
  XCTestExpectation *first = [self expectationWithDescription:@"first speech completes"];
  XCTestExpectation *second = [self expectationWithDescription:@"second speech completes"];
  XCTestExpectation *secondStarted = [self expectationWithDescription:@"second waits for first"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"second"]) [secondStarted fulfill]; };
  [self.player announce:@"first" text:@"first" language:@"en-US" resolve:^(id reason) {
    XCTAssertEqualObjects(reason, @"completed"); [first fulfill];
  } reject:self.unexpectedError];
  [self.player announce:@"second" text:@"second" language:@"en-US" resolve:^(id reason) {
    XCTAssertEqualObjects(reason, @"completed"); [second fulfill];
  } reject:self.unexpectedError];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first"]));
  [self finish]; [self waitForExpectations:@[first, secondStarted] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first", @"second"]));
  [self finish]; [self waitForExpectations:@[second] timeout:2];
}

- (void)testAlertRingtoneContainsPlayableAudio {
  NSError *error = nil;
  AVAudioPlayer *ringtone = [[AVAudioPlayer alloc] initWithData:[WhipSpeechPlayback alertRingtoneData] error:&error];
  XCTAssertNotNil(ringtone);
  XCTAssertNil(error);
  XCTAssertGreaterThan(ringtone.duration, 0);
}

- (void)testSelectedResponseKeepsItsChunksTogetherBeforeOtherSpeech {
  [self.player startResponse:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  XCTestExpectation *first = [self expectationWithDescription:@"first response chunk completes"];
  XCTestExpectation *second = [self expectationWithDescription:@"second response chunk completes"];
  XCTestExpectation *otherStarted = [self expectationWithDescription:@"other speech waits for entire response"];
  XCTestExpectation *otherDone = [self expectationWithDescription:@"other speech completes"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"other"]) [otherStarted fulfill]; };
  [self.player speakChat:@"reader" text:@"first" resolve:^(id value) { [first fulfill]; } reject:self.unexpectedError];
  [self.player announce:@"other" text:@"other" language:@"en-US" resolve:^(id value) { [otherDone fulfill]; } reject:self.unexpectedError];
  [self finish]; [self waitForExpectations:@[first] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first"]));
  [self.player speakChat:@"reader" text:@"second" resolve:^(id value) { [second fulfill]; } reject:self.unexpectedError];
  [self finish]; [self waitForExpectations:@[second] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first", @"second"]));
  [self.player stopOwner:@"reader" kind:WhipSpeechChat];
  [self waitForExpectations:@[otherStarted] timeout:2];
  [self finish]; [self waitForExpectations:@[otherDone] timeout:2];
}

- (void)testAlertOwnsSpeechThenRingtoneAndShakePreservesOtherQueuedUnits {
  self.player.holdRingtone = YES;
  [self queue:@"first"]; [self queue:@"second"];
  XCTestExpectation *firstRing = [self expectationWithDescription:@"first speech hands off to its own ringtone"];
  XCTestExpectation *secondStarted = [self expectationWithDescription:@"second alert starts after whole first alert"];
  XCTestExpectation *ordinaryStarted = [self expectationWithDescription:@"ordinary speech waits for both alert stages"];
  XCTestExpectation *ordinaryDone = [self expectationWithDescription:@"ordinary speech completes"];
  self.player.onRingtone = ^(NSString *token) { if ([token isEqualToString:@"first"]) [firstRing fulfill]; };
  self.player.onPlay = ^(NSString *text) {
    if ([text isEqualToString:@"second"]) [secondStarted fulfill];
    if ([text isEqualToString:@"ordinary"]) [ordinaryStarted fulfill];
  };
  [self.player announceStatus:@"first" resolve:^(id value) {} reject:self.unexpectedError];
  [self.player announceStatus:@"second" resolve:^(id value) {} reject:self.unexpectedError];
  [self.player announce:@"ordinary" text:@"ordinary" language:@"en-US" resolve:^(id value) { [ordinaryDone fulfill]; } reject:self.unexpectedError];
  [self finish]; [self waitForExpectations:@[firstRing] timeout:2];
  XCTAssertEqualObjects(self.player.spoken, (@[@"first"]));
  XCTAssertEqualObjects(self.player.ringtones, (@[@"first"]));
  [self.player shake];
  XCTAssertTrue([valid containsObject:@"second"]);
  [self waitForExpectations:@[secondStarted] timeout:2];
  self.player.holdRingtone = NO;
  [self finish]; [self waitForExpectations:@[ordinaryStarted] timeout:2];
  XCTAssertEqualObjects(self.player.ringtones, (@[@"first", @"second"]));
  XCTAssertEqualObjects(self.player.spoken, (@[@"first", @"second", @"ordinary"]));
  [self finish]; [self waitForExpectations:@[ordinaryDone] timeout:2];
}

- (void)testShakeDuringAlertSpeechRemovesItsPendingRingtoneOnly {
  [self queue:@"first"]; [self queue:@"second"];
  XCTestExpectation *dismissed = [self expectationWithDescription:@"whole first alert dismissed"];
  XCTestExpectation *secondStarted = [self expectationWithDescription:@"other alert preserved"];
  XCTestExpectation *secondDone = [self expectationWithDescription:@"other alert completes"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"second"]) [secondStarted fulfill]; };
  [self.player announceStatus:@"first" resolve:^(id reason) { XCTAssertEqualObjects(reason, @"shake"); [dismissed fulfill]; } reject:self.unexpectedError];
  AVSpeechUtterance *old = self.player.utterance;
  [self.player announceStatus:@"second" resolve:^(id reason) { [secondDone fulfill]; } reject:self.unexpectedError];
  [self.player shake];
  [self waitForExpectations:@[dismissed, secondStarted] timeout:2];
  [self.player speechSynthesizer:[AVSpeechSynthesizer new] didFinishSpeechUtterance:old];
  [self finish]; [self waitForExpectations:@[secondDone] timeout:2];
  XCTAssertEqualObjects(self.player.ringtones, (@[@"second"]));
}

- (void)testCancellingQueuedSpeechDoesNotInterruptCurrentSpeechOrReplayLater {
  [self.player announce:@"current" text:@"current" language:@"en-US" resolve:^(id reason) {} reject:self.unexpectedError];
  uint64_t current = activeLease;
  XCTestExpectation *cancelled = [self expectationWithDescription:@"queued speech cancelled"];
  [self.player announce:@"queued" text:@"queued" language:@"en-US" resolve:^(id reason) {
    XCTAssertEqualObjects(reason, @"stopped"); [cancelled fulfill];
  } reject:self.unexpectedError];
  XCTAssertTrue([self.player stopOwner:@"queued" kind:WhipSpeechAnnouncement]);
  XCTAssertTrue(whip_speech_is_current(current));
  [self finish];
  XCTestExpectation *drained = [self expectationWithDescription:@"no cancelled audio returns"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertEqualObjects(self.player.spoken, (@[@"current"])); [drained fulfill];
  });
  [self waitForExpectations:@[cancelled, drained] timeout:2];
}

- (void)testIdleReaderYieldsAndResumesAfterAnotherPlaybackUnit {
  [self.player startChat:@"reader" label:@"Chat" resolve:^(id value) {} reject:self.unexpectedError];
  uint64_t old = activeLease;
  NSObject *preview = [NSObject new];
  [self.player startPlayback:preview];
  [self.player yieldIdlePlayback];
  XCTestExpectation *started = [self expectationWithDescription:@"reader resumes after preview"];
  XCTestExpectation *completed = [self expectationWithDescription:@"deferred reader audio completes"];
  self.player.onPlay = ^(NSString *text) { if ([text isEqualToString:@"after preview"]) [started fulfill]; };
  [self.player speakChat:@"reader" text:@"after preview" resolve:^(id value) { [completed fulfill]; } reject:self.unexpectedError];
  XCTAssertEqual(self.player.spoken.count, 0u);
  [self.player finishPlayback:preview]; [self waitForExpectations:@[started] timeout:2];
  XCTAssertFalse(whip_speech_complete(old));
  XCTAssertEqual(self.stopped.count, 0u);
  [self finish]; [self waitForExpectations:@[completed] timeout:2];
}

@end
