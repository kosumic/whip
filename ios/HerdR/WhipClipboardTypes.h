#pragma once

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Plain text and web links belong to text paste, not the attachment picker.
static inline UTType *WhipClipboardContentType(NSString *identifier)
{
  UTType *type = [UTType typeWithIdentifier:identifier];
  if ([type conformsToType:UTTypeImage]) return type.preferredFilenameExtension.length ? type : nil;
  if ([type conformsToType:UTTypeData] && type.preferredFilenameExtension.length
      && ![type conformsToType:UTTypeText] && ![type conformsToType:UTTypeURL]
      && ![type conformsToType:UTTypePropertyList]) return type;
  return nil;
}

static inline BOOL WhipClipboardHasAttachment(UIPasteboard *pasteboard)
{
  // Inspect metadata only. Reading contents waits until the user selects Clipboard.
  if (pasteboard.hasImages || [pasteboard containsPasteboardTypes:@[UTTypeFileURL.identifier]]) return YES;

  NSIndexSet *items = [NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0, pasteboard.numberOfItems)];
  // UIKit groups the type identifiers by clipboard item.
  for (NSArray<NSString *> *identifiers in [pasteboard pasteboardTypesForItemSet:items]) {
    for (NSString *identifier in identifiers) {
      if (WhipClipboardContentType(identifier)) return YES;
    }
  }
  return NO;
}
