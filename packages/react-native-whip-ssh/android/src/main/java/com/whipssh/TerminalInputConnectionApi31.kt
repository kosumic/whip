package com.whipssh

import android.os.Build
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.SurroundingText
import androidx.annotation.RequiresApi

@RequiresApi(Build.VERSION_CODES.S)
internal open class TerminalInputConnectionApi31(private val editor: TerminalInputConnection) :
  InputConnectionWrapper(editor, false) {
  override fun getSurroundingText(beforeLength: Int, afterLength: Int, flags: Int): SurroundingText? {
    val offset = editor.surroundingTextOffset() ?: return null
    val text = super.getSurroundingText(beforeLength, afterLength, flags) ?: return null
    return SurroundingText(text.text, text.selectionStart, text.selectionEnd, offset + text.offset)
  }
}
