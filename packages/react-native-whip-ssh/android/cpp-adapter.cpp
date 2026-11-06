// Whip-owned adapter, preserved by ubrn.config.yaml's noOverwrite list.
#include <jni.h>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvokerHolder.h>
#include "react-native-whip-ssh.h"
#include "WhipSpeechPolicy.h"
#include "WhipRealtimeVoice.h"
#include "WhipAudioIngress.h"
#include <array>
#include <algorithm>
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

static jstring speechString(JNIEnv *env, const std::string &json) {
    jclass stringClass = env->FindClass("java/lang/String");
    jmethodID constructor = env->GetMethodID(stringClass, "<init>", "([BLjava/lang/String;)V");
    auto bytes = env->NewByteArray(static_cast<jsize>(json.size()));
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(json.size()), reinterpret_cast<const jbyte *>(json.data()));
    jstring charset = env->NewStringUTF("UTF-8");
    auto result = static_cast<jstring>(env->NewObject(stringClass, constructor, bytes, charset));
    env->DeleteLocalRef(bytes);
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(stringClass);
    return result;
}

struct VoiceCredentialContext { JNIEnv *env; jobject reader; };
extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_speechrecognition_ExpoAudioRecorder_whipCapturePcm(JNIEnv *env, jclass, jlong handle, jbyteArray bytes, jint count, jint rate, jlong sequence) {
    std::array<uint8_t, WhipAudioMaxBytes> pcm;
    if (!bytes || count < 0 || count > static_cast<jint>(pcm.size()) || count > env->GetArrayLength(bytes) || rate <= 0 || sequence < 0) return WhipAudioInvalid;
    env->GetByteArrayRegion(bytes, 0, count, reinterpret_cast<jbyte *>(pcm.data()));
    if (env->ExceptionCheck()) return WhipAudioInvalid;
    return whip_audio_ingress_push_v1(handle, pcm.data(), count, rate, 1, sequence, 0);
}
static int32_t readVoiceCredential(void *opaque, uint8_t *destination, size_t capacity) {
    auto *context = static_cast<VoiceCredentialContext *>(opaque);
    auto *env = context->env;
    auto type = env->GetObjectClass(context->reader);
    auto method = type ? env->GetMethodID(type, "read", "([B)I") : nullptr;
    if (!method || env->ExceptionCheck()) {
        env->ExceptionClear();
        if (type) env->DeleteLocalRef(type);
        return WhipVoiceCredentialUnavailable;
    }
    auto bytes = env->NewByteArray(static_cast<jsize>(capacity));
    int32_t count = WhipVoiceCredentialFailed;
    if (bytes) {
        count = env->CallIntMethod(context->reader, method, bytes);
        if (env->ExceptionCheck()) { env->ExceptionClear(); count = WhipVoiceCredentialFailed; }
        if (count > 0 && static_cast<size_t>(count) <= capacity) {
            env->GetByteArrayRegion(bytes, 0, count, reinterpret_cast<jbyte *>(destination));
            if (env->ExceptionCheck()) { env->ExceptionClear(); count = WhipVoiceCredentialFailed; }
        } else if (count > 0) count = WhipVoiceCredentialFailed;
        // Rust owns the only retained plaintext buffer. Clear the JNI temporary.
        std::array<jbyte, 256> zeros{};
        for (size_t offset = 0; offset < capacity; offset += zeros.size()) {
            auto count = std::min(zeros.size(), capacity - offset);
            env->SetByteArrayRegion(bytes, static_cast<jsize>(offset), static_cast<jsize>(count), zeros.data());
        }
        if (env->ExceptionCheck()) { env->ExceptionClear(); count = WhipVoiceCredentialFailed; }
        env->DeleteLocalRef(bytes);
    } else if (env->ExceptionCheck()) env->ExceptionClear();
    env->DeleteLocalRef(type);
    return count;
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_RealtimeVoiceNative_start(JNIEnv *env, jclass, jstring config, jobject reader) {
    const auto configValue = speechUtf8(env, config);
    if (env->ExceptionCheck()) { env->ExceptionClear(); return 0; }
    VoiceCredentialContext context{env, reader};
    return whip_realtime_start(configValue.c_str(), readVoiceCredential, &context);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_RealtimeVoiceNative_credentialsUpdating(JNIEnv *, jclass, jboolean updating) {
    whip_voice_credentials_updating(updating);
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_prepare(JNIEnv *, jclass, jboolean enabled) {
    return whip_realtime_prepare(enabled);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_RealtimeVoiceNative_stop(JNIEnv *, jclass, jlong call) { whip_realtime_stop(call); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_stopped(JNIEnv *, jclass, jlong call) { return whip_realtime_stopped(call); }
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_RealtimeVoiceNative_control(JNIEnv *, jclass, jlong call, jint action) { whip_realtime_control(call, static_cast<uint8_t>(action)); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_submitted(JNIEnv *env, jclass, jlong call, jstring text) {
    if (!text) return false;
    const auto value = speechUtf8(env, text);
    return !env->ExceptionCheck() && whip_realtime_submitted(call, reinterpret_cast<const uint8_t *>(value.data()), value.size());
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_capture(JNIEnv *env, jclass, jlong call, jshortArray samples, jint count) {
    std::array<int16_t, WhipRealtimeMaxFrame> pcm;
    if (count < 0 || count > static_cast<jint>(pcm.size()) || count > env->GetArrayLength(samples)) return false;
    env->GetShortArrayRegion(samples, 0, count, pcm.data());
    return !env->ExceptionCheck() && whip_realtime_capture(call, pcm.data(), count);
}
extern "C" JNIEXPORT jint JNICALL
Java_com_whipssh_RealtimeVoiceNative_read(JNIEnv *env, jclass, jlong call, jshortArray samples, jlongArray epoch) {
    std::array<int16_t, WhipRealtimeMaxFrame> pcm{};
    const auto capacity = env->GetArrayLength(samples);
    if (capacity > static_cast<jsize>(pcm.size()) || env->GetArrayLength(epoch) < 1) return 0;
    uint64_t generation = 0;
    const auto count = whip_realtime_read(call, pcm.data(), capacity, &generation);
    const auto rendered = count > 0 ? count : static_cast<size_t>(capacity);
    whip_realtime_mix_cue(call, pcm.data(), rendered);
    const auto value = static_cast<jlong>(generation);
    env->SetLongArrayRegion(epoch, 0, 1, &value);
    env->SetShortArrayRegion(samples, 0, rendered, pcm.data());
    return static_cast<jint>(count);
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_RealtimeVoiceNative_cueBegin(JNIEnv *, jclass, jlong call) { return static_cast<jlong>(whip_realtime_cue_begin(call)); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_cueLoad(JNIEnv *env, jclass, jlong call, jlong generation, jstring path) {
    const auto value = speechUtf8(env, path);
    return !env->ExceptionCheck() && whip_realtime_cue_load(call, generation, value.c_str());
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_cuePlaying(JNIEnv *, jclass, jlong call, jlong generation) { return whip_realtime_cue_playing(call, generation); }
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_RealtimeVoiceNative_cueStop(JNIEnv *, jclass, jlong call, jlong generation) { whip_realtime_cue_stop(call, generation); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_render(JNIEnv *env, jclass, jlong call, jlong epoch, jshortArray samples, jint offset, jint count, jboolean audio, jlong delayNs) {
    std::array<int16_t, WhipRealtimeMaxFrame> pcm;
    const auto length = env->GetArrayLength(samples);
    if (offset < 0 || count < 0 || count > static_cast<jint>(pcm.size()) || offset > length || count > length - offset) return false;
    env->GetShortArrayRegion(samples, offset, count, pcm.data());
    return !env->ExceptionCheck() && whip_realtime_render(call, epoch, pcm.data(), count, audio, delayNs);
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_RealtimeVoiceNative_inputGeneration(JNIEnv *, jclass, jlong call) { return static_cast<jlong>(whip_realtime_input_generation(call)); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_RealtimeVoiceNative_captureTimed(JNIEnv *env, jclass, jlong call, jshortArray samples, jint count, jlong generation, jlong ageNs) {
    std::array<int16_t, WhipRealtimeMaxFrame> pcm;
    if (count < 0 || count > static_cast<jint>(pcm.size()) || count > env->GetArrayLength(samples) || ageNs < 0) return false;
    env->GetShortArrayRegion(samples, 0, count, pcm.data());
    return !env->ExceptionCheck() && whip_realtime_capture_timed(call, pcm.data(), count, generation, ageNs);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_RealtimeVoiceNative_played(JNIEnv *, jclass, jlong call, jlong epoch, jlong samples) { whip_realtime_played(call, epoch, samples); }
extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_RealtimeVoiceNative_epoch(JNIEnv *, jclass, jlong call) { return static_cast<jlong>(whip_realtime_epoch(call)); }
extern "C" JNIEXPORT jstring JNICALL
Java_com_whipssh_RealtimeVoiceNative_view(JNIEnv *env, jclass, jlong call) {
    auto *value = whip_realtime_view(call);
    const std::string json(value ? value : "{\"phase\":\"closed\"}");
    whip_realtime_free(value);
    return speechString(env, json);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_whipssh_SpeechPolicy_backendCommand(JNIEnv *env, jclass, jstring root, jstring action) {
    const auto rootValue = speechUtf8(env, root);
    const auto actionValue = speechUtf8(env, action);
    if (env->ExceptionCheck()) return nullptr;
    auto *value = whip_speech_backend_command(rootValue.c_str(), actionValue.c_str());
    // Status strings contain JSON-escaped user data; decode standard UTF-8.
    if (!value) return nullptr;
    const std::string json(value);
    whip_speech_backend_free(value);
    return speechString(env, json);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_phononEnabled(JNIEnv *env, jclass, jstring language) {
    const auto value = speechUtf8(env, language);
    return !env->ExceptionCheck() && whip_phonon_enabled(value.c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_pcmEnabled(JNIEnv *env, jclass, jstring language, jboolean localOnly) {
    const auto value = speechUtf8(env, language);
    return !env->ExceptionCheck() && whip_speech_pcm_enabled(value.c_str(), localOnly);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_networkSelected(JNIEnv *, jclass) {
    return whip_speech_network_selected();
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_SpeechPolicy_pcmPlaybackFailed(JNIEnv *, jclass) {
    whip_speech_pcm_playback_failed();
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
Java_com_whipssh_SpeechPolicy_pcmSpeak(JNIEnv *env, jclass, jlong lease, jstring text, jobject sink, jobject reader) {
    const auto value = speechUtf8(env, text);
    if (env->ExceptionCheck()) return -1;
    jclass sinkClass = env->GetObjectClass(sink);
    jmethodID write = env->GetMethodID(sinkClass, "write", "([F)Z");
    if (!write) { env->DeleteLocalRef(sinkClass); return -1; }
    PcmSinkContext context{env, sink, write};
    VoiceCredentialContext credentialContext{env, reader};
    const auto result = whip_speech_pcm_speak(static_cast<uint64_t>(lease), value.c_str(), writeSpeechPcm, &context,
                                             reader ? readVoiceCredential : nullptr, &credentialContext);
    env->DeleteLocalRef(sinkClass);
    return result;
}

namespace jsi = facebook::jsi;
namespace react = facebook::react;

// Process-owned callback: no React instance, Activity, or local JNI references.
static JavaVM *automaticVm = nullptr;
static jclass automaticPolicy = nullptr;
static jmethodID automaticWakeMethod = nullptr;
static void wakeAutomaticSpeech() {
    JNIEnv *env = nullptr;
    const bool attach = automaticVm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED;
    if (attach && automaticVm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
    if (!env) return;
    env->CallStaticVoidMethod(automaticPolicy, automaticWakeMethod);
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attach) automaticVm->DetachCurrentThread();
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_SpeechPolicy_registerAutomaticSpeech(JNIEnv *env, jclass type) {
    if (automaticPolicy) return;
    auto method = env->GetStaticMethodID(type, "automaticSpeechWake", "()V");
    if (!method) return;
    auto policy = static_cast<jclass>(env->NewGlobalRef(type));
    if (!policy || env->GetJavaVM(&automaticVm) != JNI_OK) {
        if (policy) env->DeleteGlobalRef(policy);
        return;
    }
    automaticPolicy = policy;
    automaticWakeMethod = method;
    whip_automatic_speech_register(wakeAutomaticSpeech);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_whipssh_SpeechPolicy_automaticSpeech(JNIEnv *env, jclass, jstring command) {
    const auto input = speechUtf8(env, command);
    char *value = whip_automatic_speech_command(input.c_str());
    const std::string json(value ? value : "null");
    whip_alert_speech_free(value);
    return speechString(env, json);
}

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

extern "C" JNIEXPORT jstring JNICALL
Java_com_whipssh_SpeechPolicy_alertSpeech(JNIEnv *env, jclass, jstring action, jstring token, jlong lease) {
    const char *actionValue = env->GetStringUTFChars(action, nullptr);
    if (!actionValue) return nullptr;
    const char *tokenValue = env->GetStringUTFChars(token, nullptr);
    char *value = tokenValue ? whip_alert_speech_command(actionValue, tokenValue, static_cast<uint64_t>(lease)) : nullptr;
    if (tokenValue) env->ReleaseStringUTFChars(token, tokenValue);
    env->ReleaseStringUTFChars(action, actionValue);
    const std::string json(value ? value : "null");
    whip_alert_speech_free(value);
    return speechString(env, json);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_SpeechPolicy_isCurrent(JNIEnv *, jclass, jlong lease) {
    return whip_speech_is_current(static_cast<uint64_t>(lease));
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_captionStart(JNIEnv *env, jclass, jstring text) {
    const auto value = speechUtf8(env, text);
    return static_cast<jlong>(whip_speech_caption_start(value.c_str()));
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_whipssh_SpeechPolicy_captionProgress(JNIEnv *, jclass, jlong id, jlong played, jlong samples, jboolean complete) {
    if (played < 0 || samples < 0) return 0;
    return static_cast<jlong>(whip_speech_caption_progress(id, played, samples, complete));
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
