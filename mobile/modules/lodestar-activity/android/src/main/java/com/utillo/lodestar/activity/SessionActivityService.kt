package com.utillo.lodestar.activity

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SessionActivityService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS)
    .pingInterval(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
  private val questions = mutableMapOf<String, String>()
  private val activity = mutableMapOf<String, String>()
  private var liveDueAt = 0L
  private var liveShownAt = 0L
  private val liveTask = Runnable { showLive() }
  private val sessions = linkedMapOf<String, Session>()
  private lateinit var notifications: SessionNotifications
  private var endpoint: Endpoint? = null
  private var socket: WebSocket? = null
  private var session: RelaySession? = null
  private var connected = false
  private var host = 0
  private var failures = 0
  private var droppedAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    notifications = SessionNotifications(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    showLive()
    val next = SessionActivityModule.endpoint
    if (next == null) {
      stopSelf()
    } else if (next != endpoint) {
      clearSocket()
      sessions.keys.forEach(notifications::dismiss)
      sessions.clear()
      questions.clear()
      activity.clear()
      endpoint = next
      host = 0
      failures = 0
      connect(next)
    }
    return START_NOT_STICKY
  }

  private fun showLive() {
    handler.removeCallbacks(liveTask)
    liveDueAt = 0L
    liveShownAt = SystemClock.uptimeMillis()
    startForeground(SessionNotifications.LIVE_ID, notifications.live(sessions.values, connected, activity, questions))
  }

  private fun queueLive(wait: Long = 0L) {
    val due = maxOf(SystemClock.uptimeMillis() + wait, liveShownAt + LIVE_MIN_GAP_MS)
    if (liveDueAt != 0L && liveDueAt <= due) return
    handler.removeCallbacks(liveTask)
    liveDueAt = due
    handler.postAtTime(liveTask, due)
  }

  private fun connect(target: Endpoint) {
    val relay = target.relay?.takeIf { host >= target.urls.size }
    val handshake = relay?.let { runCatching { RelayHandshake(it) }.getOrNull() }
    val auth = JSONObject().put("auth", target.token).put("feed", "activity").toString()
    val request = Request.Builder().url(relay?.clientUrl ?: target.urls[host]).build()
    socket = client.newWebSocket(request, object : WebSocketListener() {
      private var sealed: RelaySession? = null

      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (relay == null) webSocket.send(auth)
        else if (handshake == null) fail(webSocket)
        else webSocket.send(handshake.first(RELAY_HELLO.toByteArray()).toByteString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (relay == null) read(webSocket, text)
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (handshake == null) return
        val opened = sealed
        if (opened != null) {
          runCatching { String(opened.open(bytes.toByteArray())) }.onSuccess { read(webSocket, it) }.onFailure { fail(webSocket) }
          return
        }
        val welcome = runCatching { handshake.second(bytes.toByteArray()) }.getOrNull() ?: return fail(webSocket)
        val reply = runCatching { JSONObject(String(welcome.first)) }.getOrNull()
        if (reply?.optBoolean("ok") != true) return fail(webSocket, if (reply?.optString("error") == "bad token") 4401 else 0)
        sealed = welcome.second
        handler.post { if (webSocket === socket) session = welcome.second }
        webSocket.send(welcome.second.seal(auth.toByteArray()).toByteString())
      }

      private fun read(webSocket: WebSocket, text: String) {
        if (text.startsWith("{\"event\":{\"type\":\"timeline") && !text.take(768).contains("\"kind\":\"permission\"")) return
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        handler.post { if (webSocket === socket) receive(webSocket, frame) }
      }

      private fun fail(webSocket: WebSocket, code: Int = 0) {
        webSocket.cancel()
        handler.post { lost(webSocket, code) }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
        handler.post { lost(webSocket, code) }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        handler.post { lost(webSocket, 0) }
      }
    })
  }

  private fun say(ws: WebSocket, text: String) {
    val sealed = session
    if (sealed == null) ws.send(text) else ws.send(sealed.seal(text.toByteArray()).toByteString())
  }

  private fun receive(ws: WebSocket, frame: JSONObject) {
    if (frame.has("ready")) {
      say(ws, """{"id":1,"method":"agents.list","params":{}}""")
      return
    }
    if (frame.optInt("id") == 1) {
      val list = frame.optJSONArray("result") ?: return
      val present = mutableSetOf<String>()
      for (i in 0 until list.length()) {
        val agent = list.optJSONObject(i) ?: continue
        present.add(agent.optString("id"))
        update(agent, false)
      }
      (sessions.keys - present).forEach(::remove)
      connected = true
      failures = 0
      droppedAt = 0L
      queueLive()
      return
    }
    val event = frame.optJSONObject("event") ?: return
    when (event.optString("type")) {
      "agent" -> {
        val agent = event.optJSONObject("agent") ?: return
        if (update(agent, connected)) queueLive()
      }
      "timelineUpsert" -> {
        val item = event.optJSONObject("item") ?: return
        if (item.optString("kind") != "permission" || item.optString("status") != "pending") return
        val question = item.optJSONObject("input")?.optJSONArray("questions")?.optJSONObject(0)?.optString("question")?.take(400)
        if (question.isNullOrBlank()) return
        val id = event.optString("agentId")
        if (questions.put(id, question) != question && connected) sessions[id]?.takeIf { it.status == "waiting" }?.let { notifications.alert(it, question) }
        if (connected) queueLive()
      }
      "agentRemoved" -> if (remove(event.optString("agentId"))) queueLive()
      "activity" -> {
        val id = event.optString("agentId")
        val text = event.optString("text").take(120)
        if (text.isBlank() || activity[id] == text) return
        activity[id] = text
        if (sessions[id]?.status == "running") queueLive(LIVE_REFRESH_MS)
      }
    }
  }

  private fun remove(id: String): Boolean {
    if (sessions.remove(id) == null) return false
    notifications.dismiss(id)
    questions.remove(id)
    activity.remove(id)
    return true
  }

  private fun update(agent: JSONObject, announceNew: Boolean): Boolean {
    val id = agent.optString("id")
    if (id.isEmpty()) return false
    if (agent.optBoolean("done")) return remove(id)
    val next = Session(id, agent.optString("title").ifBlank { "Session" }, agent.optString("status"), agent.optBoolean("unread"))
    val previous = sessions.put(id, next)
    if (next == previous) return false
    if (previous?.unread == true && !next.unread && next.status != "waiting") notifications.dismiss(id)
    if (next.status != previous?.status) {
      if (previous?.status == "waiting" && next.status != "waiting") questions.remove(id)
      if (next.status == "running") notifications.dismiss(id)
      val finished = next.status == "idle" && (previous?.status == "running" || previous?.status == "waiting")
      val needsAction = next.status in listOf("waiting", "error") && (previous != null || announceNew)
      if (finished || needsAction) notifications.alert(next, if (next.status == "waiting") questions[id] else null, activity[id])
    }
    return true
  }

  private fun lost(ws: WebSocket, code: Int) {
    if (socket !== ws) return
    val wasConnected = connected
    clearSocket()
    if (code == 4401 || code == 4001) {
      SessionActivityModule.disable(this)
      stopSelf()
      return
    }
    val target = endpoint ?: return
    if (wasConnected) droppedAt = SystemClock.uptimeMillis()
    queueLive(maxOf(0L, droppedAt + RECONNECT_GRACE_MS - SystemClock.uptimeMillis()))
    if (!wasConnected) host = (host + 1) % target.routes
    failures++
    val pause = if (wasConnected || failures < target.routes) 100L else minOf(30000L, 1000L shl minOf(failures - 1, 5))
    handler.postDelayed({ if (endpoint === target) connect(target) }, pause)
  }

  private fun clearSocket() {
    handler.removeCallbacksAndMessages(null)
    liveDueAt = 0L
    socket?.cancel()
    socket = null
    session = null
    connected = false
  }

  override fun onDestroy() {
    clearSocket()
    endpoint = null
    sessions.keys.forEach(notifications::dismiss)
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
    super.onDestroy()
  }

  companion object {
    private const val LIVE_REFRESH_MS = 1500L
    private const val LIVE_MIN_GAP_MS = 400L
    private const val RECONNECT_GRACE_MS = 5000L
    private const val RELAY_HELLO = """{"v":1,"kind":"ws"}"""
  }
}
