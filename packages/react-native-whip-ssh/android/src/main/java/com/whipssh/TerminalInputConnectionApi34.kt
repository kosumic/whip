package com.whipssh

import android.os.Build
import android.view.inputmethod.TextAttribute
import androidx.annotation.RequiresApi

/** Keep API 34 types out of the connection loaded on older Android versions. */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class TerminalInputConnectionApi34(private val editor: TerminalInputConnection) :
  TerminalInputConnectionApi31(editor) {
  override fun replaceText(
    start: Int,
    end: Int,
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean = editor.replaceTextRange(start, end, text, newCursorPosition)
}
