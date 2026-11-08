package io.github.kaminarios.whip

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract

/** Navigate to an existing SAF destination without taking a new persistent grant. */
internal object SavedDestinationBrowser {
  fun open(context: Context, savedUri: String, directoryUri: String) {
    val saved = Uri.parse(savedUri)
    val tree = Uri.parse(directoryUri)
    require(saved.scheme == "content" && tree.scheme == "content" && saved.authority == tree.authority) {
      "Unsupported saved destination"
    }
    val folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    context.contentResolver.query(saved, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null).use {
      check(it != null && it.moveToFirst()) { "The saved file is missing or access has expired" }
    }
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(folder, DocumentsContract.Document.MIME_TYPE_DIR)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(view)
    } catch (_: ActivityNotFoundException) {
      // Providers without a folder viewer can still appear in DocumentsUI.
      // EXTRA_INITIAL_URI is a hint; providers may use another starting folder.
      val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
        .addCategory(Intent.CATEGORY_OPENABLE)
        .putExtra(DocumentsContract.EXTRA_INITIAL_URI, folder)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(picker)
    }
  }
}
