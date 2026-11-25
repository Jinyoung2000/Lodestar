package com.utillo.lodestar.activity

import android.app.Activity
import android.app.Application
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup

internal class BlankScreenGuard(private val onReport: (String) -> Unit) : Application.ActivityLifecycleCallbacks {
  private val main = Handler(Looper.getMainLooper())
  private val started = mutableSetOf<Activity>()
  private var recreated = 0

  fun alreadyRunning(activity: Activity?) {
    if (activity != null) started.add(activity)
  }

  override fun onActivityResumed(activity: Activity) {
    if (activity !in started) {
      started.add(activity)
      return
    }
    CHECK_DELAYS_MS.forEachIndexed { index, delay ->
      main.postDelayed({ check(activity, index == CHECK_DELAYS_MS.lastIndex) }, delay)
    }
  }

  override fun onActivityPaused(activity: Activity) {
    main.removeCallbacksAndMessages(null)
  }

  override fun onActivityDestroyed(activity: Activity) {
    started.remove(activity)
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
  override fun onActivityStarted(activity: Activity) = Unit
  override fun onActivityStopped(activity: Activity) = Unit
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  private fun check(activity: Activity, last: Boolean) {
    if (activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) return
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val shown = visibleLeaves(content)
    if (shown >= MIN_LEAVES) {
      main.removeCallbacksAndMessages(null)
      return
    }
    if (!last) return
    val healing = recreated < MAX_RECREATES
    onReport("screen blank after resume: $shown visible views${if (healing) "; recreating the activity" else ""}\n${tree(content, 0)}".take(TEXT_CHARS))
    if (healing) {
      recreated++
      activity.recreate()
    }
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
    private val CHECK_DELAYS_MS = listOf(1500L, 3000L)
    private const val MIN_LEAVES = 3
    private const val MIN_ALPHA = 0.01f
    private const val MAX_RECREATES = 3
    private const val MAX_DEPTH = 14
    private const val MAX_CHILDREN = 6
    private const val TEXT_CHARS = 12_000
  }
}
