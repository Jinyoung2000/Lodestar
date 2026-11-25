package com.utillo.lodestar.activity

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal object NativeUpload {
  private const val PREFS = "diag-upload"
  private const val MAX_BYTES = 560_000
  private val client by lazy {
    OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
  }

  fun configure(context: Context, url: String, fields: Map<String, String>, device: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString("url", url).putString("fields", JSONObject(fields).toString()).putString("device", device).apply()
  }

  fun send(context: Context, name: String, text: String): String? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val url = prefs.getString("url", null) ?: return null
    val fields = JSONObject(prefs.getString("fields", null) ?: return null)
    val key = "phone-logs/${prefs.getString("device", null) ?: "unknown"}/$name"
    val bytes = text.toByteArray()
    val kept = if (bytes.size > MAX_BYTES) bytes.copyOfRange(bytes.size - MAX_BYTES, bytes.size) else bytes
    val form = MultipartBody.Builder().setType(MultipartBody.FORM)
    for (field in fields.keys()) form.addFormDataPart(field, if (field == "key") key else fields.getString(field))
    form.addFormDataPart("file", "log.txt", kept.toRequestBody("text/plain; charset=utf-8".toMediaType()))
    return runCatching {
      client.newCall(Request.Builder().url(url).post(form.build()).build()).execute().use { response -> if (response.isSuccessful) key else null }
    }.getOrNull()
  }
}
