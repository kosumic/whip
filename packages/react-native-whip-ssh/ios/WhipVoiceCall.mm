#import "WhipVoiceCall.h"
#import "WhipRealtimeVoice.h"
#import <AVFoundation/AVFoundation.h>
#import <CallKit/CallKit.h>

NSString *const WhipVoiceCallEvent = @"WhipVoiceCall";
static NSString *const WhipCallError = @"E_VOICE_CALL";

@interface WhipVoiceCall () <CXProviderDelegate, AVAudioPlayerDelegate>
@property(nonatomic, strong) CXProvider *provider;
@property(nonatomic, strong) CXCallController *controller;
@property(nonatomic, strong) NSUUID *uuid;
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *label;
@property(nonatomic, readwrite) BOOL active;
@property(nonatomic, readwrite) BOOL muted;
@property(nonatomic, copy) RCTPromiseResolveBlock ready;
@property(nonatomic, copy) RCTPromiseRejectBlock failed;
@property(nonatomic, strong) NSTimer *timeout;
@property(nonatomic, strong) NSMutableArray *endings;
@property(nonatomic) BOOL ending;
@property(nonatomic) BOOL audioActive;
@property(nonatomic) BOOL soundOwnsSession;
@property(nonatomic, strong) AVAudioPlayer *soundPlayer;
@property(nonatomic, copy) NSString *pendingSoundURI;
@property(nonatomic, copy) RCTPromiseResolveBlock soundDone;
@property(nonatomic, copy) RCTPromiseRejectBlock soundFailed;
@property(nonatomic, strong) NSTimer *soundTimeout;
@end

@implementation WhipVoiceCall
- (BOOL)owns:(NSString *)token { return self.active && [self.token isEqualToString:token]; }
+ (instancetype)shared
{
  static WhipVoiceCall *call;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ call = [WhipVoiceCall new]; });
  return call;
}
- (instancetype)init
{
  if ((self = [super init])) {
    CXProviderConfiguration *configuration = [CXProviderConfiguration new];
    configuration.supportsVideo = NO;
    configuration.maximumCallGroups = 1;
    configuration.maximumCallsPerCallGroup = 1;
    configuration.supportedHandleTypes = [NSSet setWithObject:@(CXHandleTypeGeneric)];
    configuration.includesCallsInRecents = NO;
    _provider = [[CXProvider alloc] initWithConfiguration:configuration];
    [_provider setDelegate:self queue:dispatch_get_main_queue()];
    _controller = [CXCallController new];
    _endings = [NSMutableArray new];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (self.token) { reject(WhipCallError, @"A voice call is already active.", nil); return; }
  [self stopSound];
  self.token = token; self.label = label; self.uuid = NSUUID.UUID;
  self.ready = resolve; self.failed = reject;
  CXStartCallAction *action = [[CXStartCallAction alloc] initWithCallUUID:self.uuid handle:[[CXHandle alloc] initWithType:CXHandleTypeGeneric value:label]];
  action.video = NO;
  __weak WhipVoiceCall *weakSelf = self;
  self.timeout = [NSTimer scheduledTimerWithTimeInterval:15 repeats:NO block:^(NSTimer *timer) {
    if ([weakSelf.token isEqualToString:token]) [weakSelf fail:@"The system voice call did not activate."];
  }];
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{ if (error && [weakSelf.token isEqualToString:token]) [weakSelf fail:error.localizedDescription]; });
  }];
}
- (void)provider:(CXProvider *)provider performStartCallAction:(CXStartCallAction *)action
{
  if (![action.callUUID isEqual:self.uuid]) { [action fail]; return; }
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat
       options:AVAudioSessionCategoryOptionAllowBluetooth error:&error]) {
    [action fail]; [self fail:error.localizedDescription]; return;
  }
  CXCallUpdate *update = [CXCallUpdate new];
  update.remoteHandle = action.handle; update.localizedCallerName = self.label;
  update.hasVideo = NO; update.supportsHolding = NO; update.supportsGrouping = NO;
  update.supportsUngrouping = NO; update.supportsDTMF = NO;
  [provider reportCallWithUUID:self.uuid updated:update];
  [provider reportOutgoingCallWithUUID:self.uuid startedConnectingAtDate:NSDate.date];
  // CallKit activates the audio session; speech I/O starts only in didActivate.
  [action fulfill];
}
- (void)provider:(CXProvider *)provider didActivateAudioSession:(AVAudioSession *)audioSession
{
  self.audioActive = YES;
  if (!self.token) return;
  self.active = YES;
  // Start hands-free unless the user already has a headset connected. Leaving
  // defaultToSpeaker unset allows the speaker control to return to the receiver.
  BOOL external = NO;
  for (AVAudioSessionPortDescription *port in audioSession.currentRoute.outputs) {
    external |= ![port.portType isEqualToString:AVAudioSessionPortBuiltInReceiver] &&
      ![port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker];
  }
  if (!external) [audioSession overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
  [self.timeout invalidate]; self.timeout = nil;
  [provider reportOutgoingCallWithUUID:self.uuid connectedAtDate:NSDate.date];
  RCTPromiseResolveBlock ready = self.ready;
  self.ready = nil; self.failed = nil;
  if (ready) ready(nil);
  [self routeChanged:nil];
}
- (void)provider:(CXProvider *)provider didDeactivateAudioSession:(AVAudioSession *)audioSession
{
  self.audioActive = NO;
  self.active = NO;
  if (self.token) [self fail:@"The system interrupted voice chat for another call."];
  if (self.pendingSoundURI) [self startSound:self.pendingSoundURI inCall:NO];
}

- (void)playSound:(NSString *)uri inCall:(BOOL)inCall resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self stopSound];
  if (inCall != self.active || (!inCall && self.token)) { resolve(nil); return; }
  if (![NSURL URLWithString:uri].isFileURL) { reject(WhipCallError, @"Voice call sounds must be bundled local files.", nil); return; }
  self.soundDone = resolve; self.soundFailed = reject;
  __weak WhipVoiceCall *weakSelf = self;
  self.soundTimeout = [NSTimer scheduledTimerWithTimeInterval:5 repeats:NO block:^(NSTimer *timer) {
    [weakSelf finishSound:[NSError errorWithDomain:WhipCallError code:1 userInfo:@{NSLocalizedDescriptionKey: @"Voice call sound timed out."}]];
  }];
  // clear: resolves hang-up before CallKit deactivates audio. Wait for that
  // callback so it cannot cut off the closing piano cue halfway through.
  if (!inCall && self.audioActive) self.pendingSoundURI = uri;
  else [self startSound:uri inCall:inCall];
}
- (void)startSound:(NSString *)uri inCall:(BOOL)inCall
{
  NSURL *url = [NSURL URLWithString:uri];
  self.pendingSoundURI = nil;
  NSError *error = nil;
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  if (!inCall) {
    if (![audio setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault
        options:AVAudioSessionCategoryOptionMixWithOthers error:&error] || ![audio setActive:YES error:&error]) {
      [self finishSound:error]; return;
    }
    self.soundOwnsSession = YES;
  }
  self.soundPlayer = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&error];
  self.soundPlayer.delegate = self;
  self.soundPlayer.volume = 0.5;
  if (!self.soundPlayer || ![self.soundPlayer play]) {
    [self finishSound:error ?: [NSError errorWithDomain:WhipCallError code:2 userInfo:@{NSLocalizedDescriptionKey: @"Voice call sound could not play."}]];
  }
}
- (void)finishSound:(NSError *)error
{
  RCTPromiseResolveBlock done = self.soundDone;
  RCTPromiseRejectBlock failed = self.soundFailed;
  self.soundDone = nil; self.soundFailed = nil;
  [self.soundTimeout invalidate]; self.soundTimeout = nil;
  [self.soundPlayer stop]; self.soundPlayer = nil; self.pendingSoundURI = nil;
  if (self.soundOwnsSession && !self.audioActive && !self.token) {
    [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
  }
  self.soundOwnsSession = NO;
  if (error && failed) failed(WhipCallError, error.localizedDescription, error);
  else if (done) done(nil);
}
- (void)stopSound { [self finishSound:nil]; }
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag
{ if (player == self.soundPlayer) [self finishSound:nil]; }
- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error
{ if (player == self.soundPlayer) [self finishSound:error]; }
- (void)end:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token]) { resolve(nil); return; }
  [self.endings addObject:[resolve copy]];
  if (self.ending) return;
  self.ending = YES;
  NSUUID *uuid = self.uuid;
  CXEndCallAction *action = [[CXEndCallAction alloc] initWithCallUUID:uuid];
  __weak WhipVoiceCall *weakSelf = self;
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error && [weakSelf.token isEqualToString:token]) {
        [weakSelf.provider reportCallWithUUID:uuid endedAtDate:NSDate.date reason:CXCallEndedReasonFailed];
        [weakSelf clear:nil];
      }
    });
  }];
}
- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action
{
  if ([action.callUUID isEqual:self.uuid]) [self clear:nil];
  [action fulfill];
}
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token]) { reject(WhipCallError, @"The voice call has ended.", nil); return; }
  CXSetMutedCallAction *action = [[CXSetMutedCallAction alloc] initWithCallUUID:self.uuid muted:muted];
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    if (error) reject(WhipCallError, error.localizedDescription, error); else resolve(nil);
  }];
}
- (void)provider:(CXProvider *)provider performSetMutedCallAction:(CXSetMutedCallAction *)action
{
  if (![action.callUUID isEqual:self.uuid]) { [action fail]; return; }
  self.muted = action.muted;
  [WhipRealtimeVoice.shared mute:self.token muted:action.muted];
  [self emit:@{@"type": @"muted", @"muted": @(action.muted)}];
  [action fulfill];
}
- (void)speaker:(NSString *)token enabled:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token] || !self.active) { reject(WhipCallError, @"The voice call is not active.", nil); return; }
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance overrideOutputAudioPort:speaker ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone error:&error]) {
    reject(WhipCallError, error.localizedDescription, error); return;
  }
  [self routeChanged:nil]; resolve(nil);
}
- (void)routeChanged:(NSNotification *)notification
{
  BOOL speaker = NO;
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    speaker |= [port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker];
  }
  [self emit:@{@"type": @"route", @"speaker": @(speaker)}];
}
- (void)emit:(NSDictionary *)event
{
  NSString *token = self.token;
  if (!token) return;
  NSMutableDictionary *body = [event mutableCopy]; body[@"token"] = token;
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSNotificationCenter.defaultCenter postNotificationName:WhipVoiceCallEvent object:self userInfo:body];
  });
}
- (void)clear:(NSString *)error
{
  [WhipRealtimeVoice.shared stop:self.token];
  self.muted = NO;
  [self emit:error ? @{@"type": @"ended", @"error": error} : @{@"type": @"ended"}];
  RCTPromiseRejectBlock failed = self.failed;
  self.ready = nil; self.failed = nil;
  [self.timeout invalidate]; self.timeout = nil;
  self.active = NO; self.token = nil; self.uuid = nil; self.label = nil;
  self.ending = NO;
  NSArray *endings = [self.endings copy];
  [self.endings removeAllObjects];
  if (failed) failed(WhipCallError, error ?: @"Voice call ended before activation.", nil);
  for (RCTPromiseResolveBlock ended in endings) ended(nil);
}
- (void)fail:(NSString *)error
{
  if (self.uuid) [self.provider reportCallWithUUID:self.uuid endedAtDate:NSDate.date reason:CXCallEndedReasonFailed];
  [self clear:error ?: @"The system voice call failed."];
}
- (void)providerDidReset:(CXProvider *)provider { [self fail:@"The system reset voice chat."]; }
- (void)provider:(CXProvider *)provider timedOutPerformingAction:(CXAction *)action { [self fail:@"The system voice call timed out."]; }
- (void)invalidate { [self stopSound]; if (self.token) [self fail:@"Voice chat ended."]; }
@end
