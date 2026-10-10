#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *const WhipClipboardError = @"E_CLIPBOARD_ATTACHMENT";
static NSString *const WhipClipboardDirectory = @"clipboard-attachments";

// Plain text and web links belong to text paste, not the attachment picker.
static UTType *WhipClipboardContentType(NSString *identifier)
{
  UTType *type = [UTType typeWithIdentifier:identifier];
  if ([type conformsToType:UTTypeImage]) return type.preferredFilenameExtension.length ? type : nil;
  if ([type conformsToType:UTTypeData] && type.preferredFilenameExtension.length
      && ![type conformsToType:UTTypeText] && ![type conformsToType:UTTypeURL]
      && ![type conformsToType:UTTypePropertyList]) return type;
  return nil;
}

@interface ClipboardAttachment : NSObject <RCTBridgeModule>
@end

@implementation ClipboardAttachment
RCT_EXPORT_MODULE(ClipboardAttachment)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_EXPORT_METHOD(hasAttachment:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  UIPasteboard *pasteboard = UIPasteboard.generalPasteboard;
  // Inspect metadata only. Do not read other apps' clipboard contents when
  // opening the menu; reading happens after the user selects Clipboard.
  if (pasteboard.hasImages || [pasteboard containsPasteboardTypes:@[UTTypeFileURL.identifier]]) {
    resolve(@YES);
    return;
  }
  NSIndexSet *items = [NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0, pasteboard.numberOfItems)];
  for (NSString *identifier in [pasteboard pasteboardTypesForItemSet:items]) {
    if (WhipClipboardContentType(identifier)) {
      resolve(@YES);
      return;
    }
  }
  resolve(@NO);
}

- (void)saveAttachmentWithName:(NSString *)name
                         type:(UTType *)type
                        write:(BOOL (^)(NSURL *, NSError **))write
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  NSFileManager *manager = NSFileManager.defaultManager;
  NSError *error = nil;
  NSURL *cache = [manager URLForDirectory:NSCachesDirectory inDomain:NSUserDomainMask
                       appropriateForURL:nil create:YES error:&error];
  NSURL *directory = [cache URLByAppendingPathComponent:WhipClipboardDirectory isDirectory:YES];
  if (!directory || ![manager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error]) {
    reject(WhipClipboardError, @"Could not prepare the clipboard attachment", error);
    return;
  }
  NSString *filename = name.lastPathComponent;
  if (!filename.length) filename = @"clipboard";
  if (type.preferredFilenameExtension.length
      && ![[UTType typeWithFilenameExtension:filename.pathExtension] conformsToType:type])
    filename = [filename.stringByDeletingPathExtension stringByAppendingPathExtension:type.preferredFilenameExtension];
  NSURL *destination = [directory URLByAppendingPathComponent:
    [NSString stringWithFormat:@"%@-%@", NSUUID.UUID.UUIDString, filename]];
  if (!write(destination, &error)) {
    [manager removeItemAtURL:destination error:nil];
    reject(WhipClipboardError, @"Could not copy the clipboard attachment", error);
    return;
  }
  resolve(@{@"uri": destination.absoluteString, @"name": filename,
            @"mimeType": type.preferredMIMEType ?: @"application/octet-stream"});
}

- (void)copyFileURL:(NSURL *)url resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (!url.isFileURL) {
    reject(WhipClipboardError, @"The clipboard attachment is not a local file", nil);
    return;
  }
  BOOL scoped = [url startAccessingSecurityScopedResource];
  UTType *type = [UTType typeWithFilenameExtension:url.pathExtension];
  [self saveAttachmentWithName:url.lastPathComponent type:type write:^BOOL(NSURL *destination, NSError **error) {
    __block BOOL copied = NO;
    __block NSError *copyError = nil;
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    [coordinator coordinateReadingItemAtURL:url options:NSFileCoordinatorReadingWithoutChanges error:error
      byAccessor:^(NSURL *source) {
        NSNumber *regularFile = nil;
        if ([source getResourceValue:&regularFile forKey:NSURLIsRegularFileKey error:&copyError] && regularFile.boolValue)
          copied = [NSFileManager.defaultManager copyItemAtURL:source toURL:destination error:&copyError];
      }];
    if (copyError && error) *error = copyError;
    return copied;
  } resolve:resolve reject:reject];
  if (scoped) [url stopAccessingSecurityScopedResource];
}

RCT_EXPORT_METHOD(copyAttachment:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  for (NSItemProvider *provider in UIPasteboard.generalPasteboard.itemProviders) {
    if ([provider hasItemConformingToTypeIdentifier:UTTypeFileURL.identifier]
        && [provider canLoadObjectOfClass:NSURL.class]) {
      [provider loadObjectOfClass:NSURL.class completionHandler:^(id<NSItemProviderReading> item, NSError *error) {
        if (!item || error) reject(WhipClipboardError, @"Could not read the clipboard file", error);
        else [self copyFileURL:(NSURL *)item resolve:resolve reject:reject];
      }];
      return;
    }
    for (NSString *identifier in provider.registeredTypeIdentifiers) {
      UTType *type = WhipClipboardContentType(identifier);
      if (!type) continue;
      [provider loadFileRepresentationForTypeIdentifier:identifier completionHandler:^(NSURL *url, NSError *error) {
        if (!url || error) {
          reject(WhipClipboardError, @"Could not read the clipboard attachment", error);
          return;
        }
        // The provider deletes its temporary file when this callback returns.
        [self saveAttachmentWithName:provider.suggestedName ?: url.lastPathComponent type:type
          write:^BOOL(NSURL *destination, NSError **copyError) {
            return [NSFileManager.defaultManager copyItemAtURL:url toURL:destination error:copyError];
          } resolve:resolve reject:reject];
      }];
      return;
    }
    // Some apps expose a UIImage without an encoded image representation.
    if ([provider canLoadObjectOfClass:UIImage.class]) {
      [provider loadObjectOfClass:UIImage.class completionHandler:^(id<NSItemProviderReading> item, NSError *error) {
        NSData *data = item ? UIImagePNGRepresentation((UIImage *)item) : nil;
        if (!data || error) {
          reject(WhipClipboardError, @"Could not read the clipboard image", error);
          return;
        }
        [self saveAttachmentWithName:@"clipboard.png" type:UTTypePNG
          write:^BOOL(NSURL *destination, NSError **writeError) {
            return [data writeToURL:destination options:NSDataWritingAtomic error:writeError];
          } resolve:resolve reject:reject];
      }];
      return;
    }
  }
  resolve(nil);
}
@end
