package dev.devscope

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Reports every OkHttp request/response to the DevScope web server.
 *
 * Setup (debug builds only):
 *   OkHttpClient.Builder()
 *       .addInterceptor(DevScopeInterceptor(context))   // add it LAST so it sees the final request
 *       .build()
 *
 * Transport: the server runs `adb reverse tcp:8765 tcp:8765` for each connected device,
 * so `http://localhost:8765` on the device reaches the server on your machine.
 * Emulators also work through 10.0.2.2 as a fallback.
 *
 * Requires in AndroidManifest (debug flavor): android:usesCleartextTraffic="true"
 * or a network_security_config that allows cleartext for localhost / 10.0.2.2.
 */
class DevScopeInterceptor(
    context: Context,
    private val port: Int = 8765,
    private val maxBodyBytes: Long = 512 * 1024,
) : Interceptor {

    private val appId = context.packageName

    @SuppressLint("HardwareIds")
    private val androidId: String =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""

    // Separate client without this interceptor, otherwise we'd report our own reports.
    private val reporter = OkHttpClient.Builder()
        .connectTimeout(1, TimeUnit.SECONDS)
        .writeTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()

    private val hosts = listOf("http://localhost:$port", "http://10.0.2.2:$port")
    @Volatile private var activeHost: String? = null

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.url.host == "localhost" || request.url.host == "10.0.2.2") return chain.proceed(request)

        val startedAt = System.currentTimeMillis()
        val event = JSONObject().apply {
            put("startedAt", startedAt)
            put("method", request.method)
            put("url", request.url.toString())
            put("requestHeaders", request.headers.toJson())
            put("requestBody", request.body?.readAsString())
            put("appId", appId)
            put("androidId", androidId)
            put("deviceModel", Build.MODEL)
        }

        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            event.put("durationMs", System.currentTimeMillis() - startedAt)
            event.put("error", e.toString())
            report(event)
            throw e
        }

        event.put("durationMs", System.currentTimeMillis() - startedAt)
        event.put("status", response.code)
        event.put("responseHeaders", response.headers.toJson())
        val peeked = runCatching { response.peekBody(maxBodyBytes) }.getOrNull()
        val bodyText = peeked?.let { body ->
            val type = body.contentType()?.toString() ?: ""
            if (isTextLike(type)) runCatching { body.string() }.getOrNull() else "<binary ${type}>"
        }
        event.put("responseBody", bodyText)
        event.put("responseSize", response.body?.contentLength()?.takeIf { it >= 0 } ?: peeked?.contentLength())
        report(event)
        return response
    }

    private fun report(event: JSONObject) {
        val payload = event.toString().toRequestBody("application/json".toMediaType())
        val candidates = activeHost?.let { listOf(it) } ?: hosts
        Thread {
            for (host in candidates) {
                val ok = runCatching {
                    reporter.newCall(Request.Builder().url("$host/ingest").post(payload).build())
                        .execute().use { it.isSuccessful }
                }.getOrDefault(false)
                if (ok) { activeHost = host; return@Thread }
            }
            activeHost = null
        }.start()
    }

    private fun okhttp3.Headers.toJson() = JSONObject().also { json ->
        names().forEach { json.put(it, values(it).joinToString(", ")) }
    }

    private fun okhttp3.RequestBody.readAsString(): String? = runCatching {
        if (isOneShot() || isDuplex()) return "<streamed body>"
        val type = contentType()?.toString() ?: ""
        if (!isTextLike(type)) return "<binary $type>"
        Buffer().also { writeTo(it) }.readUtf8()
    }.getOrNull()

    private fun isTextLike(type: String) =
        type.isEmpty() || type.contains("json") || type.contains("text") ||
            type.contains("xml") || type.contains("x-www-form-urlencoded") || type.contains("javascript")
}
