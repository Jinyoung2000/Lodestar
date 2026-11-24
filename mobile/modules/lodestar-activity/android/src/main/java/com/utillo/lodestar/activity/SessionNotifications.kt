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
import android.graphics.Typeface
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat

internal data class Session(val id: String, val title: String, val status: String, val unread: Boolean)

private enum class LiveState(val label: String, val count: String) {
  WAITING("Needs reply", "waiting"),
  ERROR("Error", "failed"),
  RUNNING("Working", "working"),
  FINISHED("Finished", "finished"),
}

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

  private fun builder(channel: String, title: String, text: CharSequence, id: String?) =
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
    val shown = if (connected) sessions.mapNotNull { session -> liveState(session)?.let { session to it } }.sortedBy { it.second.ordinal } else emptyList()
    val promoted = shown.any { it.second == LiveState.WAITING || it.second == LiveState.RUNNING }
    val lines = shown.take(MAX_LINES).map { (session, state) -> entry(state, session.title, detail(session, state, activity, questions)) }
    val title = if (shown.isEmpty()) "Lodestar" else LiveState.entries.mapNotNull { state ->
      shown.count { it.second == state }.takeIf { it > 0 }?.let { "$it ${state.count}" }
    }.joinToString(" · ")
    val collapsed = when {
      !connected -> "Reconnecting to your Mac"
      shown.isEmpty() -> "Listening for questions and results"
      else -> lines.first()
    }
    val notification = builder(LIVE, title, collapsed, shown.singleOrNull()?.first?.id)
      .setOnlyAlertOnce(true).setOngoing(true).setShowWhen(false)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    if (shown.isNotEmpty()) {
      val body = SpannableStringBuilder()
      lines.forEachIndexed { index, line -> if (index > 0) body.append("\n"); body.append(line) }
      if (shown.size > MAX_LINES) body.append("\n+${shown.size - MAX_LINES} more")
      notification.setStyle(NotificationCompat.BigTextStyle().bigText(body))
    }
    if (promoted) {
      notification.setRequestPromotedOngoing(true)
      notification.setShortCriticalText(if (shown.any { it.second == LiveState.WAITING }) "Reply" else "Working")
    }
    return notification.build()
  }

  private fun liveState(session: Session) = when {
    session.status == "waiting" -> LiveState.WAITING
    session.status == "error" && session.unread -> LiveState.ERROR
    session.status == "running" -> LiveState.RUNNING
    session.status == "idle" && session.unread -> LiveState.FINISHED
    else -> null
  }

  private fun detail(session: Session, state: LiveState, activity: Map<String, String>, questions: Map<String, String>) = when (state) {
    LiveState.WAITING -> questions[session.id] ?: "Needs your reply"
    LiveState.ERROR -> "Stopped with an error"
    LiveState.RUNNING, LiveState.FINISHED -> activity[session.id].orEmpty()
  }

  private fun entry(state: LiveState, title: String, doing: String): CharSequence {
    val room = if (doing.isEmpty()) TITLE_ALONE_CHARS else TITLE_CHARS
    val name = if (title.length > room) title.take(room - 1).trimEnd() + "…" else title
    return SpannableStringBuilder().apply {
      append(state.label)
      append(" · ")
      append(name, StyleSpan(Typeface.BOLD), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if (doing.isNotEmpty()) append("  $doing")
    }
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
    private const val TITLE_CHARS = 18
    private const val TITLE_ALONE_CHARS = 40
    private const val MAX_LINES = 6
    const val LIVE_ID = 1
  }
}
