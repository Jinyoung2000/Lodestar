package com.utillo.lodestar.activity

import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import androidx.core.view.WindowCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WindowSettingsModule : Module() {
  private var observingContext: Context? = null
  private val callbacks = object : ComponentCallbacks {
    override fun onConfigurationChanged(newConfig: Configuration) {
      sendEvent("fontScaleChanged")
    }

    override fun onLowMemory() = Unit
  }

  private fun stopObserving() {
    observingContext?.unregisterComponentCallbacks(callbacks)
    observingContext = null
  }

  override fun definition() = ModuleDefinition {
    Name("LodestarWindowSettings")
    Events("fontScaleChanged")

    Function("fontScale") {
      requireNotNull(appContext.reactContext).resources.configuration.fontScale.toDouble()
    }

    AsyncFunction("setNavigationBarStyle") { lightBackground: Boolean ->
      val window = appContext.currentActivity?.window ?: return@AsyncFunction
      if (Build.VERSION.SDK_INT < 35) window.navigationBarColor = Color.TRANSPARENT
      if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
      WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = lightBackground
    }.runOnQueue(Queues.MAIN)

    OnStartObserving {
      observingContext = appContext.reactContext?.applicationContext
      observingContext?.registerComponentCallbacks(callbacks)
    }
    OnStopObserving { stopObserving() }
    OnDestroy { stopObserving() }
  }
}
