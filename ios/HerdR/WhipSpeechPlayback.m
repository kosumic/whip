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
static const NSTimeInterval WhipModelInitializationTimeout = 60;

static dispatch_queue_t WhipPhononWorker(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("whip.phonon.audio", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

/** At most three 80 ms PCM buffers. Completion means played back, not generated. */
@interface WhipPhononAudio : NSObject
@property(nonatomic) uint64_t lease;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVAudioPlayerNode *node;
@property(nonatomic, strong) AVAudioFormat *format;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic) NSUInteger queued;
@property(nonatomic) BOOL cancelled;
@property(nonatomic) BOOL started;
@property(nonatomic, copy) void (^onStarted)(void);
- (BOOL)open:(double)rate error:(NSError **)error;
- (BOOL)write:(const float *)samples count:(NSUInteger)count;
- (BOOL)drain;
- (void)stop;
@end

@implementation WhipPhononAudio
- (instancetype)init
{
  if ((self = [super init])) _condition = [NSCondition new];
  return self;
}
- (BOOL)open:(double)rate error:(NSError **)error
{
  self.engine = [AVAudioEngine new];
  self.node = [AVAudioPlayerNode new];
  // AVAudioEngine converts mono PCM to the current hardware format. Adjusting
  // the input rate preserves the device.speak rate contract without JS audio.
  self.format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:24000 * rate channels:1];
  if (!self.format) return NO;
  [self.engine attachNode:self.node];
  [self.engine connect:self.node to:self.engine.mainMixerNode format:self.format];
  if (![self.engine startAndReturnError:error]) return NO;
  [self.node play];
  return YES;
}
- (BOOL)write:(const float *)samples count:(NSUInteger)count
{
  [self.condition lock];
  while (self.queued >= 3 && !self.cancelled && whip_speech_is_current(self.lease))
    [self.condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  BOOL accepted = !self.cancelled && whip_speech_is_current(self.lease);
  if (accepted) self.queued += 1;
  [self.condition unlock];
  if (!accepted) return NO;
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.format frameCapacity:(AVAudioFrameCount)count];
  if (!buffer) { [self stop]; return NO; }
  buffer.frameLength = (AVAudioFrameCount)count;
  for (NSUInteger i = 0; i < count; i++) buffer.floatChannelData[0][i] = isfinite(samples[i]) ? samples[i] : 0;
  // Scheduling and stop are serialized on the main queue, fencing the last
  // cancellation race between checking the lease and scheduling a buffer.
  dispatch_sync(dispatch_get_main_queue(), ^{
    [self.condition lock];
    BOOL current = !self.cancelled && whip_speech_is_current(self.lease);
    [self.condition unlock];
    if (!current) return;
    [self.node scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) {
      [self.condition lock];
      if (self.queued) self.queued -= 1;
      [self.condition broadcast];
      [self.condition unlock];
    }];
    if (!self.started) { self.started = YES; if (self.onStarted) self.onStarted(); }
  });
  [self.condition lock];
  accepted = !self.cancelled && whip_speech_is_current(self.lease);
  [self.condition unlock];
  return accepted;
}
- (BOOL)drain
{
  [self.condition lock];
  while (self.queued && !self.cancelled && whip_speech_is_current(self.lease))
    [self.condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  BOOL completed = !self.cancelled && whip_speech_is_current(self.lease);
  [self.condition unlock];
  return completed;
}
- (void)stop
{
  [self.condition lock];
  self.cancelled = YES;
  [self.condition broadcast];
  [self.condition unlock];
  [self.node stop];
  [self.engine stop];
}
@end

static bool WhipConsumePhonon(void *context, const float *samples, uintptr_t count)
{
  @autoreleasepool { return [(__bridge WhipPhononAudio *)context write:samples count:count]; }
}

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
@property(nonatomic, strong) WhipPhononAudio *phonon;
@property(nonatomic, copy) NSString *systemVoice;
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
    if (@available(iOS 18.0, *)) whip_phonon_set_supported(true);
    [self backendCommand:@"status" resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) {
      NSLog(@"[Phonon] %@", message);
    }];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(audioInterrupted:) name:AVAudioSessionInterruptionNotification object:nil];
    [center addObserver:self selector:@selector(audioRouteChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}

- (void)backendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if ([action isEqualToString:@"system-voices"]) {
    NSMutableArray *voices = [NSMutableArray array];
    for (AVSpeechSynthesisVoice *voice in AVSpeechSynthesisVoice.speechVoices) {
      [voices addObject:@{@"id": voice.identifier, @"name": voice.name, @"language": voice.language, @"networkRequired": @NO}];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:voices options:0 error:nil];
    resolve([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    return;
  }
  if ([@[@"system", @"phonon", @"delete"] containsObject:action] ||
      [action hasPrefix:@"voice:"] || [action hasPrefix:@"system-voice:"] || [action hasPrefix:@"remove-voice:"]) [self stop];
  static dispatch_queue_t settings;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ settings = dispatch_queue_create("whip.phonon.settings", DISPATCH_QUEUE_SERIAL); });
  dispatch_async(settings, ^{
    NSURL *support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *directory = [support URLByAppendingPathComponent:@"phonon" isDirectory:YES];
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error] ||
        ![directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error]) {
      reject(WhipSpeechError, error.localizedDescription ?: @"Could not prepare model storage", error);
      return;
    }
    char *json = whip_phonon_command(directory.path.UTF8String, action.UTF8String);
    NSString *value = json ? [NSString stringWithUTF8String:json] : nil;
    whip_phonon_free(json);
    NSDictionary *status = value ? [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error] : nil;
    if (!status || status[@"commandError"]) reject(WhipSpeechError, status[@"commandError"] ?: @"Speech backend unavailable", error);
    else dispatch_async(dispatch_get_main_queue(), ^{
      self.systemVoice = status[@"systemVoice"];
      resolve(value);
    });
  });
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
  [self announce:owner text:text language:language preview:NO resolve:resolve reject:reject];
}
- (void)preview:(NSString *)owner text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self announce:owner text:text language:language preview:YES resolve:resolve reject:reject];
}
- (void)announce:(NSString *)owner text:(NSString *)text language:(NSString *)language preview:(BOOL)preview resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self begin:WhipSpeechAnnouncement owner:owner request:@"" ended:^(NSString *reason, NSString *error) {
    if (error) reject(WhipSpeechError, error, nil); else resolve(reason);
  }]) {
    resolve(@"busy");
    return;
  }
  [self play:text language:language rate:1 started:nil preview:preview];
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
  [self play:text language:language rate:rate started:^{
    acknowledged = YES;
    resolve(@{@"started": @YES});
  }];
}

- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate
{
  return [self play:text language:language rate:rate started:nil];
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started
{
  return [self play:text language:language rate:rate started:started preview:NO];
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview
{
  NSString *requestedLanguage = language.length ? language : AVSpeechSynthesisVoice.currentLanguageCode;
  BOOL local = whip_phonon_enabled(requestedLanguage.UTF8String);
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:requestedLanguage];
  AVSpeechSynthesisVoice *selected = self.systemVoice.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:self.systemVoice] : nil;
  if (selected && (!language.length ||
      [[selected.language componentsSeparatedByString:@"-"].firstObject caseInsensitiveCompare:
       [requestedLanguage componentsSeparatedByString:@"-"].firstObject] == NSOrderedSame)) voice = selected;
  if ((!local && !voice) || !isfinite(rate) || rate <= 0) {
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
  NSTimeInterval timeout = whip_speech_timeout_ms(preview ? WhipSpeechChat : self.kind, text.length) / 1000.0;
  // Model initialization has its own watchdog. The ordinary Rust speech
  // deadline starts at the first PCM, after device-specific Core ML compilation.
  NSTimeInterval initializationTimeout = local ? WhipModelInitializationTimeout : timeout;
  __weak WhipSpeechPlayback *weakSelf = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:initializationTimeout repeats:NO block:^(NSTimer *timer) {
    WhipSpeechPlayback *playback = weakSelf;
    if (playback.lease == lease) [playback stopWithReason:WhipSpeechStopped error:@"Speech playback timed out"];
  }];
  [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
  if (local) {
    WhipPhononAudio *player = [WhipPhononAudio new];
    player.lease = lease;
    void (^playbackStarted)(void) = ^{
      WhipSpeechPlayback *playback = weakSelf;
      if (playback.lease != lease || playback.utterance != utterance) return;
      [playback.timer invalidate];
      playback.timer = [NSTimer scheduledTimerWithTimeInterval:timeout repeats:NO block:^(NSTimer *timer) {
        WhipSpeechPlayback *current = weakSelf;
        if (current.lease == lease && current.utterance == utterance)
          [current stopWithReason:WhipSpeechStopped error:@"Speech playback timed out"];
      }];
      [NSRunLoop.mainRunLoop addTimer:playback.timer forMode:NSRunLoopCommonModes];
      if (started) started();
    };
    player.onStarted = playbackStarted;
    self.phonon = player;
    if (![player open:rate error:&error]) {
      whip_phonon_playback_failed();
      [player stop]; self.phonon = nil;
      [self.speech speakUtterance:utterance];
      playbackStarted();
      return YES;
    }
    dispatch_async(WhipPhononWorker(), ^{
      int result = whip_phonon_speak(lease, text.UTF8String, WhipConsumePhonon, (__bridge void *)player);
      BOOL completed = result > 0 && [player drain];
      dispatch_async(dispatch_get_main_queue(), ^{
        WhipSpeechPlayback *playback = weakSelf;
        if (playback.lease != lease || playback.phonon != player || !whip_speech_is_current(lease)) return;
        if (completed && whip_speech_complete(lease)) {
          if (playback.kind == WhipSpeechChat) [playback finishUtterance:nil];
          else [playback clear:WhipSpeechCompleted error:nil];
        } else if (result < 0 && !player.started) {
          [player stop]; playback.phonon = nil;
          [playback.speech speakUtterance:utterance];
          playbackStarted();
        } else [playback stopWithReason:WhipSpeechInterrupted error:result < 0 ? @"Phonon speech failed" : nil];
      });
    });
  } else {
    [self.speech speakUtterance:utterance];
    if (started) started();
  }
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
  [self.phonon stop];
  self.phonon = nil;
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
