package io.github.kaminarios.whip

import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

internal object BrowserProfile {
  private const val DESKTOP_MODE = "desktop"

  fun apply(webView: WebView, userAgent: String?, contentMode: String) {
    require(contentMode in listOf("mobile", DESKTOP_MODE, "recommended")) { "Invalid browser profile" }
    val settings = webView.settings
    settings.useWideViewPort = true
    settings.loadWithOverviewMode = true
    if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
      val metadata = UserAgentMetadata.Builder()
      if (contentMode == DESKTOP_MODE) metadata.setMobile(false).setPlatform("Linux")
      WebSettingsCompat.setUserAgentMetadata(settings, metadata.build())
    }
    val agent = userAgent ?: WebSettings.getDefaultUserAgent(webView.context)
    if (settings.userAgentString != agent) settings.userAgentString = agent
  }
}
