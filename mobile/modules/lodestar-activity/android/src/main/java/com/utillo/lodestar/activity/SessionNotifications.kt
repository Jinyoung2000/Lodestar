package com.utillo.lodestar.activity

import android.app.ActivityManager
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

  fun live(sessions: Collection<Session>, connected: Boolean, activity: Map<String, String>, questions: Map<String, String>): Notification {
    val waiting = sessions.filter { it.status == "waiting" }
    val running = sessions.filter { it.status == "running" }
    val active = waiting + running
    val lead = active.firstOrNull()
    val line = { session: Session -> if (session.status == "waiting") questions[session.id] ?: "Needs your reply" else activity[session.id] ?: "Working" }
    val title = when {
      !connected -> "Lodestar"
      lead == null -> "Lodestar"
      active.size == 1 -> lead.title
      else -> listOfNotNull(
        if (running.isNotEmpty()) "${running.size} running" else null,
        if (waiting.isNotEmpty()) "${waiting.size} waiting" else null,
      ).joinToString(" · ")
    }
    val detail = when {
      !connected -> "Reconnecting to your Mac"
      lead == null -> "Listening for questions and results"
      active.size == 1 -> line(lead)
      else -> "${lead.title} · ${line(lead)}"
    }
    val notification = builder(LIVE, title, detail, if (connected) lead?.id else null)
      .setOnlyAlertOnce(true).setOngoing(true).setShowWhen(false)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    if (connected && active.size > 1) {
      val inbox = NotificationCompat.InboxStyle().setBigContentTitle(title)
      active.take(5).forEach { inbox.addLine("${it.title} · ${line(it)}") }
      if (active.size > 5) inbox.setSummaryText("+${active.size - 5} more")
      notification.setStyle(inbox)
    } else if (connected && lead != null) {
      notification.setStyle(NotificationCompat.BigTextStyle().bigText(detail))
    }
    if (connected && lead != null) {
      notification.setRequestPromotedOngoing(true)
      notification.setShortCriticalText(if (waiting.isNotEmpty()) "Reply" else "Running")
    }
    return notification.build()
  }

  private fun appOnScreen(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  fun alert(session: Session, question: String? = null, summary: String? = null) {
    if (appOnScreen()) return
    val text = when (session.status) {
      "waiting" -> question ?: "Needs your reply"
      "idle" -> summary ?: "Finished"
      "error" -> "Stopped with an error"
      else -> return
    }
    manager.notify(session.id, ALERT_ID, builder(ALERT, session.title, text, session.id)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text)).setOnlyAlertOnce(true)
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
