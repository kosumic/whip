package io.github.kaminarios.whip

import android.text.Editable
import android.text.Spannable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.swmansion.enriched.markdown.spans.ChatCjkFont
import java.lang.ref.WeakReference

/** Reuse chat's coverage and spans without replacing text or touching IME spans. */
internal class ComposerFontBinding(input: EditText) : TextWatcher, View.OnLayoutChangeListener {
  private val input = WeakReference(input)
  private var text: Editable? = null

  init {
    input.addOnLayoutChangeListener(this)
    bindText()
  }

  private fun bindText() {
    val input = input.get() ?: return
    val current = input.text
    if (text === current) return
    text?.removeSpan(this)
    text = current
    // ReactEditText suppresses addTextChangedListener callbacks for JS updates.
    // Watching the Editable itself also covers dictation and inserted selections.
    current.setSpan(this, 0, current.length, Spannable.SPAN_INCLUSIVE_INCLUSIVE)
    ChatCjkFont.apply(current, input.context.assets)
  }

  override fun afterTextChanged(text: Editable) {
    input.get()?.let { ChatCjkFont.apply(text, it.context.assets) }
  }

  override fun beforeTextChanged(text: CharSequence, start: Int, count: Int, after: Int) = Unit
  override fun onTextChanged(text: CharSequence, start: Int, before: Int, count: Int) = Unit

  override fun onLayoutChange(
    view: View, left: Int, top: Int, right: Int, bottom: Int,
    oldLeft: Int, oldTop: Int, oldRight: Int, oldBottom: Int,
  ) = bindText()

  fun matches(view: View): Boolean = input.get() === view

  fun detach() {
    input.get()?.removeOnLayoutChangeListener(this)
    text?.removeSpan(this)
    text = null
  }
}

class ComposerFontModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val bindings = mutableMapOf<String, ComposerFontBinding>()

  override fun getName(): String = "ComposerFont"

  @ReactMethod
  fun attachInput(tag: Int, token: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val input = UIManagerHelper.getUIManagerForReactTag(reactContext, tag)?.resolveView(tag) as? EditText
        requireNotNull(input) { "Could not find the composer input" }
        bindings.filterValues { it.matches(input) }.keys.toList().forEach(::detach)
        detach(token)
        bindings[token] = ComposerFontBinding(input)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject(ERROR, "Could not enable the composer CJK font", error)
      }
    }
  }

  @ReactMethod
  fun detachInput(token: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      detach(token)
      promise.resolve(null)
    }
  }

  private fun detach(token: String) {
    bindings.remove(token)?.detach()
  }

  override fun invalidate() {
    UiThreadUtil.runOnUiThread { bindings.keys.toList().forEach(::detach) }
    super.invalidate()
  }

  companion object {
    private const val ERROR = "E_COMPOSER_FONT"
  }
}
