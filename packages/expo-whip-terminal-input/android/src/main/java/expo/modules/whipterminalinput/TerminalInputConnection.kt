package expo.modules.whipterminalinput

import android.text.Editable
import android.text.Selection
import android.text.SpannableStringBuilder
import android.text.SpannedString
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest

/**
 * An editor for the current IME word/preedit, never a copy of the remote line.
 * Mutations are sent immediately, including individually committed letters.
 * Navigation, paste, focus and session boundaries retire the whole connection.
 */
internal class TerminalInputConnection(
  view: View,
  private val acceptsInput: () -> Boolean,
  private val emit: (String) -> Unit,
  private val selectionChanged: (Int, Int, Int, Int) -> Unit,
  private val keyEvent: (KeyEvent) -> Boolean,
  private val overflow: () -> Unit,
  private val extractedTextChanged: (Int, ExtractedText) -> Unit = { _, _ -> },
) : BaseInputConnection(view, true) {
  private val buffer = SpannableStringBuilder()
  private var open = true
  private var batchDepth = 0
  private var mutationDepth = 0
  private var selectionDirty = false
  private var terminalCursor = 0
  private var contextOffset = 0
  private var extractedRequest: ExtractedTextRequest? = null
  private val active: Boolean get() = open && acceptsInput()

  init { Selection.setSelection(buffer, 0) }

  override fun getEditable(): Editable = buffer

  fun retire() {
    open = false
    batchDepth = 0
    extractedRequest = null
    forgetText()
  }

  override fun closeConnection() { retire() }

  override fun beginBatchEdit(): Boolean {
    if (!active) return false
    batchDepth++
    return true
  }

  override fun endBatchEdit(): Boolean {
    if (!active || batchDepth == 0) return false
    batchDepth--
    if (batchDepth == 0 && mutationDepth == 0) compactContext()
    reportSelection()
    return batchDepth > 0
  }

  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean = mutate {
    super.commitText(terminalText(text), newCursorPosition)
  }

  override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean = mutate {
    val value = terminalText(text)
    super.setComposingText(value, newCursorPosition).also {
      if ('\r' in value) super.finishComposingText()
    }
  }

  override fun setComposingRegion(start: Int, end: Int): Boolean = mutate {
    val localStart = start - contextOffset
    val localEnd = end - contextOffset
    if (!validRange(localStart, localEnd)) false else super.setComposingRegion(localStart, localEnd)
  }

  override fun finishComposingText(): Boolean = mutate { super.finishComposingText() }

  /** API 34 suggestion replacements must pass through the same terminal diff. */
  fun replaceTextRange(start: Int, end: Int, text: CharSequence, newCursorPosition: Int): Boolean {
    val localStart = start - contextOffset
    val localEnd = end - contextOffset
    if (!active || !validRange(localStart, localEnd)) return false
    return mutate {
      // Call the base operations inside one mutation. Calling our public finish
      // operation here would discard the preedit before the range is replaced.
      super.finishComposingText()
      super.setSelection(localStart, localEnd)
      super.commitText(terminalText(text), newCursorPosition)
    }
  }

  override fun setSelection(start: Int, end: Int): Boolean {
    val localStart = start - contextOffset
    val localEnd = end - contextOffset
    if (!active || !validRange(localStart, localEnd)) return false
    return mutate { super.setSelection(localStart, localEnd) }
  }

  private fun validRange(start: Int, end: Int) = start in 0..buffer.length && end in 0..buffer.length &&
    isCodePointBoundary(start) && isCodePointBoundary(end)

  fun surroundingTextOffset(): Int? = if (active) contextOffset else null

  override fun getTextBeforeCursor(length: Int, flags: Int): CharSequence? =
    if (active && length >= 0) super.getTextBeforeCursor(length, flags) else null

  override fun getTextAfterCursor(length: Int, flags: Int): CharSequence? =
    if (active && length >= 0) super.getTextAfterCursor(length, flags) else null

  override fun getSelectedText(flags: Int): CharSequence? =
    if (active) super.getSelectedText(flags) else null

  override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
    if (!active || request == null) return null
    if (flags and GET_EXTRACTED_TEXT_MONITOR != 0) extractedRequest = request
    return extractText(request.flags)
  }

  private fun extractText(flags: Int) = ExtractedText().apply {
    text = if (flags and GET_TEXT_WITH_STYLES != 0) SpannedString(buffer) else buffer.toString()
    startOffset = contextOffset
    partialStartOffset = -1
    partialEndOffset = -1
    selectionStart = Selection.getSelectionStart(buffer)
    selectionEnd = Selection.getSelectionEnd(buffer)
  }

  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
    deleteAroundSelection(beforeLength, afterLength, false)

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
    deleteAroundSelection(beforeLength, afterLength, true)

  private fun deleteAroundSelection(beforeLength: Int, afterLength: Int, codePoints: Boolean): Boolean {
    if (!active || beforeLength < 0 || afterLength < 0) return false
    val start = minOf(Selection.getSelectionStart(buffer), Selection.getSelectionEnd(buffer))
    val end = maxOf(Selection.getSelectionStart(buffer), Selection.getSelectionEnd(buffer))
    val before = beforeLength.coerceAtMost(MAX_PREEDIT)
    val after = afterLength.coerceAtMost(MAX_PREEDIT)
    var left = if (codePoints) Character.offsetByCodePoints(buffer, start, -minOf(before, codePointCount(0, start)))
      else (start - before).coerceAtLeast(0)
    var right = if (codePoints) Character.offsetByCodePoints(buffer, end, minOf(after, codePointCount(end, buffer.length)))
      else (end.toLong() + after).coerceAtMost(buffer.length.toLong()).toInt()
    // Never split a UTF-16 pair, even for an IME using the code-unit API.
    if (!isCodePointBoundary(left)) left--
    if (!isCodePointBoundary(right)) right++
    if (codePoints && !validSurrogates(buffer.substring(left, right))) return true
    val knownBefore = if (codePoints) codePointCount(left, start) else start - left
    val knownAfter = if (codePoints) codePointCount(end, right) else right - end
    return mutate {
      // Delete outside the selection, preserving Android's selection/spans.
      buffer.delete(end, right)
      buffer.delete(left, start)
      reconcileText() // Explicit edits outside preedit are relative to its boundaries.
      val cursor = terminalCursor
      val data = StringBuilder()
      if (before > knownBefore) {
        data.append(moveCursor(0)).append(BACKSPACE.repeat(before - knownBefore))
      }
      if (after > knownAfter) {
        data.append(moveCursor(codePointCount(0, buffer.length)))
          .append(DELETE.repeat(after - knownAfter))
      }
      data.append(moveCursor(cursor))
      if (data.isNotEmpty()) emit(data.toString())
      true
    }
  }

  override fun sendKeyEvent(event: KeyEvent): Boolean = active && keyEvent(event)

  override fun performEditorAction(actionCode: Int): Boolean {
    if (!active || actionCode == EditorInfo.IME_ACTION_NONE) return false
    return keyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
  }

  private var sentText = ""

  private fun terminalText(text: CharSequence?): String =
    text?.toString()?.replace("\r\n", "\r")?.replace('\n', '\r') ?: ""

  private inline fun mutate(operation: () -> Boolean): Boolean {
    if (!active) return false
    mutationDepth++
    try {
      val result = operation()
      reconcileText()
      selectionDirty = true
      return result
    } finally {
      mutationDepth--
      if (batchDepth == 0 && mutationDepth == 0) compactContext()
      reportSelection()
      if (buffer.length > MAX_PREEDIT) overflow()
    }
  }

  private fun reconcileText() {
    val next = buffer.toString()
    val oldPoints = sentText.codePoints().toArray()
    val newPoints = next.codePoints().toArray()
    var prefix = 0
    while (prefix < minOf(oldPoints.size, newPoints.size) && oldPoints[prefix] == newPoints[prefix]) prefix++
    var suffix = 0
    while (suffix < minOf(oldPoints.size, newPoints.size) - prefix
      && oldPoints[oldPoints.lastIndex - suffix] == newPoints[newPoints.lastIndex - suffix]) suffix++
    val data = StringBuilder()
    if (sentText != next) {
      data.append(moveCursor(oldPoints.size - suffix))
      data.append(BACKSPACE.repeat(oldPoints.size - suffix - prefix))
      data.append(String(newPoints, prefix, newPoints.size - suffix - prefix))
      terminalCursor = newPoints.size - suffix
    }
    sentText = next
    val selection = Selection.getSelectionEnd(buffer).coerceIn(0, buffer.length)
    data.append(moveCursor(codePointCount(0, selection)))
    if (data.isNotEmpty()) emit(data.toString())
  }

  private fun moveCursor(position: Int): String {
    val delta = position - terminalCursor
    terminalCursor = position
    return if (delta < 0) LEFT.repeat(-delta) else RIGHT.repeat(delta)
  }

  private fun forgetText() {
    removeComposingSpans(buffer)
    buffer.clear()
    Selection.setSelection(buffer, 0)
    sentText = ""
    terminalCursor = 0
    contextOffset = 0
  }

  /** Keep one correction word (and its trailing separator), or active preedit.
   * Absolute IME positions continue advancing after earlier words are discarded.
   */
  private fun compactContext() {
    val selection = minOf(Selection.getSelectionStart(buffer), Selection.getSelectionEnd(buffer))
      .coerceIn(0, buffer.length)
    var boundary = 0
    for (index in 0 until selection) {
      if (buffer[index] == '\r' || buffer[index] == '\t') boundary = index + 1
    }
    var wordEnd = selection
    while (wordEnd > boundary && buffer[wordEnd - 1].isWhitespace()) wordEnd--
    var wordStart = wordEnd
    while (wordStart > boundary && !buffer[wordStart - 1].isWhitespace()) wordStart--
    val composingStart = getComposingSpanStart(buffer)
    val prefix = if (composingStart >= 0) minOf(wordStart, composingStart) else wordStart
    if (prefix == 0) return
    val points = codePointCount(0, prefix)
    buffer.delete(0, prefix)
    sentText = sentText.substring(prefix)
    terminalCursor -= points
    contextOffset += prefix
  }

  private fun reportSelection() {
    if (!active || !selectionDirty || batchDepth > 0 || mutationDepth > 0) return
    selectionDirty = false
    val composingStart = getComposingSpanStart(buffer)
    val composingEnd = getComposingSpanEnd(buffer)
    selectionChanged(contextOffset + Selection.getSelectionStart(buffer), contextOffset + Selection.getSelectionEnd(buffer),
      if (composingStart >= 0) contextOffset + composingStart else -1,
      if (composingEnd >= 0) contextOffset + composingEnd else -1)
    extractedRequest?.let { extractedTextChanged(it.token, extractText(it.flags)) }
  }

  private fun isCodePointBoundary(index: Int): Boolean = index == 0 || index == buffer.length ||
    !(Character.isHighSurrogate(buffer[index - 1]) && Character.isLowSurrogate(buffer[index]))

  private fun codePointCount(start: Int, end: Int): Int = Character.codePointCount(buffer, start, end)

  private fun validSurrogates(text: String): Boolean {
    var index = 0
    while (index < text.length) {
      val character = text[index++]
      if (Character.isHighSurrogate(character)) {
        if (index == text.length || !Character.isLowSurrogate(text[index++])) return false
      } else if (Character.isLowSurrogate(character)) return false
    }
    return true
  }

  companion object {
    const val MAX_PREEDIT = 1024
    const val BACKSPACE = "\u007f"
    const val DELETE = "\u001b[3~"
    const val LEFT = "\u001b[D"
    const val RIGHT = "\u001b[C"
  }
}
