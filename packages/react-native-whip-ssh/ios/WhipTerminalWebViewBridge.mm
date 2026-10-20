#import "WhipTerminalWebViewBridge.h"
#import <WebKit/WebKit.h>
#import <UIKit/UIKit.h>
#import <os/signpost.h>
#include "terminal_native.h"

@interface WhipTerminalWebViewBridge : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) WKWebView *view;
@property(nonatomic) uint64_t token;
@property(nonatomic) BOOL closed;
@property(nonatomic) NSMutableDictionary<NSString *, NSString *> *routes;
- (void)reset;
- (void)close;
@end

static NSMapTable<NSNumber *, WhipTerminalWebViewBridge *> *bridges;
static uint64_t nextToken = 1; // Main-thread owned, as are all WKWebView calls.
static os_log_t terminalLog;
static NSSet<NSURL *> *documentURLs;
static NSString *const Handler = @"WhipTerminalNative";

static BOOL terminalDocument(WKWebView *view) {
    NSURL *url = view.URL;
    return url.isFileURL && [documentURLs containsObject:url.URLByStandardizingPath];
}

static os_signpost_id_t traceID(uint64_t generation, uint64_t batch) {
    return generation * 1000003 + batch;
}

static void deliver(uint64_t token, uint64_t generation, uint64_t batch, const uint8_t *data, size_t length) {
    @autoreleasepool {
        // Copy the borrowed Rust buffer before returning. The UI queue holds no view.
        NSString *packet = [[NSString alloc] initWithBytes:data length:length encoding:NSUTF8StringEncoding];
        if (!packet) return;
        BOOL tracing = os_signpost_enabled(terminalLog);
        double startedAt = tracing ? NSDate.date.timeIntervalSince1970 * 1000 : 0;
        if (tracing) os_signpost_interval_begin(terminalLog, traceID(generation, batch), "terminal inbound to visible");
        dispatch_async(dispatch_get_main_queue(), ^{
            WhipTerminalWebViewBridge *bridge = [bridges objectForKey:@(token)];
            if (!bridge || bridge.closed || !bridge.routes[@(generation).stringValue] || !terminalDocument(bridge.view)) return;
            // Structured WK arguments avoid constructing an injection string here.
            [bridge.view callAsyncJavaScript:@"window.herdrDeliverNative(JSON.parse(packet), tracing, startedAt);"
                                  arguments:@{@"packet":packet, @"tracing":@(tracing), @"startedAt":@(startedAt)}
                                    inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
        });
    }
}

@implementation WhipTerminalWebViewBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (self.closed || !message.frameInfo.isMainFrame || !terminalDocument(self.view) || ![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *value = message.body;
    NSString *generation = value[@"generation"];
    if (![generation isKindOfClass:NSString.class]) return;
    uint64_t number = strtoull(generation.UTF8String, nullptr, 10);
    NSString *op = value[@"op"];
    if ([op isEqual:@"bind"]) {
        NSString *key = value[@"key"];
        NSString *identity = value[@"identity"];
        if (![key isKindOfClass:NSString.class] || ![identity isKindOfClass:NSString.class]) return;
        for (NSString *previous in self.routes.allKeys) {
            if ([self.routes[previous] isEqual:key] && ![previous isEqual:generation]) {
                [self.routes removeObjectForKey:previous];
                whip_terminal_release_native(self.token, strtoull(previous.UTF8String, nullptr, 10));
            }
        }
        self.routes[generation] = key;
        NSData *keyData = [key dataUsingEncoding:NSUTF8StringEncoding];
        NSData *identityData = [identity dataUsingEncoding:NSUTF8StringEncoding];
        BOOL bound = whip_terminal_bind_native(self.token, number, (const uint8_t *)keyData.bytes, keyData.length,
                                               (const uint8_t *)identityData.bytes, identityData.length);
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) whip_terminal_pause_native(self.token, true);
        if (!bound) [self.routes removeObjectForKey:generation];
        [self.view callAsyncJavaScript:@"window.herdrNativeBound(generation, bound);"
                            arguments:@{@"generation":generation, @"bound":@(bound)}
                              inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
    } else if ([op isEqual:@"release"]) {
        [self.routes removeObjectForKey:generation];
        whip_terminal_release_native(self.token, number);
    } else if (self.routes[generation]) {
        NSString *batch = value[@"batchId"];
        if (![batch isKindOfClass:NSString.class]) return;
        uint64_t batchNumber = strtoull(batch.UTF8String, nullptr, 10);
        if ([op isEqual:@"written"]) {
            os_signpost_event_emit(terminalLog, traceID(number, batchNumber), "xterm written", "write_ms=%{public}.3f decode_ms=%{public}.3f", [value[@"writeMs"] doubleValue], [value[@"base64Ms"] doubleValue]);
            whip_terminal_ack_native(self.token, number, batchNumber);
        } else if ([op isEqual:@"visible"]) {
            os_signpost_interval_end(terminalLog, traceID(number, batchNumber), "terminal inbound to visible");
        } else if ([op isEqual:@"received"]) {
            os_signpost_event_emit(terminalLog, traceID(number, batchNumber), "WebView received", "receive_ms=%{public}.3f", [value[@"receiveMs"] doubleValue]);
        }
    }
}
- (void)reset {
    [self.routes removeAllObjects];
    whip_terminal_unbind_native(self.token);
}
- (void)close {
    self.closed = YES;
    [self reset];
    [self.view.configuration.userContentController removeScriptMessageHandlerForName:Handler];
    [bridges removeObjectForKey:@(self.token)];
    self.view = nil;
}
@end

void WhipInstallTerminalWebViewBridge(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        bridges = [NSMapTable strongToWeakObjectsMapTable];
        NSMutableSet<NSURL *> *urls = [NSMutableSet new];
        for (NSBundle *container in [@[NSBundle.mainBundle, [NSBundle bundleForClass:WhipTerminalWebViewBridge.class]] arrayByAddingObjectsFromArray:NSBundle.allFrameworks]) {
            NSString *path = [container pathForResource:@"WhipTerminalAssets" ofType:@"bundle"];
            if (!path) continue;
            NSBundle *assets = [NSBundle bundleWithPath:path];
            NSURL *url = [assets URLForResource:@"index" withExtension:@"html"];
            if (url) [urls addObject:url.URLByStandardizingPath];
        }
        documentURLs = urls;
        terminalLog = os_log_create("io.github.kaminarios.whip", "terminal-delivery");
        whip_terminal_set_native_callback(deliver);
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        [center addObserverForName:@"RNCWebViewLocalBridgeCreated" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            WKWebView *view = note.object;
            WhipTerminalWebViewBridge *bridge = [WhipTerminalWebViewBridge new];
            bridge.view = view;
            bridge.token = nextToken++;
            bridge.routes = [NSMutableDictionary new];
            [bridges setObject:bridge forKey:@(bridge.token)];
            [view.configuration.userContentController addScriptMessageHandler:bridge name:Handler];
        }];
        for (NSString *name in @[@"RNCWebViewLocalBridgeDestroyed", @"RNCWebViewLocalBridgeNavigating"]) {
            [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
                for (WhipTerminalWebViewBridge *bridge in bridges.objectEnumerator.allObjects) {
                    if (bridge.view == note.object) {
                        if ([name isEqual:@"RNCWebViewLocalBridgeDestroyed"]) [bridge close];
                        else [bridge reset];
                    }
                }
            }];
        }
        for (NSString *name in @[UIApplicationDidEnterBackgroundNotification, UIApplicationWillEnterForegroundNotification]) {
            [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
                for (WhipTerminalWebViewBridge *bridge in bridges.objectEnumerator.allObjects) {
                    whip_terminal_pause_native(bridge.token, [note.name isEqual:UIApplicationDidEnterBackgroundNotification]);
                }
            }];
        }
    });
}
void WhipCloseTerminalWebViewBridges(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        for (WhipTerminalWebViewBridge *bridge in bridges.objectEnumerator.allObjects) [bridge close];
    });
}
