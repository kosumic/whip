package com.whipssh

import android.text.Selection
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class TerminalInputConnectionTest {
  private lateinit var input: TerminalInputConnection
  private val writes = mutableListOf<String>()
  private val selections = mutableListOf<List<Int>>()
  private val events = mutableListOf<KeyEvent>()
  private var acceptsInput = true
  private var overflows = 0
  private val extractedUpdates = mutableListOf<Pair<Int, ExtractedText>>()

  @Before fun setup() {
    input = newConnection()
  }

  private fun newConnection() = TerminalInputConnection(
    View(RuntimeEnvironment.getApplication()), { acceptsInput }, writes::add,
    { start, end, composingStart, composingEnd -> selections.add(listOf(start, end, composingStart, composingEnd)) },
    { events.add(it); true }, { overflows++ },
    { token, text -> extractedUpdates.add(token to text) },
  )

  @Test fun slashAndResumeAreDeliveredBeforeCompositionFinishes() {
    input.beginBatchEdit()
    for (text in listOf("/", "/r", "/re", "/res", "/resu", "/resum", "/resume")) {
      input.setComposingText(text, 1)
      assertEquals(text, writes.joinToString(""))
    }
    assertTrue(selections.isEmpty())
    assertFalse(input.endBatchEdit())
    assertEquals(listOf(7, 7, 0, 7), selections.last())
    input.commitText("/resume", 1)
    input.finishComposingText()
    assertEquals("/resume", writes.joinToString(""))
    assertEquals("/resume", input.getTextBeforeCursor(100, 0).toString())
  }

  @Test fun composingAutocorrectionOnlyEditsTheCurrentTransaction() {
    input.commitText("git ", 1)
    input.setComposingText("analuz", 1)
    input.setComposingText("analyze", 1)
    input.commitText("analyze ", 1)
    assertEquals(listOf("git ", "analuz", "\u007f\u007fyze", " "), writes)
    assertEquals("analyze ", input.editable.toString())
  }

  @Test fun suggestionReplacementIsDeliveredImmediatelyBeforeBatchEnds() {
    input.setComposingText("teh", 1)
    input.beginBatchEdit()
    assertTrue(TerminalInputConnectionApi34(input).replaceText(0, 3, "the", 1, null))
    assertEquals(listOf("teh", "\u007f\u007fhe"), writes)
    input.endBatchEdit()
    assertEquals("the", input.editable.toString())
  }

  @Test fun gboardIndividualLetterCommitsRemainCorrectableWithoutDelayingAnyLetter() {
    val modern = TerminalInputConnectionApi34(input)
    for (letter in "teh") {
      modern.commitText(letter.toString(), 1)
      assertEquals(letter.toString(), writes.last())
    }
    assertEquals("teh", input.getTextBeforeCursor(100, 0).toString())
    assertEquals(listOf(3, 3, -1, -1), selections.last())
    modern.beginBatchEdit()
    assertTrue(modern.replaceText(0, 3, "the", 1, null))
    assertEquals(listOf("t", "e", "h", "\u007f\u007fhe"), writes)
    modern.endBatchEdit()
  }

  @Test fun earlierWordsAreDiscardedWhileImeCoordinatesAndCorrectionsStayConsistent() {
    val modern = TerminalInputConnectionApi34(input)
    modern.commitText("earlier ", 1)
    for (letter in "teh") modern.commitText(letter.toString(), 1)
    assertEquals("teh", input.editable.toString())
    assertEquals(listOf(11, 11, -1, -1), selections.last())
    val surrounding = modern.getSurroundingText(100, 100, 0)!!
    assertEquals("teh", surrounding.text.toString())
    assertEquals(8, surrounding.offset)
    assertEquals(3, surrounding.selectionStart)
    assertFalse(modern.replaceText(0, 7, "cannot edit history", 1, null))
    assertTrue(modern.replaceText(8, 11, "the", 1, null))
    assertEquals("\u007f\u007fhe", writes.last())
    val extracted = modern.getExtractedText(ExtractedTextRequest(), 0)!!
    assertEquals(8, extracted.startOffset)
    assertEquals(3, extracted.selectionStart)
    modern.commitText("\n", 1)
    assertEquals("", input.editable.toString())
    assertFalse(modern.replaceText(8, 11, "cannot edit the prior prompt", 1, null))
  }

  @Test fun suggestionReplacementHonorsItsRangeAndCursorWithoutEditingCommittedHistory() {
    input.commitText("earlier ", 1)
    input.setComposingText("ab😀cd", 1)
    val modern = TerminalInputConnectionApi34(input)
    assertFalse(modern.replaceText(11, 12, "x", 1, null)) // Inside a surrogate pair.
    assertFalse(modern.replaceText(0, 100, "x", 1, null))
    assertEquals(listOf("earlier ", "ab😀cd"), writes)
    assertTrue(modern.replaceText(12, 10, "好", 1, null)) // Reversed range.
    assertEquals("\u001b[D\u001b[D\u007f好", writes.last())
    assertEquals("ab好cd", input.editable.toString())
    assertFalse(modern.replaceText(0, 2, "stale", 1, null))
    assertTrue(modern.commitText("!", 1, null))
    assertEquals("!", writes.last())
    input.retire()
    assertFalse(modern.replaceText(0, 0, "late", 1, null))
    assertFalse(modern.commitText("late", 1, null))
  }

  @Test fun dictationCanReadAndReviseLivePreeditWithoutReplayingCommittedText() {
    input.commitText("earlier ", 1)
    val request = ExtractedTextRequest().apply { token = 7 }
    assertEquals("earlier ", input.getExtractedText(request, InputConnection.GET_EXTRACTED_TEXT_MONITOR)!!.text)
    input.beginBatchEdit()
    input.setComposingText("turn on", 1)
    assertEquals(listOf("earlier ", "turn on"), writes)
    assertTrue(extractedUpdates.isEmpty())
    input.endBatchEdit()
    val (token, snapshot) = extractedUpdates.last()
    assertEquals(7, token)
    assertEquals("turn on", snapshot.text.toString())
    assertEquals(7, snapshot.selectionEnd)
    input.setComposingText("turn off", 1)
    assertEquals("\u007f" + "ff", writes.last())
    assertEquals("turn on", snapshot.text.toString()) // Snapshots cannot mutate under the IME.
    input.commitText("turn off", 1)
    assertEquals("off", extractedUpdates.last().second.text.toString())
    input.retire()
    assertNull(input.getExtractedText(request, 0))
    assertFalse(input.commitText("late transcript", 1))
  }

  @Test fun finishDoesNotResendPreeditAndTheNextCommitCannotDeleteIt() {
    input.setComposingText("old", 1)
    input.finishComposingText()
    assertFalse(input.setComposingRegion(0, 100))
    input.commitText("new", 1)
    assertEquals(listOf("old", "new"), writes)
  }

  @Test fun selectionAndComposingRegionReplaceOnlyTheSelectedPreedit() {
    input.setComposingText("abcd", 1)
    input.setComposingRegion(1, 3)
    input.setComposingText("X", 1)
    assertEquals("aXd", input.editable.toString())
    assertEquals(listOf("abcd", "\u001b[D\u007f\u007fX"), writes)
    assertEquals("aX", input.getTextBeforeCursor(100, 0).toString())
    assertEquals("d", input.getTextAfterCursor(100, 0).toString())
    input.setSelection(2, 1) // Android permits reversed selections.
    assertEquals("X", input.getSelectedText(0).toString())
    input.finishComposingText()
    assertEquals("aXd", input.editable.toString())
  }

  @Test fun cursorPositionsAreHonoredDuringComposition() {
    input.setComposingText("abc", 0)
    assertEquals(0, Selection.getSelectionEnd(input.editable))
    assertEquals("abc\u001b[D\u001b[D\u001b[D", writes.joinToString(""))
    input.setSelection(2, 2)
    assertEquals("\u001b[C\u001b[C", writes.last())
    assertFalse(input.setSelection(-1, 2))
    assertFalse(input.setSelection(0, 100))
  }

  @Test fun supplementaryCharactersUseOneTerminalDeletion() {
    input.setComposingText("a😀", 1)
    input.setComposingText("a好", 1)
    assertEquals(listOf("a😀", "\u007f好"), writes)
    assertFalse(input.setSelection(100, 100))
  }

  @Test fun codeUnitDeletionDoesNotSplitSurrogatePairs() {
    input.setComposingText("a😀", 1)
    input.deleteSurroundingText(1, 0)
    assertEquals("a", input.editable.toString())
    assertEquals("\u007f", writes.last())
  }

  @Test fun codePointDeletionCanEditBothSidesOfTheCursor() {
    input.setComposingText("a😀bc", 1)
    input.setSelection(3, 3)
    input.deleteSurroundingTextInCodePoints(1, 1)
    assertEquals("ac", input.editable.toString())
    assertEquals(1, Selection.getSelectionEnd(input.editable))
    assertEquals("\u001b[C\u007f\u007f", writes.last())
  }

  @Test fun invalidSurrogatesDoNotEmitPartialCodePointDeletion() {
    input.setComposingText("\uD800x", 1)
    writes.clear()
    input.deleteSurroundingTextInCodePoints(2, 0)
    assertTrue(writes.isEmpty())
  }

  @Test fun deletionOutsidePreeditIsAnExplicitKeyAndNeverAMirrorDiff() {
    input.commitText("git ", 1)
    input.deleteSurroundingText(1, 0)
    input.deleteSurroundingTextInCodePoints(0, 1)
    assertEquals(listOf("git ", "\u007f", "\u001b[3~"), writes)
  }

  @Test fun nestedBatchesDeferSelectionNotificationsButNeverInput() {
    input.beginBatchEdit()
    input.beginBatchEdit()
    input.setComposingText("a", 1)
    assertEquals(listOf("a"), writes)
    assertTrue(input.endBatchEdit())
    assertTrue(selections.isEmpty())
    assertFalse(input.endBatchEdit())
    assertEquals(1, selections.size)
    assertFalse(input.endBatchEdit())
  }

  @Test fun staleImeCallsAfterTabHistoryCtrlCOrPasteCannotDeleteOrReinsertText() {
    for (boundary in listOf("\t", "\u001b[A", "\u0003", "pasted")) {
      writes.clear()
      val old = newConnection()
      old.setComposingText("git ch", 1)
      old.retire() // The view retires/restarts input before the external action.
      writes.add(boundary)
      assertFalse(old.commitText("git change", 1))
      assertFalse(old.setComposingText("stale", 1))
      assertFalse(old.setSelection(0, 0))
      assertFalse(old.deleteSurroundingText(5, 0))
      assertFalse(old.deleteSurroundingTextInCodePoints(5, 0))
      assertFalse(old.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)))
      val fresh = newConnection()
      fresh.setComposingText("x", 1)
      fresh.commitText("x", 1)
      assertEquals(listOf("git ch", boundary, "x"), writes)
    }
  }

  @Test fun closeAndFocusLossRejectInputAndQueries() {
    input.setComposingText("abc", 1)
    acceptsInput = false
    assertFalse(input.commitText("x", 1))
    assertNull(input.getTextBeforeCursor(10, 0))
    acceptsInput = true
    input.closeConnection()
    assertEquals(0, input.editable.length)
    assertFalse(input.beginBatchEdit())
    assertFalse(input.finishComposingText())
  }

  @Test fun actionsAndKeyEventsReachTheSharedHardwareHandlerImmediately() {
    input.setComposingText("/", 1)
    assertTrue(input.performEditorAction(EditorInfo.IME_ACTION_GO))
    assertEquals(KeyEvent.KEYCODE_ENTER, events.last().keyCode)
    input.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN))
    assertEquals(KeyEvent.KEYCODE_DPAD_DOWN, events.last().keyCode)
    assertEquals(listOf("/"), writes)
  }

  @Test fun preeditIsBounded() {
    input.setComposingText("a".repeat(TerminalInputConnection.MAX_PREEDIT + 1), 1)
    assertEquals(1, overflows)
  }

  @Test fun imeNewlineIsAnImmediateEnterAndForgetsPreedit() {
    input.setComposingText("/", 1)
    input.commitText("/\n", 1)
    assertEquals(listOf("/", "\r"), writes)
    assertEquals(0, input.editable.length)
  }
}
