#include <jni.h>
#include <mutex>
#include "terminal_native.h"

namespace {
JavaVM *vm = nullptr;
jclass bridgeClass = nullptr;
jmethodID deliverMethod = nullptr;
std::once_flag installed;

struct ThreadEnvironment {
  JNIEnv *env = nullptr;
  bool attached = false;
  ThreadEnvironment() {
    attached = vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED;
    if (attached && vm->AttachCurrentThread(&env, nullptr) != JNI_OK) env = nullptr;
  }
  ~ThreadEnvironment() { if (attached && env) vm->DetachCurrentThread(); }
};

void deliver(uint64_t token, uint64_t generation, uint64_t batch,
             const uint8_t *bytes, size_t length) {
  thread_local ThreadEnvironment thread;
  JNIEnv *env = thread.env;
  if (!env) return;
  auto data = env->NewByteArray(static_cast<jsize>(length));
  if (data) {
    env->SetByteArrayRegion(data, 0, static_cast<jsize>(length), reinterpret_cast<const jbyte *>(bytes));
    env->CallStaticVoidMethod(bridgeClass, deliverMethod, static_cast<jlong>(token),
                             static_cast<jlong>(generation), static_cast<jlong>(batch), data);
    env->DeleteLocalRef(data);
  }
}
}

extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativeInstall(JNIEnv *env, jclass cls) {
  std::call_once(installed, [env, cls] {
    env->GetJavaVM(&vm);
    bridgeClass = static_cast<jclass>(env->NewGlobalRef(cls));
    deliverMethod = env->GetStaticMethodID(cls, "deliver", "(JJJ[B)V");
    whip_terminal_set_native_callback(deliver);
  });
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativeBind(JNIEnv *env, jclass, jlong token, jlong generation, jbyteArray key, jbyteArray identity) {
  auto keyData = env->GetByteArrayElements(key, nullptr);
  if (!keyData) return false;
  auto identityData = env->GetByteArrayElements(identity, nullptr);
  bool result = identityData && whip_terminal_bind_native(token, generation,
      reinterpret_cast<uint8_t *>(keyData), env->GetArrayLength(key),
      reinterpret_cast<uint8_t *>(identityData), env->GetArrayLength(identity));
  if (identityData) env->ReleaseByteArrayElements(identity, identityData, JNI_ABORT);
  env->ReleaseByteArrayElements(key, keyData, JNI_ABORT);
  return result;
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativeAck(JNIEnv *, jclass, jlong token, jlong generation, jlong batch) {
  whip_terminal_ack_native(token, generation, batch);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativeUnbind(JNIEnv *, jclass, jlong token) {
  whip_terminal_unbind_native(token);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativeRelease(JNIEnv *, jclass, jlong token, jlong generation) {
  whip_terminal_release_native(token, generation);
}
extern "C" JNIEXPORT void JNICALL
Java_com_whipssh_WhipTerminalWebViewBridge_nativePause(JNIEnv *, jclass, jlong token, jboolean paused) {
  whip_terminal_pause_native(token, paused == JNI_TRUE);
}
