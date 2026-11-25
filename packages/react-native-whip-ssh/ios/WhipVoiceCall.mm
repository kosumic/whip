#import "WhipVoiceCall.h"
#import "WhipRealtimeVoice.h"
#import "../cpp/WhipSpeechPolicy.h"
#import "../../../ios/HerdR/WhipSpeechPlayback.h"
#import <AVFoundation/AVFoundation.h>

NSString *const WhipVoiceCallEvent = @"WhipVoiceCall";
static NSString *const WhipCallError = @"E_VOICE_CALL";

@interface WhipVoiceCall () <AVAudioPlayerDelegate>
@property(nonatomic, copy) NSString *token;
@property(nonatomic, readwrite) BOOL active;
@property(nonatomic, readwrite) BOOL muted;
@property(nonatomic, copy) RCTPromiseResolveBlock ready;
@property(nonatomic, copy) RCTPromiseRejectBlock failed;
@property(nonatomic, strong) NSTimer *authority;
@property(nonatomic) BOOL soundOwnsSession;
@property(nonatomic, strong) AVAudioPlayer *soundPlayer;
@property(nonatomic, copy) RCTPromiseResolveBlock soundDone;
@property(nonatomic, copy) RCTPromiseRejectBlock soundFailed;
@property(nonatomic, strong) NSTimer *soundTimeout;
@property(nonatomic, strong) id playbackTurn;
@end

@implementation WhipVoiceCall
- (BOOL)owns:(NSString *)token { return self.playbackTurn && [self.token isEqualToString:token]; }
- (id)playbackKey:(NSString *)token { return (!token || [self.token isEqualToString:token]) ? self.playbackTurn : nil; }
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
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
    [center addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
    [center addObserver:self selector:@selector(mediaServicesReset:) name:AVAudioSessionMediaServicesWereResetNotification object:nil];
  }
  return self;
}
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (!whip_voice_session_current(token.UTF8String)) { reject(WhipCallError, @"The voice call was cancelled.", nil); return; }
  if (self.token) { reject(WhipCallError, @"A voice call is already active.", nil); return; }
  [self stopSound];
  self.token = token;
  self.ready = resolve; self.failed = reject;
  __weak WhipVoiceCall *weakSelf = self;
  self.authority = [NSTimer timerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
    WhipVoiceCall *call = weakSelf;
    if ([call.token isEqualToString:token] && !whip_voice_session_current(token.UTF8String)) {
      [call end:token resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) {}];
    }
  }];
  [NSRunLoop.mainRunLoop addTimer:self.authority forMode:NSRunLoopCommonModes];
  self.playbackTurn = [NSObject new];
  [self activateCall:token turn:self.playbackTurn];
}
- (void)activateCall:(NSString *)token turn:(id)turn
{
  if (![self.token isEqualToString:token] || self.playbackTurn != turn) { [WhipSpeechPlayback.shared finishPlayback:turn]; return; }
  if (!whip_voice_session_current(token.UTF8String)) { [self clear:nil]; return; }
  if ([WhipSpeechPlayback.shared deferPlayback:turn block:^{ [self activateCall:token turn:turn]; }]) return;
  [WhipSpeechPlayback.shared startPlayback:turn];
  // Reserve the playback owner while credentials/models/transport prepare.
  // Capture or playout activates the audio session when its media is ready.
  RCTPromiseResolveBlock ready = self.ready;
  self.ready = nil; self.failed = nil;
  if (ready) ready(nil);
}
- (void)activateAudio:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self owns:token]) { reject(WhipCallError, @"The voice call was cancelled.", nil); return; }
  if (!whip_voice_session_current(token.UTF8String)) {
    [self clear:nil]; reject(WhipCallError, @"The voice call was cancelled.", nil); return;
  }
  if (self.active) { resolve(nil); return; }
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  NSError *error = nil;
  NSLog(@"WhipVoice event=media_ready token=%@ at_s=%.3f", token, NSProcessInfo.processInfo.systemUptime);
  NSLog(@"WhipVoice event=focus_request token=%@ at_s=%.3f owner=voice", token, NSProcessInfo.processInfo.systemUptime);
  // VoiceChat mode enables hands-free Bluetooth routes.
  if (![audio setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat
      options:0 error:&error] || ![audio setActive:YES error:&error]) {
    NSString *message = error.localizedDescription ?: @"Voice audio could not start.";
    [self clear:message]; reject(WhipCallError, message, error); return;
  }
  self.active = YES;
  [audio setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
  // Start hands-free on the built-in route. Preserve a connected headset.
  for (AVAudioSessionPortDescription *port in audio.currentRoute.outputs) {
    if ([port.portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
      [audio overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
      break;
    }
  }
  [self routeChanged:nil];
  resolve(nil);
}
- (void)interrupted:(NSNotification *)notification
{
  if (!self.active || [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] != AVAudioSessionInterruptionTypeBegan) return;
  [self stopSound];
  // Realtime can pause and recover its engine. Local recognition ends.
  if (WhipRealtimeVoice.shared.playbackKey != self.playbackTurn) {
    [self clear:@"Voice audio was interrupted. Start a new call or resume from call history."];
  }
}
- (void)mediaServicesReset:(NSNotification *)notification
{
  [self stopSound];
  if (self.token) [self clear:@"The system reset voice audio. Start a new call."];
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
  NSURL *url = [NSURL URLWithString:uri];
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
  [self.soundPlayer stop]; self.soundPlayer = nil;
  if (self.soundOwnsSession) {
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
  if ([self.token isEqualToString:token]) [self clear:nil];
  resolve(nil);
}
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self owns:token]) { reject(WhipCallError, @"The voice call has ended.", nil); return; }
  [WhipRealtimeVoice.shared mute:token muted:muted];
  [self syncMuted:token muted:muted];
  resolve(nil);
}
- (void)syncMuted:(NSString *)token muted:(BOOL)muted
{
  if (![self owns:token] || self.muted == muted) return;
  self.muted = muted;
  [self emit:@{@"type": @"muted", @"muted": @(muted)}];
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
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self routeChanged:nil]; });
    return;
  }
  if (!self.active) return;
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
  NSLog(@"WhipVoice event=call_clear token=%@ failed=%d", self.token, error != nil);
  whip_voice_session_end_reason(self.token.UTF8String, error.UTF8String);
  [self.authority invalidate]; self.authority = nil;
  id turn = self.playbackTurn;
  [WhipSpeechPlayback.shared cancelPlayback:turn];
  [WhipRealtimeVoice.shared stop:self.token];
  [WhipSpeechPlayback.shared stopLocalChatForTurn:turn];
  [self stopSound];
  if (self.active) {
    NSError *deactivationError = nil;
    if (![AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&deactivationError])
      NSLog(@"WhipVoice event=deactivation_error error=%@", deactivationError.localizedDescription);
  }
  [self emit:error ? @{@"type": @"ended", @"error": error} : @{@"type": @"ended"}];
  RCTPromiseRejectBlock failed = self.failed;
  self.ready = nil; self.failed = nil;
  self.active = NO; self.muted = NO; self.token = nil; self.playbackTurn = nil;
  [WhipSpeechPlayback.shared finishPlayback:turn];
  if (failed) failed(WhipCallError, error ?: @"Voice call ended before activation.", nil);
}
- (void)invalidate { [self stopSound]; if (self.token) [self clear:@"Voice chat ended."]; }
@end
