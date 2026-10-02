package io.github.kaminarios.whip

import android.content.SharedPreferences
import android.net.Uri
import android.webkit.CookieManager
import androidx.webkit.CookieManagerCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray

/** Native-only cookie values. React receives domain names and availability only. */
internal class BrowserSiteCookies(
  private val preferences: SharedPreferences,
  private val cookies: CookieManager = CookieManager.getInstance(),
) {
  companion object {
    private const val URLS_KEY = "visited_urls"
    private const val MAX_VISITED_URLS = 500
    private const val MAX_URL_LENGTH = 8192
    private const val EXPIRED = "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  }

  private val urls = linkedSetOf<String>()

  init {
    try {
      val saved = JSONArray(preferences.getString(URLS_KEY, "[]"))
      for (index in 0 until minOf(saved.length(), MAX_VISITED_URLS))
        cleanUrl(saved.optString(index))?.let { urls.add(it) }
    } catch (_: Exception) { /* Discard corrupt history without logging URLs. */ }
  }

  private fun cleanUrl(value: String): String? {
    if (value.length > MAX_URL_LENGTH) return null
    val url = Uri.parse(value)
    if (url.scheme !in listOf("http", "https") || url.host.isNullOrBlank() || url.userInfo != null)
      return null
    return url.buildUpon().clearQuery().fragment(null).build().toString()
  }

  fun record(value: String) {
    val url = cleanUrl(value) ?: return
    if (urls.contains(url)) return
    urls.add(url)
    while (urls.size > MAX_VISITED_URLS) urls.remove(urls.first())
    preferences.edit().putString(URLS_KEY, JSONArray(urls.toList()).toString()).apply()
  }

  fun domains(): List<String> = urls.mapNotNull { Uri.parse(it).host?.lowercase() }.distinct().sorted()
  fun hasCookies(): Boolean = cookies.hasCookies()
  fun canClearDomains(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)

  /** CookieManager has no domain-wide enumeration. Expire all cookies on visited paths. */
  fun clearDomain(domain: String, complete: (Boolean) -> Unit) {
    require(domain in domains()) { "Unknown browser domain" }
    check(canClearDomains()) { "Update Android System WebView to clear cookies by domain" }
    val pages = urls.filter { Uri.parse(it).host?.lowercase() == domain }
    val expired = linkedSetOf<Pair<String, String>>()
    for (page in pages) {
      for (info in CookieManagerCompat.getCookieInfo(cookies, page)) {
        val parts = info.split(';')
        val name = parts.first().substringBefore('=').trim()
        val attributes = parts.drop(1).associate {
          it.substringBefore('=').trim().lowercase() to it.substringAfter('=', "").trim()
        }
        val path = attributes["path"] ?: "/"
        val secure = "secure" in attributes || name.startsWith("__Secure-") || name.startsWith("__Host-")
        val flags = buildString {
          if (secure) append("; Secure")
          if ("httponly" in attributes) append("; HttpOnly")
          if ("partitioned" in attributes) append("; Partitioned")
        }
        val base = "$name=; $EXPIRED; Path=$path"
        // Expire host-only and Domain variants. __Host- requires no Domain attribute.
        expired.add(page to (base + flags))
        val cookieDomain = attributes["domain"]?.lowercase()
        if (cookieDomain != null && !name.startsWith("__Host-") &&
          (domain == cookieDomain.trimStart('.') || domain.endsWith("." + cookieDomain.trimStart('.'))))
          expired.add(page to "$base; Domain=$cookieDomain$flags")
      }
    }
    if (expired.isEmpty()) { complete(true); return }
    var remaining = expired.size
    var succeeded = true
    for ((page, expiry) in expired) cookies.setCookie(page, expiry) { accepted ->
      succeeded = succeeded && accepted
      if (--remaining == 0) {
        cookies.flush()
        complete(succeeded && pages.all { CookieManagerCompat.getCookieInfo(cookies, it).isEmpty() })
      }
    }
  }
}
