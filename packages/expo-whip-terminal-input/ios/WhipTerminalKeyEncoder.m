#import "WhipTerminalKeyEncoder.h"

NSString *WhipTerminalKeySequence(UIKeyboardHIDUsage usage, UIKeyModifierFlags flags,
  NSString *characters, NSString *unmodified, BOOL application, BOOL kitty) {
  if (flags & UIKeyModifierCommand) return nil; // Keep system shortcuts with UIKit.
  BOOL shift = (flags & UIKeyModifierShift) != 0;
  BOOL alt = (flags & UIKeyModifierAlternate) != 0;
  BOOL ctrl = (flags & UIKeyModifierControl) != 0;
  NSUInteger modifiers = 1 + shift + 2 * alt + 4 * ctrl;
  NSString *field = [NSString stringWithFormat:kitty ? @"%lu:1" : @"%lu", (unsigned long)modifiers];
  NSString *final = nil, *data = nil;
  NSUInteger tilde = 0;
  switch (usage) {
    case UIKeyboardHIDUsageKeyboardUpArrow: final = @"A"; break;
    case UIKeyboardHIDUsageKeyboardDownArrow: final = @"B"; break;
    case UIKeyboardHIDUsageKeyboardRightArrow: final = @"C"; break;
    case UIKeyboardHIDUsageKeyboardLeftArrow: final = @"D"; break;
    case UIKeyboardHIDUsageKeyboardHome: final = @"H"; break;
    case UIKeyboardHIDUsageKeyboardEnd: final = @"F"; break;
    case UIKeyboardHIDUsageKeyboardDeleteForward: tilde = 3; break;
    case UIKeyboardHIDUsageKeyboardInsert: tilde = 2; break;
    case UIKeyboardHIDUsageKeyboardPageUp: tilde = 5; break;
    case UIKeyboardHIDUsageKeyboardPageDown: tilde = 6; break;
    case UIKeyboardHIDUsageKeyboardTab: data = shift && !kitty ? @"\x1b[Z" : @"\t"; break;
    case UIKeyboardHIDUsageKeyboardEscape: data = @"\x1b"; break;
    case UIKeyboardHIDUsageKeyboardDeleteOrBackspace: data = @"\x7f"; break;
    case UIKeyboardHIDUsageKeyboardReturnOrEnter: data = @"\r"; break;
    default: break;
  }
  if (final) return kitty || modifiers > 1 ? [NSString stringWithFormat:@"\x1b[1;%@%@", field, final]
    : [NSString stringWithFormat:@"\x1b%@%@", application ? @"O" : @"[", final];
  if (tilde) return [NSString stringWithFormat:@"\x1b[%lu%@~", (unsigned long)tilde,
    kitty || modifiers > 1 ? [@";" stringByAppendingString:field] : @""];
  if (data) {
    if (kitty && data.length == 1) return [NSString stringWithFormat:@"\x1b[%u;%@u", [data characterAtIndex:0], field];
    return alt && data.length == 1 ? [@"\x1b" stringByAppendingString:data] : data;
  }
  if (!ctrl && !alt) return nil;
  if (unmodified.length != 1) return alt ? [@"\x1b" stringByAppendingString:characters] : nil;
  unichar code = [unmodified characterAtIndex:0];
  if (kitty) return [NSString stringWithFormat:@"\x1b[%u;%@u", code, field];
  if (ctrl) {
    unichar upper = [unmodified.uppercaseString characterAtIndex:0];
    if (upper >= '@' && upper <= '_') code = upper & 31;
    else if (code == ' ' || code == '2') code = 0;
    else if (code >= '3' && code <= '7') code -= '3' - 27;
    else if (code == '8' || code == '?') code = 127;
  }
  data = [NSString stringWithCharacters:&code length:1];
  return alt ? [@"\x1b" stringByAppendingString:data] : data;
}
