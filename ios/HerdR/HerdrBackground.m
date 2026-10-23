#import <React/RCTEventEmitter.h>
#import "WhipSpeechPlayback.h"

/** React bridge only; all speech paths share WhipSpeechPlayback. */
@interface HerdrBackground : RCTEventEmitter
@end

@implementation HerdrBackground
RCT_EXPORT_MODULE(HerdrBackground)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[WhipChatSpeechStopped]; }
- (instancetype)init
{
  if ((self = [super init])) {
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatStopped:) name:WhipChatSpeechStopped object:nil];
  }
  return self;
}
- (void)chatStopped:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechStopped body:notification.userInfo]; }
RCT_EXPORT_METHOD(startChatSpeech:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared startChat:token label:label resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(speakChat:(NSString *)token text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared speakChat:token text:text resolve:resolve reject:reject];
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
  dispatch_async(dispatch_get_main_queue(), ^{ [WhipSpeechPlayback.shared stop]; });
  [super invalidate];
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
