package com.utillo.lodestar.activity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.res.Resources
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat

internal data class Session(val id: String, val title: String, val status: String)

internal class SessionNotifications(private val context: Context) {
  private val manager = context.getSystemService(NotificationManager::class.java)

  init {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(LIVE, "Live session status", NotificationManager.IMPORTANCE_LOW))
      manager.createNotificationChannel(NotificationChannel(ALERT, "Questions and results", NotificationManager.IMPORTANCE_HIGH))
    }
  }

  private fun open(id: String?): PendingIntent {
    val uri = Uri.Builder().scheme("lodestar").authority(if (id == null) "" else "session")
    if (id != null) uri.appendPath(id) else uri.path("/")
    val intent = Intent(Intent.ACTION_VIEW, uri.build()).setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun builder(channel: String, title: String, text: String, id: String?) =
    NotificationCompat.Builder(context, channel)
      .setPriority(if (channel == LIVE) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(R.drawable.ic_session_star)
      .setColor(notificationAccent())
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(open(id))

  private fun notificationAccent(): Int {
    val nightMode = Resources.getSystem().configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    val systemConfig = Configuration().apply { uiMode = nightMode }
    return context.createConfigurationContext(systemConfig).getColor(R.color.session_notification_accent)
  }

  fun live(sessions: Collection<Session>, connected: Boolean): Notification {
    val waiting = sessions.filter { it.status == "waiting" }
    val running = sessions.filter { it.status == "running" }
    val lead = waiting.firstOrNull() ?: running.firstOrNull()
    val title = when {
      !connected -> "Connecting to your Mac"
      waiting.isNotEmpty() -> if (waiting.size == 1) "Waiting for your reply" else "${waiting.size} sessions need a reply"
      running.isNotEmpty() -> if (running.size == 1) "Session in progress" else "${running.size} sessions in progress"
      else -> "Session alerts are on"
    }
    val detail = when {
      !connected -> "Reconnecting to Lodestar"
      lead != null -> lead.title
      else -> "Listening for questions and results"
    }
    val notification = builder(LIVE, title, detail, if (connected) lead?.id else null)
      .setOnlyAlertOnce(true).setOngoing(true).setShowWhen(false)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    if (connected && lead != null) {
      notification.setRequestPromotedOngoing(true)
      notification.setShortCriticalText(if (waiting.isNotEmpty()) "Reply" else "Running")
    }
    return notification.build()
  }

  fun alert(session: Session, question: String? = null) {
    val title = when (session.status) {
      "waiting" -> "Your reply is needed"
      "idle" -> "Session finished"
      "error" -> "Session needs attention"
      else -> return
    }
    manager.notify(session.id, ALERT_ID, builder(ALERT, if (question == null) title else session.title, question ?: session.title, session.id)
      .setStyle(NotificationCompat.BigTextStyle().bigText(question ?: session.title)).setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS).setAutoCancel(true).build())
  }

  fun dismiss(id: String) = manager.cancel(id, ALERT_ID)

  companion object {
    private const val LIVE = "session-live"
    private const val ALERT = "session-alerts"
    private const val ALERT_ID = 2
    const val LIVE_ID = 1
  }
}
