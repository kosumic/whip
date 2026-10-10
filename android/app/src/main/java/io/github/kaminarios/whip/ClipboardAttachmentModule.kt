package io.github.kaminarios.whip

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.textinput.ReactEditText
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

class ClipboardAttachmentModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private class InputBinding(val input: WeakReference<ReactEditText>) {
    val pendingFiles = mutableMapOf<String, File>()
  }

  private val bindings = mutableMapOf<String, InputBinding>()
  private val copies = Executors.newSingleThreadExecutor()

  override fun getName(): String = "ClipboardAttachment"

  @ReactMethod
  fun hasAttachment(promise: Promise) {
    promise.resolve(runCatching {
      clipboardUri(primaryClip())?.let { uri ->
        openClipboardSource(uri)?.use { it.read() != -1 }
      } == true
    }.getOrDefault(false))
  }

  @ReactMethod
  fun copyAttachment(promise: Promise) {
    try {
      val clip = try { primaryClip() } catch (_: SecurityException) { null }
      val uri = clipboardUri(clip)
      if (uri == null) {
        promise.resolve(null)
        return
      }
      promise.resolve(copyUri(uri, clip?.description?.getMimeType(0)))
    } catch (error: Throwable) {
      promise.reject(ERROR, "Could not read the clipboard attachment", error)
    }
  }

  @ReactMethod
  fun attachInput(tag: Int, token: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val input = UIManagerHelper.getUIManagerForReactTag(reactContext, tag)?.resolveView(tag) as? ReactEditText
        requireNotNull(input) { "Could not find the composer input" }
        bindings.filterValues { it.input.get() === input }.keys.toList().forEach(::detach)
        detach(token)
        bindings[token] = InputBinding(WeakReference(input))
        ViewCompat.setOnReceiveContentListener(input, arrayOf(IMAGE_MIME_TYPE)) { _, payload ->
          receiveImages(token, payload)
        }
        if (input.hasFocus())
          (reactContext.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).restartInput(input)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject(ERROR, "Could not enable image paste", error)
      }
    }
  }

  @ReactMethod
  fun detachInput(token: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      detach(token)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun takePasteAttachment(token: String, uri: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      promise.resolve(bindings[token]?.pendingFiles?.remove(uri) != null)
    }
  }

  private fun receiveImages(token: String, payload: ContentInfoCompat): ContentInfoCompat? {
    val fallbackMime = imageMime(payload.clip)
    val parts = payload.partition { item ->
      val uri = item.uri
      uri != null && (runCatching { reactContext.contentResolver.getType(uri) }.getOrNull()
        ?: fallbackMime)?.startsWith("image/") == true
    }
    val images = parts.first ?: return payload
    // Retain the payload until copying completes: it owns the keyboard's URI permission.
    copies.execute {
      val clip = images.clip
      for (index in 0 until clip.itemCount) {
        try {
          // Keep the original payload reachable until the final image is copied.
          val attachment = copyUri(clip.getItemAt(index).uri!!, imageMime(payload.clip)) ?: continue
          val uri = attachment.getString("uri")!!
          val file = File(Uri.parse(uri).path!!)
          UiThreadUtil.runOnUiThread {
            val binding = bindings[token]
            if (binding?.input?.get() == null || !reactContext.hasActiveReactInstance()) file.delete()
            else {
              binding.pendingFiles[uri] = file
              emit(Arguments.createMap().apply {
                putString("token", token)
                putMap("attachment", attachment)
              })
            }
          }
        } catch (error: Exception) {
          UiThreadUtil.runOnUiThread {
            if (bindings.containsKey(token)) emit(Arguments.createMap().apply {
              putString("token", token)
              putString("error", error.message ?: "Could not paste the image")
            })
          }
        }
      }
    }
    return parts.second
  }

  private fun emit(event: WritableMap) {
    if (reactContext.hasActiveReactInstance())
      reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(IMAGE_PASTE_EVENT, event)
  }

  private fun imageMime(clip: ClipData): String? =
    (0 until clip.description.mimeTypeCount).map(clip.description::getMimeType)
      .firstOrNull { it.startsWith("image/") }

  private fun detach(token: String) {
    val binding = bindings.remove(token) ?: return
    binding.input.get()?.let { ViewCompat.setOnReceiveContentListener(it, null, null) }
    binding.pendingFiles.values.forEach { it.delete() }
  }

  override fun invalidate() {
    UiThreadUtil.runOnUiThread { bindings.keys.toList().forEach(::detach) }
    copies.shutdown()
    super.invalidate()
  }

  internal fun copyUri(uri: Uri, fallbackMime: String?): WritableMap? {
    val input = openClipboardSource(uri) ?: return null
    return input.use {
      val firstByte = input.read()
      if (firstByte == -1) return null
      val resolver = reactContext.contentResolver
      // Providers may support reading data without exposing metadata.
      val mime = runCatching { resolver.getType(uri) }.getOrNull() ?: fallbackMime
      val extension = mime?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
      val name = runCatching { displayName(uri) }.getOrNull()
        ?: listOfNotNull("clipboard", extension).joinToString(".")
      val directory = File(reactContext.cacheDir, "clipboard-attachments").apply {
        check(isDirectory || mkdirs()) { "Could not prepare the clipboard attachment" }
      }
      val destination = File(directory, "${UUID.randomUUID()}-${safeName(name)}")
      try {
        destination.outputStream().use { output ->
          output.write(firstByte)
          input.copyTo(output)
        }
        Arguments.createMap().apply {
          putString("uri", Uri.fromFile(destination).toString())
          putString("name", name)
          putString("mimeType", mime)
        }
      } catch (error: Throwable) {
        destination.delete()
        throw error
      }
    }
  }

  private fun openClipboardSource(uri: Uri): InputStream? {
    if (!isLocalAttachmentUri(uri)) return null
    return try {
      reactContext.contentResolver.openInputStream(uri)
    } catch (_: FileNotFoundException) {
      null
    } catch (_: SecurityException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    }
  }

  private fun isLocalAttachmentUri(uri: Uri): Boolean =
    uri.scheme == ContentResolver.SCHEME_CONTENT || uri.scheme == ContentResolver.SCHEME_FILE

  private fun primaryClip(): ClipData? =
    (reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip

  internal fun clipboardUri(clip: ClipData?): Uri? {
    if (clip == null || clip.itemCount == 0) return null
    for (index in 0 until clip.itemCount) {
      val item = clip.getItemAt(index)
      val uri = item.uri ?: item.intent?.data
      if (uri != null && isLocalAttachmentUri(uri)) return uri
    }
    return null
  }

  private fun displayName(uri: Uri): String? {
    reactContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null).use { cursor ->
      if (cursor != null && cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0) return cursor.getString(index)
      }
    }
    return uri.lastPathSegment
  }

  private fun safeName(name: String): String =
    name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]+"), "-")

  companion object {
    private const val ERROR = "E_CLIPBOARD_ATTACHMENT"
    private const val IMAGE_PASTE_EVENT = "WhipComposerImagePaste"
    private const val IMAGE_MIME_TYPE = "image/*"
  }
}
