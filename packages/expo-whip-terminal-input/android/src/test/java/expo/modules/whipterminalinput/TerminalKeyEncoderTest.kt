package expo.modules.whipterminalinput

import android.view.KeyEvent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class TerminalKeyEncoderTest {
  private val encoder = TerminalKeyEncoder()
  private fun key(code: Int, meta: Int = 0) = encoder.encode(KeyEvent(0, 0, KeyEvent.ACTION_DOWN, code, 0, meta))

  @Test fun navigationAndInterruptAreImmediateTerminalKeys() {
    assertEquals("\t", key(KeyEvent.KEYCODE_TAB))
    assertEquals("\r", key(KeyEvent.KEYCODE_ENTER))
    assertEquals("\u0003", key(KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON))
    assertEquals("\u007f", key(KeyEvent.KEYCODE_DEL))
    assertEquals("\u001b[3~", key(KeyEvent.KEYCODE_FORWARD_DEL))
    assertEquals("\u001b[A", key(KeyEvent.KEYCODE_DPAD_UP))
    assertEquals("\u001b[B", key(KeyEvent.KEYCODE_DPAD_DOWN))
    assertEquals("\u001b[1;5D", key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.META_CTRL_ON))
    assertEquals("\u001b[Z", key(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON))
    assertEquals("\u001bx", key(KeyEvent.KEYCODE_X, KeyEvent.META_ALT_ON))
  }

  @Test fun applicationCursorModeUsesSs3AndModifiedKeysUseCsi() {
    encoder.applicationCursorKeys = true
    assertEquals("\u001bOA", key(KeyEvent.KEYCODE_DPAD_UP))
    assertEquals("\u001bOH", key(KeyEvent.KEYCODE_MOVE_HOME))
    assertEquals("\u001b[1;2A", key(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.META_SHIFT_ON))
  }

  @Test fun systemKeysAndKeyUpDoNotGenerateTerminalText() {
    assertNull(key(KeyEvent.KEYCODE_BACK))
    assertNull(key(KeyEvent.KEYCODE_VOLUME_UP))
    assertNull(encoder.encode(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_A)))
  }

  @Test fun kittyModePreservesHardwareControlModifiers() {
    encoder.kittyKeyboardReportAll = true
    assertEquals("\u001b[99;5:1u", key(KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON))
    assertEquals("\u001b[1;5:1D", key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.META_CTRL_ON))
    assertEquals("\u001b[9;2:1u", key(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON))
    assertEquals("\u001b[127;1:1u", key(KeyEvent.KEYCODE_DEL))
  }
}
