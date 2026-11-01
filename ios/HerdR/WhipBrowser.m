#import "WhipBrowser.h"
#import <WebKit/WebKit.h>
#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>
#import <errno.h>

static const CGFloat WhipBrowserScreenshotLimit = 1024;
static const CGFloat WhipBrowserJPEGQuality = 0.75;
static NSString *const WhipBrowserUnavailable = @"BROWSER_UNAVAILABLE";
static NSString *const WhipBrowserEvaluation = @"BROWSER_EVALUATE";
static NSString *const WhipBrowserScreenshot = @"BROWSER_SCREENSHOT";
static NSString *const WhipBrowserInvalidURL = @"BROWSER_URL";
static NSString *const WhipBrowserDownloadError = @"DOWNLOAD_FAILED";
static const int64_t WhipBrowserMaxDownloadBytes = 64 * 1024 * 1024;
static const int64_t WhipBrowserDownloadStorageReserve = 64 * 1024 * 1024;
static NSString *const WhipDownloadLowStorage = @"Not enough storage. Free up space and download again.";
static NSString *const WhipDownloadStorageUnavailable = @"Could not check available storage. Try downloading again.";
static NSString *const WhipDownloadFailure = @"Download failed. Try again from the page.";
static NSString *const WhipDownloadSizeLimit = @"Download exceeds the size limit.";
static NSString *const WhipDownloadHTTP = @"The server could not provide the file. Try again from the page.";
static NSString *const WhipDownloadTimeout = @"The download timed out. Check your connection and try again.";
static NSString *const WhipDownloadNetwork = @"The connection was interrupted. Check your connection and download again.";
static NSString *const WhipDownloadWrite = @"Could not save the download. Check device storage and try again.";
static NSString *const WhipDownloadInterruption = @"Download interrupted because the browser connection or app stopped. Download again from the page.";
static NSString *const WhipDownloadActive = @"downloading";
static NSString *const WhipDownloadSaving = @"saving";
static NSString *const WhipDownloadComplete = @"complete";
static NSString *const WhipDownloadFailed = @"failed";
static NSString *const WhipDownloadCancelled = @"cancelled";
static NSString *const WhipDownloadInterrupted = @"interrupted";

static BOOL WhipDownloadIsActive(NSString *state) {
  return [state isEqual:WhipDownloadActive] || [state isEqual:WhipDownloadSaving];
}

// Never forward localizedDescription/userInfo: they can include signed URLs and tokens.
static NSString *WhipDownloadErrorMessage(NSError *error, BOOL writing) {
  NSString *message = writing ? WhipDownloadWrite : WhipDownloadFailure;
  NSUInteger depth = 0;
  for (NSError *cause = error; cause && depth++ < 16; cause = cause.userInfo[NSUnderlyingErrorKey]) {
    if (([cause.domain isEqual:NSCocoaErrorDomain] && cause.code == NSFileWriteOutOfSpaceError) ||
        ([cause.domain isEqual:NSPOSIXErrorDomain] && cause.code == ENOSPC)) return WhipDownloadLowStorage;
    if ([cause.domain isEqual:NSURLErrorDomain]) {
      switch (cause.code) {
        case NSURLErrorBadServerResponse: message = WhipDownloadHTTP; break;
        case NSURLErrorTimedOut: message = WhipDownloadTimeout; break;
        case NSURLErrorCannotFindHost:
        case NSURLErrorCannotConnectToHost:
        case NSURLErrorNetworkConnectionLost:
        case NSURLErrorDNSLookupFailed:
        case NSURLErrorNotConnectedToInternet:
        case NSURLErrorSecureConnectionFailed: message = WhipDownloadNetwork; break;
        case NSURLErrorCannotCreateFile:
        case NSURLErrorCannotOpenFile:
        case NSURLErrorCannotWriteToFile:
        case NSURLErrorCannotMoveFile: message = WhipDownloadWrite; break;
        default: break;
      }
    } else if ([cause.domain isEqual:NSCocoaErrorDomain]) {
      message = WhipDownloadWrite;
    } else if ([cause.domain isEqual:NSPOSIXErrorDomain] &&
               (writing || cause.code == EACCES || cause.code == EIO || cause.code == EROFS || cause.code == EDQUOT)) {
      message = WhipDownloadWrite;
    }
  }
  return message;
}

static NSURL *WhipDownloadDirectory(NSString *identifier) {
  NSURL *root = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject
    URLByAppendingPathComponent:@"browser-downloads" isDirectory:YES];
  return [root URLByAppendingPathComponent:identifier isDirectory:YES];
}

static BOOL WhipValidDownload(NSString *identifier, NSString *name) {
  return [[NSUUID alloc] initWithUUIDString:identifier] != nil && name.length &&
    ![name isEqual:@"."] && ![name isEqual:@".."] &&
    [name rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/\\"]].location == NSNotFound;
}

static NSURL *WhipDownloadManifest(NSString *identifier) {
  return [NSURL fileURLWithPath:[WhipDownloadDirectory(identifier).path stringByAppendingString:@".json"]];
}

@interface WhipBrowserDownload : NSObject <WKDownloadDelegate>
@property(nonatomic, strong) WKDownload *download;
@property(nonatomic, strong) NSURL *file;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, copy) NSString *mimeType;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic) int64_t maxBytes;
@property(nonatomic) NSUInteger redirects;
@property(nonatomic) BOOL cancelled;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *state;
@property(nonatomic) int64_t createdAt;
@property(nonatomic) int64_t bytes;
@property(nonatomic) int64_t totalBytes;
@property(nonatomic, copy) NSString *error;
- (void)cancel;
- (NSDictionary *)status;
@end

@implementation WhipBrowserDownload
- (NSDictionary *)status {
  NSMutableDictionary *status = [@{@"id": self.identifier, @"name": self.name, @"bytes": @(self.bytes),
    @"total_bytes": @(self.totalBytes), @"mime_type": self.mimeType,
    @"state": self.state, @"created_at": @(self.createdAt)} mutableCopy];
  if (self.error) status[@"error"] = self.error;
  return status;
}
- (NSNumber *)availableBytesAtURL:(NSURL *)directory {
  // Use a fresh URL so repeated checks do not reuse cached resource values.
  NSURL *volume = [NSURL fileURLWithPath:directory.path];
  return [volume resourceValuesForKeys:@[NSURLVolumeAvailableCapacityKey] error:nil][NSURLVolumeAvailableCapacityKey];
}
- (BOOL)checkStorageAtURL:(NSURL *)directory required:(int64_t)required {
  if (!self.identifier) return YES; // Agent requests keep their independent byte bound.
  NSNumber *available = [self availableBytesAtURL:directory];
  if (!available || available.longLongValue < 0) {
    self.error = WhipDownloadStorageUnavailable;
    return NO;
  }
  if (available.longLongValue <= WhipBrowserDownloadStorageReserve ||
      required > available.longLongValue - WhipBrowserDownloadStorageReserve) {
    self.error = WhipDownloadLowStorage;
    return NO;
  }
  return YES;
}
- (void)cancel
{
  if (self.identifier && [self.state isEqual:WhipDownloadComplete]) return;
  if (self.identifier && WhipDownloadIsActive(self.state)) {
    self.state = WhipDownloadFailed;
    if (!self.error) self.error = WhipDownloadFailure;
  }
  self.cancelled = YES;
  [self.timer invalidate];
  self.timer = nil;
  WKDownload *download = self.download;
  self.download = nil;
  NSURL *file = self.file;
  [download cancel:^(NSData *resumeData) {
    if (file) [[NSFileManager defaultManager] removeItemAtURL:file error:nil];
  }];
  if (self.file) [[NSFileManager defaultManager] removeItemAtURL:self.file error:nil];
  if (self.reject) self.reject(WhipBrowserDownloadError, self.error ?: WhipDownloadFailure, nil);
  self.resolve = nil;
  self.reject = nil;
}
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
 suggestedFilename:(NSString *)suggestedFilename completionHandler:(void (^)(NSURL *))completionHandler
{
  NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
  BOOL generatedFile = [@[@"blob", @"data"] containsObject:response.URL.scheme] ||
    [@[@"blob", @"data"] containsObject:self.download.originalRequest.URL.scheme];
  BOOL validStatus = (status >= 200 && status < 300 && status != 206) ||
    (self.identifier && generatedFile);
  if (self.cancelled || !validStatus || response.expectedContentLength > self.maxBytes) {
    if (!self.cancelled) self.error = !validStatus
      ? (status >= 100 && status <= 599
        ? [NSString stringWithFormat:@"The server could not provide the file (HTTP %ld). Try again from the page.", (long)status]
        : WhipDownloadHTTP)
      : WhipDownloadSizeLimit;
    completionHandler(nil);
    [self cancel];
    return;
  }
  NSURL *directory = [[[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject
      URLByAppendingPathComponent:@"whip-browser-downloads" isDirectory:YES];
  if (self.identifier) directory = WhipDownloadDirectory(self.identifier);
  NSError *error = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error]) {
    self.error = WhipDownloadErrorMessage(error, YES);
    completionHandler(nil);
    [self cancel];
    return;
  }
  if (![self checkStorageAtURL:directory required:MAX(0, response.expectedContentLength)]) {
    completionHandler(nil);
    [self cancel];
    return;
  }
  // A server's filename cannot select either the phone cache path or host path.
  self.file = [directory URLByAppendingPathComponent:NSUUID.UUID.UUIDString];
  if (self.identifier) {
    NSString *name = [[suggestedFilename.lastPathComponent componentsSeparatedByCharactersInSet:NSCharacterSet.controlCharacterSet] componentsJoinedByString:@""];
    name = [name stringByReplacingOccurrencesOfString:@"\\" withString:@"_"];
    if (name.length > 180) name = [name substringWithRange:[name rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, 180)]];
    self.name = WhipValidDownload(self.identifier, name) ? name : @"download";
    self.file = [directory URLByAppendingPathComponent:[self.name stringByAppendingString:@".part"]];
  }
  self.mimeType = response.MIMEType ?: @"application/octet-stream";
  self.totalBytes = response.expectedContentLength;
  __weak WhipBrowserDownload *weakSelf = self;
  self.timer = [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
    WhipBrowserDownload *job = weakSelf;
    if (!job) { [timer invalidate]; return; }
    NSNumber *size = [[NSFileManager defaultManager] attributesOfItemAtPath:job.file.path error:nil][NSFileSize];
    job.bytes = MAX(size.longLongValue, job.download.progress.completedUnitCount);
    if (job.bytes > job.maxBytes) { job.error = WhipDownloadSizeLimit; [job cancel]; return; }
    if (![job checkStorageAtURL:job.file.URLByDeletingLastPathComponent required:MAX(0, job.totalBytes - size.longLongValue)]) {
      [job cancel]; return;
    }
    if (job.identifier && ((job.totalBytes > 0 && job.bytes >= job.totalBytes) || job.download.progress.finished))
      job.state = WhipDownloadSaving;
  }];
  completionHandler(self.file);
}
- (void)download:(WKDownload *)download willPerformHTTPRedirection:(NSHTTPURLResponse *)response
 newRequest:(NSURLRequest *)request decisionHandler:(void (^)(WKDownloadRedirectPolicy))decisionHandler
{
  NSURL *url = request.URL;
  BOOL valid = ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"])
    && url.host.length && !url.user && !url.password
    && (!([response.URL.scheme isEqualToString:@"https"]) || [url.scheme isEqualToString:@"https"]);
  if (self.cancelled || !valid || ++self.redirects > 10) {
    decisionHandler(WKDownloadRedirectPolicyCancel);
    [self cancel];
  } else decisionHandler(WKDownloadRedirectPolicyAllow);
}
- (void)downloadDidFinish:(WKDownload *)download
{
  [self.timer invalidate];
  self.timer = nil;
  NSNumber *size = [[NSFileManager defaultManager] attributesOfItemAtPath:self.file.path error:nil][NSFileSize];
  if (self.cancelled) return;
  if (!size || size.longLongValue > self.maxBytes) {
    self.error = size ? WhipDownloadSizeLimit : WhipDownloadWrite;
    [self cancel]; return;
  }
  if (![self checkStorageAtURL:self.file.URLByDeletingLastPathComponent required:0]) { [self cancel]; return; }
  if (self.identifier) {
    self.state = WhipDownloadSaving;
    NSURL *destination = [WhipDownloadDirectory(self.identifier) URLByAppendingPathComponent:self.name];
    NSError *error = nil;
    if (![[NSFileManager defaultManager] moveItemAtURL:self.file toURL:destination error:&error]) {
      self.error = WhipDownloadErrorMessage(error, YES); [self cancel]; return;
    }
    self.file = destination;
    self.state = WhipDownloadComplete;
    self.bytes = size.longLongValue;
    self.totalBytes = self.bytes;
    NSData *manifest = [NSJSONSerialization dataWithJSONObject:self.status options:0 error:nil];
    if (![manifest writeToURL:WhipDownloadManifest(self.identifier) options:NSDataWritingAtomic error:&error]) {
      self.state = WhipDownloadFailed;
      self.error = WhipDownloadErrorMessage(error, YES);
      [self cancel];
      return;
    }
    self.download = nil;
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = @"Download complete";
    content.body = self.name;
    content.sound = UNNotificationSound.defaultSound;
    content.userInfo = @{@"browserDownloadId": self.identifier};
    [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:
      [UNNotificationRequest requestWithIdentifier:self.identifier content:content trigger:nil] withCompletionHandler:nil];
  }
  if (self.resolve) self.resolve(@{@"local_path": self.file.path, @"bytes": size, @"mime_type": self.mimeType});
  self.resolve = nil;
  self.reject = nil;
}
- (void)download:(WKDownload *)download didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
 completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler
{
  completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData
{
  if (self.cancelled || [self.state isEqual:WhipDownloadComplete]) return;
  if ([error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorCancelled && !self.error) {
    self.state = WhipDownloadCancelled;
  } else if (!self.error) {
    self.error = WhipDownloadErrorMessage(error, NO);
  }
  [self cancel];
}
@end

@interface WhipBrowser () <UIDocumentInteractionControllerDelegate>
@property(nonatomic, strong) NSMutableDictionary<NSString *, WhipBrowserDownload *> *downloads;
@property(nonatomic, strong) NSMutableDictionary<NSString *, id> *savedStates;
@property(nonatomic, strong) NSMutableDictionary<NSString *, WhipBrowserDownload *> *savedDownloads;
@property(nonatomic, strong) NSHashTable<WKWebView *> *managedBrowsers;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *restoredDownloads;
@property(nonatomic, strong) UIDocumentInteractionController *downloadPreview;
@end

/** Native operations are reachable only from React Native, never a webpage bridge. */
@implementation WhipBrowser
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;

RCT_EXPORT_MODULE(WhipBrowser)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (instancetype)init {
  if ((self = [super init])) {
    _savedDownloads = [NSMutableDictionary new];
    _managedBrowsers = [NSHashTable weakObjectsHashTable];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(downloadStarted:) name:@"WhipBrowserDownloadStarted" object:nil];
  }
  return self;
}

- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }

- (void)downloadStarted:(NSNotification *)notification {
  WKDownload *download = notification.userInfo[@"download"];
  if (![self.managedBrowsers containsObject:notification.object] || !download) return;
  if (![@[@"http", @"https", @"blob", @"data"] containsObject:download.originalRequest.URL.scheme]) {
    [download cancel:nil];
    return;
  }
  WhipBrowserDownload *job = [WhipBrowserDownload new];
  job.identifier = NSUUID.UUID.UUIDString;
  job.name = @"download";
  job.state = WhipDownloadActive;
  job.createdAt = (int64_t)(NSDate.date.timeIntervalSince1970 * 1000);
  job.totalBytes = -1;
  job.mimeType = @"application/octet-stream";
  job.maxBytes = INT64_MAX; // Personal downloads are bounded by available storage.
  job.download = download;
  self.savedDownloads[job.identifier] = job;
  download.delegate = job;
}

- (WKWebView *)browserInView:(UIView *)view
{
  if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
  for (UIView *child in view.subviews) {
    WKWebView *browser = [self browserInView:child];
    if (browser) return browser;
  }
  return nil;
}

- (void)withBrowser:(NSNumber *)tag
            reject:(RCTPromiseRejectBlock)reject
            action:(void (^)(WKWebView *))action
{
  // RCTViewRegistry resolves Fabric tags in the bridgeless app. The supplied
  // tag belongs to our non-collapsible container, not WebView's JS wrapper.
  WKWebView *browser = [self browserInView:[self.viewRegistry_DEPRECATED viewForReactTag:tag]];
  if (!browser) {
    reject(WhipBrowserUnavailable, @"Browser tab is no longer mounted", nil);
    return;
  }
  action(browser);
}

RCT_EXPORT_METHOD(prepare:(NSNumber *)tag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    browser.allowsBackForwardNavigationGestures = YES;
    [self.managedBrowsers addObject:browser];
    objc_setAssociatedObject(browser, NSSelectorFromString(@"whipManagedDownloads"), @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    resolve(nil);
  }];
}

RCT_EXPORT_METHOD(saveState:(NSNumber *)tag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    id state = browser.interactionState;
    if (!state) { resolve(nil); return; }
    if (!self.savedStates) self.savedStates = [NSMutableDictionary new];
    NSString *token = NSUUID.UUID.UUIDString;
    self.savedStates[token] = state;
    resolve(token);
  }];
}

RCT_EXPORT_METHOD(restoreState:(NSNumber *)tag
                  token:(NSString *)token
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    id state = self.savedStates[token];
    [self.savedStates removeObjectForKey:token];
    if (!state) { resolve(@NO); return; }
    browser.interactionState = state;
    resolve(@YES);
  }];
}

RCT_EXPORT_METHOD(discardState:(NSString *)token)
{
  [self.savedStates removeObjectForKey:token];
}

RCT_EXPORT_METHOD(defaultUserAgent:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.defaultWebpagePreferences.preferredContentMode = WKContentModeMobile;
  WKWebView *browser = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration];
  [browser evaluateJavaScript:@"navigator.userAgent" completionHandler:^(id value, NSError *error) {
    // Keep the temporary view alive until WebKit completes the request.
    (void)browser;
    if (error || ![value isKindOfClass:NSString.class])
      reject(WhipBrowserUnavailable, @"Could not read browser user agent", error);
    else resolve(value);
  }];
}

RCT_EXPORT_METHOD(configureProfile:(NSNumber *)tag
                  userAgent:(NSString *)userAgent
                  contentMode:(NSString *)contentMode
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *modes = @{@"mobile": @(WKContentModeMobile), @"desktop": @(WKContentModeDesktop),
                           @"recommended": @(WKContentModeRecommended)};
  NSNumber *mode = modes[contentMode];
  if (!mode) { reject(WhipBrowserUnavailable, @"Invalid browser profile", nil); return; }
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    browser.configuration.defaultWebpagePreferences.preferredContentMode = mode.integerValue;
    browser.customUserAgent = userAgent.length ? userAgent : nil;
    resolve(nil);
  }];
}

RCT_EXPORT_METHOD(navigate:(NSNumber *)tag
                  url:(NSString *)url
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSURLComponents *address = [NSURLComponents componentsWithString:url];
  if (!([address.scheme isEqualToString:@"http"] || [address.scheme isEqualToString:@"https"]) ||
      !address.host.length || address.user != nil || address.password != nil || !address.URL) {
    reject(WhipBrowserInvalidURL, @"Only valid HTTP and HTTPS links without credentials can be opened", nil);
    return;
  }
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser loadRequest:[NSURLRequest requestWithURL:address.URL]];
    resolve(nil);
  }];
}

RCT_EXPORT_METHOD(evaluate:(NSNumber *)tag
                  script:(NSString *)script
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
      if (error) {
        reject(WhipBrowserEvaluation, @"Could not evaluate browser action", error);
        return;
      }
      // Android returns JSON-encoded evaluateJavascript results. Preserve that
      // contract, including a DOM program that itself returns a JSON string.
      NSData *encoded = [NSJSONSerialization dataWithJSONObject:value ?: NSNull.null
                                                       options:NSJSONWritingFragmentsAllowed
                                                         error:&error];
      if (!encoded) reject(WhipBrowserEvaluation, @"Browser action returned an unsupported value", error);
      else resolve([[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding]);
    }];
  }];
}

RCT_EXPORT_METHOD(download:(NSNumber *)tag
                  identifier:(NSString *)identifier
                  url:(NSString *)url
                  maxBytes:(NSNumber *)maxBytes
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSURLComponents *address = [NSURLComponents componentsWithString:url];
  if (!([address.scheme isEqualToString:@"http"] || [address.scheme isEqualToString:@"https"]) ||
      !address.host.length || address.user != nil || address.password != nil || !address.URL ||
      maxBytes.longLongValue < 1 || maxBytes.longLongValue > WhipBrowserMaxDownloadBytes ||
      maxBytes.doubleValue != (double)maxBytes.longLongValue) {
    reject(WhipBrowserDownloadError, @"Invalid browser download request", nil);
    return;
  }
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    WhipBrowserDownload *job = [WhipBrowserDownload new];
    job.maxBytes = maxBytes.longLongValue;
    job.resolve = resolve;
    job.reject = reject;
    if (!self.downloads) self.downloads = [NSMutableDictionary new];
    self.downloads[identifier] = job;
    [browser startDownloadUsingRequest:[NSURLRequest requestWithURL:address.URL] completionHandler:^(WKDownload *download) {
      job.download = download;
      download.delegate = job;
      if (job.cancelled) [job cancel];
    }];
    __weak WhipBrowser *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(125 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [job cancel];
      [weakSelf.downloads removeObjectForKey:identifier];
    });
  }];
}

RCT_EXPORT_METHOD(cancelDownload:(NSString *)identifier)
{
  [self.downloads[identifier] cancel];
  [self.downloads removeObjectForKey:identifier];
}

- (void)invalidate
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  for (WhipBrowserDownload *job in self.savedDownloads.allValues)
    if (WhipDownloadIsActive(job.state)) {
      job.state = WhipDownloadInterrupted;
      job.error = WhipDownloadInterruption;
      [job cancel];
    }
  [self.savedStates removeAllObjects];
  for (WhipBrowserDownload *job in self.downloads.allValues) [job cancel];
  [self.downloads removeAllObjects];
}

RCT_EXPORT_METHOD(downloadUpdates:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!self.restoredDownloads) {
    self.restoredDownloads = [NSMutableDictionary new];
    NSURL *root = WhipDownloadDirectory(@"");
    for (NSURL *file in [[NSFileManager defaultManager] contentsOfDirectoryAtURL:root includingPropertiesForKeys:nil options:0 error:nil]) {
      if (![file.pathExtension isEqual:@"json"]) continue;
      NSData *data = [NSData dataWithContentsOfURL:file];
      id entry = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if ([entry isKindOfClass:NSDictionary.class] && [entry[@"state"] isEqual:WhipDownloadComplete] &&
          [entry[@"id"] isKindOfClass:NSString.class]) self.restoredDownloads[entry[@"id"]] = entry;
    }
  }
  NSMutableDictionary *updates = [self.restoredDownloads mutableCopy];
  for (WhipBrowserDownload *job in self.savedDownloads.allValues) {
    updates[job.identifier] = job.status;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:updates.allValues options:0 error:nil];
  resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}

RCT_EXPORT_METHOD(cancelSavedDownload:(NSString *)identifier)
{
  WhipBrowserDownload *job = self.savedDownloads[identifier];
  if (WhipDownloadIsActive(job.state)) { job.state = WhipDownloadCancelled; [job cancel]; }
}

RCT_EXPORT_METHOD(removeSavedDownload:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!WhipValidDownload(identifier, @"download")) { reject(@"DOWNLOAD_REMOVE", @"Invalid download", nil); return; }
  [self cancelSavedDownload:identifier];
  NSURL *directory = WhipDownloadDirectory(identifier);
  NSError *error = nil;
  if ([[NSFileManager defaultManager] fileExistsAtPath:directory.path] &&
      ![[NSFileManager defaultManager] removeItemAtURL:directory error:&error]) {
    reject(@"DOWNLOAD_REMOVE", @"Could not delete download", error); return;
  }
  [self.savedDownloads removeObjectForKey:identifier];
  [self.restoredDownloads removeObjectForKey:identifier];
  NSURL *manifest = WhipDownloadManifest(identifier);
  if ([[NSFileManager defaultManager] fileExistsAtPath:manifest.path] &&
      ![[NSFileManager defaultManager] removeItemAtURL:manifest error:&error]) {
    reject(@"DOWNLOAD_REMOVE", @"Could not delete download", error); return;
  }
  [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:@[identifier]];
  resolve(nil);
}

RCT_EXPORT_METHOD(openSavedDownload:(NSString *)identifier name:(NSString *)name mimeType:(NSString *)mimeType
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  if (!WhipValidDownload(identifier, name)) { reject(@"DOWNLOAD_OPEN", @"Invalid download", nil); return; }
  NSURL *file = [WhipDownloadDirectory(identifier) URLByAppendingPathComponent:name];
  if (![[NSFileManager defaultManager] fileExistsAtPath:file.path]) { reject(@"DOWNLOAD_OPEN", @"Downloaded file is no longer available", nil); return; }
  UIViewController *presenter = [self downloadPresenter];
  if (!presenter) { reject(@"DOWNLOAD_OPEN", @"Could not open downloaded file", nil); return; }
  self.downloadPreview = [UIDocumentInteractionController interactionControllerWithURL:file];
  self.downloadPreview.delegate = self;
  self.downloadPreview.name = name;
  if ([self.downloadPreview presentPreviewAnimated:YES]) { resolve(nil); return; }
  UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[file] applicationActivities:nil];
  sheet.popoverPresentationController.sourceView = presenter.view;
  sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(presenter.view.bounds), CGRectGetMidY(presenter.view.bounds), 1, 1);
  [presenter presentViewController:sheet animated:YES completion:nil];
  resolve(nil);
}

- (UIViewController *)downloadPresenter {
  UIViewController *presenter = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive || ![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) if (window.isKeyWindow) presenter = window.rootViewController;
  }
  while (presenter.presentedViewController) presenter = presenter.presentedViewController;
  return presenter;
}

- (UIViewController *)documentInteractionControllerViewControllerForPreview:(UIDocumentInteractionController *)controller {
  return [self downloadPresenter];
}

RCT_EXPORT_METHOD(screenshot:(NSNumber *)tag
                  annotations:(NSDictionary *)annotations
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    CGSize size = browser.bounds.size;
    if (size.width <= 0 || size.height <= 0) {
      reject(WhipBrowserScreenshot, @"Browser has no drawable viewport", nil);
      return;
    }
    CGFloat scale = MIN(1, WhipBrowserScreenshotLimit / MAX(size.width, size.height));
    CGSize outputSize = CGSizeMake(MAX(1, floor(size.width * scale)), MAX(1, floor(size.height * scale)));
    WKSnapshotConfiguration *configuration = [WKSnapshotConfiguration new];
    configuration.rect = browser.bounds;
    configuration.snapshotWidth = @(outputSize.width);
    [browser takeSnapshotWithConfiguration:configuration completionHandler:^(UIImage *image, NSError *error) {
      if (!image || error) {
        reject(WhipBrowserScreenshot, @"Could not capture browser viewport", error);
        return;
      }
      // WebKit may return a Retina image. Normalize to bounded pixel dimensions.
      UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
      format.scale = 1;
      format.opaque = YES;
      UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:outputSize format:format];
      UIImage *bounded = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        [UIColor.whiteColor setFill];
        [context fillRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
        [image drawInRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
        if (annotations) {
          CGFloat viewportWidth = [annotations[@"viewport_width"] doubleValue];
          CGFloat viewportHeight = [annotations[@"viewport_height"] doubleValue];
          if (viewportWidth > 0 && viewportHeight > 0) {
            CGContextRef cg = context.CGContext;
            CGContextSaveGState(cg);
            CGContextScaleCTM(cg, outputSize.width / viewportWidth, outputSize.height / viewportHeight);
            NSDictionary *attributes = @{NSFontAttributeName: [UIFont systemFontOfSize:11],
                                         NSForegroundColorAttributeName: UIColor.whiteColor};
            NSArray *elements = annotations[@"elements"];
            for (NSDictionary *item in [elements subarrayWithRange:NSMakeRange(0, MIN(elements.count, 200))]) {
              NSString *label = item[@"ref"];
              label = [label substringToIndex:MIN(label.length, 256)];
              CGFloat width = [label sizeWithAttributes:attributes].width + 6;
              CGFloat x = MAX(0, MIN([item[@"x"] doubleValue], viewportWidth - width));
              CGFloat y = MAX(0, MIN([item[@"y"] doubleValue], viewportHeight - 17));
              [[UIColor colorWithRed:18.0/255 green:64.0/255 blue:148.0/255 alpha:1] setFill];
              UIRectFill(CGRectMake(x, y, width, 17));
              [label drawAtPoint:CGPointMake(x + 3, y + 1) withAttributes:attributes];
            }
            CGContextRestoreGState(cg);
          }
        }
      }];
      NSData *jpeg = UIImageJPEGRepresentation(bounded, WhipBrowserJPEGQuality);
      if (!jpeg) reject(WhipBrowserScreenshot, @"Could not encode browser viewport", nil);
      else resolve([jpeg base64EncodedStringWithOptions:0]);
    }];
  }];
}

// WKHTTPCookieStore enumerates domains directly; no visited URL history or
// cookie values need to cross the native boundary or be persisted separately.
RCT_EXPORT_METHOD(recordSite:(NSString *)url) {}

- (BOOL)checkSite:(WKWebView *)browser expected:(NSString *)expected
          reject:(RCTPromiseRejectBlock)reject
{
  NSURLComponents *address = [NSURLComponents componentsWithString:expected];
  NSURLComponents *current = [NSURLComponents componentsWithURL:browser.URL resolvingAgainstBaseURL:NO];
  BOOL matches = ([address.scheme isEqualToString:@"https"] || [address.scheme isEqualToString:@"http"])
    && address.host.length && address.user == nil && address.password == nil
    && [current.scheme isEqualToString:address.scheme] && [current.host isEqualToString:address.host]
    && ((current.port == nil && address.port == nil) || [current.port isEqualToNumber:address.port]);
  if (!matches) reject(WhipBrowserInvalidURL, @"Browser site changed", nil);
  return matches;
}

RCT_EXPORT_METHOD(currentSiteInfo:(NSNumber *)tag url:(NSString *)url
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    if (![self checkSite:browser expected:url reject:reject]) return;
    NSString *host = browser.URL.host.lowercaseString;
    NSMutableDictionary *result = [@{
      @"url": browser.URL.absoluteString,
      @"secure": @([browser.URL.scheme isEqualToString:@"https"] && browser.serverTrust != nil && browser.hasOnlySecureContent && !browser.loading),
      @"thirdPartyCookiesAllowed": NSNull.null, @"canClearSiteData": @YES,
      @"permissions": @{@"location": @"system", @"camera": @"system", @"microphone": @"system"}
    } mutableCopy];
    if (browser.serverTrust) {
      NSArray *chain = CFBridgingRelease(SecTrustCopyCertificateChain(browser.serverTrust));
      if (chain.count) {
        NSString *subject = CFBridgingRelease(SecCertificateCopySubjectSummary((__bridge SecCertificateRef)chain.firstObject));
        result[@"certificate"] = @{@"subject": subject ?: @""};
      }
    }
    [browser.configuration.websiteDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
      BOOL found = NO;
      for (NSHTTPCookie *cookie in cookies) {
        NSString *domain = cookie.domain.lowercaseString;
        if ([domain hasPrefix:@"."]) domain = [domain substringFromIndex:1];
        if ([host isEqualToString:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]]) { found = YES; break; }
      }
      result[@"hasCookies"] = @(found);
      resolve(result);
    }];
  }];
}

RCT_EXPORT_METHOD(clearCurrentSiteData:(NSNumber *)tag url:(NSString *)url
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    if (![self checkSite:browser expected:url reject:reject]) return;
    NSString *host = browser.URL.host.lowercaseString;
    WKWebsiteDataStore *store = browser.configuration.websiteDataStore;
    NSSet *types = WKWebsiteDataStore.allWebsiteDataTypes;
    [store fetchDataRecordsOfTypes:types completionHandler:^(NSArray<WKWebsiteDataRecord *> *records) {
      NSMutableArray *selected = [NSMutableArray new];
      for (WKWebsiteDataRecord *record in records) {
        NSString *domain = record.displayName.lowercaseString;
        if ([host isEqualToString:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]] || [domain hasSuffix:[@"." stringByAppendingString:host]]) [selected addObject:record];
      }
      [store removeDataOfTypes:types forDataRecords:selected completionHandler:^{ resolve(nil); }];
    }];
  }];
}

RCT_EXPORT_METHOD(siteData:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [[WKWebsiteDataStore defaultDataStore].httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    NSMutableSet<NSString *> *domains = [NSMutableSet new];
    for (NSHTTPCookie *cookie in cookies) {
      NSString *domain = cookie.domain.lowercaseString;
      if ([domain hasPrefix:@"."]) domain = [domain substringFromIndex:1];
      if (domain.length) [domains addObject:domain];
    }
    resolve(@{@"hasCookies": @(cookies.count > 0), @"canClearDomains": @YES,
              @"domains": [domains.allObjects sortedArrayUsingSelector:@selector(compare:)]});
  }];
}

RCT_EXPORT_METHOD(clearDomainCookies:(NSString *)domain
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  WKHTTPCookieStore *store = [WKWebsiteDataStore defaultDataStore].httpCookieStore;
  [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    dispatch_group_t deletions = dispatch_group_create();
    for (NSHTTPCookie *cookie in cookies) {
      NSString *cookieDomain = cookie.domain.lowercaseString;
      if ([cookieDomain hasPrefix:@"."]) cookieDomain = [cookieDomain substringFromIndex:1];
      if (![cookieDomain isEqualToString:domain.lowercaseString]) continue;
      dispatch_group_enter(deletions);
      [store deleteCookie:cookie completionHandler:^{ dispatch_group_leave(deletions); }];
    }
    dispatch_group_notify(deletions, dispatch_get_main_queue(), ^{ resolve(nil); });
  }];
}

RCT_EXPORT_METHOD(clearSiteData:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self.savedStates removeAllObjects];
  [[WKWebsiteDataStore defaultDataStore] removeDataOfTypes:[WKWebsiteDataStore allWebsiteDataTypes]
                                          modifiedSince:NSDate.distantPast
                                      completionHandler:^{ resolve(nil); }];
}

RCT_EXPORT_METHOD(clearTabData:(NSNumber *)tag
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self withBrowser:tag reject:reject action:^(WKWebView *browser) {
    [browser stopLoading];
    NSSet *caches = [NSSet setWithObjects:WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeDiskCache, nil];
    [browser.configuration.websiteDataStore removeDataOfTypes:caches
                                              modifiedSince:NSDate.distantPast
                                          completionHandler:^{ resolve(nil); }];
    // The shared controller disposes the renderer to clear history, form and
    // session state. WKWebView has no public API to clear its back-forward list.
  }];
}
@end
