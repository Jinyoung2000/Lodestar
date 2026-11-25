package com.utillo.lodestar.activity

import android.app.Activity
import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup

internal class BlankScreenGuard(private val onReport: (String) -> Unit) : Application.ActivityLifecycleCallbacks {
  private val main = Handler(Looper.getMainLooper())
  private val armed = mutableSetOf<Activity>()
  private var watched: Activity? = null
  private var blankChecks = 0
  private var recreated = 0
  private val loop = Runnable { tick() }

  fun alreadyRunning(activity: Activity?) {
    if (activity != null) watch(activity)
  }

  override fun onActivityResumed(activity: Activity) = watch(activity)

  override fun onActivityPaused(activity: Activity) {
    if (watched === activity) watched = null
    main.removeCallbacks(loop)
  }

  override fun onActivityDestroyed(activity: Activity) {
    armed.remove(activity)
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
  override fun onActivityStarted(activity: Activity) = Unit
  override fun onActivityStopped(activity: Activity) = Unit
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  private fun watch(activity: Activity) {
    watched = activity
    blankChecks = 0
    main.removeCallbacks(loop)
    main.postDelayed(loop, CHECK_EVERY_MS)
  }

  private fun tick() {
    val activity = watched ?: return
    main.postDelayed(loop, CHECK_EVERY_MS)
    if (activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) return
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val leaves = visibleLeaves(content)
    if (leaves < MIN_LEAVES) {
      judge(activity, content, "$leaves visible views")
      return
    }
    samplePixels(activity) { uniform ->
      if (watched !== activity) return@samplePixels
      if (uniform == null) {
        armed.add(activity)
        blankChecks = 0
      } else {
        judge(activity, content, "$leaves visible views but the window shows one flat color ${uniform}")
      }
    }
  }

  private fun judge(activity: Activity, content: ViewGroup, finding: String) {
    if (activity !in armed) return
    blankChecks++
    if (blankChecks < BLANK_CHECKS) return
    blankChecks = 0
    val healing = recreated < MAX_RECREATES
    val summary = "screen blank: $finding${if (healing) "; recreating the activity" else ""}\n${ProcessSnapshot.memory()}\n${tree(content, 0)}".take(TEXT_CHARS)
    Thread({ onReport("$summary\n-- own logcat --\n${ProcessSnapshot.ownLogcat()}") }, "lodestar-blank-report").start()
    if (healing) {
      recreated++
      armed.remove(activity)
      activity.recreate()
    }
  }

  private fun samplePixels(activity: Activity, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < 26) return done(null)
    val bitmap = Bitmap.createBitmap(SAMPLE_W, SAMPLE_H, Bitmap.Config.ARGB_8888)
    try {
      PixelCopy.request(activity.window, bitmap, { result ->
        val uniform = if (result == PixelCopy.SUCCESS) flatColor(bitmap) else null
        bitmap.recycle()
        done(uniform)
      }, main)
    } catch (_: Exception) {
      bitmap.recycle()
      done(null)
    }
  }

  private fun flatColor(bitmap: Bitmap): String? {
    val first = bitmap.getPixel(0, bitmap.height / 2)
    for (y in bitmap.height / 10 until bitmap.height) for (x in 0 until bitmap.width) {
      val pixel = bitmap.getPixel(x, y)
      if (Math.abs(Color.red(pixel) - Color.red(first)) > PIXEL_TOLERANCE ||
        Math.abs(Color.green(pixel) - Color.green(first)) > PIXEL_TOLERANCE ||
        Math.abs(Color.blue(pixel) - Color.blue(first)) > PIXEL_TOLERANCE) return null
    }
    return String.format("#%06x", first and 0xffffff)
  }

  private fun visibleLeaves(view: View): Int {
    if (!view.isShown || view.alpha < MIN_ALPHA || !view.getGlobalVisibleRect(Rect())) return 0
    if (view !is ViewGroup || view.childCount == 0) return 1
    var count = 0
    for (i in 0 until view.childCount) count += visibleLeaves(view.getChildAt(i))
    return count
  }

  private fun tree(view: View, depth: Int): String {
    val rect = Rect()
    val onScreen = view.getGlobalVisibleRect(rect)
    val line = "  ".repeat(depth) + "${view.javaClass.simpleName} ${visibilityName(view.visibility)} a=${"%.2f".format(view.alpha)} " +
      "${view.width}x${view.height} at ${view.left},${view.top} t=${view.translationX.toInt()},${view.translationY.toInt()} " +
      (if (onScreen) "shown ${rect.toShortString()}" else "offscreen")
    if (view !is ViewGroup || depth >= MAX_DEPTH) return line
    val children = (0 until view.childCount).map { view.getChildAt(it) }
    val kids = children.take(MAX_CHILDREN).joinToString("") { "\n" + tree(it, depth + 1) }
    val more = if (children.size > MAX_CHILDREN) "\n" + "  ".repeat(depth + 1) + "... ${children.size - MAX_CHILDREN} more" else ""
    return line + kids + more
  }

  private fun visibilityName(visibility: Int) = when (visibility) {
    View.VISIBLE -> "visible"
    View.INVISIBLE -> "invisible"
    else -> "gone"
  }

  companion object {
    private const val CHECK_EVERY_MS = 1500L
    private const val BLANK_CHECKS = 2
    private const val SAMPLE_W = 108
    private const val SAMPLE_H = 240
    private const val PIXEL_TOLERANCE = 6
    private const val MIN_LEAVES = 3
    private const val MIN_ALPHA = 0.01f
    private const val MAX_RECREATES = 3
    private const val MAX_DEPTH = 14
    private const val MAX_CHILDREN = 6
    private const val TEXT_CHARS = 12_000
  }
}
