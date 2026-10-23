package com.whipssh

import android.view.KeyCharacterMap
import android.view.KeyEvent

/** Hardware keys and IME sendKeyEvent use the same encoding. */
internal class TerminalKeyEncoder {
  var applicationCursorKeys = false
  var kittyKeyboardReportAll = false
  private var combiningAccent = 0

  fun reset() { combiningAccent = 0 }

  fun encode(event: KeyEvent): String? {
    if (event.action == KeyEvent.ACTION_MULTIPLE) return event.characters
    if (event.action != KeyEvent.ACTION_DOWN) return null
    val modifiers = 1 + (if (event.isShiftPressed) 1 else 0) +
      (if (event.isAltPressed) 2 else 0) + (if (event.isCtrlPressed) 4 else 0)
    val modifierField = if (kittyKeyboardReportAll) "$modifiers:1" else "$modifiers"
    fun cursor(final: Char): String = if (kittyKeyboardReportAll || modifiers > 1) "\u001b[1;$modifierField$final"
      else "\u001b${if (applicationCursorKeys) 'O' else '['}$final"
    fun tilde(number: Int): String = "\u001b[$number${if (kittyKeyboardReportAll || modifiers > 1) ";$modifierField" else ""}~"
    val special = when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "\r"
      KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) "\u001b[Z" else "\t"
      KeyEvent.KEYCODE_ESCAPE -> "\u001b"
      KeyEvent.KEYCODE_DEL -> TerminalInputConnection.BACKSPACE
      KeyEvent.KEYCODE_FORWARD_DEL -> tilde(3)
      KeyEvent.KEYCODE_DPAD_UP -> cursor('A')
      KeyEvent.KEYCODE_DPAD_DOWN -> cursor('B')
      KeyEvent.KEYCODE_DPAD_RIGHT -> cursor('C')
      KeyEvent.KEYCODE_DPAD_LEFT -> cursor('D')
      KeyEvent.KEYCODE_MOVE_HOME -> cursor('H')
      KeyEvent.KEYCODE_MOVE_END -> cursor('F')
      KeyEvent.KEYCODE_PAGE_UP -> tilde(5)
      KeyEvent.KEYCODE_PAGE_DOWN -> tilde(6)
      KeyEvent.KEYCODE_INSERT -> tilde(2)
      in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F4 -> {
        val final = ('P'.code + event.keyCode - KeyEvent.KEYCODE_F1).toChar()
        if (kittyKeyboardReportAll || modifiers > 1) "\u001b[1;$modifierField$final" else "\u001bO$final"
      }
      in KeyEvent.KEYCODE_F5..KeyEvent.KEYCODE_F12 ->
        tilde(intArrayOf(15, 17, 18, 19, 20, 21, 23, 24)[event.keyCode - KeyEvent.KEYCODE_F5])
      else -> null
    }
    if (special != null) {
      reset()
      if (kittyKeyboardReportAll && (special.length == 1 || event.keyCode == KeyEvent.KEYCODE_TAB)) {
        val code = if (event.keyCode == KeyEvent.KEYCODE_TAB) 9 else special[0].code
        return "\u001b[$code;${modifierField}u"
      }
      return if (event.isAltPressed && special.length == 1) "\u001b$special" else special
    }
    // Obtain printable text without Ctrl/Alt, then apply terminal modifiers.
    // Android's AltGr layouts use right Alt to produce text rather than ESC.
    val altGr = event.metaState and KeyEvent.META_ALT_RIGHT_ON != 0
    val printableMeta = event.metaState and KeyEvent.META_CTRL_MASK.inv() and
      (if (altGr) -1 else KeyEvent.META_ALT_MASK.inv())
    var codePoint = event.getUnicodeChar(printableMeta)
    if (codePoint == 0) return null
    if (codePoint and KeyCharacterMap.COMBINING_ACCENT != 0) {
      combiningAccent = codePoint and KeyCharacterMap.COMBINING_ACCENT_MASK
      return ""
    }
    var prefix = ""
    if (combiningAccent != 0) {
      val combined = KeyCharacterMap.getDeadChar(combiningAccent, codePoint)
      if (combined != 0) codePoint = combined
      else prefix = String(Character.toChars(combiningAccent))
      combiningAccent = 0
    }
    if (kittyKeyboardReportAll && (event.isCtrlPressed || (event.isAltPressed && !altGr))) {
      return "\u001b[$codePoint;${modifierField}u"
    }
    if (event.isCtrlPressed) {
      codePoint = when (codePoint) {
        in 'a'.code..'z'.code -> codePoint - 'a'.code + 1
        in '@'.code..'_'.code -> codePoint - '@'.code
        ' '.code, '2'.code -> 0
        '3'.code -> 27
        '4'.code -> 28
        '5'.code -> 29
        '6'.code -> 30
        '7'.code -> 31
        '8'.code, '?'.code -> 127
        else -> codePoint
      }
    }
    val text = prefix + String(Character.toChars(codePoint))
    return if (event.isAltPressed && !altGr) "\u001b$text" else text
  }
}
