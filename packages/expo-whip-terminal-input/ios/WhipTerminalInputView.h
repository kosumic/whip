#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/** Nonvisual UIKit editor. xterm remains the only terminal renderer. */
@interface WhipTerminalInputView : UIView
@property(nonatomic, copy) NSString *binding;
@property(nonatomic, copy, nullable) void (^onTerminalInput)(NSDictionary *event);
@property(nonatomic) BOOL inputEnabled;
@property(nonatomic) BOOL modifiedInput;
@property(nonatomic) BOOL applicationCursorKeys;
@property(nonatomic) BOOL kittyKeyboardReportAll;
@property(nonatomic, readonly) UITextView *editor;
- (void)focusInput;
- (void)blurInput;
- (void)resetEditor;
- (void)barrier:(NSString *)binding commandId:(NSNumber *)commandId;
@end

NS_ASSUME_NONNULL_END
