#import <XCTest/XCTest.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "WhipBrowser.h"

@interface WhipBrowser (SavedDestinationTesting)
- (void)revealSavedDestination:(NSString *)savedUri directoryUri:(NSString *)directoryUri
                      resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (UIViewController *)downloadPresenter;
@end

@interface DestinationPresenter : UIViewController
@property(nonatomic, strong) UIViewController *shown;
@end
@implementation DestinationPresenter
- (void)presentViewController:(UIViewController *)controller animated:(BOOL)animated completion:(void (^)(void))completion {
  self.shown = controller;
  if (completion) completion();
}
@end

@interface DestinationBrowser : WhipBrowser
@property(nonatomic, strong) DestinationPresenter *presenter;
@end
@implementation DestinationBrowser
- (UIViewController *)downloadPresenter { return self.presenter; }
@end

@interface WhipSavedDestinationTests : XCTestCase
@end
@implementation WhipSavedDestinationTests
- (void)testSavedDestinationOpensSystemPickerAtContainingFolderWithoutImporting
{
  DestinationBrowser *browser = [DestinationBrowser new];
  browser.presenter = [DestinationPresenter new];
  NSURL *folder = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
  [[NSFileManager defaultManager] createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
  NSURL *file = [folder URLByAppendingPathComponent:@"saved 日本語.txt"];
  [@"saved" writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
  __block BOOL resolved = NO;
  @try {
    [browser revealSavedDestination:file.absoluteString directoryUri:folder.absoluteString
      resolve:^(id value) { resolved = YES; }
      reject:^(NSString *code, NSString *message, NSError *error) { XCTFail(@"%@", message); }];
    XCTAssertTrue(resolved);
    XCTAssertTrue([browser.presenter.shown isKindOfClass:UIDocumentPickerViewController.class]);
    UIDocumentPickerViewController *picker = (id)browser.presenter.shown;
    XCTAssertEqualObjects(picker.directoryURL, folder);
    XCTAssertEqual(picker.documentPickerMode, UIDocumentPickerModeOpen);
    XCTAssertFalse(picker.allowsMultipleSelection);
    XCTAssertNil(picker.delegate);
    XCTAssertTrue([[NSFileManager defaultManager] fileExistsAtPath:file.path]);
  } @finally {
    [[NSFileManager defaultManager] removeItemAtURL:folder error:nil];
  }
}

- (void)testMissingFileAndInvalidUriRejectWithoutPresenting
{
  DestinationBrowser *browser = [DestinationBrowser new];
  browser.presenter = [DestinationPresenter new];
  NSURL *missing = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  for (NSString *uri in @[missing.absoluteString, @"content://provider/document/opaque", @"https://host/file"]) {
    __block BOOL rejected = NO;
    [browser revealSavedDestination:uri directoryUri:missing.URLByDeletingLastPathComponent.absoluteString
      resolve:^(id value) { XCTFail(@"Missing/unsupported destination succeeded"); }
      reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
    XCTAssertTrue(rejected);
    XCTAssertNil(browser.presenter.shown);
  }
}

- (void)testUnavailablePresenterRejects
{
  DestinationBrowser *browser = [DestinationBrowser new];
  NSURL *folder = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
  __block BOOL rejected = NO;
  [browser revealSavedDestination:folder.absoluteString directoryUri:folder.absoluteString
    resolve:^(id value) { XCTFail(@"Unavailable presenter succeeded"); }
    reject:^(NSString *code, NSString *message, NSError *error) { rejected = YES; }];
  XCTAssertTrue(rejected);
}
@end
