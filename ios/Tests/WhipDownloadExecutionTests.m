#import <XCTest/XCTest.h>
#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>

// The standalone host replaces React transport and the Rust C boundary. Tests
// exercise the real OS execution and bookmark adapter methods below that bridge.
void RCTRegisterModule(Class module) {}
@implementation RCTEventEmitter
- (void)sendEventWithName:(NSString *)name body:(id)body {}
- (void)invalidate {}
@end
NSString *const WhipVoiceCallEvent = @"WhipVoiceCallEvent";
static NSMutableArray<NSDictionary *> *expirations;
void whip_download_execution_expired(const char *execution, bool cancelled) {
  [expirations addObject:@{@"id": @(execution), @"cancelled": @(cancelled)}];
}
void whip_cancel_background_download(const char *host, const char *transfer) {
  XCTFail(@"Durable downloads must expire by execution identity even without a transfer binding");
}

@interface HerdrBackground : RCTEventEmitter
- (void)beginDownloadExecution:(NSString *)identifier name:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)endDownloadExecution:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)expireDownload:(NSString *)identifier;
- (void)retainDownloadJobDestination:(NSString *)identifier uri:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)resolveDownloadJobDestination:(NSString *)identifier uri:(NSString *)uri permission:(NSString *)permission resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)releaseDownloadJobDestination:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (BOOL)retainDownloadScope:(NSURL *)url;
- (void)releaseDownloadScope:(NSString *)uri;
@end
@interface DownloadFixture : HerdrBackground
@property(nonatomic, strong) NSCountedSet<NSString *> *holds;
@property(nonatomic, strong) NSMutableArray<NSString *> *events;
@end
@implementation DownloadFixture
- (instancetype)init {
  if ((self = [super init])) { _holds = [NSCountedSet new]; _events = [NSMutableArray new]; }
  return self;
}
- (BOOL)retainDownloadScope:(NSURL *)url { [self.holds addObject:url.absoluteString]; return YES; }
- (void)releaseDownloadScope:(NSString *)uri { [self.holds removeObject:uri]; }
- (void)sendEventWithName:(NSString *)name body:(id)body {
  if ([name isEqualToString:@"WhipDownloadExpired"]) {
    XCTAssertEqualObjects(expirations.lastObject[@"id"], body[@"id"]);
    [self.events addObject:body[@"id"]];
  }
}
@end

@interface WhipDownloadExecutionTests : XCTestCase
@end
@implementation WhipDownloadExecutionTests
- (void)setUp { expirations = [NSMutableArray new]; }
- (id)resultOf:(void (^)(RCTPromiseResolveBlock, RCTPromiseRejectBlock))operation {
  __block BOOL resolved = NO;
  __block id result;
  operation(^(id value) { resolved = YES; result = value; }, ^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@ %@", code, message); });
  XCTAssertTrue(resolved);
  return result;
}
- (void)testExpiryBeforeTransferBindingReachesRustBeforeJavaScriptAndCannotExpireReplacement {
  DownloadFixture *adapter = [DownloadFixture new];
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter beginDownloadExecution:@"attempt-one" name:@"archive" resolve:yes reject:no];
  }];
  [adapter expireDownload:@"attempt-one"];
  XCTAssertEqualObjects(expirations, (@[@{@"id": @"attempt-one", @"cancelled": @NO}]));
  XCTAssertEqualObjects(adapter.events, (@[@"attempt-one"]));
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter beginDownloadExecution:@"attempt-two" name:@"archive" resolve:yes reject:no];
  }];
  [adapter expireDownload:@"attempt-one"];
  XCTAssertEqual(expirations.count, 1u);
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter endDownloadExecution:@"attempt-two" resolve:yes reject:no];
    [adapter endDownloadExecution:@"attempt-two" resolve:yes reject:no];
  }];
  XCTAssertEqual(expirations.count, 1u);
}
- (void)testRepeatedReleaseOfOneAttemptKeepsConcurrentAccessToSameFolder {
  DownloadFixture *adapter = [DownloadFixture new];
  NSString *uri = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES].absoluteString;
  NSString *bookmark = [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter retainDownloadJobDestination:@"attempt-one" uri:uri resolve:yes reject:no];
  }];
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter retainDownloadJobDestination:@"attempt-one" uri:uri resolve:yes reject:no];
  }];
  XCTAssertEqual([adapter.holds countForObject:uri], 1u);
  NSString *resolved = [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter resolveDownloadJobDestination:@"attempt-two" uri:uri permission:bookmark resolve:yes reject:no];
  }];
  XCTAssertEqualObjects(resolved, uri);
  XCTAssertEqual([adapter.holds countForObject:uri], 2u);
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter releaseDownloadJobDestination:@"attempt-one" resolve:yes reject:no];
    [adapter releaseDownloadJobDestination:@"attempt-one" resolve:yes reject:no];
  }];
  XCTAssertEqual([adapter.holds countForObject:uri], 1u);
  [self resultOf:^(RCTPromiseResolveBlock yes, RCTPromiseRejectBlock no) {
    [adapter releaseDownloadJobDestination:@"attempt-two" resolve:yes reject:no];
  }];
  XCTAssertEqual([adapter.holds countForObject:uri], 0u);
}
- (void)testInvalidBookmarkDoesNotAcquireAnAttemptScope {
  DownloadFixture *adapter = [DownloadFixture new];
  __block BOOL rejected = NO;
  [adapter resolveDownloadJobDestination:@"attempt" uri:@"file:///missing" permission:@"invalid"
    resolve:^(id result) { XCTFail(@"Invalid bookmark resolved"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
  XCTAssertEqual(adapter.holds.count, 0u);
}
@end
