package com.utillo.lodestar.activity

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Debug
import android.os.Process

internal object ProcessSnapshot {
  private const val LOG_LINES = 600
  private const val LOG_CHARS = 24_000

  fun memory(): String {
    val runtime = Runtime.getRuntime()
    val info = Debug.MemoryInfo()
    Debug.getMemoryInfo(info)
    val stats = listOf("summary.total-pss", "summary.java-heap", "summary.native-heap", "summary.graphics", "summary.code", "summary.stack", "summary.private-other")
      .joinToString(" ") { key -> "${key.removePrefix("summary.")}=${info.getMemoryStat(key) ?: "?"}KB" }
    val javaUsed = (runtime.totalMemory() - runtime.freeMemory()) / 1024
    return "$stats javaUsed=${javaUsed}KB javaMax=${runtime.maxMemory() / 1024}KB nativeAllocated=${Debug.getNativeHeapAllocatedSize() / 1024}KB threads=${Thread.activeCount()}"
  }

  fun ownLogcat(): String = runCatching {
    val process = ProcessBuilder("logcat", "-d", "-t", LOG_LINES.toString(), "--pid", Process.myPid().toString(), "-v", "time", "ReactNativeJS:S", "*:I")
      .redirectErrorStream(true).start()
    val text = process.inputStream.bufferedReader().use { it.readText() }
    process.waitFor()
    text.takeLast(LOG_CHARS)
  }.getOrElse { "logcat unreadable: ${it.message}" }

  fun pressureWatcher(report: (String) -> Unit) = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) = report("trim memory level $level ${memory()}")
    override fun onConfigurationChanged(newConfig: Configuration) = Unit
    @Deprecated("Deprecated in Java")
    override fun onLowMemory() = report("low memory ${memory()}")
  }
}
