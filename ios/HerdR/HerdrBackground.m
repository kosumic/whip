#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMotion/CoreMotion.h>
#import <math.h>

static NSString *const WhipChatSpeechStopped = @"WhipChatSpeechStopped";
static NSString *const WhipSpeechShake = @"WhipSpeechShake";
static NSString *const WhipChatSpeechError = @"E_CHAT_SPEECH";
static const double WhipShakeGravityThreshold = 2.7;
static const NSTimeInterval WhipShakeInterval = 0.02;
static const NSTimeInterval WhipShakeCooldown = 0.75;
static const NSTimeInterval WhipMinSpeechTimeout = 20;
static const NSTimeInterval WhipMaxSpeechTimeout = 180;
static const NSTimeInterval WhipSecondsPerCharacter = 0.12;

/** Platform playback only. Rust owns transcript selection and the speech queue. */
@interface HerdrBackground : RCTEventEmitter <AVSpeechSynthesizerDelegate>
@property(nonatomic, strong) AVSpeechSynthesizer *speech;
@property(nonatomic, copy) NSString *chatToken;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, copy) RCTPromiseResolveBlock utteranceResolve;
@property(nonatomic, strong) NSTimer *speechTimer;
@property(nonatomic) BOOL audioActive;
@property(nonatomic, strong) CMMotionManager *motion;
@property(nonatomic, copy) NSString *speechShakeToken;
@property(nonatomic) NSTimeInterval lastShake;
@end

@implementation HerdrBackground
RCT_EXPORT_MODULE(HerdrBackground)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[WhipChatSpeechStopped, WhipSpeechShake]; }

- (instancetype)init
{
  if ((self = [super init])) {
    _speech = [AVSpeechSynthesizer new];
    _speech.delegate = self;
    _motion = [CMMotionManager new];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(audioInterrupted:)
      name:AVAudioSessionInterruptionNotification object:nil];
    [center addObserver:self selector:@selector(audioRouteChanged:)
      name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}

- (void)releaseAudio
{
  if (!self.audioActive) return;
  self.audioActive = NO;
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error])
    NSLog(@"[ChatSpeech] Could not release audio session: %@", error.localizedDescription);
}

- (void)finishUtterance
{
  [self.speechTimer invalidate];
  self.speechTimer = nil;
  self.utterance = nil;
  RCTPromiseResolveBlock resolve = self.utteranceResolve;
  self.utteranceResolve = nil;
  [self releaseAudio];
  if (resolve) resolve(nil);
}

- (void)stopChatWithError:(NSString *)error notify:(BOOL)notify
{
  NSString *token = self.chatToken;
  self.chatToken = nil;
  self.utterance = nil;
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  [self updateShakeListener];
  // Deliver the stop before resolving the in-flight utterance, so JS clears
  // its Rust queue before it can drain another chunk.
  if (token && notify) {
    NSMutableDictionary *event = [@{@"token": token} mutableCopy];
    if (error) event[@"error"] = error;
    [self sendEventWithName:WhipChatSpeechStopped body:event];
  }
  [self finishUtterance];
}

RCT_EXPORT_METHOD(startChatSpeech:(NSString *)token label:(NSString *)label
  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [self stopChatWithError:nil notify:YES];
  self.chatToken = token;
  [self updateShakeListener];
  resolve(nil);
}

RCT_EXPORT_METHOD(speakChat:(NSString *)token text:(NSString *)text
  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (![self.chatToken isEqualToString:token] || self.utterance) {
    reject(WhipChatSpeechError, @"Chat listening is no longer available for this utterance", nil);
    return;
  }
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:AVSpeechSynthesisVoice.currentLanguageCode];
  if (!voice) {
    [self stopChatWithError:@"Install a speech voice for your device language in iOS settings" notify:YES];
    reject(WhipChatSpeechError, @"Speech voice is unavailable", nil);
    return;
  }
  AVAudioSession *session = AVAudioSession.sharedInstance;
  NSError *error = nil;
  if (![session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeSpokenAudio
       options:AVAudioSessionCategoryOptionDuckOthers error:&error] ||
      ![session setActive:YES error:&error]) {
    [self stopChatWithError:error.localizedDescription ?: @"Audio is unavailable" notify:YES];
    reject(WhipChatSpeechError, @"Could not activate speech audio", error);
    return;
  }
  self.audioActive = YES;
  AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  utterance.voice = voice;
  self.utterance = utterance;
  self.utteranceResolve = resolve;
  NSTimeInterval timeout = MIN(WhipMaxSpeechTimeout, MAX(WhipMinSpeechTimeout, text.length * WhipSecondsPerCharacter));
  __weak HerdrBackground *owner = self;
  self.speechTimer = [NSTimer scheduledTimerWithTimeInterval:timeout repeats:NO block:^(NSTimer *timer) {
    [owner stopChatWithError:@"Speech playback timed out" notify:YES];
  }];
  [NSRunLoop.mainRunLoop addTimer:self.speechTimer forMode:NSRunLoopCommonModes];
  [self.speech speakUtterance:utterance];
}

RCT_EXPORT_METHOD(stopChatSpeech:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if ([self.chatToken isEqualToString:token]) [self stopChatWithError:nil notify:NO];
  resolve(nil);
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance == utterance) [self finishUtterance];
  });
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance == utterance) [self stopChatWithError:nil notify:YES];
  });
}

- (void)audioInterrupted:(NSNotification *)notification
{
  if ([notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan)
    dispatch_async(dispatch_get_main_queue(), ^{ [self stopChatWithError:nil notify:YES]; });
}

- (void)audioRouteChanged:(NSNotification *)notification
{
  if ([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
    dispatch_async(dispatch_get_main_queue(), ^{ [self stopChatWithError:nil notify:YES]; });
}

RCT_EXPORT_METHOD(startSpeechShake:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!self.motion.accelerometerAvailable) {
    reject(@"E_SPEECH_SHAKE_START", @"This device has no accelerometer", nil);
    return;
  }
  self.speechShakeToken = token;
  [self updateShakeListener];
  resolve(nil);
}

RCT_EXPORT_METHOD(stopSpeechShake:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if ([self.speechShakeToken isEqualToString:token]) {
    self.speechShakeToken = nil;
    [self updateShakeListener];
  }
  resolve(nil);
}

- (void)updateShakeListener
{
  if (!self.chatToken && !self.speechShakeToken) {
    [self.motion stopAccelerometerUpdates];
    return;
  }
  if (self.motion.accelerometerActive || !self.motion.accelerometerAvailable) return;
  self.lastShake = 0;
  self.motion.accelerometerUpdateInterval = WhipShakeInterval;
  __weak HerdrBackground *owner = self;
  [self.motion startAccelerometerUpdatesToQueue:NSOperationQueue.mainQueue withHandler:^(CMAccelerometerData *data, NSError *error) {
    HerdrBackground *module = owner;
    if (!module || !data) return;
    CMAcceleration acceleration = data.acceleration;
    double gravity = sqrt(acceleration.x * acceleration.x + acceleration.y * acceleration.y + acceleration.z * acceleration.z);
    if (!isfinite(gravity) || gravity < WhipShakeGravityThreshold || data.timestamp - module.lastShake < WhipShakeCooldown) return;
    module.lastShake = data.timestamp;
    NSString *speechToken = module.speechShakeToken;
    module.speechShakeToken = nil;
    [module stopChatWithError:nil notify:YES];
    if (speechToken) [module sendEventWithName:WhipSpeechShake body:@{@"token": speechToken}];
  }];
}

- (void)invalidate
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  dispatch_async(dispatch_get_main_queue(), ^{
    self.chatToken = nil;
    self.speechShakeToken = nil;
    [self.motion stopAccelerometerUpdates];
    self.speech.delegate = nil;
    self.utterance = nil;
    [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    [self finishUtterance];
  });
  [super invalidate];
}

- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
@end
