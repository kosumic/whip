#import "WhipSpeechPlayback.h"
#import "../../packages/react-native-whip-ssh/ios/WhipVoiceCall.h"
#import "../../packages/react-native-whip-ssh/ios/WhipRealtimeVoice.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreMotion/CoreMotion.h>
#import <math.h>
#import <UIKit/UIKit.h>
#import <stdatomic.h>
#import <UserNotifications/UserNotifications.h>

@interface WhipPendingSpeech : NSObject
@property(nonatomic) enum WhipSpeechKind kind;
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, copy) NSString *request;
@property(nonatomic, strong) id turn;
@property(nonatomic) BOOL localOnly;
@property(nonatomic) BOOL atomic;
@property(nonatomic, copy) dispatch_block_t ready;
@property(nonatomic, copy) void (^ended)(NSString *, NSString *);
@end
@implementation WhipPendingSpeech
@end

@interface WhipAlertUnit : NSObject
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *notification;
@property(nonatomic) BOOL prepared;
@property(nonatomic) BOOL speech;
@property(nonatomic) BOOL silent;
@property(nonatomic) BOOL persistent;
@property(nonatomic) BOOL ringing;
@property(nonatomic) NSTimeInterval timeout;
@end
@implementation WhipAlertUnit
@end

NSString *const WhipChatSpeechStopped = @"WhipChatSpeechStopped";
NSString *const WhipChatSpeechStarted = @"WhipChatSpeechStarted";
NSString *const WhipChatSpeechLevel = @"WhipChatSpeechLevel";
NSString *const WhipAutomaticSpeechFocus = @"WhipAutomaticSpeechFocus";
NSString *const WhipSpeechCaption = @"WhipSpeechCaption";
static NSString *const WhipSpeechError = @"E_SPEECH";
static NSString *const WhipSpeechCompleted = @"completed";
static NSString *const WhipSpeechStopped = @"stopped";
static NSString *const WhipSpeechReplaced = @"replaced";
static NSString *const WhipSpeechInterrupted = @"interrupted";
static NSString *const WhipAutomaticOwner = @"automatic-chat-speech";
static const double WhipShakeGravityThreshold = 2.7;
static const NSTimeInterval WhipShakeInterval = 0.02;
static const NSTimeInterval WhipModelInitializationTimeout = 60;

// A small cancellable app tone. System notification sounds cannot be stopped
// when the user shakes, so they cannot own an atomic playback unit.
static NSData *WhipAlertTone(void)
{
  static NSData *tone;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    const uint32_t rate = 24000, frames = rate * 3 / 4, bytes = frames * sizeof(int16_t);
    NSMutableData *data = [NSMutableData dataWithLength:44 + bytes];
    uint8_t *header = data.mutableBytes;
    memcpy(header, "RIFF", 4); memcpy(header + 8, "WAVEfmt ", 8); memcpy(header + 36, "data", 4);
    uint32_t fields[] = {CFSwapInt32HostToLittle(36 + bytes), CFSwapInt32HostToLittle(16),
      CFSwapInt32HostToLittle(rate), CFSwapInt32HostToLittle(rate * 2), CFSwapInt32HostToLittle(bytes)};
    memcpy(header + 4, &fields[0], 4); memcpy(header + 16, &fields[1], 4);
    memcpy(header + 24, &fields[2], 4); memcpy(header + 28, &fields[3], 4); memcpy(header + 40, &fields[4], 4);
    uint16_t format[] = {CFSwapInt16HostToLittle(1), CFSwapInt16HostToLittle(1), CFSwapInt16HostToLittle(2), CFSwapInt16HostToLittle(16)};
    memcpy(header + 20, &format[0], 4); memcpy(header + 32, &format[2], 4);
    int16_t *samples = (int16_t *)(header + 44);
    for (uint32_t i = 0; i < frames; i++) {
      double t = (double)i / rate;
      double start = t < 0.24 ? 0 : 0.28;
      double position = t - start;
      double value = position >= 0 && position < 0.2
        ? sin(2 * M_PI * (start == 0 ? 880 : 660) * position) * MIN(1, position / 0.005) * exp(-position * 20) : 0;
      samples[i] = CFSwapInt16HostToLittle((int16_t)(value * 12000));
    }
    tone = data;
  });
  return tone;
}

static dispatch_queue_t WhipPcmSpeechWorker(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("whip.speech.pcm", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

/** At most three 80 ms PCM buffers. Completion means played back, not generated. */
@interface WhipPcmSpeechAudio : NSObject
@property(nonatomic) uint64_t lease;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVAudioPlayerNode *node;
@property(nonatomic, strong) AVAudioFormat *format;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic) NSUInteger queued;
@property(nonatomic) BOOL cancelled;
@property(nonatomic) BOOL started;
@property(nonatomic, copy) void (^onStarted)(void);
@property(nonatomic, copy) void (^onLevel)(float);
@property(nonatomic, copy) void (^onProgress)(NSUInteger, NSUInteger, BOOL);
@property(nonatomic) NSUInteger scheduledSamples;
@property(nonatomic) NSUInteger playedSamples;
@property(nonatomic) BOOL synthesisDone;
@property(nonatomic) NSTimeInterval lastLevelTime;
@property(nonatomic) BOOL levelTapInstalled;
- (BOOL)open:(double)rate error:(NSError **)error;
- (BOOL)write:(const float *)samples count:(NSUInteger)count;
- (BOOL)drain;
- (void)stop;
@end

@implementation WhipPcmSpeechAudio
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
  __weak WhipPcmSpeechAudio *weakSelf = self;
  [self.engine.mainMixerNode installTapOnBus:0 bufferSize:1024 format:nil block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    WhipPcmSpeechAudio *audio = weakSelf;
    NSTimeInterval now = NSDate.timeIntervalSinceReferenceDate;
    if (!audio || !buffer.floatChannelData || !buffer.frameLength || now - audio.lastLevelTime < 0.04) return;
    audio.lastLevelTime = now;
    double sum = 0;
    for (AVAudioChannelCount channel = 0; channel < buffer.format.channelCount; channel++)
      for (AVAudioFrameCount frame = 0; frame < buffer.frameLength; frame++) {
        float sample = buffer.format.interleaved
          ? buffer.floatChannelData[0][frame * buffer.format.channelCount + channel]
          : buffer.floatChannelData[channel][frame];
        sum += sample * sample;
      }
    float level = fmin(1, sqrt(sum / (buffer.frameLength * buffer.format.channelCount)));
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!audio.cancelled && whip_speech_is_current(audio.lease) && audio.onLevel) audio.onLevel(level);
    });
  }];
  self.levelTapInstalled = YES;
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
  if (accepted) self.scheduledSamples += count;
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
      self.playedSamples += count;
      NSUInteger played = self.playedSamples;
      NSUInteger samples = self.scheduledSamples;
      BOOL done = self.synthesisDone;
      [self.condition broadcast];
      [self.condition unlock];
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.cancelled && self.onProgress) self.onProgress(played, samples, done);
      });
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
  self.synthesisDone = YES;
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
  if (self.levelTapInstalled) { [self.engine.mainMixerNode removeTapOnBus:0]; self.levelTapInstalled = NO; }
  [self.engine stop];
}
@end

static bool WhipConsumeSpeechPcm(void *context, const float *samples, uintptr_t count)
{
  @autoreleasepool { return [(__bridge WhipPcmSpeechAudio *)context write:samples count:count]; }
}

static AVSpeechSynthesisVoice *WhipConfiguredSystemVoice(NSString *identifier, NSString *language, BOOL explicitLanguage)
{
  AVSpeechSynthesisVoice *selected = identifier.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:identifier] : nil;
  if (selected && (!explicitLanguage ||
      [[selected.language componentsSeparatedByString:@"-"].firstObject caseInsensitiveCompare:
       [language componentsSeparatedByString:@"-"].firstObject] == NSOrderedSame)) return selected;
  return [AVSpeechSynthesisVoice voiceWithLanguage:language];
}

/** Borrow the live call's lease, without claiming or completing speech ownership. */
@interface WhipCallAnnouncement : NSObject <AVSpeechSynthesizerDelegate>
@property(nonatomic, strong) AVSpeechSynthesizer *speech;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, strong) WhipPcmSpeechAudio *pcm;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, copy) dispatch_block_t completed;
@property(nonatomic) BOOL active;
- (void)start:(uint64_t)lease text:(NSString *)text voice:(NSString *)voice completed:(dispatch_block_t)completed;
- (void)cancel;
@end

@implementation WhipCallAnnouncement
- (void)finish
{
  if (!self.active) return;
  dispatch_block_t completed = self.completed;
  [self cancel];
  if (completed) completed();
}
- (void)start:(uint64_t)lease text:(NSString *)text voice:(NSString *)voice completed:(dispatch_block_t)completed
{
  [self cancel];
  self.active = YES;
  self.completed = completed;
  if (!whip_speech_is_current(lease)) { [self finish]; return; }
  __weak WhipCallAnnouncement *weakSelf = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:WhipModelInitializationTimeout repeats:NO block:^(NSTimer *timer) {
    NSLog(@"Whip call announcement timed out");
    [weakSelf finish];
  }];
  NSString *language = AVSpeechSynthesisVoice.currentLanguageCode;
  if (whip_speech_pcm_enabled(language.UTF8String, false)) {
    WhipPcmSpeechAudio *player = [WhipPcmSpeechAudio new];
    player.lease = lease;
    self.pcm = player;
    NSError *error = nil;
    if (![player open:1 error:&error]) { [self finish]; return; }
    dispatch_async(WhipPcmSpeechWorker(), ^{
      int result = whip_speech_pcm_speak(lease, text.UTF8String, 0, WhipConsumeSpeechPcm, (__bridge void *)player,
                                        WhipReadOpenAiVoiceCredential, NULL);
      BOOL drained = result > 0 && [player drain];
      dispatch_async(dispatch_get_main_queue(), ^{
        WhipCallAnnouncement *announcement = weakSelf;
        if (announcement.pcm != player) return;
        if (!drained) NSLog(@"Whip call announcement speech did not complete");
        [announcement finish];
      });
    });
  } else {
    self.speech = [AVSpeechSynthesizer new];
    self.speech.delegate = self;
    self.utterance = [AVSpeechUtterance speechUtteranceWithString:text];
    self.utterance.voice = WhipConfiguredSystemVoice(voice, language, NO);
    if (!self.utterance.voice) { [self finish]; return; }
    [self.speech speakUtterance:self.utterance];
  }
}
- (void)cancel
{
  self.active = NO;
  self.completed = nil;
  [self.timer invalidate]; self.timer = nil;
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  self.speech = nil; self.utterance = nil;
  [self.pcm stop]; self.pcm = nil;
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)speech didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{ dispatch_async(dispatch_get_main_queue(), ^{ if (self.utterance == utterance) [self finish]; }); }
- (void)speechSynthesizer:(AVSpeechSynthesizer *)speech didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{ dispatch_async(dispatch_get_main_queue(), ^{ if (self.utterance == utterance) [self finish]; }); }
@end

@interface WhipSpeechPlayback () <AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate>
@property(nonatomic, strong) WhipCallAnnouncement *callAnnouncement;
@property(nonatomic, strong) AVSpeechSynthesizer *speech;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, copy) NSDictionary *captionSource;
@property(nonatomic, strong) NSMutableDictionary *caption;
@property(nonatomic) uint64_t captionClock;
@property(nonatomic) NSInteger captionPrefix;
@property(nonatomic) NSInteger captionPosition;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) CMMotionManager *motion;
@property(nonatomic) uint64_t lease;
@property(nonatomic) enum WhipSpeechKind kind;
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, copy) void (^ended)(NSString *, NSString *);
@property(nonatomic, copy) RCTPromiseResolveBlock utteranceResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock utteranceReject;
@property(nonatomic) BOOL audioActive;
@property(nonatomic, strong) WhipPcmSpeechAudio *pcm;
@property(nonatomic, copy) NSString *systemVoice;
@property(nonatomic) BOOL localOnly;
@property(nonatomic) BOOL atomic;
@property(nonatomic) BOOL atomicPlaying;
@property(nonatomic) BOOL reportedStart;
@property(nonatomic, strong) NSTimer *levelTimer;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *statusCallbacks;
@property(nonatomic, strong) NSDictionary *suspendedChat;
@property(nonatomic, copy) RCTPromiseResolveBlock boundaryResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock boundaryReject;
@property(nonatomic, strong) NSDictionary *deferredChat;
@property(nonatomic, copy) NSString *statusOwner;
@property(nonatomic) uint64_t automaticId;
@property(nonatomic, copy) NSDictionary *automaticFocus;
@property(nonatomic, strong) NSMapTable<id, NSString *> *playbackIds;
@property(nonatomic, strong) NSMutableDictionary<NSString *, dispatch_block_t> *playbackCallbacks;
@property(nonatomic, strong) id turn;
@property(nonatomic, strong) NSMutableSet<WhipPendingSpeech *> *pendingSpeech;
@property(nonatomic, strong) NSMutableDictionary<NSString *, WhipAlertUnit *> *alertUnits;
@property(nonatomic, strong) WhipAlertUnit *currentAlert;
@property(nonatomic, strong) AVAudioPlayer *ringtone;
@property(nonatomic, strong) NSTimer *ringtoneTimeout;
- (void)drainAutomatic;
@end

static id WhipAutomaticCommand(NSDictionary *command)
{
  NSData *input = [NSJSONSerialization dataWithJSONObject:command options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:input encoding:NSUTF8StringEncoding];
  char *result = whip_automatic_speech_command(json.UTF8String);
  if (!result) return nil;
  NSData *data = [[NSString stringWithUTF8String:result] dataUsingEncoding:NSUTF8StringEncoding];
  whip_alert_speech_free(result);
  id value = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
  return value == NSNull.null ? nil : value;
}

static atomic_bool WhipAutomaticWakePending = false;
static void WhipWakeAutomaticSpeech(void)
{
  if (atomic_exchange(&WhipAutomaticWakePending, true)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    atomic_store(&WhipAutomaticWakePending, false);
    [WhipSpeechPlayback.shared drainAutomatic];
  });
}

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
    _statusCallbacks = [NSMutableDictionary new];
    _playbackIds = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsStrongMemory | NSPointerFunctionsObjectPointerPersonality valueOptions:NSPointerFunctionsStrongMemory];
    _playbackCallbacks = [NSMutableDictionary new];
    _pendingSpeech = [NSMutableSet new];
    _alertUnits = [NSMutableDictionary new];
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
    [center addObserver:self selector:@selector(automaticLocked:) name:UIApplicationProtectedDataWillBecomeUnavailable object:nil];
    [center addObserver:self selector:@selector(automaticUnlocked:) name:UIApplicationProtectedDataDidBecomeAvailable object:nil];
  }
  return self;
}

- (void)automaticBinding:(NSString *)token host:(NSString *)host tabName:(NSString *)tabName
{
  WhipAutomaticCommand(@{@"action": @"bind", @"bindingToken": token, @"hostId": host, @"tabName": tabName});
}
- (void)automaticControl:(NSString *)action value:(BOOL)value
{
  static dispatch_once_t once;
  dispatch_once(&once, ^{ whip_automatic_speech_register(WhipWakeAutomaticSpeech); });
  NSString *key = [action isEqualToString:@"enable"] || [action isEqualToString:@"read-while-locked"] ? @"enabled" : @"paused";
  WhipAutomaticCommand(@{@"action": action, key: @(value)});
  WhipAutomaticCommand(@{@"action": @"lock", @"locked": @(!UIApplication.sharedApplication.protectedDataAvailable)});
  [self drainAutomatic];
  [NSNotificationCenter.defaultCenter postNotificationName:WhipAutomaticSpeechFocus object:self userInfo:self.automaticFocus ?: @{}];
}
- (void)automaticLocked:(NSNotification *)notification
{
  WhipAutomaticCommand(@{@"action": @"lock", @"locked": @YES});
  [self drainAutomatic];
}
- (void)automaticUnlocked:(NSNotification *)notification
{
  WhipAutomaticCommand(@{@"action": @"lock", @"locked": @NO});
  [self drainAutomatic];
}
- (void)automaticEnded:(NSString *)reason error:(NSString *)error
{
  uint64_t identity = self.automaticId;
  NSLog(@"[SpeechPlayback] automatic-ended id=%llu reason=%@ failed=%d", identity, reason, error != nil);
  self.automaticId = 0;
  self.automaticFocus = nil;
  [NSNotificationCenter.defaultCenter postNotificationName:WhipAutomaticSpeechFocus object:self userInfo:@{}];
  if (identity) WhipAutomaticCommand(@{@"action": @"ended", @"id": @(identity),
    @"reason": reason ?: WhipSpeechInterrupted, @"failed": @(error != nil)});
}
- (void)drainAutomatic
{
  if (self.automaticId) {
    if ([WhipAutomaticCommand(@{@"action": @"valid", @"id": @(self.automaticId)}) boolValue]) return;
    [self stopOwner:WhipAutomaticOwner kind:WhipSpeechChat];
    self.automaticId = 0;
  }
  if (WhipVoiceCall.shared.active || self.suspendedChat ||
      (self.owner && ![self.owner isEqualToString:WhipAutomaticOwner])) return;
  NSDictionary *next = WhipAutomaticCommand(@{@"action": @"take"});
  if (!next) { [self stopOwner:WhipAutomaticOwner kind:WhipSpeechChat]; return; }
  uint64_t identity = [next[@"id"] unsignedLongLongValue];
  self.automaticId = identity;
  self.automaticFocus = @{@"hostId": next[@"hostId"], @"paneId": next[@"paneId"]};
  [NSNotificationCenter.defaultCenter postNotificationName:WhipAutomaticSpeechFocus object:self
    userInfo:self.automaticFocus];
  __weak WhipSpeechPlayback *weakSelf = self;
  RCTPromiseRejectBlock fail = ^(NSString *code, NSString *message, NSError *error) {
    WhipSpeechPlayback *playback = weakSelf;
    if (playback.automaticId != identity) return;
    NSString *failure = message ?: @"Automatic speech playback failed";
    [playback automaticEnded:WhipSpeechStopped error:failure];
    [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechStopped object:playback userInfo:
      @{@"token": WhipAutomaticOwner, @"reason": WhipSpeechStopped, @"error": failure}];
    [playback stopOwner:WhipAutomaticOwner kind:WhipSpeechChat];
  };
  void (^speak)(void) = ^{
    WhipSpeechPlayback *playback = weakSelf;
    if (playback.automaticId != identity || ![WhipAutomaticCommand(@{@"action": @"valid", @"id": @(identity)}) boolValue]) {
      [playback drainAutomatic]; return;
    }
    NSMutableDictionary *source = [next[@"caption"] isKindOfClass:NSDictionary.class] ? [next[@"caption"] mutableCopy] : nil;
    source[@"hostId"] = next[@"hostId"]; source[@"paneId"] = next[@"paneId"];
    source[@"bindingTokens"] = next[@"bindingTokens"];
    [playback speakChat:WhipAutomaticOwner text:next[@"text"] source:source resolve:^(id value) {
      WhipSpeechPlayback *current = weakSelf;
      if (current.automaticId != identity) return;
      WhipAutomaticCommand(@{@"action": @"completed", @"id": @(identity)});
      current.automaticId = 0;
      dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf drainAutomatic]; });
    } reject:fail];
  };
  if ([self.owner isEqualToString:WhipAutomaticOwner]) speak();
  else [self startChat:WhipAutomaticOwner label:next[@"label"] resolve:^(id value) { speak(); } reject:fail];
}
- (void)detachPresentation
{
  if (![self.owner isEqualToString:WhipAutomaticOwner] &&
      ![self.suspendedChat[@"owner"] isEqualToString:WhipAutomaticOwner]) [self cancel];
}

- (void)backendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if ([action hasPrefix:@"stt-cancel:"]) {
    char *json = whip_speech_backend_command("", action.UTF8String);
    NSString *value = json ? [NSString stringWithUTF8String:json] : @"{}";
    whip_speech_backend_free(json);
    resolve(value);
    return;
  }
  if ([action isEqualToString:@"system-voices"]) {
    NSMutableArray *voices = [NSMutableArray array];
    for (AVSpeechSynthesisVoice *voice in AVSpeechSynthesisVoice.speechVoices) {
      [voices addObject:@{@"id": voice.identifier, @"name": voice.name, @"language": voice.language, @"networkRequired": @NO}];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:voices options:0 error:nil];
    resolve([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    return;
  }
  if ([@[@"system", @"phonon", @"openai", @"delete"] containsObject:action] ||
      [action hasPrefix:@"openai-voice:"] || [action hasPrefix:@"voice:"] || [action hasPrefix:@"system-voice:"] || [action hasPrefix:@"remove-voice:"]) [self cancel];
  static dispatch_queue_t settings;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ settings = dispatch_queue_create("whip.speech.settings", DISPATCH_QUEUE_SERIAL); });
  dispatch_async(settings, ^{
    if ([action hasPrefix:@"stt-start:"]) whip_voice_credentials_prepare(WhipReadOpenAiVoiceCredential, NULL);
    NSURL *support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *directory = [support URLByAppendingPathComponent:@"phonon" isDirectory:YES];
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error] ||
        ![directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error]) {
      reject(WhipSpeechError, error.localizedDescription ?: @"Could not prepare model storage", error);
      return;
    }
    char *json = whip_speech_backend_command(directory.path.UTF8String, action.UTF8String);
    NSString *value = json ? [NSString stringWithUTF8String:json] : nil;
    whip_speech_backend_free(json);
    NSDictionary *status = value ? [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error] : nil;
    if (!status || status[@"commandError"]) reject(WhipSpeechError, status[@"commandError"] ?: @"Speech backend unavailable", error);
    else dispatch_async(dispatch_get_main_queue(), ^{
      if (status[@"systemVoice"]) self.systemVoice = status[@"systemVoice"];
      resolve(value);
    });
  });
}

- (NSString *)alertCommand:(NSString *)action token:(NSString *)token lease:(uint64_t)lease
{
  char *result = whip_alert_speech_command(action.UTF8String, token.UTF8String, lease);
  NSString *value = result ? [NSString stringWithUTF8String:result] : @"null";
  whip_alert_speech_free(result);
  return value;
}
- (NSString *)playbackId:(id)key
{
  NSString *identity = [self.playbackIds objectForKey:key];
  if (!identity) {
    identity = [self alertCommand:@"playback-id" token:@"" lease:0];
    if (identity.longLongValue <= 0) [NSException raise:NSInternalInconsistencyException format:@"Rust playback admission is unavailable"];
    [self.playbackIds setObject:identity forKey:key];
  }
  return identity;
}
- (BOOL)deferPlayback:(id)key block:(dispatch_block_t)block
{
  NSString *identity = [self playbackId:key];
  if (![[self alertCommand:@"playback-defer" token:identity lease:0] isEqualToString:@"true"]) return NO;
  self.playbackCallbacks[identity] = [block copy];
  return YES;
}
- (void)startPlayback:(id)key
{
  BOOL admitted = [[self alertCommand:@"playback-start" token:[self playbackId:key] lease:0] isEqualToString:@"true"];
  if (!admitted) [NSException raise:NSInternalInconsistencyException format:@"Playback units cannot interrupt one another"];
}
- (void)cancelPlayback:(id)key
{
  if (!key) return;
  NSString *identity = [self.playbackIds objectForKey:key];
  if (!identity) return;
  [self alertCommand:@"playback-cancel" token:identity lease:0];
  [self.playbackCallbacks removeObjectForKey:identity];
  if (![[self alertCommand:@"playback-owns" token:identity lease:0] isEqualToString:@"true"]) [self.playbackIds removeObjectForKey:key];
}
- (void)finishPlayback:(id)key
{
  NSString *identity = key ? [self.playbackIds objectForKey:key] : nil;
  if (!identity || ![[self alertCommand:@"playback-finish" token:identity lease:0] isEqualToString:@"true"]) return;
  [self.playbackIds removeObjectForKey:key];
  [self.playbackCallbacks removeObjectForKey:identity];
  dispatch_async(dispatch_get_main_queue(), ^{
    while (YES) {
      NSString *next = [self alertCommand:@"playback-next" token:@"" lease:0];
      if ([next isEqualToString:@"null"]) break;
      dispatch_block_t block = self.playbackCallbacks[next];
      [self.playbackCallbacks removeObjectForKey:next];
      if (block) block(); else [self alertCommand:@"playback-finish" token:next lease:0];
    }
  });
}
- (void)yieldIdlePlayback
{
  if (!self.lease || self.kind != WhipSpeechChat || self.utterance || [WhipVoiceCall.shared playbackKey:nil] == self.turn) return;
  whip_speech_stop(self.lease);
  [self suspendChat];
}
- (void)finishTurn:(id)turn
{
  if (!turn || self.currentAlert == turn || [WhipVoiceCall.shared playbackKey:nil] == turn) return;
  if (self.turn == turn && self.atomicPlaying) return;
  [self finishPlayback:turn];
}
- (void)queueSpeech:(enum WhipSpeechKind)kind owner:(NSString *)owner request:(NSString *)request localOnly:(BOOL)localOnly atomic:(BOOL)atomic turn:(id)turn ready:(dispatch_block_t)ready ended:(void (^)(NSString *, NSString *))ended
{
  WhipPendingSpeech *pending = [WhipPendingSpeech new];
  pending.kind = kind; pending.owner = owner; pending.request = request;
  pending.localOnly = localOnly; pending.ready = ready; pending.ended = ended;
  pending.atomic = atomic;
  pending.turn = turn ?: [WhipVoiceCall.shared playbackKey:owner] ?: [NSObject new];
  [self.pendingSpeech addObject:pending];
  [self admitSpeech:pending];
}
- (void)admitSpeech:(WhipPendingSpeech *)pending
{
  if (![self.pendingSpeech containsObject:pending]) { [self finishPlayback:pending.turn]; return; }
  if ([self deferPlayback:pending.turn block:^{ [self admitSpeech:pending]; }]) return;
  [self.pendingSpeech removeObject:pending];
  if (self.lease && self.kind == WhipSpeechChat && pending.kind != WhipSpeechChat) {
    whip_speech_stop(self.lease);
    [self suspendChat];
  }
  if (![self begin:pending.kind owner:pending.owner request:pending.request ended:pending.ended]) {
    [self finishPlayback:pending.turn];
    if (pending.ended) pending.ended(WhipSpeechStopped, @"Could not start speech");
    return;
  }
  self.turn = pending.turn;
  self.localOnly = pending.localOnly;
  self.atomic = pending.atomic;
  [self startPlayback:pending.turn];
  pending.ready();
  if (self.turn == pending.turn && self.kind == WhipSpeechChat && !self.utterance) [self finishTurn:self.turn];
}
- (BOOL)cancelPendingSpeech:(BOOL (^)(WhipPendingSpeech *))matches reason:(NSString *)reason
{
  BOOL cancelled = NO;
  for (WhipPendingSpeech *pending in self.pendingSpeech.allObjects) if (matches(pending)) {
    cancelled = YES;
    [self.pendingSpeech removeObject:pending];
    [self cancelPlayback:pending.turn];
    [self finishPlayback:pending.turn];
    if (pending.ended) pending.ended(reason, nil);
  }
  return cancelled;
}
- (void)suspendChat
{
  NSMutableDictionary *chat = [@{@"owner": self.owner, @"localOnly": @(self.localOnly), @"atomic": @(self.atomic), @"reportedStart": @(self.reportedStart)} mutableCopy];
  if (self.ended) chat[@"ended"] = [self.ended copy];
  self.suspendedChat = chat;
  [self cancelPlayback:self.turn];
  self.owner = nil; self.ended = nil; self.lease = 0; self.turn = nil;
  [self clear:WhipSpeechCompleted error:nil];
}
- (void)announceStatus:(NSString *)owner resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![[self alertCommand:@"register" token:owner lease:0] isEqualToString:@"true"]) { resolve(@"busy"); return; }
  self.statusCallbacks[owner] = @{@"resolve": [resolve copy], @"reject": [reject copy]};
  [self alertUnit:owner];
  [self drainStatus];
}
- (void)refreshStatus { [self drainStatus]; }
- (BOOL)drainStatus
{
  for (WhipAlertUnit *unit in self.alertUnits.allValues) {
    if (!unit.prepared && [[self alertCommand:@"speech-only" token:unit.token lease:0] isEqualToString:@"true"]) unit.prepared = YES;
  }
  for (NSString *token in self.statusCallbacks.allKeys) {
    if (![token isEqualToString:self.statusOwner] && ![[self alertCommand:@"valid" token:token lease:0] isEqualToString:@"true"]) {
      RCTPromiseResolveBlock resolve = self.statusCallbacks[token][@"resolve"];
      [self.statusCallbacks removeObjectForKey:token];
      resolve(@"busy");
      WhipAlertUnit *unit = self.alertUnits[token];
      if (unit != self.currentAlert) {
        if (unit.prepared) unit.speech = NO;
        else { [self.alertUnits removeObjectForKey:token]; [self cancelPlayback:unit]; }
      }
    }
  }
  BOOL waiting = self.currentAlert != nil;
  for (WhipAlertUnit *unit in self.alertUnits.allValues) {
    if (!unit.prepared || unit == self.currentAlert || (unit.speech && !self.statusCallbacks[unit.token])) continue;
    waiting = YES;
    if (![self deferPlayback:unit block:^{ [self startAlert:unit]; }]) [self startAlert:unit];
  }
  return waiting;
}
- (WhipAlertUnit *)alertUnit:(NSString *)token
{
  WhipAlertUnit *unit = self.alertUnits[token];
  if (!unit) { unit = [WhipAlertUnit new]; unit.token = token; unit.speech = YES; self.alertUnits[token] = unit; }
  return unit;
}
- (void)prepareAlertNotification:(NSString *)notification effect:(NSString *)effect
{
  NSString *json = [self alertCommand:@"effect-alert" token:effect lease:0];
  NSDictionary *info = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (![info isKindOfClass:NSDictionary.class]) {
    [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:@[notification]];
    return;
  }
  WhipAlertUnit *unit = [self alertUnit:info[@"token"]];
  unit.notification = notification; unit.prepared = YES;
  unit.speech = [info[@"speech"] boolValue]; unit.silent = [info[@"silent"] boolValue];
  unit.persistent = [info[@"persistent"] boolValue];
  unit.timeout = MIN(60, MAX(1, [info[@"timeoutMs"] doubleValue] / 1000));
  [self drainStatus];
}
- (void)dismissAlertNotification:(NSString *)notification
{
  for (WhipAlertUnit *unit in self.alertUnits.allValues) {
    if (!notification || [unit.notification isEqualToString:notification]) [self finishAlert:unit.token reason:WhipSpeechStopped];
  }
  if (notification) [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:@[notification]];
}
- (void)startAlert:(WhipAlertUnit *)unit
{
  if (self.alertUnits[unit.token] != unit) { [self finishPlayback:unit]; return; }
  if ([self deferPlayback:unit block:^{ [self startAlert:unit]; }]) return;
  [self startPlayback:unit];
  if (![[self alertCommand:@"alert-valid" token:unit.token lease:0] isEqualToString:@"true"]) {
    [self finishAlert:unit.token reason:WhipSpeechStopped]; return;
  }
  self.currentAlert = unit;
  if (!unit.speech || ![[self alertCommand:@"valid" token:unit.token lease:0] isEqualToString:@"true"]) { [self ringAlert:unit]; return; }
  NSString *json = [self alertCommand:@"take-token" token:unit.token lease:self.lease];
  if ([json isEqualToString:@"null"]) { [self ringAlert:unit]; return; }
  NSDictionary *next = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (!next) { [self finishAlert:unit.token reason:WhipSpeechStopped]; return; }
  if (self.lease) {
    [self suspendChat];
  }
  NSString *token = next[@"token"];
  self.statusOwner = token;
  self.lease = [next[@"lease"] unsignedLongLongValue];
  self.kind = WhipSpeechAnnouncement;
  self.owner = token;
  self.turn = unit;
  self.localOnly = NO;
  __weak WhipSpeechPlayback *weakSelf = self;
  self.ended = ^(NSString *reason, NSString *error) {
    WhipSpeechPlayback *playback = weakSelf;
    playback.statusOwner = nil;
    [playback alertCommand:@"finish" token:token lease:0];
    NSDictionary *callbacks = playback.statusCallbacks[token];
    [playback.statusCallbacks removeObjectForKey:token];
    RCTPromiseResolveBlock resolve = callbacks[@"resolve"];
    RCTPromiseRejectBlock reject = callbacks[@"reject"];
    if (error) { if (reject) reject(WhipSpeechError, error, nil); }
    else if (resolve) resolve(reason);
    if (playback.alertUnits[token] == unit) {
      if ([reason isEqualToString:WhipSpeechCompleted] || error) [playback ringAlert:unit];
      else [playback finishAlert:token reason:reason];
    }
  };
  [self watchShake];
  [self play:next[@"text"] language:next[@"language"] rate:1];
}
- (void)ringAlert:(WhipAlertUnit *)unit
{
  if (self.alertUnits[unit.token] != unit || unit.ringing) return;
  unit.ringing = YES;
  if (unit.silent || !unit.notification) { [self finishAlert:unit.token reason:WhipSpeechCompleted]; return; }
  [self watchShake];
  [self playAlertRingtone:unit.token];
}
- (void)playAlertRingtone:(NSString *)token
{
  WhipAlertUnit *unit = self.alertUnits[token];
  if (!unit) return;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.currentAlert != unit || self.alertUnits[unit.token] != unit) return;
      if (settings.soundSetting != UNNotificationSettingEnabled) {
        [self finishAlert:unit.token reason:WhipSpeechCompleted]; return;
      }
      NSError *error = nil;
      AVAudioSession *audio = AVAudioSession.sharedInstance;
      NSString *category = unit.persistent ? AVAudioSessionCategoryPlayback : AVAudioSessionCategoryAmbient;
      if (![audio setCategory:category mode:AVAudioSessionModeDefault options:AVAudioSessionCategoryOptionMixWithOthers error:&error] || ![audio setActive:YES error:&error]) {
        [self finishAlert:unit.token reason:WhipSpeechStopped]; return;
      }
      self.audioActive = YES;
      self.ringtone = [[AVAudioPlayer alloc] initWithData:[self.class alertRingtoneData] error:&error];
      self.ringtone.delegate = self;
      self.ringtone.numberOfLoops = unit.persistent ? -1 : 0;
      if (!self.ringtone || ![self.ringtone play]) { [self finishAlert:unit.token reason:WhipSpeechStopped]; return; }
      self.ringtoneTimeout = [NSTimer scheduledTimerWithTimeInterval:unit.timeout repeats:NO block:^(NSTimer *timer) {
        if (self.currentAlert == unit) [self finishAlert:unit.token reason:WhipSpeechCompleted];
      }];
      [NSRunLoop.mainRunLoop addTimer:self.ringtoneTimeout forMode:NSRunLoopCommonModes];
    });
  }];
}
+ (NSData *)alertRingtoneData { return WhipAlertTone(); }
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag
{
  if (player == self.ringtone && self.currentAlert) [self finishAlert:self.currentAlert.token reason:WhipSpeechCompleted];
}
- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error
{
  if (player == self.ringtone && self.currentAlert) [self finishAlert:self.currentAlert.token reason:WhipSpeechStopped];
}
- (void)finishAlert:(NSString *)token reason:(NSString *)reason
{
  WhipAlertUnit *unit = self.alertUnits[token];
  if (!unit) return;
  [self.alertUnits removeObjectForKey:token];
  [self cancelPlayback:unit];
  if (self.currentAlert == unit) {
    self.currentAlert = nil;
    [self.ringtoneTimeout invalidate]; self.ringtoneTimeout = nil;
    [self.ringtone stop]; self.ringtone = nil;
    if (self.turn == unit && whip_speech_stop(self.lease)) [self clear:reason error:nil];
    [self.motion stopAccelerometerUpdates];
    [self releaseAudio];
  }
  RCTPromiseResolveBlock resolve = self.statusCallbacks[token][@"resolve"];
  [self.statusCallbacks removeObjectForKey:token];
  if (resolve) resolve(reason);
  if (![reason isEqualToString:WhipSpeechCompleted]) {
    [self alertCommand:@"dismiss-alert" token:token lease:0];
    if (unit.notification) [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:@[unit.notification]];
  }
  [self finishPlayback:unit];
  dispatch_async(dispatch_get_main_queue(), ^{ [self drainStatus]; [self resumeChat]; [self drainAutomatic]; });
}
- (void)resumeChat
{
  NSDictionary *previous = self.suspendedChat;
  if (!previous || self.lease) return;
  self.suspendedChat = nil;
  RCTPromiseResolveBlock completed = self.boundaryResolve;
  RCTPromiseRejectBlock failed = self.boundaryReject;
  self.boundaryResolve = nil;
  self.boundaryReject = nil;
  NSDictionary *pending = self.deferredChat;
  self.deferredChat = nil;
  __block BOOL ready = NO;
  [self queueSpeech:WhipSpeechChat owner:previous[@"owner"] request:@"" localOnly:[previous[@"localOnly"] boolValue] atomic:[previous[@"atomic"] boolValue] turn:nil ready:^{
    ready = YES;
    self.reportedStart = [previous[@"reportedStart"] boolValue];
    if (completed) completed(nil);
    if (pending) [self speakChat:previous[@"owner"] text:pending[@"text"] source:pending[@"source"] resolve:pending[@"resolve"] reject:pending[@"reject"]];
  } ended:^(NSString *reason, NSString *error) {
    void (^ended)(NSString *, NSString *) = previous[@"ended"];
    if (ended) ended(reason, error);
    if (!ready) {
      if (failed) failed(WhipSpeechError, error ?: @"Speech cancelled before resuming", nil);
      RCTPromiseRejectBlock reject = pending[@"reject"];
      if (reject) reject(WhipSpeechError, error ?: @"Speech cancelled before resuming", nil);
    }
  }];
}
- (void)discardSuspendedChat:(NSString *)reason error:(NSString *)error
{
  NSDictionary *previous = self.suspendedChat;
  if (!previous) return;
  self.suspendedChat = nil;
  if ([previous[@"owner"] isEqualToString:WhipAutomaticOwner]) [self automaticEnded:reason error:error];
  NSMutableDictionary *event = [@{@"token": previous[@"owner"], @"reason": reason} mutableCopy];
  if (error) event[@"error"] = error;
  [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechStopped object:self userInfo:event];
  RCTPromiseResolveBlock completed = self.boundaryResolve;
  RCTPromiseRejectBlock failed = self.boundaryReject;
  self.boundaryResolve = nil;
  self.boundaryReject = nil;
  NSDictionary *pending = self.deferredChat;
  self.deferredChat = nil;
  RCTPromiseResolveBlock resolve = pending[@"resolve"];
  RCTPromiseRejectBlock reject = pending[@"reject"];
  if (error) { if (failed) failed(WhipSpeechError, error, nil); if (reject) reject(WhipSpeechError, error, nil); }
  else { if (completed) completed(nil); if (resolve) resolve(nil); }
}

- (BOOL)begin:(enum WhipSpeechKind)kind owner:(NSString *)owner request:(NSString *)request ended:(void (^)(NSString *, NSString *))ended
{
  uint64_t lease = whip_speech_claim(kind, owner.UTF8String, request.UTF8String);
  if (!lease) return NO;
  if (kind == WhipSpeechChat) [self discardSuspendedChat:@"replaced" error:nil];
  [self clear:@"replaced" error:nil];
  self.lease = lease;
  self.localOnly = NO;
  self.reportedStart = NO;
  self.kind = kind;
  self.owner = owner;
  self.ended = ended;
  [self watchShake];
  return YES;
}
- (void)startChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self startChat:owner localOnly:NO atomic:NO turn:nil resolve:resolve reject:reject];
}
- (void)startResponse:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self startChat:owner localOnly:NO atomic:YES turn:nil resolve:resolve reject:reject];
}
- (void)startLocalChat:(NSString *)owner label:(NSString *)label callToken:(NSString *)callToken resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  id turn = callToken ? [WhipVoiceCall.shared playbackKey:callToken] : nil;
  if (!turn) { reject(WhipSpeechError, @"Voice chat is no longer active", nil); return; }
  [self startChat:owner localOnly:YES atomic:NO turn:turn resolve:resolve reject:reject];
}
- (void)startChat:(NSString *)owner localOnly:(BOOL)localOnly atomic:(BOOL)atomic turn:(id)turn resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  __block BOOL ready = NO;
  uint64_t identity = self.automaticId;
  [self queueSpeech:WhipSpeechChat owner:owner request:@"" localOnly:localOnly atomic:atomic turn:turn ready:^{ ready = YES; resolve(nil); }
    ended:^(NSString *reason, NSString *error) {
      if (!ready) {
        // Admission cancellation has no active lease for clear: to finish.
        // Preserve its reason before the rejected startup promise runs.
        if ([owner isEqualToString:WhipAutomaticOwner] && self.automaticId == identity && identity)
          [self automaticEnded:reason error:error];
        reject(WhipSpeechError, error ?: @"Speech cancelled before starting", nil);
      }
    }];
}
- (void)speakChat:(NSString *)owner text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self speakChat:owner text:text source:nil resolve:resolve reject:reject];
}
- (void)speakChat:(NSString *)owner text:(NSString *)text source:(NSDictionary *)source resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if ([self.suspendedChat[@"owner"] isEqualToString:owner] && !self.deferredChat) {
    self.deferredChat = @{@"text": text, @"source": source ?: @{}, @"resolve": [resolve copy], @"reject": [reject copy]};
    return;
  }
  if (self.kind != WhipSpeechChat || ![self.owner isEqualToString:owner] || self.utterance || !whip_speech_is_current(self.lease)) {
    reject(WhipSpeechError, @"Chat listening is no longer available for this utterance", nil);
    return;
  }
  id turn = self.turn;
  uint64_t lease = self.lease;
  NSDictionary *pending = @{@"text": text, @"source": source ?: @{}, @"resolve": [resolve copy], @"reject": [reject copy]};
  if ([self deferPlayback:turn block:^{
    if (self.lease == lease && self.deferredChat == pending) {
      self.deferredChat = nil;
      [self speakChat:owner text:text source:source resolve:resolve reject:reject];
    } else [self finishPlayback:turn];
  }]) { self.deferredChat = pending; return; }
  [self startPlayback:turn];
  self.atomicPlaying = self.atomic;
  [self watchShake];
  self.utteranceResolve = resolve;
  self.utteranceReject = reject;
  self.captionSource = source;
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
  [self queueSpeech:WhipSpeechAnnouncement owner:owner request:@"" localOnly:NO atomic:NO turn:nil ready:^{
    [self play:text language:language rate:1 started:nil preview:preview];
  } ended:^(NSString *reason, NSString *error) {
    if (error) reject(WhipSpeechError, error, nil); else resolve(reason);
  }];
}
- (void)speakDevice:(NSString *)owner request:(NSString *)request text:(NSString *)text language:(NSString *)language rate:(double)rate resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  __block BOOL acknowledged = NO;
  [self queueSpeech:WhipSpeechDevice owner:owner request:request localOnly:NO atomic:NO turn:nil ready:^{
    [self play:text language:language rate:rate started:^{
      acknowledged = YES;
      resolve(@{@"started": @YES});
    }];
  } ended:^(NSString *reason, NSString *error) {
    if (!acknowledged) reject(error ? @"device_unavailable" : @"cancelled", error ?: @"Speech request cancelled", nil);
  }];
}

- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate
{
  return [self play:text language:language rate:rate started:nil];
}
- (void)speakCallAnnouncement:(uint64_t)lease text:(NSString *)text completed:(dispatch_block_t)completed
{
  [self cancelCallAnnouncement];
  self.callAnnouncement = [self newCallAnnouncement];
  [self.callAnnouncement start:lease text:text voice:self.systemVoice completed:completed];
}
- (WhipCallAnnouncement *)newCallAnnouncement { return [WhipCallAnnouncement new]; }
- (void)cancelCallAnnouncement
{
  [self.callAnnouncement cancel];
  self.callAnnouncement = nil;
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started
{
  return [self play:text language:language rate:rate started:started preview:NO];
}
- (BOOL)play:(NSString *)text language:(NSString *)language rate:(double)rate started:(void (^)(void))started preview:(BOOL)preview
{
  NSString *requestedLanguage = language.length ? language : AVSpeechSynthesisVoice.currentLanguageCode;
  BOOL local = whip_speech_pcm_enabled(requestedLanguage.UTF8String, self.localOnly);
  BOOL cloud = !self.localOnly && whip_speech_network_selected();
  AVSpeechSynthesisVoice *voice = WhipConfiguredSystemVoice(self.systemVoice, requestedLanguage, language.length > 0);
  AVSpeechSynthesisVoice *selected = self.systemVoice.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:self.systemVoice] : nil;
  if (self.localOnly && !local && self.systemVoice.length && !selected) {
    [self stopWithReason:WhipSpeechStopped error:@"The voice selected in Settings is unavailable. Select an installed voice."];
    return NO;
  }
  if ((!local && !voice) || !isfinite(rate) || rate <= 0) {
    [self stopWithReason:WhipSpeechStopped error:@"Requested speech voice or rate is unavailable"];
    return NO;
  }
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  NSError *error = nil;
  if (!WhipVoiceCall.shared.active && (![audio setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeSpokenAudio
         options:AVAudioSessionCategoryOptionDuckOthers error:&error] || ![audio setActive:YES error:&error])) {
    [self stopWithReason:WhipSpeechStopped error:error.localizedDescription ?: @"Could not activate speech audio"];
    return NO;
  }
  self.audioActive = YES;
  AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  utterance.voice = voice;
  utterance.rate = MIN(AVSpeechUtteranceMaximumSpeechRate, MAX(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate));
  self.utterance = utterance;
  self.caption = self.kind == WhipSpeechChat && (!WhipVoiceCall.shared.active || self.localOnly) && self.captionSource.count
    ? [self.captionSource mutableCopy] : nil;
  self.captionPrefix = self.caption ? (NSInteger)text.length - (NSInteger)[self.caption[@"text"] length] : 0;
  self.captionClock = self.caption ? whip_speech_caption_start(text.UTF8String, MAX(0, self.captionPrefix)) : 0;
  self.caption[@"id"] = [NSString stringWithFormat:@"%llu", (unsigned long long)self.captionClock];
  self.captionPosition = -1;
  uint64_t lease = self.lease;
  NSTimeInterval timeout = whip_speech_timeout_ms(preview ? WhipSpeechChat : self.kind, text.length) / 1000.0;
  // Model initialization has its own watchdog. The ordinary Rust speech
  // deadline starts at the first PCM, after device-specific Core ML compilation.
  [self armSpeechTimeout:local ? WhipModelInitializationTimeout : timeout initialization:local];
  __weak WhipSpeechPlayback *weakSelf = self;
  if (local) {
    WhipPcmSpeechAudio *player = [WhipPcmSpeechAudio new];
    player.lease = lease;
    player.onLevel = ^(float level) {
      if (weakSelf.lease == lease && weakSelf.utterance == utterance) [weakSelf reportLevel:level];
    };
    player.onProgress = ^(NSUInteger played, NSUInteger samples, BOOL complete) {
      WhipSpeechPlayback *playback = weakSelf;
      if (playback.lease == lease && playback.utterance == utterance && playback.captionClock && played > 0)
        [playback reportCaption:whip_speech_caption_progress(playback.captionClock, played, samples, complete)];
    };
    void (^playbackStarted)(void) = ^{
      WhipSpeechPlayback *playback = weakSelf;
      if (playback.lease != lease || playback.utterance != utterance) return;
      [playback armSpeechTimeout:timeout initialization:NO];
      if (started) started();
    };
    player.onStarted = ^{
      if (weakSelf.lease == lease && weakSelf.utterance == utterance) [weakSelf reportStarted];
      playbackStarted();
    };
    self.pcm = player;
    if (![player open:rate error:&error]) {
      whip_speech_pcm_playback_failed();
      [player stop]; self.pcm = nil;
      if (self.localOnly || cloud) { [self stopWithReason:WhipSpeechStopped error:error.localizedDescription ?: @"The selected voice could not start."]; return NO; }
      [self.speech speakUtterance:utterance];
      playbackStarted();
      return YES;
    }
    uint64_t captionClock = self.captionClock;
    dispatch_async(WhipPcmSpeechWorker(), ^{
      int result = whip_speech_pcm_speak(lease, text.UTF8String, captionClock, WhipConsumeSpeechPcm, (__bridge void *)player,
                                         WhipReadOpenAiVoiceCredential, NULL);
      BOOL completed = result > 0 && [player drain];
      dispatch_async(dispatch_get_main_queue(), ^{
        WhipSpeechPlayback *playback = weakSelf;
        if (playback.lease != lease || playback.pcm != player || !whip_speech_is_current(lease)) return;
        if (completed && whip_speech_complete(lease)) {
          if (playback.kind == WhipSpeechChat) [playback finishUtterance:nil];
          else { [playback clear:WhipSpeechCompleted error:nil]; [playback drainStatus]; }
        } else if (result < 0 && !player.started && !playback.localOnly && !cloud) {
          [player stop]; playback.pcm = nil;
          [playback.speech speakUtterance:utterance];
          playbackStarted();
        } else [playback stopWithReason:WhipSpeechInterrupted error:result < 0 ? @"Speech synthesis failed. Check the selected backend in Settings." : nil];
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
  NSString *reason = kind == WhipSpeechChat && [owner isEqualToString:WhipAutomaticOwner] ? WhipSpeechReplaced : WhipSpeechStopped;
  BOOL waiting = [self cancelPendingSpeech:^BOOL(WhipPendingSpeech *pending) { return pending.kind == kind && [pending.owner isEqualToString:owner]; } reason:reason];
  if (kind == WhipSpeechAnnouncement && self.alertUnits[owner]) {
    [self finishAlert:owner reason:WhipSpeechStopped]; return YES;
  }
  if (kind == WhipSpeechChat && [self.suspendedChat[@"owner"] isEqualToString:owner]) {
    [self discardSuspendedChat:reason error:nil];
    return YES;
  }
  uint64_t stopped = whip_speech_stop_owner(kind, owner.UTF8String);
  if (!stopped || self.lease != stopped) return waiting;
  [self clear:reason error:nil];
  dispatch_async(dispatch_get_main_queue(), ^{ [self drainStatus]; });
  return YES;
}
- (void)cancelDeviceRequest:(NSString *)request
{
  [self cancelPendingSpeech:^BOOL(WhipPendingSpeech *pending) { return pending.kind == WhipSpeechDevice && [pending.request isEqualToString:request]; } reason:WhipSpeechStopped];
  uint64_t stopped = whip_speech_cancel_request(WhipSpeechDevice, request.UTF8String);
  if (stopped && self.lease == stopped) {
    [self clear:WhipSpeechStopped error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{ [self drainStatus]; });
  }
}
- (void)armSpeechTimeout:(NSTimeInterval)interval initialization:(BOOL)initialization
{
  [self.timer invalidate];
  uint64_t lease = self.lease;
  AVSpeechUtterance *utterance = self.utterance;
  __weak WhipSpeechPlayback *weakSelf = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:interval repeats:NO block:^(NSTimer *timer) {
    WhipSpeechPlayback *playback = weakSelf;
    if (!playback || playback.lease != lease || playback.utterance != utterance) return;
    NSTimeInterval delay = initialization ? 0 :
      [[playback alertCommand:@"playback-timeout-delay-ms" token:@"" lease:0] doubleValue] / 1000.0;
    if (delay > 0) [playback armSpeechTimeout:delay initialization:NO];
    else [playback stopWithReason:WhipSpeechStopped error:@"Speech playback timed out"];
  }];
  [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
}
- (void)stopDevice {
  [self cancelPendingSpeech:^BOOL(WhipPendingSpeech *pending) { return pending.kind == WhipSpeechDevice; } reason:WhipSpeechStopped];
  if (self.kind == WhipSpeechDevice) [self stopOwner:self.owner kind:self.kind];
}
- (void)stop { [self stopWithReason:WhipSpeechStopped error:nil]; }
- (void)cancel { [self stopWithReason:WhipSpeechReplaced error:nil]; }
- (void)stopWithReason:(NSString *)reason error:(NSString *)error
{
  if ([reason isEqualToString:@"shake"]) { [self shake]; return; }
  if (error || [reason isEqualToString:WhipSpeechInterrupted]) {
    if (self.currentAlert.ringing) [self finishAlert:self.currentAlert.token reason:reason];
    else if (whip_speech_stop(self.lease)) [self clear:reason error:error];
    return;
  }
  [self cancelPendingSpeech:^BOOL(WhipPendingSpeech *pending) { return YES; } reason:reason];
  for (WhipAlertUnit *unit in self.alertUnits.allValues) [self finishAlert:unit.token reason:reason];
  [self alertCommand:@"clear" token:@"" lease:0];
  [self discardSuspendedChat:reason error:error];
  for (NSString *token in self.statusCallbacks.allKeys) if (![token isEqualToString:self.statusOwner]) {
    RCTPromiseResolveBlock resolve = self.statusCallbacks[token][@"resolve"];
    [self.statusCallbacks removeObjectForKey:token];
    resolve(reason);
  }
  if (whip_speech_stop(self.lease)) [self clear:reason error:error];
}
- (void)shake
{
  if (self.currentAlert) { [self finishAlert:self.currentAlert.token reason:@"shake"]; return; }
  if ([WhipRealtimeVoice.shared shake]) return;
  if (whip_speech_stop(self.lease)) [self clear:@"shake" error:nil];
}
- (void)releaseAudio
{
  if (!self.audioActive) return;
  self.audioActive = NO;
  if (WhipVoiceCall.shared.active) return; // CallKit retains the session between conversation turns.
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error])
    NSLog(@"[SpeechPlayback] Could not release audio session: %@", error.localizedDescription);
}
- (void)finishUtterance:(NSString *)error
{
  // Chunk completion can precede the next chunk's audio. The session's clear:
  // path ends the caption; until then keep the last word and upcoming dimming.
  if (error) [self clearCaption];
  [self.levelTimer invalidate]; self.levelTimer = nil;
  [self reportLevel:0];
  [self.pcm stop];
  self.pcm = nil;
  [self.timer invalidate];
  self.timer = nil;
  self.utterance = nil;
  RCTPromiseResolveBlock resolve = self.utteranceResolve;
  RCTPromiseRejectBlock reject = self.utteranceReject;
  self.utteranceResolve = nil;
  self.utteranceReject = nil;
  [self releaseAudio];
  if (error) { if (reject) reject(WhipSpeechError, error, nil); }
  else if (resolve) {
    if (self.lease && self.kind == WhipSpeechChat && !self.atomicPlaying && !WhipVoiceCall.shared.active) {
      self.boundaryResolve = resolve;
      self.boundaryReject = reject;
      if ([self drainStatus]) { [self finishTurn:self.turn]; return; }
      self.boundaryResolve = nil;
      self.boundaryReject = nil;
    }
    [self finishTurn:self.turn];
    resolve(nil);
  }
}
- (void)clear:(NSString *)reason error:(NSString *)error
{
  [self clearCaption];
  self.captionSource = nil;
  NSString *owner = self.owner;
  if ([owner isEqualToString:WhipAutomaticOwner])
    NSLog(@"[SpeechPlayback] automatic-clear id=%llu lease=%llu reason=%@ failed=%d", self.automaticId, self.lease, reason, error != nil);
  id turn = self.turn;
  enum WhipSpeechKind kind = self.kind;
  void (^ended)(NSString *, NSString *) = self.ended;
  self.ended = nil;
  self.lease = 0;
  self.owner = nil;
  self.turn = nil;
  self.atomic = NO; self.atomicPlaying = NO;
  self.utterance = nil;
  [self.motion stopAccelerometerUpdates];
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  // Publish the stop before resolving the chunk so JS cannot drain another.
  if (owner && kind == WhipSpeechChat) {
    if ([owner isEqualToString:WhipAutomaticOwner]) [self automaticEnded:reason error:error];
    NSMutableDictionary *event = [@{@"token": owner} mutableCopy];
    if (reason) event[@"reason"] = reason;
    if (error) event[@"error"] = error;
    [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechStopped object:self userInfo:event];
  }
  [self finishUtterance:error];
  if (kind == WhipSpeechChat && ![self.suspendedChat[@"owner"] isEqualToString:owner]) {
    RCTPromiseResolveBlock deferred = self.deferredChat[@"resolve"];
    self.deferredChat = nil;
    if (deferred) deferred(nil);
  }
  if (ended) ended(reason, error);
  [self finishTurn:turn];
  dispatch_async(dispatch_get_main_queue(), ^{ [self resumeChat]; });
}
- (void)watchPlaybackShake { [self watchShake]; }
- (void)watchShake
{
  if (!self.motion.accelerometerAvailable) return;
  WhipAlertUnit *alert = self.currentAlert;
  id realtime = WhipRealtimeVoice.shared.playbackKey;
  if (!alert && !self.lease && !realtime) { [self.motion stopAccelerometerUpdates]; return; }
  self.motion.accelerometerUpdateInterval = WhipShakeInterval;
  uint64_t lease = self.lease;
  __weak WhipSpeechPlayback *weakSelf = self;
  [self.motion startAccelerometerUpdatesToQueue:NSOperationQueue.mainQueue withHandler:^(CMAccelerometerData *data, NSError *error) {
    WhipSpeechPlayback *playback = weakSelf;
    if (!data || playback.currentAlert != alert || (!alert && playback.lease != lease) || (!alert && WhipRealtimeVoice.shared.playbackKey != realtime)) return;
    CMAcceleration a = data.acceleration;
    double gravity = sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (isfinite(gravity) && gravity >= WhipShakeGravityThreshold) [playback shake];
  }];
}
- (void)audioInterrupted:(NSNotification *)notification
{
  uint64_t lease = self.lease;
  if ([notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan)
    dispatch_async(dispatch_get_main_queue(), ^{ if (self.lease == lease) [self stopWithReason:WhipSpeechInterrupted error:nil]; });
}
- (void)audioRouteChanged:(NSNotification *)notification
{
  uint64_t lease = self.lease;
  if ([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
    dispatch_async(dispatch_get_main_queue(), ^{ if (self.lease == lease) [self stopWithReason:WhipSpeechInterrupted error:nil]; });
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance != utterance || !whip_speech_complete(self.lease)) return;
    if (self.kind == WhipSpeechChat) [self finishUtterance:nil];
    else { [self clear:WhipSpeechCompleted error:nil]; [self drainStatus]; }
  });
}
- (void)reportStarted
{
  if (self.kind != WhipSpeechChat || self.reportedStart || !self.owner) return;
  self.reportedStart = YES;
  [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechStarted object:self userInfo:@{@"token": self.owner}];
}
- (void)reportLevel:(float)level
{
  if (self.kind == WhipSpeechChat && self.owner)
    [NSNotificationCenter.defaultCenter postNotificationName:WhipChatSpeechLevel object:self userInfo:@{@"token": self.owner, @"level": @(level)}];
}
- (void)reportCaption:(NSUInteger)position
{
  NSInteger contentPosition = (NSInteger)position - self.captionPrefix;
  if (!self.caption || contentPosition < 0 || contentPosition == self.captionPosition) return;
  self.captionPosition = contentPosition;
  self.caption[@"spokenUtf16"] = @([self.caption[@"startUtf16"] unsignedIntegerValue] + contentPosition);
  [NSNotificationCenter.defaultCenter postNotificationName:WhipSpeechCaption object:self userInfo:self.caption];
}
- (void)clearCaption
{
  if (self.caption) {
    NSMutableDictionary *ended = [self.caption mutableCopy]; ended[@"ended"] = @YES;
    [NSNotificationCenter.defaultCenter postNotificationName:WhipSpeechCaption object:self userInfo:ended];
  }
  self.caption = nil;
  self.captionClock = 0;
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer willSpeakRangeOfSpeechString:(NSRange)range utterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance != utterance) return;
    [self reportCaption:range.location];
    [self reportLevel:0.1 + MIN(range.length, 12) * 0.006];
    [self.levelTimer invalidate];
    __weak WhipSpeechPlayback *weakSelf = self;
    self.levelTimer = [NSTimer scheduledTimerWithTimeInterval:0.18 repeats:NO block:^(NSTimer *timer) { [weakSelf reportLevel:0]; }];
    [NSRunLoop.mainRunLoop addTimer:self.levelTimer forMode:NSRunLoopCommonModes];
  });
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didStartSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{ if (self.utterance == utterance) [self reportStarted]; });
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance == utterance) [self stopWithReason:WhipSpeechInterrupted error:nil];
  });
}
@end
