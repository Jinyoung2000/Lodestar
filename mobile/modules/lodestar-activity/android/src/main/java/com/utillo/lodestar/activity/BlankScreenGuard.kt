package com.utillo.lodestar.activity

import android.app.Activity
import android.app.Application
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal class BlankScreenGuard(private val upload: (String, String) -> String?, private val onReport: (String) -> Unit) : Application.ActivityLifecycleCallbacks {
  private val main = Handler(Looper.getMainLooper())
  private val armed = mutableSetOf<Activity>()
  private var watched: Activity? = null
  private var blankChecks = 0
  private val recreatedAt = ArrayDeque<Long>()
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
    val leaves = visibleLeaves(content, MIN_LEAVES)
    if (leaves >= MIN_LEAVES) {
      armed.add(activity)
      blankChecks = 0
      return
    }
    judge(activity, content, "$leaves visible views")
  }

  private fun judge(activity: Activity, content: ViewGroup, finding: String) {
    if (activity !in armed) return
    blankChecks++
    if (blankChecks < BLANK_CHECKS) return
    blankChecks = 0
    val now = SystemClock.uptimeMillis()
    while (recreatedAt.isNotEmpty() && now - recreatedAt.first() > RECREATE_WINDOW_MS) recreatedAt.removeFirst()
    val healing = recreatedAt.size < MAX_RECREATES
    val summary = "screen blank: $finding${if (healing) "; recreating the activity" else ""}\n${ProcessSnapshot.memory()}\n${tree(content, 0)}".take(TEXT_CHARS)
    val name = "${SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss-SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())}-native-blank.txt"
    Thread({
      val log = ProcessSnapshot.ownLogcat()
      val uploaded = upload(name, "[crash] native blank screen report\n$summary\n-- own logcat --\n$log")
      onReport("$summary\nfull report: ${uploaded ?: "not uploaded"}\n-- own logcat tail --\n${log.takeLast(TAIL_CHARS)}")
    }, "lodestar-blank-report").start()
    if (healing) {
      recreatedAt.addLast(now)
      armed.remove(activity)
      activity.recreate()
    }
  }

  private fun visibleLeaves(view: View, enough: Int): Int {
    if (!view.isShown || view.alpha < MIN_ALPHA || !view.getGlobalVisibleRect(Rect())) return 0
    if (view !is ViewGroup || view.childCount == 0) return 1
    var count = 0
    for (i in 0 until view.childCount) {
      count += visibleLeaves(view.getChildAt(i), enough - count)
      if (count >= enough) return count
    }
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
    private const val CHECK_EVERY_MS = 500L
    private const val RECREATE_WINDOW_MS = 60_000L
    private const val TAIL_CHARS = 16_000
    private const val BLANK_CHECKS = 2
    private const val MIN_LEAVES = 3
    private const val MIN_ALPHA = 0.01f
    private const val MAX_RECREATES = 3
    private const val MAX_DEPTH = 14
    private const val MAX_CHILDREN = 6
    private const val TEXT_CHARS = 12_000
  }
}
