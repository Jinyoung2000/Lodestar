package com.utillo.lodestar.activity

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

class ScreenCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LodestarScreenCapture")

    AsyncFunction("captureWindowAsync") { promise: Promise ->
      val activity = appContext.currentActivity
      val window = activity?.window
      val view = window?.decorView
      if (activity == null || window == null || view == null || view.width <= 0 || view.height <= 0) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
      PixelCopy.request(window, bitmap, { result ->
        if (result != PixelCopy.SUCCESS) {
          bitmap.recycle()
          promise.resolve(null)
          return@request
        }
        Thread {
          try {
            val file = File(activity.cacheDir, "feedback-${System.currentTimeMillis()}.png")
            FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            promise.resolve(mapOf("uri" to "file://${file.absolutePath}", "width" to bitmap.width, "height" to bitmap.height))
          } catch (error: Exception) {
            promise.resolve(null)
          } finally {
            bitmap.recycle()
          }
        }.start()
      }, Handler(Looper.getMainLooper()))
    }.runOnQueue(Queues.MAIN)
  }
}
