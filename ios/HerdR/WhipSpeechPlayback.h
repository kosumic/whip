#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import "../../packages/react-native-whip-ssh/cpp/WhipSpeechPolicy.h"

FOUNDATION_EXPORT NSString *const WhipChatSpeechStopped;
FOUNDATION_EXPORT NSString *const WhipChatSpeechStarted;
FOUNDATION_EXPORT NSString *const WhipChatSpeechLevel;
FOUNDATION_EXPORT NSString *const WhipAutomaticSpeechFocus;
FOUNDATION_EXPORT NSString *const WhipSpeechCaption;

/** Main-thread OS playback shared by chat, announcements, and device tools. */
@interface WhipSpeechPlayback : NSObject
+ (instancetype)shared;
- (void)backendCommand:(NSString *)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)startChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)startResponse:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)startLocalChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)speakChat:(NSString *)owner text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)speakChat:(NSString *)owner text:(NSString *)text source:(NSDictionary *)source resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)announce:(NSString *)owner text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)announceStatus:(NSString *)owner resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)refreshStatus;
- (void)automaticControl:(NSString *)action value:(BOOL)value;
- (void)automaticBinding:(NSString *)token host:(NSString *)host tabName:(NSString *)tabName;
- (void)detachPresentation;
- (void)preview:(NSString *)owner text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)speakDevice:(NSString *)owner request:(NSString *)request text:(NSString *)text language:(NSString *)language rate:(double)rate resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (BOOL)stopOwner:(NSString *)owner kind:(enum WhipSpeechKind)kind;
- (void)cancelDeviceRequest:(NSString *)request;
- (void)stopDevice;
- (void)stop;
// Native callback handoff; the process-wide Rust queue owns admission.
- (BOOL)deferPlayback:(id)key block:(dispatch_block_t)block;
- (void)startPlayback:(id)key;
- (void)cancelPlayback:(id)key;
- (void)finishPlayback:(id)key;
- (void)prepareAlertNotification:(NSString *)notification effect:(NSString *)effect;
- (void)dismissAlertNotification:(NSString *)notification;
- (void)finishAlert:(NSString *)token reason:(NSString *)reason;
- (void)shake;
- (void)watchPlaybackShake;
- (void)yieldIdlePlayback;
@end
