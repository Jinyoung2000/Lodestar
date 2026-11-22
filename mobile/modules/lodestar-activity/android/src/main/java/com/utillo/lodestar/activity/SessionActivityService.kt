package com.utillo.lodestar.activity

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SessionActivityService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS)
    .pingInterval(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
  private val questions = mutableMapOf<String, String>()
  private val sessions = linkedMapOf<String, Session>()
  private lateinit var notifications: SessionNotifications
  private var endpoint: Endpoint? = null
  private var socket: WebSocket? = null
  private var connected = false
  private var host = 0
  private var failures = 0

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
      endpoint = next
      host = 0
      failures = 0
      connect(next)
    }
    return START_NOT_STICKY
  }

  private fun showLive() {
    startForeground(SessionNotifications.LIVE_ID, notifications.live(sessions.values, connected))
  }

  private fun connect(target: Endpoint) {
    val request = Request.Builder().url(target.urls[host]).build()
    socket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        webSocket.send(JSONObject().put("auth", target.token).put("feed", "activity").toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (text.startsWith("{\"event\":{\"type\":\"timeline") && !text.take(768).contains("\"kind\":\"permission\"")) return
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        handler.post { if (webSocket === socket) receive(webSocket, frame) }
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

  private fun receive(ws: WebSocket, frame: JSONObject) {
    if (frame.has("ready")) {
      ws.send("""{"id":1,"method":"agents.list","params":{}}""")
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
      showLive()
      return
    }
    val event = frame.optJSONObject("event") ?: return
    when (event.optString("type")) {
      "agent" -> {
        val agent = event.optJSONObject("agent") ?: return
        if (update(agent, connected)) showLive()
      }
      "timelineUpsert" -> {
        val item = event.optJSONObject("item") ?: return
        if (item.optString("kind") != "permission" || item.optString("status") != "pending") return
        val question = item.optJSONObject("input")?.optJSONArray("questions")?.optJSONObject(0)?.optString("question")?.take(400)
        if (question.isNullOrBlank()) return
        val id = event.optString("agentId")
        if (questions.put(id, question) != question && connected) sessions[id]?.takeIf { it.status == "waiting" }?.let { notifications.alert(it, question) }
      }
      "agentRemoved" -> if (remove(event.optString("agentId"))) showLive()
    }
  }

  private fun remove(id: String): Boolean {
    if (sessions.remove(id) == null) return false
    notifications.dismiss(id)
    questions.remove(id)
    return true
  }

  private fun update(agent: JSONObject, announceNew: Boolean): Boolean {
    val id = agent.optString("id")
    if (id.isEmpty()) return false
    if (agent.optBoolean("done")) return remove(id)
    val next = Session(id, agent.optString("title").ifBlank { "Session" }, agent.optString("status"))
    val previous = sessions.put(id, next)
    if (next == previous) return false
    if (next.status != previous?.status) {
      if (previous?.status == "waiting" && next.status != "waiting") questions.remove(id)
      if (next.status == "running") notifications.dismiss(id)
      val finished = next.status == "idle" && (previous?.status == "running" || previous?.status == "waiting")
      val needsAction = next.status in listOf("waiting", "error") && (previous != null || announceNew)
      if (finished || needsAction) notifications.alert(next, if (next.status == "waiting") questions[id] else null)
    }
    return true
  }

  private fun lost(ws: WebSocket, code: Int) {
    if (socket !== ws) return
    clearSocket()
    if (code == 4401 || code == 4001) {
      SessionActivityModule.disable(this)
      stopSelf()
      return
    }
    val target = endpoint ?: return
    showLive()
    host = (host + 1) % target.urls.size
    failures++
    val pause = if (failures < target.urls.size) 100L else minOf(30000L, 1000L shl minOf(failures - 1, 5))
    handler.postDelayed({ if (endpoint === target) connect(target) }, pause)
  }

  private fun clearSocket() {
    handler.removeCallbacksAndMessages(null)
    socket?.cancel()
    socket = null
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
}
