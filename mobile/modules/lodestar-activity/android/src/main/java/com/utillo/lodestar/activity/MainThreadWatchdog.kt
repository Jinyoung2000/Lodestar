package com.utillo.lodestar.activity

import android.app.ActivityManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.File

internal class MainThreadWatchdog(private val file: File, private val onEvent: (String) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var postedAt = 0L
  @Volatile private var pending = false
  @Volatile private var reportedAt = 0L
  private val tick = Runnable {
    val reported = reportedAt
    if (reported != 0L) {
      val stalled = SystemClock.uptimeMillis() - postedAt
      reportedAt = 0L
      onEvent("main thread answered again after ${stalled}ms")
    }
    pending = false
  }

  fun start() {
    val thread = Thread({ loop() }, "lodestar-watchdog")
    thread.isDaemon = true
    thread.start()
  }

  private fun loop() {
    var wokeAt = SystemClock.uptimeMillis()
    while (true) {
      if (!pending) {
        pending = true
        postedAt = SystemClock.uptimeMillis()
        main.post(tick)
      }
      try {
        Thread.sleep(CHECK_MS)
      } catch (_: InterruptedException) {
        return
      }
      val now = SystemClock.uptimeMillis()
      val overslept = now - wokeAt - CHECK_MS > OVERSLEEP_MS
      wokeAt = now
      if (overslept && pending) {
        postedAt = now
        continue
      }
      if (pending && reportedAt == 0L && now - postedAt >= STALL_MS && inForeground()) {
        reportedAt = now
        val text = "main thread blocked ${now - postedAt}ms\n${stacks()}".take(TEXT_CHARS) + "\n${ProcessSnapshot.memory()}\n-- own logcat tail --\n${ProcessSnapshot.ownLogcat().takeLast(LOG_TAIL_CHARS)}"
        runCatching { file.writeText(text) }
        onEvent(text)
      }
    }
  }

  private fun inForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun stacks(): String {
    val all = Thread.getAllStackTraces()
    val mainThread = Looper.getMainLooper().thread
    val picked = all.filterKeys { it === mainThread || it.name.startsWith("mqt_") || it.name.contains("hermes", ignoreCase = true) }
    return picked.entries.sortedBy { if (it.key === mainThread) 0 else 1 }.joinToString("\n\n") { (thread, frames) ->
      "thread ${thread.name} (${thread.state})\n" + frames.take(FRAMES).joinToString("\n") { "\tat $it" }
    }
  }

  companion object {
    private const val CHECK_MS = 500L
    private const val STALL_MS = 2000L
    private const val OVERSLEEP_MS = 1000L
    private const val FRAMES = 60
    private const val TEXT_CHARS = 12_000
    private const val LOG_TAIL_CHARS = 16_000
  }
}
