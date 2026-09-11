# DevScope

Flipper-style inspector that runs in the browser. Detects Android devices/emulators through `adb`, iOS simulators/iPhones through `xcrun` and Chromium browsers through the DevTools protocol, and shows every API call from your app live: method, status, URL, timing, request/response headers and bodies — plus the view / composable / DOM tree.

No manual wiring needed: DevScope hands you a **copy-paste prompt** that makes your AI coding agent set your repo up for both inspectors — see [Set up your app with one prompt](#set-up-your-app-with-one-prompt).

## Install

**Download the app** — grab the `.dmg` for your Mac from the [Releases page](https://github.com/martinPino/devscope/releases) (`arm64` for Apple Silicon, `x64` for Intel), open it and drag DevScope to Applications. The build is ad-hoc signed, not notarized, so macOS Gatekeeper will complain the first time. Either right-click the app → **Open**, or clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/DevScope.app
```

**Or install with one command** — builds the app on your Mac (no Gatekeeper warning; needs Node.js 18+ and git) and installs it into `/Applications`. Run it again to update:

```bash
# while the repo is private (uses the GitHub CLI you are logged in with)
gh api repos/martinPino/devscope/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

```bash
# once the repo is public
curl -fsSL https://raw.githubusercontent.com/martinPino/devscope/main/install.sh | bash
```

From a checkout the same installer is `./install.sh` (or `npm run install:app`). Set `DEVSCOPE_DEST` to install somewhere other than `/Applications`.

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
npm run install:app    # build, sign and install DevScope.app into /Applications
npm run dist           # build .dmg/.zip into dist/ (macOS)
```

- **Start server / Stop server** button in the top bar (also ⌘R / ⌘. in the *Server* menu). The server dies with the app, so nothing is left running.
- **Start on launch** checkbox remembers whether the server should come up automatically.
- `adb` is auto-detected (`ADB` env, `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk/platform-tools`, Homebrew). Use **Change** to pick it manually; the choice is saved.
- If a DevScope server is already listening on the port (e.g. `npm start` in a terminal), the app attaches to it instead of failing.
- **Logs** shows the server output; **Open in browser** opens the same UI in your default browser.

Settings live in `~/Library/Application Support/devscope/settings.json` (`autoStart`, `adbPath`, `port`).
Dev hooks: `DEVSCOPE_PORT=8766` overrides the port for one launch, `DEVSCOPE_AUTOSTART=1` forces a start, `DEVSCOPE_E2E_COPY=1` verifies the Copy-prompt button end to end, `DEVSCOPE_SCREENSHOT=/path.png` (+ `DEVSCOPE_QUIT_AFTER=1`) captures the window for automated checks.

## Set up your app with one prompt

Web apps need nothing (see above). For mobile you don't have to integrate DevScope by hand either: click **Set up app**, pick **Android** or **iOS**, in the header (or the *Set up your app* link shown while DevScope is waiting for traffic), copy the prompt, and paste it into your AI coding agent (Claude Code, Cursor, Codex, …) opened in your Android or iOS repo. The agent does the wiring for you:

- adds `DevScopeInterceptor` and `DevScopeLayoutAgent` to the **debug** source set — release builds are untouched;
- installs them through a tiny `DevScope.install(context, builder)` facade (real in debug, no-op in release) as the last OkHttp interceptor;
- allows cleartext to `localhost` / `10.0.2.2` in debug via a network security config (or merges into your existing one);
- builds debug and release and tells you exactly which files it changed.

The prompt is generic (works for any project; set the **Module** field if your client lives outside `app`) and self-contained: the Kotlin sources are embedded, so the agent needs no network access. Untick **Embed the Kotlin sources** to get a shorter prompt that `curl`s them from `http://localhost:8765/android/` instead. Either way the result covers both the **Network** and the **Layout** inspector.

Prefer to do it yourself? The manual steps are below.

## Web apps: no setup at all

Type your app's URL in the **Web app** box of the sidebar and click **Open Chrome**. DevScope launches a Chrome with its own profile and `--remote-debugging-port`, attaches to every tab through the DevTools protocol and shows:

- every `fetch` / XHR / document request with headers, bodies and timing — HTTPS included, no proxy or certificate involved (static assets such as images, scripts and fonts are filtered out);
- in the **Layout** page, the DOM tree annotated with the **React component** that rendered each element (read from React's fiber, so it shows `ProductCard` rather than just `div`), `id` / `data-testid`, text, and bounds over a screenshot of the page. Live mode re-captures when the DOM changes.

Each browser appears as a device (`Chrome 152 · 3 tabs · localhost:3000`); the ✕ on its row closes it, and browsers DevScope launched are closed when the server stops. Works with Chrome, Chromium, Edge and Brave (set `DEVSCOPE_CHROME` to point at another binary). Safari and Firefox speak different protocols and are not supported this way.

Already running Chrome with `--remote-debugging-port=9222`? `POST /api/web/attach {"port": 9222}` attaches to it instead of launching a new one.

## Hook up your iOS app (debug builds only)

1. Copy `ios/DevScope.swift` into the app target (it is wrapped in `#if DEBUG`, so Release compiles it to nothing). iOS 13+.
2. Call it once at launch, guarded the same way:

   ```swift
   #if DEBUG
   DevScope.start()
   #endif
   ```

   It registers a `URLProtocol` on `URLSession.shared` and on `URLSessionConfiguration.default` / `.ephemeral`, so sessions created afterwards (Alamofire, Moya, plain URLSession) are mirrored — HTTPS included, since it runs inside the app. Sessions built from a configuration created *before* `start()` are not captured.
3. Info.plist: `NSAppTransportSecurity` → `NSAllowsLocalNetworking = YES` (plain http/ws to the dev machine). For **physical iPhones** also add `NSLocalNetworkUsageDescription` and `NSBonjourServices = ["_devscope._tcp"]`: the app finds the Mac over Bonjour on the same Wi-Fi (or set `DevScope.serverHost` to the Mac's IP). Simulators just use `localhost`.

The layout inspector shows the UIKit view hierarchy and, for SwiftUI, the accessibility tree (labels, identifiers, frames — SwiftUI does not expose its internal tree), with a screenshot taken by the agent itself. Devices are discovered with `xcrun simctl` (simulators) and `xcrun devicectl` (iPhones); on a Mac without Xcode the iOS side simply stays off.

> Not verified on a real simulator yet: this Mac has no Xcode. The Swift file is syntax-checked only — please report anything the compiler dislikes.

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

## Detail pane

Select any part of a body or header with the mouse and copy it as usual. The **Copy** button (top right of the detail pane) copies the active tab as plain text — pretty-printed JSON for bodies, `Key: value` lines for headers — and **cURL** copies the request as a ready-to-run `curl` command with its headers and body. Drag the divider between the list and the detail pane to resize it (double-click resets).

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
- `server/web.js` — Chromium provider: launches/attaches browsers, maps `Network.*` events to DevScope events (bodies via `getResponseBody`), walks the DOM with React fiber names and captures screenshots for the Layout page.
- `server/index.js` — Express + ws. Polls adb and xcrun, enriches devices (model, OS version, virtual/physical), sets up `adb reverse` for Android, advertises itself over Bonjour for iPhones, buffers the last 2000 events.
- `public/index.html` — the UI. Filter with `/`, search bodies with `⌘F`, navigate with ↑ ↓, `Esc` clears both.
- `android/DevScopeInterceptor.kt` — captures request/response (bodies up to 512 KB, text-like content only) and reports asynchronously.
- `ios/DevScope.swift` — the iOS drop-in: `URLProtocol` interceptor, layout agent (UIKit + SwiftUI accessibility), Bonjour/localhost transport.
- `android/DevScopeLayoutAgent.kt` — keeps a WebSocket to `/agent` and answers `layout.dump` with the view + Compose semantics tree of the resumed activity.

## Next plugins

The event bus is generic: post any JSON to `/ingest` with a `type` field and add a tab in the UI. Natural next ones are Logcat (`adb logcat` streamed over the same socket), SharedPreferences and a database viewer.

## Preview

<img width="1472" height="1012" alt="image" src="https://github.com/user-attachments/assets/446270ef-8e83-44c1-bac2-bf6da6af0388" />
<img width="1472" height="1012" alt="image" src="https://github.com/user-attachments/assets/1e3e8465-6707-42f6-bdaa-3189c393ea98" />

