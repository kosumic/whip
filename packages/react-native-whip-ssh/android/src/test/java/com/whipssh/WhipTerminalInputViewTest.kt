package com.whipssh

import android.app.Activity
import android.content.Context
import android.os.Looper
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowInputMethodManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, shadows = [RecordingInputMethodManager::class])
class WhipTerminalInputViewTest {
  private lateinit var view: WhipTerminalInputView

  @Before fun setup() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().visible()
    view = WhipTerminalInputView(activity.get())
    activity.get().setContentView(view)
    activity.windowFocusChanged(true)
    view.binding = "pane-1:1"
    view.inputEnabled = true
    view.focusInput()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(view.isFocused)
  }

  private fun connection(): InputConnection = view.onCreateInputConnection(EditorInfo())!!

  @Test fun editorAllowsNormalKeyboardCorrectionAndDictation() {
    val info = EditorInfo()
    assertNotNull(view.onCreateInputConnection(info))
    assertEquals(InputType.TYPE_CLASS_TEXT, info.inputType and InputType.TYPE_MASK_CLASS)
    assertEquals(InputType.TYPE_TEXT_VARIATION_NORMAL, info.inputType and InputType.TYPE_MASK_VARIATION)
    assertTrue(info.inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT != 0)
    assertTrue(info.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0)
    assertEquals(0, info.inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
    assertEquals(0, info.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING)
    assertEquals(EditorInfo.IME_ACTION_NONE, info.imeOptions and EditorInfo.IME_MASK_ACTION)
  }

  @Test fun frameworkSuggestionReplacementUsesTheNativeEditorAndRejectsLateCalls() {
    val editor = connection()
    assertTrue(editor.setComposingText("teh", 1))
    assertTrue(editor.replaceText(0, 3, "the", 1, null))
    assertEquals("the", editor.getTextBeforeCursor(100, 0).toString())
    view.barrier(view.binding, 1)
    assertFalse(editor.replaceText(0, 0, "late", 1, null))
    assertTrue(connection().setComposingText("fresh", 1))
  }

  @Test fun railBarrierAndSessionSwitchRetireOldConnections() {
    val beforeTab = connection()
    beforeTab.setComposingText("git ch", 1)
    view.barrier(view.binding, 1)
    assertFalse(beforeTab.commitText("git change", 1))
    val next = connection()
    assertEquals("", next.getTextBeforeCursor(100, 0).toString())
    assertTrue(next.setComposingText("fresh", 1))
    view.binding = "pane-2:2"
    assertFalse(next.deleteSurroundingText(5, 0))
    assertEquals("", connection().getTextBeforeCursor(100, 0).toString())
  }

  @Test fun disabledAndBlurredEditorsCannotAcceptLateImeInput() {
    val beforeComposer = connection()
    beforeComposer.setComposingText("old", 1)
    view.inputEnabled = false
    assertFalse(beforeComposer.commitText("late", 1))
    assertNull(view.onCreateInputConnection(EditorInfo()))
    assertFalse(view.isFocused)
  }

  @Test fun editorRecreationAndWindowFocusLossInvalidateTheOldConnection() {
    val first = connection()
    val replacement = connection()
    assertFalse(first.commitText("late", 1))
    assertTrue(replacement.setComposingText("live", 1))
    view.onWindowFocusChanged(false)
    assertFalse(replacement.commitText("stale", 1))
  }

  @Test fun virtualCtrlInputCannotLeaveAComposingTransaction() {
    val old = connection()
    old.setComposingText("word", 1)
    view.modifiedInput = true
    assertFalse(old.commitText("stale", 1))
    val modified = connection()
    assertTrue(modified.setComposingText("c", 1))
    assertFalse(modified.setComposingText("cc", 1))
    assertEquals("", connection().getTextBeforeCursor(100, 0).toString())
  }

  @Test fun imeKeyEventsRetirePreeditBeforeNavigationOrInterrupt() {
    val keys = listOf(
      KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB),
      KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP),
      KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_C, 0, KeyEvent.META_CTRL_ON),
    )
    for (event in keys) {
      val previous = connection()
      previous.setComposingText("word", 1)
      assertTrue(previous.sendKeyEvent(event))
      assertFalse(previous.commitText("stale", 1))
      assertEquals("", connection().getTextBeforeCursor(100, 0).toString())
    }
  }

  @Test fun blurStaysBlurredUntilFocusIsExplicitlyRequested() {
    val previous = connection()
    view.blurInput()
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(view.isFocused)
    assertFalse(previous.commitText("late", 1))
    view.focusInput()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(view.isFocused)
    assertTrue(connection().commitText("new", 1))
  }

  @Test fun disablingNativeInputHidesItsKeyboardAndReenablingRestartsTheRetiredConnection() {
    val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    assertTrue(shadowOf(imm).isSoftInputVisible)
    val old = connection()
    view.inputEnabled = false
    assertFalse(shadowOf(imm).isSoftInputVisible)
    view.inputEnabled = true
    val before = RecordingInputMethodManager.restarts
    view.focusInput()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(RecordingInputMethodManager.restarts > before)
    assertTrue(shadowOf(imm).isSoftInputVisible)
    assertFalse(old.commitText("late", 1))
    assertTrue(connection().commitText("fresh", 1))
  }

  @Test fun closedConnectionsAndWindowFocusReturnRequestAFreshEditor() {
    connection().closeConnection()
    var before = RecordingInputMethodManager.restarts
    view.focusInput()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(RecordingInputMethodManager.restarts > before)
    val old = connection()
    view.onWindowFocusChanged(false)
    before = RecordingInputMethodManager.restarts
    view.onWindowFocusChanged(true)
    assertTrue(RecordingInputMethodManager.restarts > before)
    assertFalse(old.commitText("late", 1))
  }

  @Test fun disablingTheNativeViewDoesNotHideAComposerThatAlreadyTookFocus() {
    val activity = view.context as Activity
    val layout = FrameLayout(activity)
    activity.setContentView(layout)
    layout.addView(view)
    val composer = EditText(activity)
    layout.addView(composer)
    view.focusInput()
    shadowOf(Looper.getMainLooper()).idle()
    composer.requestFocus()
    val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.showSoftInput(composer, InputMethodManager.SHOW_IMPLICIT)
    view.inputEnabled = false
    assertTrue(shadowOf(imm).isSoftInputVisible)
  }
}

@Implements(InputMethodManager::class)
class RecordingInputMethodManager : ShadowInputMethodManager() {
  companion object { var restarts = 0 }
  @Implementation override fun restartInput(view: View) { restarts++ }
}
