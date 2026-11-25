package com.utillo.lodestar.activity

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ExitReasonsModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext).applicationContext

  override fun definition() = ModuleDefinition {
    Name("LodestarExitReasons")

    Events("mainThreadStall")

    OnCreate {
      installJavaCrashRecorder(context)
      stallListener = { text -> runCatching { sendEvent("mainThreadStall", mapOf("text" to text)) } }
      startWatchdog(context)
    }

    OnDestroy { stallListener = null }

    Function("clearStall") { stallFile(context).delete() }

    Function("takeRecent") {
      val found = mutableListOf<Map<String, Any?>>()
      takeJavaCrash(context)?.let { found.add(mapOf("source" to "java", "trace" to it)) }
      takeFile(stallFile(context))?.let { found.add(mapOf("source" to "watchdog", "trace" to it)) }
      found.addAll(takeExitInfo(context))
      found
    }
  }

  companion object {
    private const val PREFS = "exit-reasons"
    private const val SEEN_KEY = "seenUntil"
    private const val TRACE_CHARS = 12_000
    @Volatile private var installed = false
    @Volatile private var watching = false
    @Volatile private var stallListener: ((String) -> Unit)? = null

    private fun stallFile(context: Context) = File(context.filesDir, "last-main-thread-stall.txt")

    private fun startWatchdog(context: Context) {
      if (watching) return
      watching = true
      MainThreadWatchdog(stallFile(context)) { text -> stallListener?.invoke(text) }.start()
    }

    private fun takeFile(file: File): String? {
      if (!file.exists()) return null
      val text = runCatching { file.readText() }.getOrNull()
      file.delete()
      return text
    }

    private fun crashFile(context: Context) = File(context.filesDir, "last-java-crash.txt")

    private fun installJavaCrashRecorder(context: Context) {
      if (installed) return
      installed = true
      val file = crashFile(context)
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        runCatching { file.writeText("thread ${thread.name}\n${error.stackTraceToString()}".take(TRACE_CHARS)) }
        previous?.uncaughtException(thread, error)
      }
    }

    private fun takeJavaCrash(context: Context) = takeFile(crashFile(context))

    private fun takeExitInfo(context: Context): List<Map<String, Any?>> {
      if (Build.VERSION.SDK_INT < 30) return emptyList()
      val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val seenUntil = prefs.getLong(SEEN_KEY, 0L)
      val exits = runCatching { manager.getHistoricalProcessExitReasons(context.packageName, 0, 8) }.getOrDefault(emptyList())
      val fresh = exits.filter { it.timestamp > seenUntil }
      exits.maxOfOrNull { it.timestamp }?.let { prefs.edit().putLong(SEEN_KEY, maxOf(it, seenUntil)).apply() }
      return fresh.map { exit ->
        mapOf(
          "source" to "system",
          "at" to exit.timestamp.toDouble(),
          "reason" to reasonName(exit.reason),
          "status" to exit.status,
          "importance" to exit.importance,
          "description" to exit.description,
          "pssKb" to exit.pss.toDouble(),
          "rssKb" to exit.rss.toDouble(),
          "process" to exit.processName,
          "trace" to traceOf(exit),
        )
      }
    }

    private fun traceOf(exit: ApplicationExitInfo): String? {
      if (exit.reason != ApplicationExitInfo.REASON_ANR && exit.reason != ApplicationExitInfo.REASON_CRASH_NATIVE) return null
      val bytes = runCatching { exit.traceInputStream?.use { it.readBytes() } }.getOrNull() ?: return null
      val text = if (exit.reason == ApplicationExitInfo.REASON_ANR) String(bytes) else readableRuns(bytes)
      return text.take(TRACE_CHARS)
    }

    private fun readableRuns(bytes: ByteArray): String {
      val runs = mutableListOf<String>()
      val current = StringBuilder()
      for (byte in bytes) {
        val char = byte.toInt() and 0xff
        if (char in 0x20..0x7e) current.append(char.toChar())
        else {
          if (current.length >= 6) runs.add(current.toString())
          current.setLength(0)
        }
      }
      if (current.length >= 6) runs.add(current.toString())
      return runs.joinToString("\n")
    }

    private fun reasonName(reason: Int) = when (reason) {
      ApplicationExitInfo.REASON_ANR -> "anr"
      ApplicationExitInfo.REASON_CRASH -> "crash"
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
      ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency died"
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource usage"
      ApplicationExitInfo.REASON_EXIT_SELF -> "exit self"
      ApplicationExitInfo.REASON_FREEZER -> "freezer"
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization failure"
      ApplicationExitInfo.REASON_LOW_MEMORY -> "low memory"
      ApplicationExitInfo.REASON_OTHER -> "other"
      ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package state change"
      ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package updated"
      ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission change"
      ApplicationExitInfo.REASON_SIGNALED -> "signaled"
      ApplicationExitInfo.REASON_USER_REQUESTED -> "user requested"
      ApplicationExitInfo.REASON_USER_STOPPED -> "user stopped"
      else -> "reason $reason"
    }
  }
}
