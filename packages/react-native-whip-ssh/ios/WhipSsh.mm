// Whip-owned adapter, preserved by ubrn.config.yaml's noOverwrite list.
#import "WhipSsh.h"
#import <React/RCTInvalidating.h>
#import "WhipTerminalWebViewBridge.h"

extern "C" void whip_detach_runtime_ui();
extern "C" void whip_set_reverse_control_recovery_directory(const char *path);
extern "C" void whip_set_conversation_directories(const char *directory, const char *legacy_directory);
extern "C" void whip_set_app_data_directory(const char *directory);

static void configureRecoveryDirectory() {
    NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
    NSURL *directory = [support URLByAppendingPathComponent:@"WhipReverseControl" isDirectory:YES];
    // Durable data is backed up. Keep it separate from disposable conversations
    // and device-bound reverse-control recovery data excluded below.
    NSURL *appData = [support URLByAppendingPathComponent:@"WhipAppData" isDirectory:YES];
    if ([[NSFileManager defaultManager] createDirectoryAtURL:appData
                                withIntermediateDirectories:YES attributes:nil error:nil]) {
        [appData setResourceValue:@NO forKey:NSURLIsExcludedFromBackupKey error:nil];
        whip_set_app_data_directory(appData.path.UTF8String);
    }
    if ([[NSFileManager defaultManager] createDirectoryAtURL:directory
                                withIntermediateDirectories:YES attributes:nil error:nil]) {
        [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
        whip_set_reverse_control_recovery_directory(directory.path.UTF8String);
    }
    NSURL *conversations = [support URLByAppendingPathComponent:@"WhipConversations" isDirectory:YES];
    NSURL *documents = [[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory
                                                             inDomains:NSUserDomainMask].firstObject;
    if ([[NSFileManager defaultManager] createDirectoryAtURL:conversations
                                withIntermediateDirectories:YES attributes:nil error:nil]) {
        [conversations setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
        whip_set_conversation_directories(conversations.path.UTF8String,
            [documents URLByAppendingPathComponent:@"SQLite" isDirectory:YES].path.UTF8String);
    }
}

namespace uniffi_generated {
    using namespace facebook::react;
    /**
    * ObjC++ class for module 'NativeWhipSsh'
    */
    class JSI_EXPORT NativeWhipSshSpecJSI : public ObjCTurboModule {
    public:
        NativeWhipSshSpecJSI(const ObjCTurboModule::InitParams &params);
        std::shared_ptr<CallInvoker> callInvoker;
    };

    static facebook::jsi::Value __hostFunction_WhipSsh_installRustCrate(facebook::jsi::Runtime& rt, TurboModule &turboModule, const facebook::jsi::Value* args, size_t count) {
        auto& tm = static_cast<NativeWhipSshSpecJSI&>(turboModule);
        auto jsInvoker = tm.callInvoker;
        configureRecoveryDirectory();
        WhipInstallTerminalWebViewBridge();
        uint8_t result = whipssh::installRustCrate(rt, jsInvoker);
        return facebook::jsi::Value(rt, result);
    }
    static facebook::jsi::Value __hostFunction_WhipSsh_cleanupRustCrate(facebook::jsi::Runtime& rt, TurboModule &turboModule, const facebook::jsi::Value* args, size_t count) {
        uint8_t result = whipssh::cleanupRustCrate(rt);
        return facebook::jsi::Value(rt, result);
    }

    NativeWhipSshSpecJSI::NativeWhipSshSpecJSI(const ObjCTurboModule::InitParams &params)
        : ObjCTurboModule(params), callInvoker(params.jsInvoker) {
            this->methodMap_["installRustCrate"] = MethodMetadata {1, __hostFunction_WhipSsh_installRustCrate};
            this->methodMap_["cleanupRustCrate"] = MethodMetadata {1, __hostFunction_WhipSsh_cleanupRustCrate};
    }
} // namespace uniffi_generated

@interface WhipSsh () <RCTInvalidating>
@end

@implementation WhipSsh
RCT_EXPORT_MODULE()

- (void)invalidate {
    WhipCloseTerminalWebViewBridges();
    // Release foreign sinks and wake blocked renderer producers before the JS
    // runtime is destroyed. SSH transports keep their existing native lifetime.
    whip_detach_runtime_ui();
}

// Don't compile this code when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED

// Automated testing checks whipssh
// by comparing the whole line here.
/*
- (NSNumber *)multiply:(double)a b:(double)b {
    NSNumber *result = @(whipssh::multiply(a, b));
}
*/

- (NSNumber *)installRustCrate {
    @throw [NSException exceptionWithName:@"UnreachableException"
                        reason:@"This method should never be called."
                        userInfo:nil];
}

- (NSNumber *)cleanupRustCrate {
    @throw [NSException exceptionWithName:@"UnreachableException"
                        reason:@"This method should never be called."
                        userInfo:nil];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<uniffi_generated::NativeWhipSshSpecJSI>(params);
}
#endif

@end
