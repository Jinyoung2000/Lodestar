package com.utillo.lodestar.activity

import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal data class Endpoint(val urls: List<String>, val token: String, val relay: RelayTarget? = null) {
  val routes get() = urls.size + if (relay == null) 0 else 1
}

class SessionActivityModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("LodestarActivity")

    Function("enabled") {
      preferences(context).getBoolean("enabled", false) && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    AsyncFunction("start") { urls: List<String>, token: String ->
      require(urls.isNotEmpty() && token.isNotBlank())
      begin(Endpoint(urls, token))
    }

    AsyncFunction("startRelayed") { urls: List<String>, token: String, relayUrl: String, relayId: String, relayKey: String, relayPrivateKey: String ->
      require(token.isNotBlank())
      begin(Endpoint(urls, token, RelayTarget(relayUrl, relayId, relayKey, relayPrivateKey)))
    }

    Function("stop") {
      disable(context)
      context.stopService(Intent(context, SessionActivityService::class.java))
    }
  }

  private fun begin(next: Endpoint) {
    check(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Allow notifications in Android settings to receive session alerts." }
    val previous = endpoint
    endpoint = next
    try {
      ContextCompat.startForegroundService(context, Intent(context, SessionActivityService::class.java))
      preferences(context).edit().putBoolean("enabled", true).apply()
    } catch (error: Exception) {
      endpoint = previous
      throw error
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
