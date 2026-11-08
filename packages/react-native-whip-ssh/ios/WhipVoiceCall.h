#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

FOUNDATION_EXPORT NSString *const WhipVoiceCallEvent;

@interface WhipVoiceCall : NSObject
+ (instancetype)shared;
@property(nonatomic, readonly) BOOL active;
@property(nonatomic, readonly) BOOL muted;
- (BOOL)owns:(NSString *)token;
- (id)playbackKey:(NSString *)token;
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)end:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)syncMuted:(NSString *)token muted:(BOOL)muted;
- (void)speaker:(NSString *)token enabled:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)playSound:(NSString *)uri inCall:(BOOL)inCall resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)stopSound;
- (void)invalidate;
@end
