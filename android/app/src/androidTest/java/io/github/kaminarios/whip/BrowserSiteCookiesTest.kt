package io.github.kaminarios.whip

import android.content.Context
import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BrowserSiteCookiesTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext

  private fun completeOnMain(action: ((Boolean) -> Unit) -> Unit) {
    val done = CountDownLatch(1)
    var accepted = false
    instrumentation.runOnMainSync { action { accepted = it; done.countDown() } }
    assertTrue("Cookie operation timed out", done.await(10, TimeUnit.SECONDS))
    assertTrue("Cookie operation failed", accepted)
  }

  @Test fun visitedDomainsRecoverWithoutQueryFragmentOrCredentials() {
    val preferences = context.getSharedPreferences("browser_sites_test_${UUID.randomUUID()}", Context.MODE_PRIVATE)
    try {
      instrumentation.runOnMainSync {
        val sites = BrowserSiteCookies(preferences)
        sites.record("https://example.invalid/auth/page?secret=hidden#private")
        sites.record("https://example.invalid/")
        sites.record("https://github.invalid/")
        sites.record("https://user:password@credential.invalid/")
        sites.record("file:///private/file")
        assertEquals(listOf("example.invalid", "github.invalid"), sites.domains())
        assertEquals(sites.domains(), BrowserSiteCookies(preferences).domains())
        val saved = preferences.all.values.joinToString()
        assertFalse(saved.contains("secret"))
        assertFalse(saved.contains("private"))
        assertFalse(saved.contains("password"))
      }
    } finally { preferences.edit().clear().commit() }
  }

  @Test fun domainDeletionRemovesSecureHttpOnlyAndPathCookiesWithoutTouchingOtherSites() {
    val preferences = context.getSharedPreferences("browser_cookies_test_${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val id = UUID.randomUUID().toString()
    val domain = "target-$id.invalid"
    val other = "other-$id.invalid"
    val page = "https://$domain/auth/page"
    val otherPage = "https://$other/"
    lateinit var sites: BrowserSiteCookies
    lateinit var cookies: CookieManager
    instrumentation.runOnMainSync {
      cookies = CookieManager.getInstance()
      sites = BrowserSiteCookies(preferences, cookies)
      sites.record(page)
      sites.record("https://$domain/")
      sites.record(otherPage)
    }
    assumeTrue(sites.canClearDomains())
    try {
      completeOnMain { cookies.setCookie(page, "root=private; Path=/; Secure; HttpOnly", it) }
      completeOnMain { cookies.setCookie(page, "path=private; Path=/auth; Domain=$domain; Secure; HttpOnly", it) }
      completeOnMain { cookies.setCookie(page, "__Host-token=private; Path=/; Secure; HttpOnly", it) }
      completeOnMain { cookies.setCookie(otherPage, "untouched=private; Path=/; Secure", it) }
      instrumentation.runOnMainSync {
        assertTrue(cookies.getCookie(page).orEmpty().contains("path="))
        assertTrue(sites.hasCookies())
      }
      completeOnMain { sites.clearDomain(domain, it) }
      instrumentation.runOnMainSync {
        assertTrue(cookies.getCookie(page).isNullOrEmpty())
        assertTrue(cookies.getCookie(otherPage).orEmpty().contains("untouched="))
        var rejected = false
        try { sites.clearDomain("unvisited.invalid") { fail("Unknown domain must not be cleared") } }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
      }
    } finally {
      // Only remove this test's cookies. Never clear the user's global cookie store.
      completeOnMain { sites.clearDomain(domain, it) }
      completeOnMain { sites.clearDomain(other, it) }
      preferences.edit().clear().commit()
    }
  }
}
