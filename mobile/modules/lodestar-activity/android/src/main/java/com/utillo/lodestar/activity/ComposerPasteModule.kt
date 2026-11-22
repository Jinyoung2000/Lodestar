package com.utillo.lodestar.activity

import android.content.ClipData
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.view.ViewCompat
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ComposerPasteModule : Module() {
  private class Binding(val input: EditText) {
    var pending = 0
  }

  private val bindings = mutableMapOf<String, Binding>()
  private val maxImages = 5
  private val maxSourceBytes = 20L * 1024 * 1024
  private val maxPixels = 40_000_000L
  private val cachePrefix = "composer-paste-"

  override fun definition() = ModuleDefinition {
    Name("LodestarComposerPaste")
    Events("pasteStarted", "pasteFinished")

    AsyncFunction("bind") { tag: Int, token: String ->
      val input = appContext.currentActivity?.findViewById<EditText>(tag)
      if (input == null) {
        android.util.Log.d("LodestarComposerPaste", "The composer view is not attached yet")
        return@AsyncFunction
      }
      if (bindings[token]?.input === input) return@AsyncFunction
      val binding = Binding(input)
      bindings[token] = binding
      ViewCompat.setOnReceiveContentListener(input, arrayOf("image/*")) { _, content ->
        if (!input.isAttachedToWindow || !input.isEnabled || !input.isShown) return@setOnReceiveContentListener content
        val partition = content.partition { isImage(input.context, it, content.clip) }
        val images = partition.first
        if (images != null) {
          val clip = images.clip
          val count = minOf(clip.itemCount, maxImages - binding.pending)
          if (count > 0) {
            binding.pending += count
            sendEvent("pasteStarted", mapOf("token" to token))
            appContext.mainQueue.launch {
              val assets = withContext(Dispatchers.IO) {
                (0 until count).mapNotNull { index -> copyImage(input.context, images.clip.getItemAt(index).uri) }
              }
              binding.pending -= count
              if (bindings[token] === binding) {
                sendEvent("pasteFinished", mapOf("token" to token, "assets" to assets, "failed" to (count - assets.size)))
              } else {
                withContext(Dispatchers.IO) {
                  assets.forEach { discard(input.context, it.getValue("uri") as String) }
                }
              }
            }
          } else {
            sendEvent("pasteFinished", mapOf("token" to token, "full" to true))
          }
        }
        partition.second
      }
      if (input.isFocused) {
        input.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.restartInput(input)
      }
      android.util.Log.d("LodestarComposerPaste", "Registered the composer image receiver")
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("unbind") { token: String ->
      val binding = bindings.remove(token) ?: return@AsyncFunction
      if (bindings.values.none { it.input === binding.input }) {
        ViewCompat.setOnReceiveContentListener(binding.input, null, null)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("discard") { uri: String ->
      appContext.reactContext?.let { discard(it, uri) }
    }

    OnCreate {
      val cache = appContext.reactContext?.cacheDir
      appContext.backgroundCoroutineScope.launch(Dispatchers.IO) {
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        cache?.listFiles()?.filter { it.name.startsWith(cachePrefix) && it.lastModified() < cutoff }?.forEach { it.delete() }
      }
    }
  }

  private fun isImage(context: Context, item: ClipData.Item, clip: ClipData): Boolean {
    val uri = item.uri ?: return false
    if (uri.scheme != "content") return false
    val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
    return mime?.startsWith("image/") ?: clip.description.hasMimeType("image/*")
  }

  private fun copyImage(context: Context, uri: Uri): Map<String, Any>? {
    var file: File? = null
    return try {
      val target = File.createTempFile(cachePrefix, ".image", context.cacheDir)
      file = target
      val input = requireNotNull(context.contentResolver.openInputStream(uri))
      input.use { source ->
        target.outputStream().use { output ->
          val buffer = ByteArray(32 * 1024)
          var total = 0L
          while (true) {
            val count = source.read(buffer)
            if (count == -1) break
            total += count
            require(total <= maxSourceBytes)
            output.write(buffer, 0, count)
          }
        }
      }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(target.absolutePath, bounds)
      require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= maxPixels)
      mapOf("uri" to Uri.fromFile(target).toString(), "width" to bounds.outWidth, "height" to bounds.outHeight)
    } catch (error: Exception) {
      android.util.Log.w("LodestarComposerPaste", "Clipboard image could not be copied or decoded", error)
      file?.delete()
      null
    }
  }

  private fun discard(context: Context, uri: String) {
    val path = Uri.parse(uri).path ?: return
    val file = File(path)
    if (file.parentFile == context.cacheDir && file.name.startsWith(cachePrefix)) file.delete()
  }
}
