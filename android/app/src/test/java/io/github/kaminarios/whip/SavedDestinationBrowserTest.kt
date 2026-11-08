package io.github.kaminarios.whip

import android.content.ActivityNotFoundException
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.DocumentsContract
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = android.app.Application::class)
class SavedDestinationBrowserTest {
  private val saved = "content://files/tree/opaque/document/opaque-child"
  private val directory = "content://files/tree/opaque"
  private val provider = DestinationProvider()
  private val launches = mutableListOf<Intent>()
  private var unavailable = emptySet<String>()
  private lateinit var context: Context

  @Before fun setup() {
    ShadowContentResolver.registerProviderInternal("files", provider)
    context = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
      override fun startActivity(intent: Intent) {
        if (intent.action in unavailable) throw ActivityNotFoundException()
        launches.add(intent)
      }
    }
  }

  @Test fun opensContainingSafFolderWithReadPermissionOnly() {
    SavedDestinationBrowser.open(context, saved, directory)
    val intent = launches.single()
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals(DocumentsContract.Document.MIME_TYPE_DIR, intent.type)
    assertEquals("content://files/tree/opaque/document/opaque", intent.data.toString())
    assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    assertEquals(0, intent.flags and (Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION))
    assertEquals(saved, provider.queried.toString())
  }

  @Test fun fallsBackToSystemNavigatorWhenNoFolderViewerExists() {
    unavailable = setOf(Intent.ACTION_VIEW)
    SavedDestinationBrowser.open(context, saved, directory)
    val intent = launches.single()
    assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
    assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
    assertEquals("content://files/tree/opaque/document/opaque", intent.getParcelableExtra<Uri>(DocumentsContract.EXTRA_INITIAL_URI).toString())
    assertEquals(0, intent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
  }

  @Test fun rejectsMissingFilesAndExpiredPermissionsWithoutLaunching() {
    provider.exists = false
    assertThrows(IllegalStateException::class.java) { SavedDestinationBrowser.open(context, saved, directory) }
    provider.denied = true
    assertThrows(SecurityException::class.java) { SavedDestinationBrowser.open(context, saved, directory) }
    assertTrue(launches.isEmpty())
  }

  @Test fun reportsUnavailableNavigatorAndRejectsNonDocumentDestinations() {
    unavailable = setOf(Intent.ACTION_VIEW, Intent.ACTION_OPEN_DOCUMENT)
    assertThrows(ActivityNotFoundException::class.java) { SavedDestinationBrowser.open(context, saved, directory) }
    assertThrows(IllegalArgumentException::class.java) { SavedDestinationBrowser.open(context, "file:///private/file", directory) }
    assertTrue(launches.isEmpty())
  }

  class DestinationProvider : ContentProvider() {
    var exists = true
    var denied = false
    var queried: Uri? = null
    override fun onCreate() = true
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
      if (denied) throw SecurityException("Expired grant")
      queried = uri
      return MatrixCursor(arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME)).apply {
        if (exists) addRow(arrayOf("source"))
      }
    }
    override fun getType(uri: Uri) = "text/plain"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
  }
}
