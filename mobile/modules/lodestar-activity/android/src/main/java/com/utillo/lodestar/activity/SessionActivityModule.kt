package com.utillo.lodestar.activity

import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal data class Endpoint(val urls: List<String>, val token: String)

class SessionActivityModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("LodestarActivity")

    Function("enabled") {
      preferences(context).getBoolean("enabled", false) && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    AsyncFunction("start") { urls: List<String>, token: String ->
      check(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Allow notifications in Android settings to receive session alerts." }
      require(urls.isNotEmpty() && token.isNotBlank())
      val previous = endpoint
      endpoint = Endpoint(urls, token)
      try {
        ContextCompat.startForegroundService(context, Intent(context, SessionActivityService::class.java))
        preferences(context).edit().putBoolean("enabled", true).apply()
      } catch (error: Exception) {
        endpoint = previous
        throw error
      }
    }

    Function("stop") {
      disable(context)
      context.stopService(Intent(context, SessionActivityService::class.java))
    }
  }

  companion object {
    @Volatile internal var endpoint: Endpoint? = null
    private fun preferences(context: Context) = context.getSharedPreferences("session-activity", Context.MODE_PRIVATE)
    internal fun disable(context: Context) {
      endpoint = null
      preferences(context).edit().remove("enabled").apply()
    }
  }
}
