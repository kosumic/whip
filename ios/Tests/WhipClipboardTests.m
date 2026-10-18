#import <XCTest/XCTest.h>
#import "WhipClipboardTypes.h"

@interface WhipClipboardTests : XCTestCase
@property (nonatomic, strong) UIPasteboard *pasteboard;
@end

@implementation WhipClipboardTests
- (void)setUp
{
  [super setUp];
  self.pasteboard = [UIPasteboard pasteboardWithUniqueName];
}

- (void)tearDown
{
  [UIPasteboard removePasteboardWithName:self.pasteboard.name];
  self.pasteboard = nil;
  [super tearDown];
}

- (void)testTextAndLinksDoNotOfferClipboardAttachments
{
  for (NSDictionary *item in @[
    @{UTTypeUTF8PlainText.identifier: @"Copied terminal output"},
    @{UTTypeURL.identifier: [NSURL URLWithString:@"https://example.com"]},
  ]) {
    self.pasteboard.items = @[item];
    XCTAssertFalse(WhipClipboardHasAttachment(self.pasteboard));
  }
}

- (void)testEmptyClipboardHasNoAttachment
{
  self.pasteboard.items = @[];
  XCTAssertFalse(WhipClipboardHasAttachment(self.pasteboard));
}

- (void)testFindsAnAttachmentAfterATextItem
{
  self.pasteboard.items = @[
    @{UTTypeUTF8PlainText.identifier: @"Copied terminal output"},
    @{UTTypePDF.identifier: [@"%PDF-1.7" dataUsingEncoding:NSUTF8StringEncoding]},
  ];
  XCTAssertTrue(WhipClipboardHasAttachment(self.pasteboard));
}

- (void)testImagesAndFileURLsOfferClipboardAttachments
{
  for (NSDictionary *item in @[
    @{UTTypePNG.identifier: [NSData data]},
    @{UTTypeFileURL.identifier: [NSURL fileURLWithPath:@"/tmp/attachment.pdf"]},
  ]) {
    self.pasteboard.items = @[item];
    XCTAssertTrue(WhipClipboardHasAttachment(self.pasteboard));
  }
}
@end
