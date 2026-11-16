#import "WhipRealtimeVoice.h"
#import "WhipCallPlaybackBoundary.h"
#import "../../../ios/HerdR/WhipSpeechPlayback.h"
#import "WhipVoiceCall.h"
#import "../cpp/WhipRealtimeVoice.h"
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#include <atomic>
#import "WhipAudioInterruption.h"
#import <mach/mach_time.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>

// Same generic-password item written by react-native-keychain. Read-only: no
// migration, synchronization, prompts, access-control changes or NSString key.
int32_t WhipReadOpenAiVoiceCredential(void *, uint8_t *destination, size_t capacity) {
  @autoreleasepool {
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return WhipVoiceCredentialUnavailable;
    if (!UIApplication.sharedApplication.protectedDataAvailable) return WhipVoiceCredentialLocked;
    LAContext *authentication = [LAContext new];
    authentication.interactionNotAllowed = YES;
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: @"io.github.kaminarios.whip.openai.voice",
      (__bridge id)kSecAttrSynchronizable: @NO,
      (__bridge id)kSecReturnData: @YES,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
      (__bridge id)kSecUseAuthenticationContext: authentication,
    };
    CFTypeRef result = nullptr;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    [authentication invalidate];
    if (status != errSecSuccess) {
      if (result) CFRelease(result);
      if (status == errSecItemNotFound) return WhipVoiceCredentialMissing;
      if (status == errSecInteractionNotAllowed || status == errSecAuthFailed) return WhipVoiceCredentialLocked;
      if (status == errSecNotAvailable || status == errSecMissingEntitlement) return WhipVoiceCredentialUnavailable;
      return WhipVoiceCredentialFailed;
    }
    NSData *data = CFBridgingRelease(result);
    if (!UIApplication.sharedApplication.protectedDataAvailable) return WhipVoiceCredentialLocked;
    if (!data.length || data.length > capacity) return WhipVoiceCredentialFailed;
    memcpy(destination, data.bytes, data.length);
    return (int32_t)data.length;
  }
}

@interface WhipRealtimeVoice () {
  std::atomic<uint64_t> _call;
  std::atomic<bool> _audioSuspended;
  std::atomic<uint64_t> _captureAfter;
  std::atomic<unsigned> _diagnosticEvents;
  WhipAudioInterruption _interruption;
  WhipCallPlaybackBoundary _announcementBoundary;
}
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *lastToken;
@property(nonatomic, copy) NSString *lastView;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVAudioPlayerNode *player;
@property(nonatomic, strong) AVAudioConverter *converter;
@property(nonatomic, strong) AVAudioPCMBuffer *capture;
@property(nonatomic, strong) AVAudioFormat *format;
@property(nonatomic, strong) dispatch_source_t timer;
@property(atomic, strong) NSNumber *announcementId;
@property(nonatomic, strong) dispatch_queue_t media;
@property(nonatomic) uint64_t epoch;
@property(nonatomic) NSUInteger queued;
@property(nonatomic) NSUInteger ticks;
@property(nonatomic) uint64_t closingCall;
@property(nonatomic) BOOL preview;
@property(nonatomic, strong) NSTimer *recoveryTimeout;
@property(nonatomic, strong) id turn;
@property(nonatomic, strong) id closingTurn;
@property(nonatomic, strong) NSDictionary *pendingStart;
@end

@implementation WhipRealtimeVoice
- (id)playbackKey { return self.token ? self.turn : nil; }
- (BOOL)shake {
  if (!self.token) return NO;
  if (self.preview) [self stop:self.token];
  else whip_realtime_control(_call.load(), WhipRealtimeSkip);
  return YES;
}
+ (instancetype)shared { static WhipRealtimeVoice *owner; static dispatch_once_t once; dispatch_once(&once, ^{ owner = [WhipRealtimeVoice new]; }); return owner; }
- (instancetype)init {
  if ((self = [super init])) {
    _call.store(0);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(protectedDataAvailable:) name:UIApplicationProtectedDataDidBecomeAvailable object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(protectedDataLost:) name:UIApplicationProtectedDataWillBecomeUnavailable object:nil];
    _media = dispatch_queue_create("whip.realtime.media", DISPATCH_QUEUE_SERIAL);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(audioChanged:) name:AVAudioEngineConfigurationChangeNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(backgrounded:) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}
- (void)credentialsUpdating:(BOOL)updating {
  whip_voice_credentials_updating(updating);
  if (updating) [self invalidate];
}
- (void)invalidate {
  whip_realtime_prepare(false);
  if (self.pendingStart) [self stop:self.pendingStart[@"token"]];
  if (self.token) { [self stop:self.token]; [WhipVoiceCall.shared invalidate]; }
}
- (void)prepare:(BOOL)enabled {
  whip_realtime_prepare(enabled && UIApplication.sharedApplication.applicationState == UIApplicationStateActive && UIApplication.sharedApplication.protectedDataAvailable);
}
- (void)protectedDataAvailable:(NSNotification *)notification {
  dispatch_async(dispatch_get_main_queue(), ^{ [self resumeAudioIfAllowed]; });
}
- (void)protectedDataLost:(NSNotification *)notification {
  whip_realtime_prepare(false);
  if (self.preview && self.token) [self stop:self.token];
  if ([self.pendingStart[@"preview"] boolValue]) [self stop:self.pendingStart[@"token"]];
  // An admitted phone call retains its native credential and audio owner.
  // Protected UI/tool checks remain independent of transport continuity.
}
- (void)start:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [self start:token config:config preview:NO resolve:resolve reject:reject];
}
- (void)preview:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) { reject(@"E_REALTIME", @"Return to Whip to preview a voice.", nil); return; }
  [self start:token config:config preview:YES resolve:resolve reject:reject];
}
- (void)start:(NSString *)token config:(NSString *)config preview:(BOOL)preview resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (self.token || self.pendingStart || (preview ? WhipVoiceCall.shared.active : ![WhipVoiceCall.shared owns:token])) {
    reject(@"E_REALTIME", @"The requested voice audio session is unavailable.", nil); return;
  }
  id turn = [WhipVoiceCall.shared playbackKey:token] ?: [NSObject new];
  NSDictionary *pending = @{@"token": token, @"preview": @(preview), @"reject": [reject copy], @"turn": turn};
  self.pendingStart = pending;
  dispatch_block_t start = ^{
    if (self.pendingStart != pending) { if (preview) [WhipSpeechPlayback.shared finishPlayback:turn]; return; }
    self.pendingStart = nil;
    [self startAdmitted:token config:config preview:preview turn:turn resolve:resolve reject:reject];
  };
  if (![WhipSpeechPlayback.shared deferPlayback:turn block:start]) start();
}
- (void)startAdmitted:(NSString *)token config:(NSString *)config preview:(BOOL)preview turn:(id)turn resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)callerReject {
  RCTPromiseRejectBlock reject = ^(NSString *code, NSString *message, NSError *error) {
    if (preview && self.closingTurn != turn) [WhipSpeechPlayback.shared finishPlayback:turn];
    callerReject(code, message, error);
  };
  [WhipSpeechPlayback.shared startPlayback:turn];
  [WhipSpeechPlayback.shared yieldIdlePlayback];
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive || !UIApplication.sharedApplication.protectedDataAvailable) { reject(@"E_VOICE_CREDENTIAL_LOCKED", @"Unlock Whip to start voice.", nil); return; }
  if (self.token || (preview ? WhipVoiceCall.shared.active : ![WhipVoiceCall.shared owns:token])) { reject(@"E_REALTIME", @"The requested voice audio session is unavailable.", nil); return; }
  NSData *requestedConfig = [config dataUsingEncoding:NSUTF8StringEncoding];
  if (!requestedConfig) { reject(@"E_REALTIME", @"Invalid voice configuration.", nil); return; }
  NSMutableDictionary *nativeConfig = [NSJSONSerialization JSONObjectWithData:requestedConfig options:NSJSONReadingMutableContainers error:nil];
  if (![nativeConfig isKindOfClass:NSMutableDictionary.class]) { reject(@"E_REALTIME", @"Invalid voice configuration.", nil); return; }
  nativeConfig[@"preview"] = @(preview);
  // Rust owns the same public WebRTC transport on both platforms. Apple's
  // voice-processing I/O remains the echo canceller and device owner on iOS.
  nativeConfig[@"webrtc"] = @YES;
  nativeConfig[@"softwareEchoCancellation"] = @NO;
  NSData *nativeData = [NSJSONSerialization dataWithJSONObject:nativeConfig options:0 error:nil];
  if (!nativeData) { reject(@"E_REALTIME", @"Invalid voice configuration.", nil); return; }
  NSString *nativeJSON = [[NSString alloc] initWithData:nativeData encoding:NSUTF8StringEncoding];
  NSError *error = nil;
  AVAudioEngine *engine = [AVAudioEngine new];
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:WhipRealtimeSampleRate channels:1 interleaved:NO];
  AVAudioInputNode *input = nil;
  AVAudioFormat *source = nil;
  AVAudioConverter *converter = nil;
  if (preview) {
    if (![AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:&error] ||
        ![AVAudioSession.sharedInstance setActive:YES error:&error]) { reject(@"E_REALTIME", @"Media audio could not start.", nil); return; }
  } else {
    input = engine.inputNode;
    // Apple's voice-processing I/O supplies native echo cancellation for full duplex.
    if (![input setVoiceProcessingEnabled:YES error:&error]) { reject(@"E_REALTIME", @"Native echo cancellation could not start.", nil); return; }
    source = [input outputFormatForBus:0];
    converter = [[AVAudioConverter alloc] initFromFormat:source toFormat:format];
    if (!converter || source.sampleRate <= 0) { reject(@"E_REALTIME", @"The microphone audio format is unavailable.", nil); return; }
  }
  int64_t result = whip_realtime_start(nativeJSON.UTF8String, WhipReadOpenAiVoiceCredential, nullptr);
  if (result <= 0) {
    if (preview) [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    NSString *code = @"E_REALTIME";
    switch (result) {
      case WhipVoiceCredentialMissing: code = @"E_VOICE_CREDENTIAL_MISSING"; break;
      case WhipVoiceCredentialLocked: code = @"E_VOICE_CREDENTIAL_LOCKED"; break;
      case WhipVoiceCredentialUnavailable: code = @"E_VOICE_CREDENTIAL_UNAVAILABLE"; break;
      case WhipVoiceCredentialFailed: code = @"E_VOICE_CREDENTIAL_FAILED"; break;
    }
    reject(code, @"Realtime could not start. Check the saved API credential and audio support.", nil); return;
  }
  uint64_t call = (uint64_t)result;
  if (WhipVoiceCall.shared.muted) whip_realtime_control(call, WhipRealtimeMute);
  self.token = token; self.preview = preview; _call.store(call);
  _audioSuspended.store(false); _captureAfter.store(mach_absolute_time());
  _interruption.reset(preview || [WhipVoiceCall.shared owns:token]);
  _diagnosticEvents.store(0);
  self.turn = turn;
  [WhipSpeechPlayback.shared watchPlaybackShake];
  self.engine = engine; self.format = format; self.converter = converter;
  if (!preview) self.capture = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:WhipRealtimeMaxFrame];
  self.player = [AVAudioPlayerNode new];
  [engine attachNode:self.player];
  [engine connect:self.player to:engine.mainMixerNode format:format];
  __weak WhipRealtimeVoice *weakSelf = self;
  // The engine invokes its tap serially. PCM conversion and upload stay native.
  AVAudioPCMBuffer *capture = self.capture;
  if (!preview) [input installTapOnBus:0 bufferSize:WhipRealtimeFrame * 2 format:source block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    WhipRealtimeVoice *owner = weakSelf;
    if (!owner) return;
    @synchronized (converter) {
    if (owner->_call.load() != call || owner->_audioSuspended.load() || when.hostTime < owner->_captureAfter.load()) return;
    uint64_t generation = whip_realtime_input_generation(call);
    __block BOOL supplied = NO;
    NSError *conversionError = nil;
    capture.frameLength = 0;
    AVAudioConverterOutputStatus status = [converter convertToBuffer:capture error:&conversionError withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *state) {
      if (supplied) { *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
      supplied = YES; *state = AVAudioConverterInputStatus_HaveData; return buffer;
    }];
    if (status == AVAudioConverterOutputStatus_Error || conversionError) {
      if (!owner->_audioSuspended.load() && whip_realtime_input_generation(call) == generation) whip_realtime_control(call, WhipRealtimeAudioFailed);
      return;
    }
    if (capture.frameLength && !owner->_audioSuspended.load()) {
      double age = [AVAudioTime secondsForHostTime:mach_absolute_time()] - [AVAudioTime secondsForHostTime:when.hostTime];
      if (when.hostTime && age >= 0 && age <= 0.5)
        whip_realtime_capture_timed(call, capture.int16ChannelData[0], capture.frameLength, generation, (uint64_t)(age * NSEC_PER_SEC));
    }
    }
  }];
  if (![engine startAndReturnError:&error]) {
    [self stop:token]; reject(@"E_REALTIME", @"The native audio engine could not start.", nil); return;
  }
  [self.player play];
  whip_realtime_control(call, WhipRealtimeMediaReady);
  self.epoch = 0; _announcementBoundary.reset(0); self.queued = 0;
  self.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.media);
  dispatch_source_set_timer(self.timer, DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC, NSEC_PER_MSEC);
  dispatch_source_set_event_handler(self.timer, ^{ [weakSelf pump:call token:token]; });
  dispatch_resume(self.timer);
  resolve(nil);
}
- (void)pump:(uint64_t)call token:(NSString *)token {
  if (_call.load() != call) return;
  uint64_t currentEpoch = whip_realtime_epoch(call);
  if (!_audioSuspended.load() && currentEpoch != self.epoch) {
    [self.player stop];
    self.epoch = currentEpoch; _announcementBoundary.reset(currentEpoch); self.queued = 0;
    [self.player play];
  }
  char *json = (++self.ticks % 10 == 0) ? whip_realtime_view(call) : nullptr;
  if (json) {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    NSDictionary *view = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    whip_realtime_free(json);
    NSDictionary *announcement = [view[@"microphoneAnnouncement"] isKindOfClass:NSDictionary.class] ? view[@"microphoneAnnouncement"] : nil;
    if (!self.preview && [announcement[@"cancelled"] boolValue]) {
      NSNumber *identity = announcement[@"id"];
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() != call || ![self.announcementId isEqual:identity]) return;
        self.announcementId = nil;
        [WhipSpeechPlayback.shared cancelCallAnnouncement];
        whip_realtime_announcement_finished(call, identity.unsignedLongLongValue);
      });
    } else if (!self.preview && announcement && ![self.announcementId isEqual:announcement[@"id"]] &&
               _announcementBoundary.drained() &&
               whip_realtime_announcement_start(call, [announcement[@"id"] unsignedLongLongValue])) {
      NSNumber *identity = announcement[@"id"];
      self.announcementId = identity;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() != call || ![self.announcementId isEqual:identity]) {
          whip_realtime_announcement_finished(call, identity.unsignedLongLongValue);
          return;
        }
        [WhipSpeechPlayback.shared speakCallAnnouncement:[announcement[@"lease"] unsignedLongLongValue] text:announcement[@"text"] beforePlayback:^BOOL {
          return whip_realtime_announcement_playing(call, identity.unsignedLongLongValue);
        } completed:^{
          whip_realtime_announcement_finished(call, identity.unsignedLongLongValue);
        }];
      });
    } else if (!announcement && self.announcementId) {
      self.announcementId = nil;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() == call && !self.announcementId) [WhipSpeechPlayback.shared cancelCallAnnouncement];
      });
    }
    if (!self.preview && view[@"muted"]) {
      BOOL muted = [view[@"muted"] boolValue];
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() == call) [WhipVoiceCall.shared syncMuted:token muted:muted];
      });
    }
    if ([view[@"phase"] isEqualToString:@"error"] || [view[@"phase"] isEqualToString:@"closed"]) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() != call) return;
        BOOL preview = self.preview;
        [self stop:token];
        if (!preview) [WhipVoiceCall.shared end:token resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) {}];
      });
      return;
    }
  }
  if (_audioSuspended.load() || self.queued >= 4) return;
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.format frameCapacity:WhipRealtimeFrame];
  uint64_t epoch = 0;
  NSUInteger count = whip_realtime_read(call, buffer.int16ChannelData[0], WhipRealtimeFrame, &epoch);
  if (epoch != self.epoch) {
    [self.player stop];
    self.epoch = epoch; _announcementBoundary.reset(epoch); self.queued = 0;
    [self.player play];
  }
  NSUInteger providerCount = count;
  if (!count) {
    if (self.preview) return;
    count = WhipRealtimeFrame;
    memset(buffer.int16ChannelData[0], 0, count * sizeof(int16_t));
  }
  whip_realtime_mix_cue(call, buffer.int16ChannelData[0], count);
  buffer.frameLength = (AVAudioFrameCount)count;
  self.queued++;
  uint64_t played = _announcementBoundary.schedule(providerCount);
  __weak WhipRealtimeVoice *weakSelf = self;
  [self.player scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) {
    WhipRealtimeVoice *owner = weakSelf;
    if (!owner) return;
    dispatch_async(owner.media, ^{
      if (owner->_call.load() != call || owner->_audioSuspended.load() || !owner->_announcementBoundary.complete(epoch, played)) return;
      if (owner.queued) owner.queued--;
      whip_realtime_played(call, epoch, played);
    });
  }];
}
- (void)stop:(NSString *)token {
  if ([self.pendingStart[@"token"] isEqualToString:token]) {
    NSDictionary *pending = self.pendingStart; self.pendingStart = nil;
    [WhipSpeechPlayback.shared cancelPlayback:pending[@"turn"]];
    if ([pending[@"preview"] boolValue]) [WhipSpeechPlayback.shared finishPlayback:pending[@"turn"]];
    RCTPromiseRejectBlock reject = pending[@"reject"];
    reject(@"E_REALTIME", @"Voice audio was cancelled before playback started.", nil);
  }
  if (![self.token isEqualToString:token]) return;
  id turn = self.turn;
  BOOL preview = self.preview;
  uint64_t call = _call.exchange(0);
  _audioSuspended.store(true);
  [self.recoveryTimeout invalidate]; self.recoveryTimeout = nil;
  self.announcementId = nil;
  [WhipSpeechPlayback.shared cancelCallAnnouncement];
  self.lastToken = token;
  char *view = whip_realtime_view(call);
  self.lastView = view ? [NSString stringWithUTF8String:view] : @"{\"phase\":\"closed\"}";
  whip_realtime_free(view);
  if (self.preview) {
    NSMutableDictionary *last = [[NSJSONSerialization JSONObjectWithData:[self.lastView dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:nil] mutableCopy];
    if (![last[@"phase"] isEqualToString:@"error"]) {
      last[@"phase"] = @"closed";
      self.lastView = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:last options:0 error:nil] encoding:NSUTF8StringEncoding];
    }
  }
  if (self.timer) { dispatch_source_cancel(self.timer); self.timer = nil; }
  if (!self.preview) [self.engine.inputNode removeTapOnBus:0];
  // Drain the media queue before releasing nodes or allowing a replacement.
  dispatch_sync(self.media, ^{ [self.player stop]; [self.engine stop]; });
  if (self.preview) [AVAudioSession.sharedInstance setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
  whip_realtime_stop(call);
  self.closingCall = call;
  if (preview) self.closingTurn = turn;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    while (!whip_realtime_stopped(call)) [NSThread sleepForTimeInterval:0.005];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (preview) { [WhipSpeechPlayback.shared finishPlayback:turn]; if (self.closingTurn == turn) self.closingTurn = nil; }
    });
  });
  self.player = nil; self.engine = nil; self.converter = nil; self.capture = nil; self.format = nil; self.token = nil;
  self.turn = nil;
  [WhipSpeechPlayback.shared watchPlaybackShake];
}
- (void)stop:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve {
  [self stop:token];
  uint64_t call = [self.lastToken isEqualToString:token] ? self.closingCall : 0;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    while (!whip_realtime_stopped(call)) [NSThread sleepForTimeInterval:0.005];
    dispatch_async(dispatch_get_main_queue(), ^{ resolve(nil); });
  });
}
- (void)control:(NSString *)token action:(uint8_t)action { if ([self.token isEqualToString:token]) whip_realtime_control(_call.load(), action); }
- (BOOL)submitted:(NSString *)token text:(NSString *)text {
  if (![self.token isEqualToString:token]) return NO;
  NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
  return bytes && whip_realtime_submitted(_call.load(), (const uint8_t *)bytes.bytes, bytes.length);
}
- (void)mute:(NSString *)token muted:(BOOL)muted { [self control:token action:muted ? WhipRealtimeMute : WhipRealtimeUnmute]; }
- (NSString *)view:(NSString *)token {
  if (![self.token isEqualToString:token]) return [self.lastToken isEqualToString:token] ? self.lastView : @"{\"phase\":\"closed\"}";
  char *view = whip_realtime_view(_call.load());
  NSString *result = view ? [NSString stringWithUTF8String:view] : @"{\"phase\":\"closed\"}";
  whip_realtime_free(view); return result;
}
- (void)audioChanged:(NSNotification *)notification {
  AVAudioEngine *engine = notification.object;
  // Configuration notifications arrive on an internal engine queue, including
  // while startup is still settling. Recheck on the owner's queue and restart
  // the existing graph without replacing the Rust call or its media session.
  dispatch_async(dispatch_get_main_queue(), ^{
    uint64_t call = self->_call.load();
    if (!call || engine != self.engine || engine.running || self->_audioSuspended.load() || !self->_interruption.canResume()) return;
    dispatch_sync(self.media, ^{
      if (self->_call.load() != call || engine.running || self->_audioSuspended.load()) return;
      NSError *error = nil;
      if (![engine startAndReturnError:&error]) {
        whip_realtime_control(call, WhipRealtimeAudioFailed);
        return;
      }
      [self.player play];
    });
  });
}
- (void)suspendAudio {
  uint64_t call = _call.load();
  if (!call || self.recoveryTimeout) return;
  _audioSuspended.store(true);
  whip_realtime_control(call, WhipRealtimeAudioSuspended);
  NSLog(@"WhipVoice event=audio_suspended token=%@ call=%llu", self.token, (unsigned long long)call);
  [WhipSpeechPlayback.shared cancelCallAnnouncement];
  dispatch_sync(self.media, ^{ [self.player stop]; [self.engine pause]; self.queued = 0; });
  __weak WhipRealtimeVoice *weakSelf = self;
  self.recoveryTimeout = [NSTimer scheduledTimerWithTimeInterval:60 repeats:NO block:^(NSTimer *timer) {
    WhipRealtimeVoice *owner = weakSelf;
    if (owner && owner->_call.load() == call && owner->_audioSuspended.load())
      whip_realtime_control(call, WhipRealtimeRecoveryTimedOut);
  }];
}
- (void)resumeAudioIfAllowed {
  uint64_t call = _call.load();
  if (!call || !_audioSuspended.load() || !_interruption.canResume() || !UIApplication.sharedApplication.protectedDataAvailable) return;
  // Never activate a CallKit session ourselves. A preview owns its own session.
  if (!self.preview && ![WhipVoiceCall.shared owns:self.token]) return;
  NSError *error = nil;
  if (self.preview && ![AVAudioSession.sharedInstance setActive:YES error:&error]) {
    whip_realtime_control(call, WhipRealtimeRecoveryFailed); return;
  }
  __block BOOL started = NO;
  dispatch_sync(self.media, ^{
    NSError *failure = nil;
    started = [self.engine startAndReturnError:&failure];
    if (started) {
      @synchronized (self.converter) { [self.converter reset]; }
      self->_captureAfter.store(mach_absolute_time());
      whip_realtime_control(call, WhipRealtimeAudioResumed);
      self.epoch = whip_realtime_epoch(call); self->_announcementBoundary.reset(self.epoch); self.queued = 0;
      self->_audioSuspended.store(false);
      [self.player play];
    }
  });
  NSLog(@"WhipVoice event=audio_recovery token=%@ call=%llu success=%d", self.token, (unsigned long long)call, started);
  [self.recoveryTimeout invalidate]; self.recoveryTimeout = nil;
  if (!started) whip_realtime_control(call, WhipRealtimeRecoveryFailed);
}
- (void)callAudioActive:(BOOL)active token:(NSString *)token {
  if (![self.token isEqualToString:token] || self.preview) return;
  _interruption.authorized = active;
  if (active) [self resumeAudioIfAllowed]; else [self suspendAudio];
}
- (void)interrupted:(NSNotification *)notification {
  uint64_t call = _call.load();
  NSUInteger type = [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  NSUInteger options = [notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
  if (call && type == AVAudioSessionInterruptionTypeBegan) {
    // Gate the captured Rust handle immediately. Only the main-queue identity
    // check below may mutate this owner's engine state or a replacement call.
    whip_realtime_control(call, WhipRealtimeAudioSuspended);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!call || self->_call.load() != call) return;
    if (self->_diagnosticEvents.fetch_add(1) < 64) NSLog(@"WhipVoice event=interruption token=%@ call=%llu type=%lu options=%lu", self.token, (unsigned long long)call, (unsigned long)type, (unsigned long)options);
    if (type == AVAudioSessionInterruptionTypeBegan) {
      self->_interruption.begin(); [self suspendAudio];
    } else if (self->_interruption.interrupted) {
      BOOL shouldResume = (options & AVAudioSessionInterruptionOptionShouldResume) != 0;
      self->_interruption.ended(shouldResume);
      if (shouldResume) [self resumeAudioIfAllowed];
      else whip_realtime_control(call, WhipRealtimeRecoveryDenied);
    }
  });
}
- (void)backgrounded:(NSNotification *)notification {
  whip_realtime_prepare(false);
  if ([self.pendingStart[@"preview"] boolValue]) [self stop:self.pendingStart[@"token"]];
  if (self.preview && self.token) [self stop:self.token];
}
- (void)routeChanged:(NSNotification *)notification {
  if (_diagnosticEvents.fetch_add(1) < 64) NSLog(@"WhipVoice event=route token=%@ call=%llu reason=%lu", self.token, (unsigned long long)_call.load(), (unsigned long)[notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]);
  if ([notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
    whip_realtime_control(_call.load(), WhipRealtimeRouteLost);
}
@end
