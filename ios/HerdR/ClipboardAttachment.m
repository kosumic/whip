#import <React/RCTEventEmitter.h>
#import <React/RCTViewRegistry.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *const WhipClipboardError = @"E_CLIPBOARD_ATTACHMENT";
static NSString *const WhipClipboardDirectory = @"clipboard-attachments";
static NSString *const WhipComposerImagePasteEvent = @"WhipComposerImagePaste";

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

@class ClipboardAttachment;
@interface WhipComposerPasteBinding : NSObject <UITextPasteDelegate>
@property (nonatomic, weak) UITextView *input;
@property (nonatomic, weak) id<UITextPasteDelegate> originalDelegate;
@property (nonatomic, strong) UIPasteConfiguration *originalConfiguration;
@property (nonatomic, weak) ClipboardAttachment *owner;
@property (nonatomic, copy) NSString *token;
@property (nonatomic, strong) NSMutableSet<NSURL *> *pendingFiles;
- (void)detach;
@end

@interface ClipboardAttachment : RCTEventEmitter
@property (nonatomic, strong) NSMutableDictionary<NSString *, WhipComposerPasteBinding *> *bindings;
@property (nonatomic) BOOL observing;
- (BOOL)copyProvider:(NSItemProvider *)provider imagesOnly:(BOOL)imagesOnly
             resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)pasteImage:(NSItemProvider *)provider binding:(WhipComposerPasteBinding *)binding;
@end

@implementation WhipComposerPasteBinding
- (void)textPasteConfigurationSupporting:(id<UITextPasteConfigurationSupporting>)text
                      transformPasteItem:(id<UITextPasteItem>)item
{
  NSItemProvider *provider = item.itemProvider;
  if ([provider hasItemConformingToTypeIdentifier:UTTypeImage.identifier]
      || [provider canLoadObjectOfClass:UIImage.class]) {
    [item setNoResult];
    [self.owner pasteImage:provider binding:self];
  } else if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate textPasteConfigurationSupporting:text transformPasteItem:item];
  } else {
    [item setDefaultResult];
  }
}

- (BOOL)respondsToSelector:(SEL)selector
{
  return [super respondsToSelector:selector] || [self.originalDelegate respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector
{
  return [self.originalDelegate respondsToSelector:selector] ? self.originalDelegate
    : [super forwardingTargetForSelector:selector];
}

- (void)detach
{
  if (self.input.pasteDelegate == self) {
    self.input.pasteDelegate = self.originalDelegate;
    self.input.pasteConfiguration = self.originalConfiguration;
  }
  for (NSURL *url in self.pendingFiles) [NSFileManager.defaultManager removeItemAtURL:url error:nil];
  [self.pendingFiles removeAllObjects];
}
@end

@implementation ClipboardAttachment
RCT_EXPORT_MODULE(ClipboardAttachment)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[WhipComposerImagePasteEvent]; }
- (void)startObserving { self.observing = YES; }
- (void)stopObserving { self.observing = NO; }

- (UITextView *)inputInView:(UIView *)view
{
  if ([view isKindOfClass:UITextView.class]) return (UITextView *)view;
  for (UIView *child in view.subviews) {
    UITextView *input = [self inputInView:child];
    if (input) return input;
  }
  return nil;
}

RCT_EXPORT_METHOD(attachInput:(NSNumber *)tag token:(NSString *)token
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  UITextView *input = [self inputInView:[self.viewRegistry_DEPRECATED viewForReactTag:tag]];
  if (!input) {
    reject(WhipClipboardError, @"Could not find the composer input", nil);
    return;
  }
  if (!self.bindings) self.bindings = [NSMutableDictionary new];
  for (NSString *key in self.bindings.allKeys) {
    WhipComposerPasteBinding *old = self.bindings[key];
    if (old.input == input || [key isEqualToString:token]) {
      [old detach];
      [self.bindings removeObjectForKey:key];
    }
  }
  WhipComposerPasteBinding *binding = [WhipComposerPasteBinding new];
  binding.input = input;
  binding.owner = self;
  binding.token = token;
  binding.pendingFiles = [NSMutableSet new];
  binding.originalDelegate = input.pasteDelegate;
  binding.originalConfiguration = input.pasteConfiguration;
  UIPasteConfiguration *configuration = [input.pasteConfiguration copy]
    ?: [[UIPasteConfiguration alloc] initWithTypeIdentifiersForAcceptingClass:NSString.class];
  [configuration addTypeIdentifiersForAcceptingClass:UIImage.class];
  self.bindings[token] = binding;
  input.pasteConfiguration = configuration;
  input.pasteDelegate = binding;
  resolve(nil);
}

RCT_EXPORT_METHOD(detachInput:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [self.bindings[token] detach];
  [self.bindings removeObjectForKey:token];
  resolve(nil);
}

RCT_EXPORT_METHOD(takePasteAttachment:(NSString *)token uri:(NSString *)uri
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  WhipComposerPasteBinding *binding = self.bindings[token];
  NSURL *url = [NSURL URLWithString:uri];
  BOOL pending = url && [binding.pendingFiles containsObject:url];
  if (pending) [binding.pendingFiles removeObject:url];
  resolve(@(pending));
}

- (void)pasteImage:(NSItemProvider *)provider binding:(WhipComposerPasteBinding *)binding
{
  RCTPromiseRejectBlock reject = ^(NSString *code, NSString *message, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.bindings[binding.token] == binding && self.observing)
        [self sendEventWithName:WhipComposerImagePasteEvent body:@{@"token": binding.token, @"error": message}];
    });
  };
  BOOL copying = [self copyProvider:provider imagesOnly:YES resolve:^(id attachment) {
    dispatch_async(dispatch_get_main_queue(), ^{
      NSURL *url = [NSURL URLWithString:attachment[@"uri"]];
      if (self.bindings[binding.token] != binding || !binding.input || !self.observing) {
        if (url) [NSFileManager.defaultManager removeItemAtURL:url error:nil];
        return;
      }
      [binding.pendingFiles addObject:url];
      [self sendEventWithName:WhipComposerImagePasteEvent
                        body:@{@"token": binding.token, @"attachment": attachment}];
    });
  } reject:reject];
  if (!copying) reject(WhipClipboardError, @"Could not read the clipboard image", nil);
}

- (void)invalidate
{
  dispatch_async(dispatch_get_main_queue(), ^{
    for (WhipComposerPasteBinding *binding in self.bindings.allValues) [binding detach];
    [self.bindings removeAllObjects];
  });
  [super invalidate];
}

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

- (BOOL)copyProvider:(NSItemProvider *)provider imagesOnly:(BOOL)imagesOnly
             resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (!imagesOnly && [provider hasItemConformingToTypeIdentifier:UTTypeFileURL.identifier]
      && [provider canLoadObjectOfClass:NSURL.class]) {
    [provider loadObjectOfClass:NSURL.class completionHandler:^(id<NSItemProviderReading> item, NSError *error) {
      if (!item || error) reject(WhipClipboardError, @"Could not read the clipboard file", error);
      else [self copyFileURL:(NSURL *)item resolve:resolve reject:reject];
    }];
    return YES;
  }
  for (NSString *identifier in provider.registeredTypeIdentifiers) {
    UTType *type = WhipClipboardContentType(identifier);
    if (!type || (imagesOnly && ![type conformsToType:UTTypeImage])) continue;
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
    return YES;
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
    return YES;
  }
  return NO;
}

RCT_EXPORT_METHOD(copyAttachment:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  for (NSItemProvider *provider in UIPasteboard.generalPasteboard.itemProviders) {
    if ([self copyProvider:provider imagesOnly:NO resolve:resolve reject:reject]) return;
  }
  resolve(nil);
}
@end
