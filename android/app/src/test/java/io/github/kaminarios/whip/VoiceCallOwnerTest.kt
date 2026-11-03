package io.github.kaminarios.whip

import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceCallOwnerTest {
  @Test fun `one native call owns resources through startup and teardown`() {
    val owner = VoiceCallOwner<Any>()
    val first = Any()
    val second = Any()
    assertTrue(owner.reserve(first))
    assertFalse(owner.reserve(second))
    assertSame(first, owner.active)
    assertTrue(owner.release(first))
    assertTrue(owner.reserve(second))
  }

  @Test fun `late cleanup from an old call cannot release its replacement`() {
    val owner = VoiceCallOwner<Any>()
    val first = Any()
    val second = Any()
    assertTrue(owner.reserve(first))
    assertTrue(owner.release(first))
    assertTrue(owner.reserve(second))
    assertFalse(owner.release(first))
    assertSame(second, owner.active)
  }
}
