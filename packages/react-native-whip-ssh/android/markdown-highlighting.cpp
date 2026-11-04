#include <jni.h>
#include <vector>
#include "WhipSyntaxHighlight.h"

extern "C" JNIEXPORT jintArray JNICALL
Java_com_whipssh_WhipSyntaxHighlighter_nativeHighlightCode(
    JNIEnv *env, jclass, jbyteArray code, jbyteArray language) {
  try {
    const auto codeLength = env->GetArrayLength(code);
    const auto languageLength = env->GetArrayLength(language);
    std::vector<uint8_t> source(codeLength), fence(languageLength);
    env->GetByteArrayRegion(code, 0, codeLength, reinterpret_cast<jbyte *>(source.data()));
    env->GetByteArrayRegion(language, 0, languageLength, reinterpret_cast<jbyte *>(fence.data()));
    if (env->ExceptionCheck()) return nullptr;
    std::vector<jint> tokens;
    const bool success = whip_syntax_highlight(
        source.data(), source.size(), fence.data(), fence.size(), &tokens,
        [](void *context, uint32_t start, uint32_t end, uint32_t type) noexcept -> bool {
          try {
            auto &output = *static_cast<std::vector<jint> *>(context);
            output.insert(output.end(), {static_cast<jint>(start), static_cast<jint>(end), static_cast<jint>(type)});
            return true;
          } catch (...) { return false; }
        });
    if (!success || tokens.empty()) return nullptr;
    auto result = env->NewIntArray(static_cast<jsize>(tokens.size()));
    if (result) env->SetIntArrayRegion(result, 0, static_cast<jsize>(tokens.size()), tokens.data());
    return result;
  } catch (...) { return nullptr; }
}
