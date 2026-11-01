#import <XCTest/XCTest.h>
#import <WebKit/WebKit.h>
#import "WhipBrowser.h"

@interface WhipBrowser (DownloadTesting)
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

@interface WhipBrowserDownloadTests : XCTestCase
@end
@implementation WhipBrowserDownloadTests
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
