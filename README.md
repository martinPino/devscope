# DevScope

Flipper-style inspector that runs in the browser. Detects Android devices and emulators through `adb` and shows every API call from your app live: method, status, URL, timing, request/response headers and bodies.

No manual wiring needed: DevScope hands you a **copy-paste prompt** that makes your AI coding agent set your repo up for both inspectors — see [Set up your app with one prompt](#set-up-your-app-with-one-prompt).

## Run

```bash
npm install
npm start            # http://localhost:8765
# adb not on PATH?  ADB=$ANDROID_HOME/platform-tools/adb npm start
```

Try it without a device:

```bash
npm run demo
```

## Desktop app (Electron)

No terminal needed: the desktop app runs the same server as a child process and shows the inspector in a window.

```bash
npm run desktop        # run from source
npm run dist           # build DevScope.app + .dmg/.zip into dist/ (macOS)
```

- **Start server / Stop server** button in the top bar (also ⌘R / ⌘. in the *Server* menu). The server dies with the app, so nothing is left running.
- **Start on launch** checkbox remembers whether the server should come up automatically.
- `adb` is auto-detected (`ADB` env, `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk/platform-tools`, Homebrew). Use **Change** to pick it manually; the choice is saved.
- If a DevScope server is already listening on the port (e.g. `npm start` in a terminal), the app attaches to it instead of failing.
- **Logs** shows the server output; **Open in browser** opens the same UI in your default browser.

Settings live in `~/Library/Application Support/devscope/settings.json` (`autoStart`, `adbPath`, `port`).
Dev hooks: `DEVSCOPE_PORT=8766` overrides the port for one launch, `DEVSCOPE_AUTOSTART=1` forces a start, `DEVSCOPE_E2E_COPY=1` verifies the Copy-prompt button end to end, `DEVSCOPE_SCREENSHOT=/path.png` (+ `DEVSCOPE_QUIT_AFTER=1`) captures the window for automated checks.

## Set up your app with one prompt

You don't have to integrate DevScope by hand. Click **Set up app** in the header (or the *Set up your app* link shown while DevScope is waiting for traffic), copy the prompt, and paste it into your AI coding agent (Claude Code, Cursor, Codex, …) opened in your Android repo. The agent does the wiring for you:

- adds `DevScopeInterceptor` and `DevScopeLayoutAgent` to the **debug** source set — release builds are untouched;
- installs them through a tiny `DevScope.install(context, builder)` facade (real in debug, no-op in release) as the last OkHttp interceptor;
- allows cleartext to `localhost` / `10.0.2.2` in debug via a network security config (or merges into your existing one);
- builds debug and release and tells you exactly which files it changed.

The prompt is generic (works for any project; set the **Module** field if your client lives outside `app`) and self-contained: the Kotlin sources are embedded, so the agent needs no network access. Untick **Embed the Kotlin sources** to get a shorter prompt that `curl`s them from `http://localhost:8765/android/` instead. Either way the result covers both the **Network** and the **Layout** inspector.

Prefer to do it yourself? The manual steps are below.

## Hook up your Android app (debug builds only)

1. Copy `android/DevScopeInterceptor.kt` into your project.
2. Add it as the **last** interceptor on your `OkHttpClient` (Retrofit uses this client too):

   ```kotlin
   val client = OkHttpClient.Builder()
       .apply { if (BuildConfig.DEBUG) addInterceptor(DevScopeInterceptor(context)) }
       .build()
   ```

3. Allow cleartext to localhost in the debug flavor (`src/debug/res/xml/network_security_config.xml`):

   ```xml
   <network-security-config>
       <domain-config cleartextTrafficPermitted="true">
           <domain includeSubdomains="false">localhost</domain>
           <domain includeSubdomains="false">10.0.2.2</domain>
       </domain-config>
   </network-security-config>
   ```

   and reference it from the debug manifest with `android:networkSecurityConfig="@xml/network_security_config"`.

4. (Optional, for the Layout inspector) copy `android/DevScopeLayoutAgent.kt` too and start it once, next to the interceptor:

   ```kotlin
   if (BuildConfig.DEBUG) DevScopeLayoutAgent.start(context)
   ```

That's it. The server runs `adb reverse tcp:8765 tcp:8765` on every device it sees, so `localhost:8765` inside the device reaches your machine. Requests and agents are matched to devices through `ANDROID_ID` when it matches, otherwise to the only connected device (`ANDROID_ID` is per-app since Android 8, so it usually differs from the value `adb` reads).

## Search

- **Filter** (top bar, `/`): matches method, status, URL and app id — narrows the request list.
- **Search in bodies** (`⌘F` / `Ctrl+F`): matches inside request/response bodies. The list shows only requests that contain the term, every hit is highlighted in yellow in the detail pane, the tab badges show how many hits each tab has, and `Enter` / `Shift+Enter` jump between hits. On the Layout page the same box highlights matching nodes in the tree. `Esc` clears both.

## Layout inspector

Switch to **Layout** in the header. **Capture** asks the in-app agent for the view hierarchy of the foreground activity: classic Views (class, `@id`, text, bounds, visibility) and, inside every ComposeView, the Compose semantics tree (role, `testTag`, text, content description, bounds). Hover a node to see its bounds drawn over a live `adb screencap` of the device; click it for the details. Composables are green, Views are blue, invisible nodes are dimmed.

**Live** (on by default) follows the app: while the Layout page is open the agent re-sends the tree after every layout pass of the resumed activity — navigating, scrolling, opening a dialog — debounced to 400 ms, and the screenshot refreshes at most every 800 ms. Selection and folded nodes survive updates within the same activity. The agent only streams while a browser is on the Layout page, so it costs nothing otherwise.

## How it works

```
Android app ──OkHttp interceptor──▶ POST /ingest ──▶ server ──WebSocket /ws──▶ browser
            ◀─layout agent (WS /agent)─▶            ◀── layout.capture ────────┘
                                        ▲
adb reverse tcp:8765 ───────────────────┘        adb devices -l  (polled every 2 s)
                                                 adb exec-out screencap -p  (on capture)
```

- `desktop/` — Electron shell: `main.js` (server child process, adb discovery, settings), `preload.cjs`, `renderer/` (top bar + embedded UI).
- `server/index.js` — Express + ws. Polls adb, enriches devices (model, Android version, AVD name, virtual/physical), sets up port reversing, buffers the last 2000 events, relays layout captures between browser (`/ws`) and in-app agents (`/agent`), serves device screenshots at `/api/screenshot/:serial`.
- `public/index.html` — the UI. Filter with `/`, search bodies with `⌘F`, navigate with ↑ ↓, `Esc` clears both.
- `android/DevScopeInterceptor.kt` — captures request/response (bodies up to 512 KB, text-like content only) and reports asynchronously.
- `android/DevScopeLayoutAgent.kt` — keeps a WebSocket to `/agent` and answers `layout.dump` with the view + Compose semantics tree of the resumed activity.

## Next plugins

The event bus is generic: post any JSON to `/ingest` with a `type` field and add a tab in the UI. Natural next ones are Logcat (`adb logcat` streamed over the same socket), SharedPreferences and a database viewer.

## Preview

<img width="1472" height="1012" alt="image" src="https://github.com/user-attachments/assets/446270ef-8e83-44c1-bac2-bf6da6af0388" />
<img width="1472" height="1012" alt="image" src="https://github.com/user-attachments/assets/1e3e8465-6707-42f6-bdaa-3189c393ea98" />

