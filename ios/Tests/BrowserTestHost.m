#import <UIKit/UIKit.h>
#import "WhipTerminalInputView.h"

// A keyboard-driven fixture for the production native input view. Captured
// bytes are separate from UIKit text, so UI tests verify terminal delivery.
@interface TerminalInputTestController : UIViewController
@property(nonatomic, strong) WhipTerminalInputView *input;
@property(nonatomic, strong) UILabel *output;
@property(nonatomic, strong) NSMutableString *bytes;
@end

@implementation TerminalInputTestController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.bytes = [NSMutableString new];
  self.output = [[UILabel alloc] initWithFrame:CGRectMake(20, 200, 380, 100)];
  self.output.numberOfLines = 0;
  self.output.accessibilityIdentifier = @"terminal-bytes";
  self.output.text = @"Native terminal input";
  [self.view addSubview:self.output];
  self.input = [[WhipTerminalInputView alloc] initWithFrame:CGRectMake(20, 180, 1, 1)];
  self.input.binding = @"ui-test";
  __weak TerminalInputTestController *weakSelf = self;
  self.input.onTerminalInput = ^(NSDictionary *event) {
    TerminalInputTestController *controller = weakSelf;
    if (!event[@"data"]) return;
    [controller.bytes appendString:event[@"data"]];
    controller.output.text = controller.bytes;
    controller.output.accessibilityValue = controller.bytes;
  };
  [self.view addSubview:self.input];
  UIButton *toggle = [UIButton buttonWithType:UIButtonTypeSystem];
  toggle.frame = CGRectMake(20, 100, 180, 50);
  [toggle setTitle:@"Toggle keyboard" forState:UIControlStateNormal];
  [toggle addTarget:self action:@selector(toggle) forControlEvents:UIControlEventTouchUpInside];
  [self.view addSubview:toggle];
}
- (void)viewDidAppear:(BOOL)animated { [super viewDidAppear:animated]; self.input.inputEnabled = YES; }
- (void)toggle { self.input.inputEnabled = !self.input.inputEnabled; }
@end

// WebKit viewport captures need an application window backed by the iOS render
// server. A test bundle without a host can evaluate DOM but captures blank views.
@interface BrowserTestAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation BrowserTestAppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options
{
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  BOOL keyboardFixture = [NSProcessInfo.processInfo.arguments containsObject:@"--terminal-input"];
  self.window.rootViewController = keyboardFixture ? [TerminalInputTestController new] : [UIViewController new];
  [self.window makeKeyAndVisible];
  return YES;
}
@end

int main(int argc, char *argv[])
{
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(BrowserTestAppDelegate.class));
  }
}
