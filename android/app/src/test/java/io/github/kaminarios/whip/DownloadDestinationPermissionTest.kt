package io.github.kaminarios.whip

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = android.app.Application::class)
class DownloadDestinationPermissionTest {
  private val tree = DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:Download/Whip")
  private val expoDirectory get() = "$tree/"
  private val access = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
  private lateinit var resolver: ContentResolver

  @Before fun setup() {
    resolver = RuntimeEnvironment.getApplication().contentResolver
  }

  @Test fun retainsPickerGrantWhenExpoAddsTrailingSlash() {
    // The picker has already persisted the original URI before Expo returns it.
    resolver.takePersistableUriPermission(tree, access)
    DownloadDestinationPermission.retain(resolver, expoDirectory)
    assertEquals(listOf(tree), resolver.persistedUriPermissions.map { it.uri })
    assertEquals(expoDirectory, DownloadDestinationPermission.resolve(resolver, expoDirectory))
  }

  @Test fun resolvesTreeAndDocumentFormsWithoutChangingSavedDestination() {
    resolver.takePersistableUriPermission(tree, access)
    val child = DocumentsContract.buildDocumentUriUsingTree(tree, "primary:Download/Whip/nested").toString() + "/"
    for (uri in listOf(tree.toString(), expoDirectory, child)) {
      assertEquals(uri, DownloadDestinationPermission.resolve(resolver, uri))
    }
  }

  @Test fun rejectsRevokedReadOnlyAndUnrelatedFolderGrants() {
    resolver.takePersistableUriPermission(tree, access)
    resolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    assertThrows(IllegalStateException::class.java) { DownloadDestinationPermission.resolve(resolver, expoDirectory) }
    resolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    assertThrows(IllegalStateException::class.java) { DownloadDestinationPermission.resolve(resolver, expoDirectory) }
    resolver.takePersistableUriPermission(Uri.parse("content://other/tree/primary%3ADownload%2FWhip"), access)
    assertThrows(IllegalStateException::class.java) { DownloadDestinationPermission.resolve(resolver, expoDirectory) }
  }
}
