package expo.modules.whipterminalinput

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager

/** A nonvisual input owner. xterm remains responsible for all terminal drawing. */
internal class WhipTerminalInputView(context: Context) : View(context) {
  var onTerminalInput: ((Map<String, Any>) -> Unit)? = null
  var binding = ""
    set(value) {
      if (field == value) return
      field = value
      resetEditor()
    }
  var inputEnabled = false
    set(value) {
      if (field == value) return
      field = value
      if (!value) blurInput()
    }
  val keys = TerminalKeyEncoder()
  var modifiedInput = false
    set(value) {
      if (field == value) return
      field = value
      resetEditor()
    }
  private var connection: TerminalInputConnection? = null
  private val pressedKeys = mutableSetOf<Int>()
  private val imm get() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
  private val acceptsInput get() = inputEnabled && binding.isNotEmpty() && isFocused &&
    isAttachedToWindow && hasWindowFocus()

  init {
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    // Prevent autofill from recording terminal input or credentials.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    }
  }

  override fun onCheckIsTextEditor(): Boolean = inputEnabled

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    if (!acceptsInput) return null
    connection?.retire()
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE
    outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_ENTER_ACTION or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
    outAttrs.initialSelStart = 0
    outAttrs.initialSelEnd = 0
    val editor = TerminalInputConnection(this, { acceptsInput }, {
      if (modifiedInput) resetEditor()
      emit(data = it)
    },
      { start, end, composingStart, composingEnd -> imm.updateSelection(this, start, end, composingStart, composingEnd) },
      ::handleKey, ::resetEditor,
      { token, text -> imm.updateExtractedText(this, token, text) }).also { connection = it }
    return when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> TerminalInputConnectionApi34(editor)
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> TerminalInputConnectionApi31(editor)
      else -> editor
    }
  }

  fun focusInput() {
    if (!inputEnabled || binding.isEmpty()) return
    isFocusableInTouchMode = true
    isFocusable = true
    requestFocus()
    // Run after WebView touch focus and after a newly mounted view is attached.
    post {
      if (!inputEnabled || binding.isEmpty() || !isAttachedToWindow || !hasWindowFocus()) return@post
      requestFocus()
      if (connection?.surroundingTextOffset() == null) imm.restartInput(this)
      imm.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  fun blurInput() {
    val ownedKeyboard = isFocused
    connection?.retire()
    connection = null
    keys.reset()
    pressedKeys.clear()
    isFocusableInTouchMode = false
    isFocusable = false
    clearFocus()
    // React Native's Keyboard.dismiss only knows registered TextInputs. Hide
    // our own IME, while leaving an editor that already took focus alone.
    if (ownedKeyboard) imm.hideSoftInputFromWindow(windowToken, 0)
  }

  fun resetEditor() {
    connection?.retire()
    connection = null
    keys.reset()
    if (isFocused) imm.restartInput(this)
  }

  /** Rail/paste commands share the UI-thread event stream with IME operations. */
  fun barrier(expectedBinding: String, commandId: Int) {
    if (binding != expectedBinding) return
    resetEditor()
    emit(commandId = commandId)
  }

  private fun handleKey(event: KeyEvent): Boolean {
    if (!acceptsInput) return false
    if (event.action == KeyEvent.ACTION_UP) return pressedKeys.remove(event.keyCode)
    val data = keys.encode(event) ?: return false
    pressedKeys.add(event.keyCode)
    if (data.isEmpty()) return true // A hardware dead key waits for its next key.
    connection?.retire()
    connection = null
    // Preserve hardware dead-key state until the encoder has consumed it.
    imm.restartInput(this)
    emit(data = data)
    return true
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = handleKey(event) || super.onKeyDown(keyCode, event)
  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
    pressedKeys.remove(keyCode) || super.onKeyUp(keyCode, event)
  override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean =
    handleKey(event) || super.onKeyMultiple(keyCode, repeatCount, event)

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (!gainFocus) resetEditor()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (!hasWindowFocus) resetEditor()
    else if (inputEnabled && isFocused) resetEditor()
  }

  override fun onDetachedFromWindow() {
    blurInput()
    super.onDetachedFromWindow()
  }

  private fun emit(data: String? = null, commandId: Int? = null) {
    val payload = mutableMapOf<String, Any>("binding" to binding).apply {
      if (data != null) put("data", data)
      if (commandId != null) put("commandId", commandId)
    }
    onTerminalInput?.invoke(payload)
  }
}
