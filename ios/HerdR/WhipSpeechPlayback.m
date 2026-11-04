#import "WhipSpeechPlayback.h"
#import "../../packages/react-native-whip-ssh/ios/WhipVoiceCall.h"
#import "../../packages/react-native-whip-ssh/ios/WhipRealtimeVoice.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreMotion/CoreMotion.h>
#import <math.h>
#import <UIKit/UIKit.h>
#import <stdatomic.h>

NSString *const WhipChatSpeechStopped = @"WhipChatSpeechStopped";
NSString *const WhipChatSpeechStarted = @"WhipChatSpeechStarted";
NSString *const WhipChatSpeechLevel = @"WhipChatSpeechLevel";
NSString *const WhipAutomaticSpeechFocus = @"WhipAutomaticSpeechFocus";
static NSString *const WhipSpeechError = @"E_SPEECH";
static NSString *const WhipSpeechCompleted = @"completed";
static NSString *const WhipSpeechStopped = @"stopped";
static NSString *const WhipSpeechInterrupted = @"interrupted";
static NSString *const WhipAutomaticOwner = @"automatic-chat-speech";
static const double WhipShakeGravityThreshold = 2.7;
static const NSTimeInterval WhipShakeInterval = 0.02;
static const NSTimeInterval WhipModelInitializationTimeout = 60;

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
  if (self.levelTapInstalled) { [self.engine.mainMixerNode removeTapOnBus:0]; self.levelTapInstalled = NO; }
  [self.engine stop];
}
@end

static bool WhipConsumeSpeechPcm(void *context, const float *samples, uintptr_t count)
{
  @autoreleasepool { return [(__bridge WhipPcmSpeechAudio *)context write:samples count:count]; }
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
@property(nonatomic, strong) WhipPcmSpeechAudio *pcm;
@property(nonatomic, copy) NSString *systemVoice;
@property(nonatomic) BOOL localOnly;
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
  WhipAutomaticCommand(@{@"action": action, [action isEqualToString:@"enable"] ? @"enabled" : @"paused": @(value)});
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
      (self.owner && ![self.owner isEqualToString:WhipAutomaticOwner]) ||
      !UIApplication.sharedApplication.protectedDataAvailable) return;
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
    [playback speakChat:WhipAutomaticOwner text:next[@"text"] resolve:^(id value) {
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
      ![self.suspendedChat[@"owner"] isEqualToString:WhipAutomaticOwner]) [self stop];
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
  if ([@[@"system", @"phonon", @"openai", @"delete"] containsObject:action] ||
      [action hasPrefix:@"openai-voice:"] || [action hasPrefix:@"voice:"] || [action hasPrefix:@"system-voice:"] || [action hasPrefix:@"remove-voice:"]) [self stop];
  static dispatch_queue_t settings;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ settings = dispatch_queue_create("whip.speech.settings", DISPATCH_QUEUE_SERIAL); });
  dispatch_async(settings, ^{
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
      self.systemVoice = status[@"systemVoice"];
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
- (void)announceStatus:(NSString *)owner resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![[self alertCommand:@"register" token:owner lease:0] isEqualToString:@"true"]) { resolve(@"busy"); return; }
  self.statusCallbacks[owner] = @{@"resolve": [resolve copy], @"reject": [reject copy]};
  [self drainStatus];
}
- (void)refreshStatus { [self drainStatus]; }
- (BOOL)drainStatus
{
  for (NSString *token in self.statusCallbacks.allKeys) {
    if (![token isEqualToString:self.statusOwner] && ![[self alertCommand:@"valid" token:token lease:0] isEqualToString:@"true"]) {
      RCTPromiseResolveBlock resolve = self.statusCallbacks[token][@"resolve"];
      [self.statusCallbacks removeObjectForKey:token];
      resolve(@"busy");
    }
  }
  if (self.utterance || self.pcm || (self.lease && self.kind != WhipSpeechChat) || WhipVoiceCall.shared.active) return NO;
  NSString *json = [self alertCommand:@"take" token:@"" lease:self.lease];
  if ([json isEqualToString:@"null"]) {
    [self resumeChat];
    dispatch_async(dispatch_get_main_queue(), ^{ [self drainAutomatic]; });
    return NO;
  }
  NSDictionary *next = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (!next) return NO;
  if (self.lease) {
    NSMutableDictionary *chat = [@{@"owner": self.owner, @"localOnly": @(self.localOnly), @"reportedStart": @(self.reportedStart)} mutableCopy];
    if (self.ended) chat[@"ended"] = [self.ended copy];
    self.suspendedChat = chat;
    // Detach without publishing a user stop or settling the held chunk.
    self.owner = nil;
    self.ended = nil;
    self.lease = 0;
    [self clear:WhipSpeechCompleted error:nil];
  }
  NSString *token = next[@"token"];
  self.statusOwner = token;
  self.lease = [next[@"lease"] unsignedLongLongValue];
  self.kind = WhipSpeechAnnouncement;
  self.owner = token;
  self.localOnly = NO;
  __weak WhipSpeechPlayback *weakSelf = self;
  self.ended = ^(NSString *reason, NSString *error) {
    WhipSpeechPlayback *playback = weakSelf;
    playback.statusOwner = nil;
    if (![reason isEqualToString:@"shake"]) [playback alertCommand:@"finish" token:token lease:0];
    NSDictionary *callbacks = playback.statusCallbacks[token];
    [playback.statusCallbacks removeObjectForKey:token];
    RCTPromiseResolveBlock resolve = callbacks[@"resolve"];
    RCTPromiseRejectBlock reject = callbacks[@"reject"];
    if (error) { if (reject) reject(WhipSpeechError, error, nil); }
    else if (resolve) resolve(reason);
    dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf drainStatus]; });
  };
  [self watchShake];
  [self play:next[@"text"] language:next[@"language"] rate:1];
  return YES;
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
  if (![self begin:WhipSpeechChat owner:previous[@"owner"] request:@"" ended:previous[@"ended"]]) {
    if (failed) failed(WhipSpeechError, @"Could not resume chat speech", nil);
    RCTPromiseRejectBlock reject = pending[@"reject"];
    if (reject) reject(WhipSpeechError, @"Could not resume chat speech", nil);
    return;
  }
  self.localOnly = [previous[@"localOnly"] boolValue];
  self.reportedStart = [previous[@"reportedStart"] boolValue];
  if (completed) completed(nil);
  if (pending) [self speakChat:previous[@"owner"] text:pending[@"text"] resolve:pending[@"resolve"] reject:pending[@"reject"]];
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
  [self discardSuspendedChat:@"replaced" error:nil];
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
  if (![self begin:WhipSpeechChat owner:owner request:@"" ended:nil]) {
    reject(WhipSpeechError, @"Could not start chat speech", nil);
    return;
  }
  resolve(nil);
}
- (void)startLocalChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self startChat:owner label:label resolve:resolve reject:reject];
  if ([self.owner isEqualToString:owner]) self.localOnly = YES;
}
- (void)speakChat:(NSString *)owner text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if ([self.suspendedChat[@"owner"] isEqualToString:owner] && !self.deferredChat) {
    self.deferredChat = @{@"text": text, @"resolve": [resolve copy], @"reject": [reject copy]};
    return;
  }
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
  BOOL local = whip_speech_pcm_enabled(requestedLanguage.UTF8String, self.localOnly);
  BOOL cloud = !self.localOnly && whip_speech_network_selected();
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:requestedLanguage];
  AVSpeechSynthesisVoice *selected = self.systemVoice.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:self.systemVoice] : nil;
  if (self.localOnly && !local && self.systemVoice.length && !selected) {
    [self stopWithReason:WhipSpeechStopped error:@"The voice selected in Settings is unavailable. Select an installed voice."];
    return NO;
  }
  if (selected && (!language.length ||
      [[selected.language componentsSeparatedByString:@"-"].firstObject caseInsensitiveCompare:
       [requestedLanguage componentsSeparatedByString:@"-"].firstObject] == NSOrderedSame)) voice = selected;
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
    WhipPcmSpeechAudio *player = [WhipPcmSpeechAudio new];
    player.lease = lease;
    player.onLevel = ^(float level) {
      if (weakSelf.lease == lease && weakSelf.utterance == utterance) [weakSelf reportLevel:level];
    };
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
    dispatch_async(WhipPcmSpeechWorker(), ^{
      int result = whip_speech_pcm_speak(lease, text.UTF8String, WhipConsumeSpeechPcm, (__bridge void *)player,
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
  if (kind == WhipSpeechChat && [self.suspendedChat[@"owner"] isEqualToString:owner]) {
    [self discardSuspendedChat:WhipSpeechStopped error:nil];
    return YES;
  }
  uint64_t stopped = whip_speech_stop_owner(kind, owner.UTF8String);
  if (!stopped || self.lease != stopped) return NO;
  [self clear:WhipSpeechStopped error:nil];
  dispatch_async(dispatch_get_main_queue(), ^{ [self drainStatus]; });
  return YES;
}
- (void)cancelDeviceRequest:(NSString *)request
{
  uint64_t stopped = whip_speech_cancel_request(WhipSpeechDevice, request.UTF8String);
  if (stopped && self.lease == stopped) {
    [self clear:WhipSpeechStopped error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{ [self drainStatus]; });
  }
}
- (void)stopDevice { if (self.kind == WhipSpeechDevice) [self stopOwner:self.owner kind:self.kind]; }
- (void)stop { [self stopWithReason:WhipSpeechStopped error:nil]; }
- (void)stopWithReason:(NSString *)reason error:(NSString *)error
{
  [self alertCommand:@"clear" token:@"" lease:0];
  [self discardSuspendedChat:reason error:error];
  for (NSString *token in self.statusCallbacks.allKeys) if (![token isEqualToString:self.statusOwner]) {
    RCTPromiseResolveBlock resolve = self.statusCallbacks[token][@"resolve"];
    [self.statusCallbacks removeObjectForKey:token];
    resolve(reason);
  }
  if (whip_speech_stop(self.lease)) [self clear:reason error:error];
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
    if (self.lease && self.kind == WhipSpeechChat) {
      self.boundaryResolve = resolve;
      self.boundaryReject = reject;
      if ([self drainStatus]) return;
      self.boundaryResolve = nil;
      self.boundaryReject = nil;
    }
    resolve(nil);
  }
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
    if ([owner isEqualToString:WhipAutomaticOwner]) [self automaticEnded:reason error:error];
    NSMutableDictionary *event = [@{@"token": owner} mutableCopy];
    if (reason) event[@"reason"] = reason;
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
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer willSpeakRangeOfSpeechString:(NSRange)range utterance:(AVSpeechUtterance *)utterance
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.utterance != utterance) return;
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
