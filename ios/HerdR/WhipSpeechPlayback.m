#import "WhipSpeechPlayback.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreMotion/CoreMotion.h>
#import <math.h>

NSString *const WhipChatSpeechStopped = @"WhipChatSpeechStopped";
static NSString *const WhipSpeechError = @"E_SPEECH";
static NSString *const WhipSpeechCompleted = @"completed";
static NSString *const WhipSpeechStopped = @"stopped";
static NSString *const WhipSpeechInterrupted = @"interrupted";
static const double WhipShakeGravityThreshold = 2.7;
static const NSTimeInterval WhipShakeInterval = 0.02;

@interface WhipSpeechPlayback () <AVSpeechSynthesizerDelegate>
@property(nonatomic, strong) AVSpeechSynthesizer *speech;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) CMMotionManager *motion;
@property(nonatomic) uint64_t lease;
@property(nonatomic) enum WhipSpeechKind kind;
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, copy) void (^ended)(NSString *, NSString *);
@property(nonatomic, copy) RCTPromiseResolveBlock utteranceResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock utteranceReject;
@property(nonatomic) BOOL audioActive;
@end

@implementation WhipSpeechPlayback
+ (instancetype)shared
{
  static WhipSpeechPlayback *playback;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ playback = [WhipSpeechPlayback new]; });
  return playback;
}
- (instancetype)init
{
  if ((self = [super init])) {
    _speech = [AVSpeechSynthesizer new];
    _speech.delegate = self;
    _motion = [CMMotionManager new];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(audioInterrupted:) name:AVAudioSessionInterruptionNotification object:nil];
    [center addObserver:self selector:@selector(audioRouteChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}

- (BOOL)begin:(enum WhipSpeechKind)kind owner:(NSString *)owner request:(NSString *)request ended:(void (^)(NSString *, NSString *))ended
{
  uint64_t lease = whip_speech_claim(kind, owner.UTF8String, request.UTF8String);
  if (!lease) return NO;
  [self clear:@"replaced" error:nil];
  self.lease = lease;
  self.kind = kind;
  self.owner = owner;
  self.ended = ended;
  [self watchShake];
  return YES;
}
- (void)startChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self begin:WhipSpeechChat owner:owner request:@"" ended:nil]) {
    reject(WhipSpeechError, @"Could not start chat speech", nil);
    return;
  }
  resolve(nil);
}
- (void)speakChat:(NSString *)owner text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (self.kind != WhipSpeechChat || ![self.owner isEqualToString:owner] || self.utterance || !whip_speech_is_current(self.lease)) {
    reject(WhipSpeechError, @"Chat listening is no longer available for this utterance", nil);
    return;
  }
  self.utteranceResolve = resolve;
  self.utteranceReject = reject;
  [self play:text language:nil rate:1];
}
- (void)announce:(NSString *)owner text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self begin:WhipSpeechAnnouncement owner:owner request:@"" ended:^(NSString *reason, NSString *error) {
    if (error) reject(WhipSpeechError, error, nil); else resolve(reason);
  }]) {
    resolve(@"busy");
    return;
  }
  [self play:text language:language rate:1];
}
- (void)speakDevice:(NSString *)owner request:(NSString *)request text:(NSString *)text language:(NSString *)language rate:(double)rate resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  __block BOOL acknowledged = NO;
  if (![self begin:WhipSpeechDevice owner:owner request:request ended:^(NSString *reason, NSString *error) {
    if (!acknowledged) reject(error ? @"device_unavailable" : @"cancelled", error ?: @"Speech request cancelled", nil);
  }]) {
    reject(@"device_unavailable", @"Another speech session is active", nil);
    return;
  }
  if ([self play:text language:language rate:rate]) {
    acknowledged = YES;
    resolve(@{@"started": @YES});
  }
}

- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate
{
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:language ?: AVSpeechSynthesisVoice.currentLanguageCode];
  if (!voice || !isfinite(rate) || rate <= 0) {
    [self stopWithReason:WhipSpeechStopped error:@"Requested speech voice or rate is unavailable"];
    return NO;
  }
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  NSError *error = nil;
  if (![audio setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeSpokenAudio
         options:AVAudioSessionCategoryOptionDuckOthers error:&error] || ![audio setActive:YES error:&error]) {
    [self stopWithReason:WhipSpeechStopped error:error.localizedDescription ?: @"Could not activate speech audio"];
    return NO;
  }
  self.audioActive = YES;
  AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  utterance.voice = voice;
  utterance.rate = MIN(AVSpeechUtteranceMaximumSpeechRate, MAX(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate));
  self.utterance = utterance;
  uint64_t lease = self.lease;
  NSTimeInterval timeout = whip_speech_timeout_ms(self.kind, text.length) / 1000.0;
  __weak WhipSpeechPlayback *weakSelf = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:timeout repeats:NO block:^(NSTimer *timer) {
    WhipSpeechPlayback *playback = weakSelf;
    if (playback.lease == lease) [playback stopWithReason:WhipSpeechStopped error:@"Speech playback timed out"];
  }];
  [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
  [self.speech speakUtterance:utterance];
  return YES;
}
- (BOOL)stopOwner:(NSString *)owner kind:(enum WhipSpeechKind)kind
{
  uint64_t stopped = whip_speech_stop_owner(kind, owner.UTF8String);
  if (!stopped || self.lease != stopped) return NO;
  [self clear:WhipSpeechStopped error:nil];
  return YES;
}
- (void)cancelDeviceRequest:(NSString *)request
{
  uint64_t stopped = whip_speech_cancel_request(WhipSpeechDevice, request.UTF8String);
  if (stopped && self.lease == stopped) [self clear:WhipSpeechStopped error:nil];
}
- (void)stopDevice { if (self.kind == WhipSpeechDevice) [self stopOwner:self.owner kind:self.kind]; }
- (void)stop { [self stopWithReason:WhipSpeechStopped error:nil]; }
- (void)stopWithReason:(NSString *)reason error:(NSString *)error
{
  if (whip_speech_stop(self.lease)) [self clear:reason error:error];
}
- (void)releaseAudio
{
  if (!self.audioActive) return;
  self.audioActive = NO;
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error])
    NSLog(@"[SpeechPlayback] Could not release audio session: %@", error.localizedDescription);
}
- (void)finishUtterance:(NSString *)error
{
  [self.timer invalidate];
  self.timer = nil;
  self.utterance = nil;
  RCTPromiseResolveBlock resolve = self.utteranceResolve;
  RCTPromiseRejectBlock reject = self.utteranceReject;
  self.utteranceResolve = nil;
  self.utteranceReject = nil;
  [self releaseAudio];
  if (error) { if (reject) reject(WhipSpeechError, error, nil); }
  else if (resolve) resolve(nil);
}
- (void)clear:(NSString *)reason error:(NSString *)error
{
  NSString *owner = self.owner;
  enum WhipSpeechKind kind = self.kind;
  void (^ended)(NSString *, NSString *) = self.ended;
  self.ended = nil;
  self.lease = 0;
  self.owner = nil;
  self.utterance = nil;
  [self.motion stopAccelerometerUpdates];
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  // Publish the stop before resolving the chunk so JS cannot drain another.
  if (owner && kind == WhipSpeechChat) {
    NSMutableDictionary *event = [@{@"token": owner} mutableCopy];
    if (error) event[@"error"] = error;
    [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechStopped object:self userInfo:event];
  }
  [self finishUtterance:error];
  if (ended) ended(reason, error);
}
- (void)watchShake
{
  if (!self.motion.accelerometerAvailable) return;
  self.motion.accelerometerUpdateInterval = WhipShakeInterval;
  uint64_t lease = self.lease;
  __weak WhipSpeechPlayback *weakSelf = self;
  [self.motion startAccelerometerUpdatesToQueue:NSOperationQueue.mainQueue withHandler:^(CMAccelerometerData *data, NSError *error) {
    WhipSpeechPlayback *playback = weakSelf;
    if (!data || playback.lease != lease) return;
    CMAcceleration a = data.acceleration;
    double gravity = sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (isfinite(gravity) && gravity >= WhipShakeGravityThreshold) [playback stopWithReason:@"shake" error:nil];
  }];
}
- (void)audioInterrupted:(NSNotification *)notification
{
  if ([notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan)
    dispatch_async(dispatch_get_main_queue(), ^{ [self stopWithReason:WhipSpeechInterrupted error:nil]; });
}
- (void)audioRouteChanged:(NSNotification *)notification
{
  if ([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
    dispatch_async(dispatch_get_main_queue(), ^{ [self stopWithReason:WhipSpeechInterrupted error:nil]; });
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance != utterance || !whip_speech_complete(self.lease)) return;
    if (self.kind == WhipSpeechChat) [self finishUtterance:nil];
    else [self clear:WhipSpeechCompleted error:nil];
  });
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance == utterance) [self stopWithReason:WhipSpeechInterrupted error:nil];
  });
}
@end
