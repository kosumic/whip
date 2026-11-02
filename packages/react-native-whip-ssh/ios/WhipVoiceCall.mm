#import "WhipVoiceCall.h"
#import <AVFoundation/AVFoundation.h>
#import <CallKit/CallKit.h>

NSString *const WhipVoiceCallEvent = @"WhipVoiceCall";
static NSString *const WhipCallError = @"E_VOICE_CALL";

@interface WhipVoiceCall () <CXProviderDelegate>
@property(nonatomic, strong) CXProvider *provider;
@property(nonatomic, strong) CXCallController *controller;
@property(nonatomic, strong) NSUUID *uuid;
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *label;
@property(nonatomic, readwrite) BOOL active;
@property(nonatomic, copy) RCTPromiseResolveBlock ready;
@property(nonatomic, copy) RCTPromiseRejectBlock failed;
@property(nonatomic, strong) NSTimer *timeout;
@property(nonatomic, strong) NSMutableArray *endings;
@property(nonatomic) BOOL ending;
@end

@implementation WhipVoiceCall
+ (instancetype)shared
{
  static WhipVoiceCall *call;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ call = [WhipVoiceCall new]; });
  return call;
}
- (instancetype)init
{
  if ((self = [super init])) {
    CXProviderConfiguration *configuration = [CXProviderConfiguration new];
    configuration.supportsVideo = NO;
    configuration.maximumCallGroups = 1;
    configuration.maximumCallsPerCallGroup = 1;
    configuration.supportedHandleTypes = [NSSet setWithObject:@(CXHandleTypeGeneric)];
    configuration.includesCallsInRecents = NO;
    _provider = [[CXProvider alloc] initWithConfiguration:configuration];
    [_provider setDelegate:self queue:dispatch_get_main_queue()];
    _controller = [CXCallController new];
    _endings = [NSMutableArray new];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
  }
  return self;
}
- (void)start:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (self.token) { reject(WhipCallError, @"A voice call is already active.", nil); return; }
  self.token = token; self.label = label; self.uuid = NSUUID.UUID;
  self.ready = resolve; self.failed = reject;
  CXStartCallAction *action = [[CXStartCallAction alloc] initWithCallUUID:self.uuid handle:[[CXHandle alloc] initWithType:CXHandleTypeGeneric value:label]];
  action.video = NO;
  __weak WhipVoiceCall *weakSelf = self;
  self.timeout = [NSTimer scheduledTimerWithTimeInterval:15 repeats:NO block:^(NSTimer *timer) {
    if ([weakSelf.token isEqualToString:token]) [weakSelf fail:@"The system voice call did not activate."];
  }];
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{ if (error && [weakSelf.token isEqualToString:token]) [weakSelf fail:error.localizedDescription]; });
  }];
}
- (void)provider:(CXProvider *)provider performStartCallAction:(CXStartCallAction *)action
{
  if (![action.callUUID isEqual:self.uuid]) { [action fail]; return; }
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat
       options:AVAudioSessionCategoryOptionAllowBluetooth error:&error]) {
    [action fail]; [self fail:error.localizedDescription]; return;
  }
  CXCallUpdate *update = [CXCallUpdate new];
  update.remoteHandle = action.handle; update.localizedCallerName = self.label;
  update.hasVideo = NO; update.supportsHolding = NO; update.supportsGrouping = NO;
  update.supportsUngrouping = NO; update.supportsDTMF = NO;
  [provider reportCallWithUUID:self.uuid updated:update];
  [provider reportOutgoingCallWithUUID:self.uuid startedConnectingAtDate:NSDate.date];
  // CallKit activates the audio session; speech I/O starts only in didActivate.
  [action fulfill];
}
- (void)provider:(CXProvider *)provider didActivateAudioSession:(AVAudioSession *)audioSession
{
  if (!self.token) return;
  self.active = YES;
  // Start hands-free unless the user already has a headset connected. Leaving
  // defaultToSpeaker unset allows the speaker control to return to the receiver.
  BOOL external = NO;
  for (AVAudioSessionPortDescription *port in audioSession.currentRoute.outputs) {
    external |= ![port.portType isEqualToString:AVAudioSessionPortBuiltInReceiver] &&
      ![port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker];
  }
  if (!external) [audioSession overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
  [self.timeout invalidate]; self.timeout = nil;
  [provider reportOutgoingCallWithUUID:self.uuid connectedAtDate:NSDate.date];
  RCTPromiseResolveBlock ready = self.ready;
  self.ready = nil; self.failed = nil;
  if (ready) ready(nil);
  [self routeChanged:nil];
}
- (void)provider:(CXProvider *)provider didDeactivateAudioSession:(AVAudioSession *)audioSession
{
  self.active = NO;
  if (self.token) [self fail:@"The system interrupted voice chat for another call."];
}
- (void)end:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token]) { resolve(nil); return; }
  [self.endings addObject:[resolve copy]];
  if (self.ending) return;
  self.ending = YES;
  NSUUID *uuid = self.uuid;
  CXEndCallAction *action = [[CXEndCallAction alloc] initWithCallUUID:uuid];
  __weak WhipVoiceCall *weakSelf = self;
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error && [weakSelf.token isEqualToString:token]) {
        [weakSelf.provider reportCallWithUUID:uuid endedAtDate:NSDate.date reason:CXCallEndedReasonFailed];
        [weakSelf clear:nil];
      }
    });
  }];
}
- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action
{
  if ([action.callUUID isEqual:self.uuid]) [self clear:nil];
  [action fulfill];
}
- (void)mute:(NSString *)token muted:(BOOL)muted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token]) { reject(WhipCallError, @"The voice call has ended.", nil); return; }
  CXSetMutedCallAction *action = [[CXSetMutedCallAction alloc] initWithCallUUID:self.uuid muted:muted];
  [self.controller requestTransaction:[[CXTransaction alloc] initWithAction:action] completion:^(NSError *error) {
    if (error) reject(WhipCallError, error.localizedDescription, error); else resolve(nil);
  }];
}
- (void)provider:(CXProvider *)provider performSetMutedCallAction:(CXSetMutedCallAction *)action
{
  if (![action.callUUID isEqual:self.uuid]) { [action fail]; return; }
  [self emit:@{@"type": @"muted", @"muted": @(action.muted)}];
  [action fulfill];
}
- (void)speaker:(NSString *)token enabled:(BOOL)speaker resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (![self.token isEqualToString:token] || !self.active) { reject(WhipCallError, @"The voice call is not active.", nil); return; }
  NSError *error = nil;
  if (![AVAudioSession.sharedInstance overrideOutputAudioPort:speaker ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone error:&error]) {
    reject(WhipCallError, error.localizedDescription, error); return;
  }
  [self routeChanged:nil]; resolve(nil);
}
- (void)routeChanged:(NSNotification *)notification
{
  BOOL speaker = NO;
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    speaker |= [port.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker];
  }
  [self emit:@{@"type": @"route", @"speaker": @(speaker)}];
}
- (void)emit:(NSDictionary *)event
{
  NSString *token = self.token;
  if (!token) return;
  NSMutableDictionary *body = [event mutableCopy]; body[@"token"] = token;
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSNotificationCenter.defaultCenter postNotificationName:WhipVoiceCallEvent object:self userInfo:body];
  });
}
- (void)clear:(NSString *)error
{
  [self emit:error ? @{@"type": @"ended", @"error": error} : @{@"type": @"ended"}];
  RCTPromiseRejectBlock failed = self.failed;
  self.ready = nil; self.failed = nil;
  [self.timeout invalidate]; self.timeout = nil;
  self.active = NO; self.token = nil; self.uuid = nil; self.label = nil;
  self.ending = NO;
  NSArray *endings = [self.endings copy];
  [self.endings removeAllObjects];
  if (failed) failed(WhipCallError, error ?: @"Voice call ended before activation.", nil);
  for (RCTPromiseResolveBlock ended in endings) ended(nil);
}
- (void)fail:(NSString *)error
{
  if (self.uuid) [self.provider reportCallWithUUID:self.uuid endedAtDate:NSDate.date reason:CXCallEndedReasonFailed];
  [self clear:error ?: @"The system voice call failed."];
}
- (void)providerDidReset:(CXProvider *)provider { [self fail:@"The system reset voice chat."]; }
- (void)provider:(CXProvider *)provider timedOutPerformingAction:(CXAction *)action { [self fail:@"The system voice call timed out."]; }
- (void)invalidate { if (self.token) [self fail:@"Voice chat ended."]; }
@end
