#import <UIKit/UIKit.h>

// nil lets UIKit handle printable text, dead keys and IME composition.
FOUNDATION_EXPORT NSString * _Nullable WhipTerminalKeySequence(UIKeyboardHIDUsage usage,
  UIKeyModifierFlags flags, NSString * _Nonnull characters, NSString * _Nonnull unmodified,
  BOOL applicationCursorKeys, BOOL kittyKeyboardReportAll);
