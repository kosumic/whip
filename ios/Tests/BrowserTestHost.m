#import <UIKit/UIKit.h>

// WebKit viewport captures need an application window backed by the iOS render
// server. A test bundle without a host can evaluate DOM but captures blank views.
@interface BrowserTestAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation BrowserTestAppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options
{
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new];
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
