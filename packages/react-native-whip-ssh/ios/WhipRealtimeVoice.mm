#import "WhipRealtimeVoice.h"
#import "WhipVoiceCall.h"
#import "../cpp/WhipRealtimeVoice.h"
#import <AVFoundation/AVFoundation.h>
#include <atomic>

@interface WhipRealtimeVoice () {
  std::atomic<uint64_t> _call;
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
@property(nonatomic, strong) dispatch_queue_t media;
@property(nonatomic) uint64_t epoch;
@property(nonatomic) uint64_t scheduled;
@property(nonatomic) NSUInteger queued;
@property(nonatomic) NSUInteger ticks;
@property(nonatomic) uint64_t closingCall;
@end

@implementation WhipRealtimeVoice
+ (instancetype)shared { static WhipRealtimeVoice *owner; static dispatch_once_t once; dispatch_once(&once, ^{ owner = [WhipRealtimeVoice new]; }); return owner; }
- (instancetype)init {
  if ((self = [super init])) {
    _call.store(0);
    _media = dispatch_queue_create("whip.realtime.media", DISPATCH_QUEUE_SERIAL);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(audioChanged:) name:AVAudioEngineConfigurationChangeNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
  }
  return self;
}
- (void)start:(NSString *)token config:(NSString *)config key:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (self.token || ![WhipVoiceCall.shared owns:token]) { reject(@"E_REALTIME", @"The voice call is not active.", nil); return; }
  NSError *error = nil;
  AVAudioEngine *engine = [AVAudioEngine new];
  AVAudioInputNode *input = engine.inputNode;
  // Apple's voice-processing I/O supplies native echo cancellation for full duplex.
  if (![input setVoiceProcessingEnabled:YES error:&error]) { reject(@"E_REALTIME", @"Native echo cancellation could not start.", nil); return; }
  AVAudioFormat *source = [input outputFormatForBus:0];
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:WhipRealtimeSampleRate channels:1 interleaved:NO];
  AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:source toFormat:format];
  if (!converter || source.sampleRate <= 0) { reject(@"E_REALTIME", @"The microphone audio format is unavailable.", nil); return; }
  uint64_t call = whip_realtime_start(config.UTF8String, key.UTF8String);
  if (!call) { reject(@"E_REALTIME", @"Realtime could not start. Open a connected agent chat and check the saved API credential.", nil); return; }
  if (WhipVoiceCall.shared.muted) whip_realtime_control(call, WhipRealtimeMute);
  self.token = token; _call.store(call);
  self.engine = engine; self.format = format; self.converter = converter;
  self.capture = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:WhipRealtimeMaxFrame];
  self.player = [AVAudioPlayerNode new];
  [engine attachNode:self.player];
  [engine connect:self.player to:engine.mainMixerNode format:format];
  __weak WhipRealtimeVoice *weakSelf = self;
  // The engine invokes its tap serially. PCM conversion and upload stay native.
  AVAudioPCMBuffer *capture = self.capture;
  [input installTapOnBus:0 bufferSize:WhipRealtimeFrame * 2 format:source block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    WhipRealtimeVoice *owner = weakSelf;
    if (!owner || owner->_call.load() != call) return;
    __block BOOL supplied = NO;
    NSError *conversionError = nil;
    capture.frameLength = 0;
    AVAudioConverterOutputStatus status = [converter convertToBuffer:capture error:&conversionError withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *state) {
      if (supplied) { *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
      supplied = YES; *state = AVAudioConverterInputStatus_HaveData; return buffer;
    }];
    if (status == AVAudioConverterOutputStatus_Error || conversionError) { whip_realtime_control(call, WhipRealtimeAudioFailed); return; }
    if (capture.frameLength) whip_realtime_capture(call, capture.int16ChannelData[0], capture.frameLength);
  }];
  if (![engine startAndReturnError:&error]) {
    [self stop:token]; reject(@"E_REALTIME", @"The native audio engine could not start.", nil); return;
  }
  [self.player play];
  self.epoch = 0; self.scheduled = 0; self.queued = 0;
  self.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.media);
  dispatch_source_set_timer(self.timer, DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC, NSEC_PER_MSEC);
  dispatch_source_set_event_handler(self.timer, ^{ [weakSelf pump:call token:token]; });
  dispatch_resume(self.timer);
  resolve(nil);
}
- (void)pump:(uint64_t)call token:(NSString *)token {
  if (_call.load() != call) return;
  uint64_t currentEpoch = whip_realtime_epoch(call);
  if (currentEpoch != self.epoch) {
    [self.player stop];
    self.epoch = currentEpoch; self.scheduled = 0; self.queued = 0;
    [self.player play];
  }
  char *json = (++self.ticks % 10 == 0) ? whip_realtime_view(call) : nullptr;
  if (json) {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    NSDictionary *view = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    whip_realtime_free(json);
    if ([view[@"phase"] isEqualToString:@"error"]) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_call.load() != call) return;
        [self stop:token];
        [WhipVoiceCall.shared end:token resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) {}];
      });
      return;
    }
  }
  if (self.queued >= 4) return;
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.format frameCapacity:WhipRealtimeFrame];
  uint64_t epoch = 0;
  NSUInteger count = whip_realtime_read(call, buffer.int16ChannelData[0], WhipRealtimeFrame, &epoch);
  if (epoch != self.epoch) {
    [self.player stop];
    self.epoch = epoch; self.scheduled = 0; self.queued = 0;
    [self.player play];
  }
  if (!count) return;
  buffer.frameLength = (AVAudioFrameCount)count;
  self.scheduled += count;
  self.queued++;
  uint64_t played = self.scheduled;
  __weak WhipRealtimeVoice *weakSelf = self;
  [self.player scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) {
    WhipRealtimeVoice *owner = weakSelf;
    if (!owner) return;
    dispatch_async(owner.media, ^{
      if (owner->_call.load() != call || owner.epoch != epoch) return;
      if (owner.queued) owner.queued--;
      whip_realtime_played(call, epoch, played);
    });
  }];
}
- (void)stop:(NSString *)token {
  if (![self.token isEqualToString:token]) return;
  uint64_t call = _call.exchange(0);
  self.lastToken = token;
  char *view = whip_realtime_view(call);
  self.lastView = view ? [NSString stringWithUTF8String:view] : @"{\"phase\":\"closed\"}";
  whip_realtime_free(view);
  if (self.timer) { dispatch_source_cancel(self.timer); self.timer = nil; }
  [self.engine.inputNode removeTapOnBus:0];
  // Drain the media queue before releasing nodes or allowing a replacement.
  dispatch_sync(self.media, ^{ [self.player stop]; [self.engine stop]; });
  whip_realtime_stop(call);
  self.closingCall = call;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    while (!whip_realtime_stopped(call)) [NSThread sleepForTimeInterval:0.005];
  });
  self.player = nil; self.engine = nil; self.converter = nil; self.capture = nil; self.format = nil; self.token = nil;
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
- (void)mute:(NSString *)token muted:(BOOL)muted { [self control:token action:muted ? WhipRealtimeMute : WhipRealtimeUnmute]; }
- (NSString *)view:(NSString *)token {
  if (![self.token isEqualToString:token]) return [self.lastToken isEqualToString:token] ? self.lastView : @"{\"phase\":\"closed\"}";
  char *view = whip_realtime_view(_call.load());
  NSString *result = view ? [NSString stringWithUTF8String:view] : @"{\"phase\":\"closed\"}";
  whip_realtime_free(view); return result;
}
- (void)audioChanged:(NSNotification *)notification {
  if (notification.object == self.engine && !self.engine.running) whip_realtime_control(_call.load(), WhipRealtimeAudioFailed);
}
- (void)interrupted:(NSNotification *)notification {
  if ([notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan) whip_realtime_control(_call.load(), WhipRealtimeAudioFailed);
}
@end
