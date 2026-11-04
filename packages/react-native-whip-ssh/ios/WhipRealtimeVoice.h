#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface WhipRealtimeVoice : NSObject
+ (instancetype)shared;
- (void)start:(NSString *)token config:(NSString *)config key:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)preview:(NSString *)token voice:(NSString *)voice key:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)stop:(NSString *)token;
- (void)stop:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve;
- (void)mute:(NSString *)token muted:(BOOL)muted;
- (void)control:(NSString *)token action:(uint8_t)action;
- (NSString *)view:(NSString *)token;
@end
