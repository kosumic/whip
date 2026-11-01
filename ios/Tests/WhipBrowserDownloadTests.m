#import <XCTest/XCTest.h>
#import <WebKit/WebKit.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>
#import "WhipBrowser.h"

@interface WhipBrowser (DownloadTesting)
- (void)prepare:(NSNumber *)tag resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)downloadUpdates:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)removeSavedDownload:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)download:(NSNumber *)tag identifier:(NSString *)identifier url:(NSString *)url maxBytes:(NSNumber *)maxBytes resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)invalidate;
@end

// Exercise the production WebKit delegate with deterministic storage availability.
@interface WhipBrowserDownload : NSObject <WKDownloadDelegate>
@property(nonatomic, strong) NSURL *file;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy) NSString *mimeType;
@property(nonatomic) int64_t maxBytes;
@property(nonatomic) int64_t bytes;
- (NSNumber *)availableBytesAtURL:(NSURL *)directory;
- (NSDictionary *)status;
- (void)cancel;
@end

@interface StorageTestDownload : WhipBrowserDownload
@property(nonatomic, strong) NSNumber *capacity;
@end
@implementation StorageTestDownload
- (NSNumber *)availableBytesAtURL:(NSURL *)directory { return self.capacity; }
@end

@interface DownloadTestRegistry : NSObject
@property(nonatomic, strong) UIView *view;
@end
@implementation DownloadTestRegistry
- (UIView *)viewForReactTag:(NSNumber *)tag { return self.view; }
@end

/** A disk/network streaming fixture; it never allocates a whole response body. */
@interface DownloadHTTPServer : NSObject
@property(nonatomic) int socket;
@property(nonatomic) uint16_t port;
@property(nonatomic, strong) dispatch_semaphore_t done;
- (instancetype)initWithBytes:(int64_t)bytes knownLength:(BOOL)known;
- (void)stop;
@end
@implementation DownloadHTTPServer
- (instancetype)initWithBytes:(int64_t)bytes knownLength:(BOOL)known {
  if (!(self = [super init])) return nil;
  self.socket = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  if (self.socket < 0 || bind(self.socket, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(self.socket, 1) != 0) {
    [self stop];
    return nil;
  }
  socklen_t length = sizeof(address);
  getsockname(self.socket, (struct sockaddr *)&address, &length);
  self.port = ntohs(address.sin_port);
  self.done = dispatch_semaphore_create(0);
  int listener = self.socket;
  dispatch_semaphore_t done = self.done;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    int client = accept(listener, NULL, NULL);
    if (client >= 0) {
      int noSignal = 1;
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
      struct timeval timeout = { .tv_sec = 10 };
      setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
      setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
      char byte;
      NSMutableData *request = [NSMutableData new];
      while (request.length < 16384 && recv(client, &byte, 1, 0) == 1) {
        [request appendBytes:&byte length:1];
        if (request.length >= 4 && memcmp((char *)request.bytes + request.length - 4, "\r\n\r\n", 4) == 0) break;
      }
      NSString *header = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=large.bin\r\n%@\r\n",
        known ? [NSString stringWithFormat:@"Content-Length: %lld\r\n", (long long)bytes] : @""];
      NSData *encoded = [header dataUsingEncoding:NSUTF8StringEncoding];
      send(client, encoded.bytes, encoded.length, 0);
      char buffer[32 * 1024];
      memset(buffer, 90, sizeof(buffer));
      int64_t remaining = bytes;
      while (remaining > 0) {
        ssize_t count = send(client, buffer, (size_t)MIN(remaining, sizeof(buffer)), 0);
        if (count <= 0) break;
        remaining -= count;
      }
      close(client);
    }
    dispatch_semaphore_signal(done);
  });
  return self;
}
- (void)stop {
  if (self.socket >= 0) { shutdown(self.socket, SHUT_RDWR); close(self.socket); self.socket = -1; }
  if (self.done) dispatch_semaphore_wait(self.done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
}
@end

@interface WhipBrowserDownloadTests : XCTestCase
@end
@implementation WhipBrowserDownloadTests
- (void)testUserDownloadsStream100And500MBWithKnownAndUnknownLengths {
  WKWebView *browser = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 320, 640)];
  DownloadTestRegistry *registry = [DownloadTestRegistry new];
  registry.view = browser;
  for (NSNumber *size in @[@100000000, @500000000]) for (NSNumber *known in @[@YES, @NO]) {
    WhipBrowser *adapter = [WhipBrowser new];
    [adapter setValue:registry forKey:@"viewRegistry_DEPRECATED"];
    [adapter prepare:@42 resolve:^(id value) {} reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
    DownloadHTTPServer *server = [[DownloadHTTPServer alloc] initWithBytes:size.longLongValue knownLength:known.boolValue];
    XCTAssertNotNil(server);
    if (!server) return;
    XCTestExpectation *started = [self expectationWithDescription:@"WebKit download started"];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/large.bin", server.port]];
    [browser startDownloadUsingRequest:[NSURLRequest requestWithURL:url] completionHandler:^(WKDownload *download) {
      [[NSNotificationCenter defaultCenter] postNotificationName:@"WhipBrowserDownloadStarted" object:browser userInfo:@{@"download":download}];
      [started fulfill];
    }];
    [self waitForExpectations:@[started] timeout:30];
    XCTestExpectation *finished = [self expectationWithDescription:@"download finished"];
    __block NSDictionary *result;
    NSTimer *poll = [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {
      [adapter downloadUpdates:^(NSString *json) {
        NSArray *entries = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        for (NSDictionary *entry in entries) {
          if ([entry[@"name"] isEqual:@"large.bin"] && ![@[@"downloading", @"saving"] containsObject:entry[@"state"]] &&
              ![entry[@"state"] isEqual:@"complete"]) { result = entry; break; }
          if ([entry[@"name"] isEqual:@"large.bin"] && [entry[@"bytes"] isEqual:size]) { result = entry; break; }
        }
        if (result && ![@[@"downloading", @"saving"] containsObject:result[@"state"]]) { [timer invalidate]; [finished fulfill]; }
      } reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
    }];
    @try {
      [self waitForExpectations:@[finished] timeout:120];
      XCTAssertEqualObjects(result[@"state"], @"complete", @"%@", result);
      XCTAssertEqualObjects(result[@"bytes"], size);
      NSURL *root = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"browser-downloads"];
      NSURL *file = [[root URLByAppendingPathComponent:result[@"id"]] URLByAppendingPathComponent:result[@"name"]];
      NSInputStream *input = [NSInputStream inputStreamWithURL:file];
      [input open];
      uint8_t buffer[32 * 1024];
      int64_t read = 0;
      NSInteger count;
      BOOL valid = YES;
      while ((count = [input read:buffer maxLength:sizeof(buffer)]) > 0) {
        read += count;
        for (NSInteger index = 0; index < count; index++) if (buffer[index] != 90) { valid = NO; break; }
        if (!valid) break;
      }
      [input close];
      XCTAssertEqual(read, size.longLongValue);
      XCTAssertTrue(valid);
      WhipBrowser *restored = [WhipBrowser new];
      [restored downloadUpdates:^(NSString *json) { XCTAssertTrue([json containsString:result[@"id"]]); }
        reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
    } @finally {
      [poll invalidate];
      [adapter invalidate];
      if (result) [adapter removeSavedDownload:result[@"id"] resolve:^(id value) {}
        reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
      [server stop];
    }
  }
}

- (StorageTestDownload *)jobWithCapacity:(NSNumber *)capacity {
  StorageTestDownload *job = [StorageTestDownload new];
  job.identifier = NSUUID.UUID.UUIDString;
  job.state = @"downloading";
  job.name = @"download";
  job.mimeType = @"application/octet-stream";
  job.maxBytes = INT64_MAX;
  job.capacity = capacity;
  return job;
}
- (void)chooseDestination:(WhipBrowserDownload *)job length:(NSNumber *)length {
  NSDictionary *headers = length ? @{@"Content-Length":length.stringValue} : @{};
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:[NSURL URLWithString:@"https://example.test/file"]
    statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:headers];
  [job download:nil decideDestinationUsingResponse:response suggestedFilename:@"file.bin" completionHandler:^(NSURL *file) {}];
}
- (void)removeJob:(WhipBrowserDownload *)job {
  [job cancel];
  NSURL *root = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"browser-downloads"];
  [[NSFileManager defaultManager] removeItemAtURL:[root URLByAppendingPathComponent:job.identifier] error:nil];
}
- (void)testKnownOversizeAndUnavailableStorageFailBeforeCreatingAFile {
  for (NSNumber *capacity in @[@(64 * 1024 * 1024), @(64 * 1024 * 1024 + 99)]) {
    StorageTestDownload *job = [self jobWithCapacity:capacity];
    [self chooseDestination:job length:@100];
    XCTAssertNil(job.file);
    XCTAssertEqualObjects(job.status[@"state"], @"failed");
    XCTAssertEqualObjects(job.status[@"error"], @"Not enough storage. Free up space and download again.");
    [self removeJob:job];
  }
  StorageTestDownload *job = [self jobWithCapacity:nil];
  [self chooseDestination:job length:nil];
  XCTAssertNil(job.file);
  XCTAssertEqualObjects(job.status[@"error"], @"Could not check available storage. Try downloading again.");
  [self removeJob:job];
}
- (void)testStorageLossCleansUpKnownAndUnknownLengthPartialDownloads {
  for (id length in @[@100, NSNull.null]) {
    StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
    [self chooseDestination:job length:length == NSNull.null ? nil : length];
    XCTAssertNotNil(job.file);
    [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
    job.capacity = @(64 * 1024 * 1024);
    [job.timer fire];
    XCTAssertEqualObjects(job.status[@"state"], @"failed");
    XCTAssertEqualObjects(job.status[@"error"], @"Not enough storage. Free up space and download again.");
    XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
    [self removeJob:job];
  }
}
- (void)testCancellationAndInvalidationCleanUpPartialFiles {
  StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
  [self chooseDestination:job length:nil];
  [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
  job.state = @"cancelled";
  [job cancel];
  XCTAssertEqualObjects(job.status[@"state"], @"cancelled");
  XCTAssertNil(job.status[@"error"]);
  XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
  [self removeJob:job];
  WhipBrowser *adapter = [WhipBrowser new];
  job = [self jobWithCapacity:@(128 * 1024 * 1024)];
  [self chooseDestination:job length:nil];
  [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
  [adapter setValue:[@{job.identifier:job} mutableCopy] forKey:@"savedDownloads"];
  [adapter invalidate];
  XCTAssertEqualObjects(job.status[@"state"], @"interrupted");
  XCTAssertEqualObjects(job.status[@"error"], @"Download interrupted because the browser connection or app stopped. Download again from the page.");
  XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
  [self removeJob:job];
}
- (void)testHTTPAndSizeFailuresAreDistinctAndDoNotExposeResponseURLs {
  for (NSNumber *status in @[@403, @503]) {
    StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:[NSURL URLWithString:@"https://example.test/file?token=secret"]
      statusCode:status.integerValue HTTPVersion:@"HTTP/1.1" headerFields:@{}];
    [job download:nil decideDestinationUsingResponse:response suggestedFilename:@"file.bin" completionHandler:^(NSURL *file) { XCTAssertNil(file); }];
    XCTAssertEqualObjects(job.status[@"state"], @"failed");
    NSString *expected = [NSString stringWithFormat:@"The server could not provide the file (HTTP %@). Try again from the page.", status];
    XCTAssertEqualObjects(job.status[@"error"], expected);
    [self removeJob:job];
  }
  for (NSNumber *known in @[@YES, @NO]) {
    StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
    job.maxBytes = 4;
    [self chooseDestination:job length:known.boolValue ? @10 : nil];
    if (!known.boolValue) {
      [@"0123456789" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
      [job.timer fire];
    }
    XCTAssertEqualObjects(job.status[@"error"], @"Download exceeds the size limit.");
    if (job.file) XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
    [self removeJob:job];
  }
}
- (void)testNativeFailuresAreCategorizedWithoutExposingErrorInternals {
  NSArray *failures = @[
    @[NSURLErrorDomain, @(NSURLErrorBadServerResponse), @"The server could not provide the file. Try again from the page."],
    @[NSURLErrorDomain, @(NSURLErrorTimedOut), @"The download timed out. Check your connection and try again."],
    @[NSURLErrorDomain, @(NSURLErrorNetworkConnectionLost), @"The connection was interrupted. Check your connection and download again."],
    @[NSCocoaErrorDomain, @(NSFileWriteNoPermissionError), @"Could not save the download. Check device storage and try again."],
    @[NSCocoaErrorDomain, @(NSFileWriteOutOfSpaceError), @"Not enough storage. Free up space and download again."],
    @[@"private-domain", @123, @"Download failed. Try again from the page."]
  ];
  for (NSArray *failure in failures) {
    StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
    [self chooseDestination:job length:nil];
    [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
    NSError *error = [NSError errorWithDomain:failure[0] code:[failure[1] integerValue]
      userInfo:@{NSLocalizedDescriptionKey:@"https://example.test/file?token=secret"}];
    [job download:nil didFailWithError:error resumeData:nil];
    XCTAssertEqualObjects(job.status[@"state"], @"failed");
    XCTAssertEqualObjects(job.status[@"error"], failure[2]);
    XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
    [self removeJob:job];
  }
}
- (void)testDownloadedBytesAreSavingUntilFinalizationSucceeds {
  StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
  [self chooseDestination:job length:@7];
  [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
  [job.timer fire];
  XCTAssertEqualObjects(job.status[@"state"], @"saving");
  // A destination collision fails during the save, after every network byte arrived.
  NSURL *destination = [job.file.URLByDeletingLastPathComponent URLByAppendingPathComponent:job.name];
  [[NSFileManager defaultManager] createDirectoryAtURL:destination withIntermediateDirectories:YES attributes:nil error:nil];
  [job downloadDidFinish:nil];
  XCTAssertEqualObjects(job.status[@"state"], @"failed");
  XCTAssertEqualObjects(job.status[@"error"], @"Could not save the download. Check device storage and try again.");
  XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
  [self removeJob:job];
}
- (void)testInterruptedTransfersCleanUpAndAgentCapRemains64MiB {
  StorageTestDownload *job = [self jobWithCapacity:@(128 * 1024 * 1024)];
  [self chooseDestination:job length:nil];
  [@"partial" writeToURL:job.file atomically:NO encoding:NSUTF8StringEncoding error:nil];
  [job download:nil didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil] resumeData:nil];
  XCTAssertEqualObjects(job.status[@"state"], @"failed");
  XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:job.file.path]);
  [self removeJob:job];
  WhipBrowser *adapter = [WhipBrowser new];
  __block BOOL rejected = NO;
  [adapter download:@42 identifier:@"agent-test" url:@"https://example.test/file" maxBytes:@(64 * 1024 * 1024 + 1)
    resolve:^(id value) { XCTFail(@"Agent download must reject larger limits"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; XCTAssertEqualObjects(message, @"Invalid browser download request"); }];
  XCTAssertTrue(rejected);
}
@end
