package dev.devscope

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.TextView
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Debug-only. Keeps a WebSocket to the DevScope server (`/agent`, through the same
 * `adb reverse` tunnel as the network interceptor) and answers layout-dump requests
 * with the current view hierarchy, including the Compose semantics tree of every
 * ComposeView it finds. With Live on in the UI it also re-sends the tree after
 * every layout pass of the resumed activity.
 *
 * Setup (debug builds only, once):
 *   if (BuildConfig.DEBUG) DevScopeLayoutAgent.start(context)
 *
 * Needs the same cleartext allowance for localhost / 10.0.2.2 as the interceptor.
 */
object DevScopeLayoutAgent {

    private const val PORT = 8765
    private val hosts = listOf("ws://localhost:$PORT/agent", "ws://10.0.2.2:$PORT/agent")

    private val started = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())
    private var currentActivity = WeakReference<Activity>(null)
    private var hostIndex = 0
    private var appId = ""
    private var androidId = ""

    // Live mode: while a browser watches the Layout page, every layout pass of the
    // resumed activity re-sends the tree (debounced so scrolling doesn't flood).
    @Volatile private var socket: WebSocket? = null
    @Volatile private var watching = false
    private var watchSerial = ""
    private var watchedRoot: View? = null
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { scheduleDump() }
    private val dumpRunnable = Runnable { socket?.let { dump(it, watchSerial) } }

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    @SuppressLint("HardwareIds")
    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val app = context.applicationContext as? Application
        if (app == null) {
            Log.w("DevScope", "layout agent: applicationContext is not an Application (${context.applicationContext?.javaClass?.name})")
            return
        }
        appId = context.packageName
        androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                currentActivity = WeakReference(activity)
                if (watching) attachWatcher()
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        connect()
    }

    private fun connect() {
        val url = hosts[hostIndex % hosts.size]
        client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i("DevScope", "layout agent connected via $url")
                socket = webSocket
                webSocket.send(
                    JSONObject().put("type", "hello").put("androidId", androidId).put("appId", appId).toString()
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (msg.optString("type")) {
                    "layout.dump" -> main.post { dump(webSocket, msg.optString("serial")) }
                    "layout.watch" -> main.post {
                        watching = msg.optBoolean("on")
                        watchSerial = msg.optString("serial")
                        if (watching) attachWatcher() else detachWatcher()
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("DevScope", "layout agent failed on $url: $t")
                retry()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
        })
    }

    private fun retry() {
        socket = null
        watching = false
        main.post { detachWatcher() }
        hostIndex++
        main.postDelayed({ connect() }, 5000)
    }

    private fun scheduleDump() {
        main.removeCallbacks(dumpRunnable)
        main.postDelayed(dumpRunnable, 400)
    }

    private fun attachWatcher() {
        val root = currentActivity.get()?.window?.decorView
        if (root === watchedRoot) return
        detachWatcher()
        watchedRoot = root
        root?.viewTreeObserver?.addOnGlobalLayoutListener(layoutListener)
        scheduleDump()
    }

    private fun detachWatcher() {
        main.removeCallbacks(dumpRunnable)
        watchedRoot?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnGlobalLayoutListener(layoutListener)
        watchedRoot = null
    }

    private fun dump(socket: WebSocket, serial: String) {
        val activity = currentActivity.get()
        val root = activity?.window?.decorView
        if (root == null) {
            socket.send(
                JSONObject().put("type", "layout.error").put("serial", serial)
                    .put("error", "No resumed activity in $appId.").toString()
            )
            return
        }
        val tree = runCatching { dumpView(root) }
            .getOrElse { JSONObject().put("kind", "view").put("type", "error").put("text", it.toString()) }
        socket.send(
            JSONObject().put("type", "layout.tree").put("serial", serial)
                .put("activity", activity.javaClass.simpleName).put("tree", tree).toString()
        )
    }

    private fun dumpView(v: View): JSONObject {
        val loc = IntArray(2).also(v::getLocationOnScreen)
        val o = JSONObject()
        o.put("kind", "view")
        o.put("type", v.javaClass.simpleName)
        if (v.id != View.NO_ID) runCatching { o.put("id", v.resources.getResourceEntryName(v.id)) }
        (v as? TextView)?.text?.takeIf { it.isNotEmpty() }?.let { o.put("text", it.toString().take(120)) }
        v.contentDescription?.takeIf { it.isNotEmpty() }?.let { o.put("desc", it.toString().take(120)) }
        o.put("bounds", JSONArray(listOf(loc[0], loc[1], v.width, v.height)))
        if (v.visibility != View.VISIBLE) o.put("hidden", true)
        val children = JSONArray()
        composeTree(v)?.let { children.put(it) }
        if (v is ViewGroup) for (i in 0 until v.childCount) children.put(dumpView(v.getChildAt(i)))
        if (children.length() > 0) o.put("children", children)
        return o
    }

    private fun composeTree(v: View): JSONObject? =
        if (v is RootForTest) {
            runCatching { dumpSemantics(v.semanticsOwner.unmergedRootSemanticsNode) }.getOrNull()
        } else null

    private fun dumpSemantics(n: SemanticsNode): JSONObject {
        val o = JSONObject()
        o.put("kind", "compose")
        val cfg = n.config
        o.put("type", cfg.getOrNull(SemanticsProperties.Role)?.toString() ?: "Composable")
        cfg.getOrNull(SemanticsProperties.TestTag)?.let { o.put("id", it) }
        cfg.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }
            ?.takeIf { it.isNotEmpty() }?.let { o.put("text", it.take(120)) }
        cfg.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ")
            ?.takeIf { it.isNotEmpty() }?.let { o.put("desc", it.take(120)) }
        val b = n.boundsInWindow
        o.put("bounds", JSONArray(listOf(b.left.toInt(), b.top.toInt(), b.width.toInt(), b.height.toInt())))
        val children = JSONArray()
        for (c in n.children) children.put(dumpSemantics(c))
        if (children.length() > 0) o.put("children", children)
        return o
    }
}
