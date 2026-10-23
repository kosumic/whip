#import <React/RCTBridgeModule.h>
#import <CoreLocation/CoreLocation.h>
#import <Network/Network.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <sys/utsname.h>

static const NSTimeInterval WhipLocationTimeout = 10;
static const NSTimeInterval WhipSampleTimeout = 5;
static const NSTimeInterval WhipSpeechTimeout = 60;

/** One bounded native sample; its stop block owns and releases the OS resource. */
@interface WhipDeviceSample : NSObject
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic, copy) void (^stop)(void);
@property(nonatomic, copy) void (^cleanup)(void);
- (void)complete:(id)value;
- (void)fail:(NSString *)code message:(NSString *)message;
@end
@implementation WhipDeviceSample
- (void)finish
{
  [self.timer invalidate];
  self.timer = nil;
  if (self.stop) self.stop();
  self.stop = nil;
  if (self.cleanup) self.cleanup();
  self.cleanup = nil;
  self.resolve = nil;
  self.reject = nil;
}
- (void)complete:(id)value
{
  RCTPromiseResolveBlock resolve = self.resolve;
  [self finish];
  if (resolve) resolve(value);
}
- (void)fail:(NSString *)code message:(NSString *)message
{
  RCTPromiseRejectBlock reject = self.reject;
  [self finish];
  if (reject) reject(code, message, nil);
}
@end

@interface WhipLocationFix : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic, copy) void (^cleanup)(void);
@property(nonatomic) BOOL requested;
- (void)fail:(NSString *)code message:(NSString *)message;
@end

@implementation WhipLocationFix
- (void)finish
{
  [self.timer invalidate];
  self.timer = nil;
  [self.manager stopUpdatingLocation];
  self.manager.delegate = nil;
  if (self.cleanup) self.cleanup();
  self.cleanup = nil;
  self.resolve = nil;
  self.reject = nil;
}
- (void)fail:(NSString *)code message:(NSString *)message
{
  RCTPromiseRejectBlock reject = self.reject;
  [self finish];
  if (reject) reject(code, message, nil);
}
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager
{
  switch (manager.authorizationStatus) {
    case kCLAuthorizationStatusAuthorizedAlways:
    case kCLAuthorizationStatusAuthorizedWhenInUse:
      if (!self.requested && self.resolve) {
        self.requested = YES;
        [manager requestLocation];
      }
      break;
    case kCLAuthorizationStatusDenied:
    case kCLAuthorizationStatusRestricted:
      [self fail:@"permission_denied" message:@"Location permission was denied"];
      break;
    default: break;
  }
}
- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations
{
  CLLocation *location = locations.lastObject;
  if (!location || location.horizontalAccuracy < 0) return;
  RCTPromiseResolveBlock resolve = self.resolve;
  [self finish];
  if (resolve) resolve(@{
    @"latitude": @(location.coordinate.latitude),
    @"longitude": @(location.coordinate.longitude),
    @"accuracy_m": @(location.horizontalAccuracy),
    @"timestamp_ms": @([location.timestamp timeIntervalSince1970] * 1000)
  });
}
- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error
{
  [self fail:error.code == kCLErrorDenied ? @"permission_denied" : @"location_unavailable"
     message:@"Could not obtain device location"];
}
@end

@interface WhipDevice : NSObject <RCTBridgeModule, AVSpeechSynthesizerDelegate>
@property(nonatomic, strong) NSMutableDictionary<NSString *, WhipLocationFix *> *requests;
@property(nonatomic, strong) NSMutableDictionary<NSString *, WhipDeviceSample *> *samples;
@property(nonatomic, strong) AVSpeechSynthesizer *speech;
@property(nonatomic, strong) AVSpeechUtterance *utterance;
@property(nonatomic, copy) NSString *speechOwner;
@property(nonatomic, copy) NSString *speechRequest;
@property(nonatomic, strong) NSTimer *speechTimer;
@end

@implementation WhipDevice
RCT_EXPORT_MODULE(WhipDevice)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (instancetype)init
{
  if ((self = [super init])) {
    _requests = [NSMutableDictionary new];
    _samples = [NSMutableDictionary new];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(didEnterBackground:)
      name:UIApplicationDidEnterBackgroundNotification object:nil];
  }
  return self;
}
- (void)didEnterBackground:(NSNotification *)notification { [self cancelAll]; }
- (void)cancelAll
{
  for (WhipLocationFix *fix in self.requests.allValues)
    [fix fail:@"cancelled" message:@"Location request cancelled"];
  for (WhipDeviceSample *sample in self.samples.allValues)
    [sample fail:@"cancelled" message:@"Device request cancelled"];
}
- (void)invalidate
{
  dispatch_async(dispatch_get_main_queue(), ^{ [self cancelAll]; [self stopCurrentSpeech]; });
}
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }

RCT_EXPORT_METHOD(info:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  struct utsname system;
  NSString *model = uname(&system) == 0 ? [NSString stringWithUTF8String:system.machine] : UIDevice.currentDevice.model;
  resolve(@{@"platform": @"ios", @"os_version": UIDevice.currentDevice.systemVersion,
    @"model": model, @"manufacturer": @"Apple",
    @"app_version": [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: NSNull.null,
    @"locale": NSLocale.preferredLanguages.firstObject ?: @"und",
    @"time_zone": NSTimeZone.localTimeZone.name});
}
RCT_EXPORT_METHOD(location:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
    reject(@"device_unavailable", @"Keep Whip foregrounded to request location", nil);
    return;
  }
  if (![CLLocationManager locationServicesEnabled]) {
    reject(@"location_unavailable", @"Location services are disabled", nil);
    return;
  }
  [self.requests[requestId] fail:@"cancelled" message:@"Location request replaced"];
  WhipLocationFix *fix = [WhipLocationFix new];
  fix.resolve = resolve;
  fix.reject = reject;
  __weak WhipDevice *owner = self;
  fix.cleanup = ^{ [owner.requests removeObjectForKey:requestId]; };
  self.requests[requestId] = fix;
  fix.manager = [CLLocationManager new];
  fix.manager.delegate = fix;
  fix.manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
  __weak WhipLocationFix *weakFix = fix;
  fix.timer = [NSTimer scheduledTimerWithTimeInterval:WhipLocationTimeout repeats:NO block:^(NSTimer *timer) {
    [weakFix fail:@"timeout" message:@"Device location timed out"];
  }];
  if (fix.manager.authorizationStatus == kCLAuthorizationStatusNotDetermined)
    [fix.manager requestWhenInUseAuthorization];
  else [fix locationManagerDidChangeAuthorization:fix.manager];
}
RCT_EXPORT_METHOD(cancelLocation:(NSString *)requestId)
{
  [self.requests[requestId] fail:@"cancelled" message:@"Location request cancelled"];
}

- (WhipDeviceSample *)sample:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self.samples[requestId] fail:@"cancelled" message:@"Device request replaced"];
  WhipDeviceSample *sample = [WhipDeviceSample new];
  sample.resolve = resolve;
  sample.reject = reject;
  __weak WhipDevice *owner = self;
  sample.cleanup = ^{ [owner.samples removeObjectForKey:requestId]; };
  self.samples[requestId] = sample;
  __weak WhipDeviceSample *weakSample = sample;
  sample.timer = [NSTimer scheduledTimerWithTimeInterval:WhipSampleTimeout repeats:NO block:^(NSTimer *timer) {
    [weakSample fail:@"timeout" message:@"Device sample timed out"];
  }];
  return sample;
}

RCT_EXPORT_METHOD(network:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  WhipDeviceSample *sample = [self sample:requestId resolve:resolve reject:reject];
  nw_path_monitor_t monitor = nw_path_monitor_create();
  sample.stop = ^{ nw_path_monitor_cancel(monitor); };
  __weak WhipDeviceSample *weakSample = sample;
  nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    BOOL connected = nw_path_get_status(path) == nw_path_status_satisfied;
    NSString *type = @"offline";
    if (connected) {
      if (nw_path_uses_interface_type(path, nw_interface_type_wifi)) type = @"wifi";
      else if (nw_path_uses_interface_type(path, nw_interface_type_cellular)) type = @"cellular";
      else if (nw_path_uses_interface_type(path, nw_interface_type_wired)) type = @"ethernet";
      else type = @"other";
    }
    [weakSample complete:@{@"connected": @(connected), @"connection_type": type,
      @"internet_reachable": NSNull.null, @"is_expensive": @(nw_path_is_expensive(path)),
      @"low_data_mode": @(nw_path_is_constrained(path))}];
  });
  nw_path_monitor_set_queue(monitor, dispatch_get_main_queue());
  nw_path_monitor_start(monitor);
}

- (void)stopCurrentSpeech
{
  [self.speechTimer invalidate];
  self.speechTimer = nil;
  self.utterance = nil;
  self.speechOwner = nil;
  self.speechRequest = nil;
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
}
RCT_EXPORT_METHOD(speak:(NSString *)sessionId requestId:(NSString *)requestId text:(NSString *)text language:(NSString *)language rate:(double)rate resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (self.speechOwner && ![self.speechOwner isEqualToString:sessionId]) {
    reject(@"device_unavailable", @"Another reverse-control session is speaking", nil);
    return;
  }
  AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithLanguage:language ?: AVSpeechSynthesisVoice.currentLanguageCode];
  if (!voice) { reject(@"device_unavailable", @"Requested speech language is unavailable", nil); return; }
  [self stopCurrentSpeech];
  if (!self.speech) { self.speech = [AVSpeechSynthesizer new]; self.speech.delegate = self; }
  AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  utterance.voice = voice;
  utterance.rate = MIN(AVSpeechUtteranceMaximumSpeechRate, MAX(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate));
  self.speechOwner = sessionId;
  self.speechRequest = requestId;
  self.utterance = utterance;
  __weak WhipDevice *owner = self;
  self.speechTimer = [NSTimer scheduledTimerWithTimeInterval:WhipSpeechTimeout repeats:NO block:^(NSTimer *timer) { [owner stopCurrentSpeech]; }];
  [self.speech speakUtterance:utterance];
  resolve(@{@"started": @YES});
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  if (self.utterance == utterance) [self stopCurrentSpeech];
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  if (self.utterance == utterance) [self stopCurrentSpeech];
}
RCT_EXPORT_METHOD(stopSpeaking:(NSString *)sessionId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  BOOL stopped = [self.speechOwner isEqualToString:sessionId];
  if (stopped) [self stopCurrentSpeech];
  resolve(@{@"stopped": @(stopped)});
}
RCT_EXPORT_METHOD(cancelRequest:(NSString *)requestId)
{
  [self.samples[requestId] fail:@"cancelled" message:@"Device request cancelled"];
  if ([self.speechRequest isEqualToString:requestId]) [self stopCurrentSpeech];
}
RCT_EXPORT_METHOD(releaseSession:(NSString *)sessionId)
{
  if ([self.speechOwner isEqualToString:sessionId]) [self stopCurrentSpeech];
}
@end
