package com.whipssh

import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Shares Rust's Syntect grammars with the native Markdown renderer. */
object WhipSyntaxHighlighter {
    // Reject oversized strings before allocating their UTF-8 representations.
    private const val MAX_CODE_LENGTH = 50 * 1024
    private const val MAX_LANGUAGE_LENGTH = 256
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "whip-syntax").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())

    init { System.loadLibrary("react-native-whip-ssh") }

    @JvmStatic
    private external fun nativeHighlightCode(code: ByteArray, language: ByteArray): IntArray?

    @JvmStatic
    fun highlight(code: String, language: String): IntArray? {
        if (code.length > MAX_CODE_LENGTH || language.length > MAX_LANGUAGE_LENGTH) return null
        return nativeHighlightCode(code.toByteArray(Charsets.UTF_8), language.toByteArray(Charsets.UTF_8))
    }

    @JvmStatic
    fun highlightAsync(code: String, language: String, onReady: (IntArray?) -> Unit): Future<*> =
        worker.submit {
            val tokens = highlight(code, language)
            main.post { onReady(tokens) }
        }
}
