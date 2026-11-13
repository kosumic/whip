#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>
#import "WhipSpeechPlayback.h"
#import "../../packages/react-native-whip-ssh/ios/WhipVoiceCall.h"
#import "../../packages/react-native-whip-ssh/ios/WhipRealtimeVoice.h"

extern void whip_cancel_background_download(const char *, const char *);
extern void whip_download_execution_expired(const char *, bool);

/** React bridge only; all speech paths share WhipSpeechPlayback. */
@interface HerdrBackground : RCTEventEmitter
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *downloadTasks;
@property(nonatomic, strong) NSCountedSet<NSString *> *downloadScopes;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *downloadDestinationLeases;
@end

@implementation HerdrBackground
RCT_EXPORT_MODULE(HerdrBackground)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"WhipDownloadExpired", WhipChatSpeechStopped, WhipChatSpeechStarted, WhipChatSpeechLevel, WhipSpeechCaption, WhipAutomaticSpeechFocus, WhipVoiceCallEvent]; }
- (instancetype)init
{
  if ((self = [super init])) {
    _downloadTasks = [NSMutableDictionary new];
    _downloadScopes = [NSCountedSet new];
    _downloadDestinationLeases = [NSMutableDictionary new];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatStopped:) name:WhipChatSpeechStopped object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatStarted:) name:WhipChatSpeechStarted object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(chatLevel:) name:WhipChatSpeechLevel object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(speechCaption:) name:WhipSpeechCaption object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(automaticFocus:) name:WhipAutomaticSpeechFocus object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(callChanged:) name:WhipVoiceCallEvent object:nil];
  }
  return self;
}
- (void)chatStopped:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechStopped body:notification.userInfo]; }
- (void)chatStarted:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechStarted body:notification.userInfo]; }
- (void)chatLevel:(NSNotification *)notification { [self sendEventWithName:WhipChatSpeechLevel body:notification.userInfo]; }
- (void)speechCaption:(NSNotification *)notification {
  NSData *data = [NSJSONSerialization dataWithJSONObject:notification.userInfo options:0 error:nil];
  if (data) [self sendEventWithName:WhipSpeechCaption body:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]];
}
- (void)automaticFocus:(NSNotification *)notification { [self sendEventWithName:WhipAutomaticSpeechFocus body:notification.userInfo]; }
- (void)callChanged:(NSNotification *)notification { [self sendEventWithName:WhipVoiceCallEvent body:notification.userInfo]; }
RCT_EXPORT_METHOD(startVoiceCall:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared start:token label:label resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(startRealtimeVoice:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipRealtimeVoice.shared start:token config:config resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(prepareRealtimeVoice:(BOOL)enabled resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipRealtimeVoice.shared prepare:enabled]; resolve(nil); }
RCT_EXPORT_METHOD(startRealtimeVoicePreview:(NSString *)token config:(NSString *)config resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipRealtimeVoice.shared preview:token config:config resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(voiceCredentialsUpdating:(BOOL)updating resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipRealtimeVoice.shared credentialsUpdating:updating];
  if (updating && whip_speech_network_selected()) [WhipSpeechPlayback.shared cancel];
  resolve(nil);
}
RCT_EXPORT_METHOD(stopRealtimeVoice:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipRealtimeVoice.shared stop:token resolve:resolve]; }
RCT_EXPORT_METHOD(realtimeVoiceControl:(NSString *)token action:(NSInteger)action resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipRealtimeVoice.shared control:token action:(uint8_t)action]; resolve(nil); }
RCT_EXPORT_METHOD(realtimeVoiceView:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ resolve([WhipRealtimeVoice.shared view:token]); }
RCT_EXPORT_METHOD(realtimeVoiceSubmitted:(NSString *)token text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ if ([WhipRealtimeVoice.shared submitted:token text:text]) resolve(nil); else reject(@"E_REALTIME_CONTEXT", @"The typed message could not be shared with voice.", nil); }
RCT_EXPORT_METHOD(endVoiceCall:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared end:token resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(playVoiceCallSound:(NSString *)uri inCall:(BOOL)inCall resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared playSound:uri inCall:inCall resolve:resolve reject:reject]; }
RCT_EXPORT_METHOD(stopVoiceCallSound:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{ [WhipVoiceCall.shared stopSound]; resolve(nil); }
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
RCT_EXPORT_METHOD(startResponseSpeech:(NSString *)token label:(NSString *)label resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared startResponse:token label:label resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(automaticSpeechControl:(NSString *)action value:(BOOL)value resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared automaticControl:action value:value]; resolve(nil);
}
RCT_EXPORT_METHOD(automaticSpeechBinding:(NSString *)token hostId:(NSString *)hostId tabName:(NSString *)tabName)
{
  [WhipSpeechPlayback.shared automaticBinding:token host:hostId tabName:tabName];
}
RCT_EXPORT_METHOD(speakChat:(NSString *)token text:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared speakChat:token text:text resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(speakChatWithSource:(NSString *)token text:(NSString *)text source:(NSString *)source resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *metadata = [NSJSONSerialization JSONObjectWithData:[source dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  [WhipSpeechPlayback.shared speakChat:token text:text source:metadata resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(startLocalChatSpeech:(NSString *)token label:(NSString *)label callToken:(NSString *)callToken resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  // AVSpeechSynthesizer uses installed device voices. Phonon is local too.
  [WhipSpeechPlayback.shared startLocalChat:token label:label callToken:callToken resolve:resolve reject:reject];
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
  [WhipSpeechPlayback.shared cancel];
  resolve(nil);
}
RCT_EXPORT_METHOD(prepareSpokenAlert:(NSString *)notification channelId:(NSString *)channelId persistent:(BOOL)persistent vibrationPattern:(NSArray *)vibrationPattern effectId:(NSString *)effectId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared prepareAlertNotification:notification effect:effectId];
  resolve(nil);
}
RCT_EXPORT_METHOD(dismissPersistentAlert:(NSString *)notification resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [WhipSpeechPlayback.shared dismissAlertNotification:notification];
  resolve(nil);
}
- (void)stopDownload:(NSString *)identifier notify:(BOOL)notify
{
  NSDictionary *task = self.downloadTasks[identifier];
  if (!task) return;
  whip_download_execution_expired(identifier.UTF8String, false);
  [self.downloadTasks removeObjectForKey:identifier];
  [UIApplication.sharedApplication endBackgroundTask:[task[@"task"] unsignedIntegerValue]];
  if (notify) [self sendEventWithName:@"WhipDownloadExpired" body:@{@"id": identifier}];
}
- (void)expireDownload:(NSString *)identifier { [self stopDownload:identifier notify:YES]; }
RCT_EXPORT_METHOD(beginDownloadExecution:(NSString *)identifier name:(NSString *)name
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
    reject(@"E_DOWNLOAD_EXECUTION", @"Return to Whip to start a download", nil); return;
  }
  __weak HerdrBackground *weakSelf = self;
  UIBackgroundTaskIdentifier task = [UIApplication.sharedApplication beginBackgroundTaskWithName:name expirationHandler:^{
    [weakSelf expireDownload:identifier];
  }];
  if (task == UIBackgroundTaskInvalid) {
    reject(@"E_DOWNLOAD_EXECUTION", @"iOS could not grant download background time", nil); return;
  }
  self.downloadTasks[identifier] = [@{@"task": @(task)} mutableCopy];
  resolve(nil);
}
RCT_EXPORT_METHOD(bindDownloadTransfer:(NSString *)identifier hostId:(NSString *)host transferId:(NSString *)transfer)
{
  NSMutableDictionary *task = self.downloadTasks[identifier];
  if (!task) { whip_cancel_background_download(host.UTF8String, transfer.UTF8String); return; }
  task[@"host"] = host; task[@"transfer"] = transfer;
}
RCT_EXPORT_METHOD(updateDownloadExecution:(NSString *)identifier status:(NSString *)status transferred:(double)transferred total:(double)total) {}
RCT_EXPORT_METHOD(downloadCancellations:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { resolve(@[]); }
RCT_EXPORT_METHOD(acknowledgeDownloadCancellation:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(endDownloadExecution:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *task = self.downloadTasks[identifier];
  if (task) {
    [UIApplication.sharedApplication endBackgroundTask:[task[@"task"] unsignedIntegerValue]];
    [self.downloadTasks removeObjectForKey:identifier];
  }
  resolve(nil);
}
- (BOOL)retainDownloadScope:(NSURL *)url
{
  if (!url.isFileURL) return NO;
  if ([self.downloadScopes countForObject:url.absoluteString] == 0 && ![url startAccessingSecurityScopedResource]) return NO;
  [self.downloadScopes addObject:url.absoluteString];
  return YES;
}
RCT_EXPORT_METHOD(retainDownloadDestination:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSURL *url = [NSURL URLWithString:uri];
  BOOL retained = [self retainDownloadScope:url];
  NSError *error = nil;
  NSData *bookmark = [url bookmarkDataWithOptions:0 includingResourceValuesForKeys:nil relativeToURL:nil error:&error];
  if (!bookmark) {
    if (retained) [self releaseDownloadScope:uri];
    reject(@"E_DOWNLOAD_PERMISSION", @"The selected folder permission could not be saved. Choose another folder.", error); return;
  }
  resolve([bookmark base64EncodedStringWithOptions:0]);
}
RCT_EXPORT_METHOD(resolveDownloadDestination:(NSString *)uri permission:(NSString *)permission
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSData *data = [[NSData alloc] initWithBase64EncodedString:permission options:0];
  BOOL stale = NO;
  NSError *error = nil;
  NSURL *url = data ? [NSURL URLByResolvingBookmarkData:data options:NSURLBookmarkResolutionWithoutUI relativeToURL:nil bookmarkDataIsStale:&stale error:&error] : nil;
  if (!url || stale) {
    reject(@"E_DOWNLOAD_PERMISSION", @"Folder access expired. Choose the destination again.", error); return;
  }
  [self retainDownloadScope:url];
  resolve(url.absoluteString);
}
- (void)releaseDownloadScope:(NSString *)uri
{
  if ([self.downloadScopes countForObject:uri] == 0) return;
  [self.downloadScopes removeObject:uri];
  if ([self.downloadScopes countForObject:uri] == 0) [[NSURL URLWithString:uri] stopAccessingSecurityScopedResource];
}
RCT_EXPORT_METHOD(retainDownloadJobDestination:(NSString *)identifier uri:(NSString *)uri
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *lease = self.downloadDestinationLeases[identifier];
  if (lease) { resolve(lease[@"permission"]); return; }
  [self retainDownloadDestination:uri resolve:^(id permission) {
    self.downloadDestinationLeases[identifier] = @{@"uri": uri, @"permission": permission};
    resolve(permission);
  } reject:reject];
}
RCT_EXPORT_METHOD(resolveDownloadJobDestination:(NSString *)identifier uri:(NSString *)uri permission:(NSString *)permission
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *lease = self.downloadDestinationLeases[identifier];
  if (lease) { resolve(lease[@"uri"]); return; }
  [self resolveDownloadDestination:uri permission:permission resolve:^(id resolvedUri) {
    self.downloadDestinationLeases[identifier] = @{@"uri": resolvedUri, @"permission": permission};
    resolve(resolvedUri);
  } reject:reject];
}
RCT_EXPORT_METHOD(releaseDownloadJobDestination:(NSString *)identifier
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *lease = self.downloadDestinationLeases[identifier];
  [self.downloadDestinationLeases removeObjectForKey:identifier];
  if (lease) [self releaseDownloadScope:lease[@"uri"]];
  resolve(nil);
}
RCT_EXPORT_METHOD(releaseDownloadDestination:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [self releaseDownloadScope:uri]; resolve(nil);
}

- (void)invalidate
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSString *identifier in self.downloadTasks.allKeys) [self stopDownload:identifier notify:NO];
    for (NSString *uri in self.downloadScopes.allObjects) [[NSURL URLWithString:uri] stopAccessingSecurityScopedResource];
    [self.downloadScopes removeAllObjects];
    [self.downloadDestinationLeases removeAllObjects];
    [WhipRealtimeVoice.shared invalidate]; [WhipVoiceCall.shared invalidate]; [WhipSpeechPlayback.shared detachPresentation];
  });
  [super invalidate];
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
