#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(WhipBackup, NSObject)
RCT_EXTERN_METHOD(getDeviceBackupEnabled:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setDeviceBackupEnabled:(BOOL)enabled resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
