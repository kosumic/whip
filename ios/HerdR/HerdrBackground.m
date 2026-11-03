#import <React/RCTEventEmitter.h>
#import "WhipSpeechPlayback.h"
#import "../../packages/react-native-whip-ssh/ios/WhipVoiceCall.h"

/** React bridge only; all speech paths share WhipSpeechPlayback. */
@interface HerdrBackground : RCTEventEmitter
@end

@implementation HerdrBackground
RCT_EXPORT_MODULE(HerdrBackground)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[WhipChatSpeechStopped, WhipChatSpeechStarted, WhipChatSpeechLevel, WhipVoiceCallEvent]; }
- (instancetype)init
{
  if ((self = [super init])) {
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatStopped:) name:WhipChatSpeechStopped object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatStarted:) name:WhipChatSpeechStarted object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatLevel:) name:WhipChatSpeechLevel object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(callChanged:) name:WhipVoiceCallEvent object:nil];
  }
  return self;
}
- (void)chatStopped:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechStopped body:notification.userInfo]; }
- (void)chatStarted:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechStarted body:notification.userInfo]; }
- (void)chatLevel:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechLevel body:notification.userInfo]; }
- (void)callChanged:(NSNotification *)notification { [self sendEventWithName:WhipVoiceCallEvent body:notification.userInfo]; }
RCT_EXPORT_METHOD(startVoiceCall:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared start:token label:label resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(endVoiceCall:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared end:token resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(setVoiceCallMuted:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared mute:token muted:muted resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(setVoiceCallSpeaker:(NSString *)token speaker:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared speaker:token enabled:speaker resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(speechBackendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared backendCommand:action resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(startChatSpeech:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared startChat:token label:label resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(speakChat:(NSString *)token text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared speakChat:token text:text resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(startLocalChatSpeech:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  // AVSpeechSynthesizer uses installed device voices. Phonon is local too.
  [WhipSpeechPlayback.shared startLocalChat:token label:label resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(stopChatSpeech:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared stopOwner:token kind:WhipSpeechChat];
  resolve(nil);
}
RCT_EXPORT_METHOD(speakAnnouncement:(NSString *)token text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared announce:token text:text language:language resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(speakStatusAnnouncement:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared announceStatus:token resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(refreshStatusAnnouncements:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared refreshStatus];
  resolve(nil);
}
RCT_EXPORT_METHOD(speakPreview:(NSString *)token text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared preview:token text:text language:language resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(stopAnnouncement:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared stopOwner:token kind:WhipSpeechAnnouncement];
  resolve(nil);
}
RCT_EXPORT_METHOD(stopSpeech:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared stop];
  resolve(nil);
}
- (void)invalidate
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
  dispatch_async(dispatch_get_main_queue(), ^{ [WhipVoiceCall.shared invalidate]; [WhipSpeechPlayback.shared stop]; });
  [super invalidate];
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
