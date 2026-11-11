package io.github.kaminarios.whip

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract

internal object DownloadDestinationPermission {
  private const val ACCESS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
  private const val EXPIRED = "Folder access expired. Choose the destination again."

  private fun treeUri(uri: String): Uri {
    val destination = Uri.parse(uri)
    require(destination.scheme == ContentResolver.SCHEME_CONTENT && DocumentsContract.isTreeUri(destination)) { EXPIRED }
    // Expo adds a trailing slash to Directory.uri. Android's persisted grant
    // belongs to the original tree URI, not that spelling or a child document.
    return DocumentsContract.buildTreeDocumentUri(destination.authority, DocumentsContract.getTreeDocumentId(destination))
  }

  fun retain(resolver: ContentResolver, uri: String) {
    resolver.takePersistableUriPermission(treeUri(uri), ACCESS)
  }

  fun resolve(resolver: ContentResolver, uri: String): String {
    val tree = treeUri(uri)
    check(resolver.persistedUriPermissions.any {
      it.uri == tree && it.isReadPermission && it.isWritePermission
    }) { EXPIRED }
    // Keep the saved destination spelling stable for Expo and download history.
    return uri
  }
}
