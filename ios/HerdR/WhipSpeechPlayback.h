#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import "../../packages/react-native-whip-ssh/cpp/WhipSpeechPolicy.h"

FOUNDATION_EXPORT NSString *const WhipChatSpeechStopped;

/** Main-thread OS playback shared by chat, announcements, and device tools. */
@interface WhipSpeechPlayback : NSObject
+ (instancetype)shared;
- (void)startChat:(NSString *)owner label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)speakChat:(NSString *)owner text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)announce:(NSString *)owner text:(NSString *)text language:(NSString *)language resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)speakDevice:(NSString *)owner request:(NSString *)request text:(NSString *)text language:(NSString *)language rate:(double)rate resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (BOOL)stopOwner:(NSString *)owner kind:(enum WhipSpeechKind)kind;
- (void)cancelDeviceRequest:(NSString *)request;
- (void)stopDevice;
- (void)stop;
@end
