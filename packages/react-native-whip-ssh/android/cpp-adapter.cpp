// Whip-owned adapter, preserved by ubrn.config.yaml's noOverwrite list.
#include <jni.h>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvokerHolder.h>
#include "react-native-whip-ssh.h"
#include "WhipSpeechPolicy.h"
#include <string>

// JNI's modified UTF-8 differs from UTF-8 for NUL and non-BMP characters.
// Use java.lang.String's explicit UTF-8 encoder for speech text.
static std::string speechUtf8(JNIEnv *env, jstring text) {
    jclass stringClass = env->GetObjectClass(text);
    jmethodID getBytes = env->GetMethodID(stringClass, "getBytes", "(Ljava/lang/String;)[B");
    jstring charset = env->NewStringUTF("UTF-8");
    auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(text, getBytes, charset));
    std::string result;
    if (bytes && !env->ExceptionCheck()) {
        const auto length = env->GetArrayLength(bytes);
        result.resize(length);
        env->GetByteArrayRegion(bytes, 0, length, reinterpret_cast<jbyte *>(result.data()));
        env->DeleteLocalRef(bytes);
    }
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(stringClass);
    return result;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_whipssh_SpeechPolicy_phononCommand(JNIEnv *env, jclass, jstring root, jstring action) {
    const auto rootValue = speechUtf8(env, root);
    const auto actionValue = speechUtf8(env, action);
    if (env->ExceptionCheck()) return nullptr;
    auto *value = whip_phonon_command(rootValue.c_str(), actionValue.c_str());
    // Status strings contain JSON-escaped user data; decode standard UTF-8.
    if (!value) return nullptr;
    jclass stringClass = env->FindClass("java/lang/String");
    jmethodID constructor = env->GetMethodID(stringClass, "<init>", "([BLjava/lang/String;)V");
    const std::string json(value);
    whip_phonon_free(value);
    auto bytes = env->NewByteArray(static_cast<jsize>(json.size()));
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(json.size()), reinterpret_cast<const jbyte *>(json.data()));
    jstring charset = env->NewStringUTF("UTF-8");
    auto result = static_cast<jstring>(env->NewObject(stringClass, constructor, bytes, charset));
    env->DeleteLocalRef(bytes);
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(stringClass);
    return result;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_phononEnabled(JNIEnv *env, jclass, jstring language) {
    const auto value = speechUtf8(env, language);
    return !env->ExceptionCheck() && whip_phonon_enabled(value.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_SpeechPolicy_phononPlaybackFailed(JNIEnv *, jclass) {
    whip_phonon_playback_failed();
}

struct PcmSinkContext { JNIEnv *env; jobject sink; jmethodID write; };
static bool writeSpeechPcm(void *opaque, const float *samples, uintptr_t count) {
    auto *context = static_cast<PcmSinkContext *>(opaque);
    auto *env = context->env;
    if (env->ExceptionCheck()) return false;
    auto array = env->NewFloatArray(static_cast<jsize>(count));
    if (!array) return false;
    env->SetFloatArrayRegion(array, 0, static_cast<jsize>(count), samples);
    const bool accepted = env->CallBooleanMethod(context->sink, context->write, array);
    env->DeleteLocalRef(array);
    return accepted && !env->ExceptionCheck();
}

extern "C" JNIEXPORT jint JNICALL
Java_com_whipssh_SpeechPolicy_phononSpeak(JNIEnv *env, jclass, jlong lease, jstring text, jobject sink) {
    const auto value = speechUtf8(env, text);
    if (env->ExceptionCheck()) return -1;
    jclass sinkClass = env->GetObjectClass(sink);
    jmethodID write = env->GetMethodID(sinkClass, "write", "([F)Z");
    if (!write) { env->DeleteLocalRef(sinkClass); return -1; }
    PcmSinkContext context{env, sink, write};
    const auto result = whip_phonon_speak(static_cast<uint64_t>(lease), value.c_str(), writeSpeechPcm, &context);
    env->DeleteLocalRef(sinkClass);
    return result;
}

namespace jsi = facebook::jsi;
namespace react = facebook::react;

extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_claim(JNIEnv *env, jclass, jint kind, jstring owner, jstring request) {
    const char *ownerValue = env->GetStringUTFChars(owner, nullptr);
    if (!ownerValue) return 0;
    const char *requestValue = env->GetStringUTFChars(request, nullptr);
    uint64_t lease = 0;
    if (requestValue) {
        lease = whip_speech_claim(static_cast<uint8_t>(kind), ownerValue, requestValue);
        env->ReleaseStringUTFChars(request, requestValue);
    }
    env->ReleaseStringUTFChars(owner, ownerValue);
    return static_cast<jlong>(lease);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_isCurrent(JNIEnv *, jclass, jlong lease) {
    return whip_speech_is_current(static_cast<uint64_t>(lease));
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_complete(JNIEnv *, jclass, jlong lease) {
    return whip_speech_complete(static_cast<uint64_t>(lease));
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_stop(JNIEnv *, jclass, jlong lease) {
    return whip_speech_stop(static_cast<uint64_t>(lease));
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_timeoutMs(JNIEnv *, jclass, jint kind, jlong textUnits) {
    return static_cast<jlong>(whip_speech_timeout_ms(static_cast<uint8_t>(kind), static_cast<uint64_t>(textUnits)));
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_stopOwner(JNIEnv *env, jclass, jint kind, jstring owner) {
    const char *value = env->GetStringUTFChars(owner, nullptr);
    if (!value) return 0;
    const auto lease = whip_speech_stop_owner(static_cast<uint8_t>(kind), value);
    env->ReleaseStringUTFChars(owner, value);
    return static_cast<jlong>(lease);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_cancelRequest(JNIEnv *env, jclass, jint kind, jstring request) {
    const char *value = env->GetStringUTFChars(request, nullptr);
    if (!value) return 0;
    const auto lease = whip_speech_cancel_request(static_cast<uint8_t>(kind), value);
    env->ReleaseStringUTFChars(request, value);
    return static_cast<jlong>(lease);
}

extern "C" void whip_set_background_monitoring_active(bool active);
extern "C" void whip_tailcat_network_changed();
extern "C" void whip_detach_runtime_ui();
extern "C" void whip_set_runtime_diagnostic_path(const char *path);
extern "C" void whip_set_reverse_control_recovery_directory(const char *path);
extern "C" void whip_set_conversation_directories(const char *directory, const char *legacy_directory);
extern "C" void whip_set_app_data_directory(const char *directory);

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipSshModule_nativeSetAppDataDirectory(JNIEnv *env, jobject, jstring directory) {
    const char *path = env->GetStringUTFChars(directory, nullptr);
    if (path == nullptr) return;
    whip_set_app_data_directory(path);
    env->ReleaseStringUTFChars(directory, path);
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipSshModule_nativeSetConversationDirectories(JNIEnv *env, jobject, jstring directory, jstring legacyDirectory) {
    const char *path = env->GetStringUTFChars(directory, nullptr);
    if (path == nullptr) return;
    const char *legacy = env->GetStringUTFChars(legacyDirectory, nullptr);
    if (legacy != nullptr) {
        whip_set_conversation_directories(path, legacy);
        env->ReleaseStringUTFChars(legacyDirectory, legacy);
    }
    env->ReleaseStringUTFChars(directory, path);
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipSshModule_nativeSetRecoveryDirectory(JNIEnv *env, jobject, jstring path) {
    const char *value = env->GetStringUTFChars(path, nullptr);
    if (value == nullptr) return;
    whip_set_reverse_control_recovery_directory(value);
    env->ReleaseStringUTFChars(path, value);
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipSshModule_nativeSetDiagnosticPath(JNIEnv *env, jobject, jstring path) {
    const char *value = env->GetStringUTFChars(path, nullptr);
    if (value == nullptr) return;
    whip_set_runtime_diagnostic_path(value);
    env->ReleaseStringUTFChars(path, value);
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipSshModule_nativeDetachUi(JNIEnv *, jobject) {
    whip_detach_runtime_ui();
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_HostRuntimeMonitoring_setBackgroundActive(JNIEnv *, jclass, jboolean active) {
    whip_set_background_monitoring_active(active == JNI_TRUE);
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_TailcatNetworkMonitoring_networkChanged(JNIEnv *, jclass) {
    whip_tailcat_network_changed();
}

// Automated testing checks Java_com_whipssh_WhipSshModule and whipssh
// by comparing the whole line here.
/*
Java_com_whipssh_WhipSshModule_nativeMultiply(JNIEnv *env, jclass type, jdouble a, jdouble b) {
    return whipssh::multiply(a, b);
}
*/

// Installer coming from WhipSshModule
extern "C"
JNIEXPORT jboolean JNICALL
Java_com_whipssh_WhipSshModule_nativeInstallRustCrate(
    JNIEnv *env,
    jclass type,
    jlong rtPtr,
    jobject callInvokerHolderJavaObj
) {
    using JCallInvokerHolder = facebook::react::CallInvokerHolder;

    auto holderLocal = facebook::jni::make_local(callInvokerHolderJavaObj);
    auto holderRef = facebook::jni::static_ref_cast<JCallInvokerHolder::javaobject>(holderLocal);
    auto* holderCxx = holderRef->cthis();
    auto jsCallInvoker = holderCxx->getCallInvoker();
    auto runtime = reinterpret_cast<jsi::Runtime *>(rtPtr);

    return whipssh::installRustCrate(*runtime, jsCallInvoker);
}

extern "C"
JNIEXPORT jboolean JNICALL
Java_com_whipssh_WhipSshModule_nativeCleanupRustCrate(JNIEnv *env, jclass type, jlong rtPtr) {
    auto runtime = reinterpret_cast<jsi::Runtime *>(rtPtr);
    return whipssh::cleanupRustCrate(*runtime);
}
