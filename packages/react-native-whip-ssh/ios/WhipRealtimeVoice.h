#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#ifdef __cplusplus
extern "C" {
#endif
int32_t WhipReadOpenAiVoiceCredential(void *context, uint8_t *destination, size_t capacity);
#ifdef __cplusplus
}
#endif

@interface WhipRealtimeVoice : NSObject
+ (instancetype)shared;
- (void)invalidate;
- (void)credentialsUpdating:(BOOL)updating;
- (void)start:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)preview:(NSString *)token voice:(NSString *)voice model:(NSString *)model resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)stop:(NSString *)token;
- (void)stop:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve;
- (void)mute:(NSString *)token muted:(BOOL)muted;
- (void)control:(NSString *)token action:(uint8_t)action;
- (NSString *)view:(NSString *)token;
@end
