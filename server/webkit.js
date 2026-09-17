// Safari and WKWebViews on iPhones / iPads, zero code in the page. iOS does not speak Chrome's
// DevTools protocol: Web Inspector travels over a lockdown service, which ios-webkit-debug-proxy
// (brew install ios-webkit-debug-proxy) exposes as one WebSocket per tab. Since iOS 12.2 every
// command must be wrapped in Target.sendMessageToTarget; the proxy does not do that for us.
// Needs the device paired ("Trust") and Settings → Apps → Safari → Advanced → Web Inspector on.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { WALKER } from "./web.js";

const LIST_PORT = 9421, FIRST_PORT = 9422, LAST_PORT = 9450;
const TEXT_MIME = /json|text|xml|javascript|x-www-form-urlencoded|graphql|event-stream/i;
const SKIP_TYPES = new Set(["Image", "Font", "StyleSheet", "Stylesheet", "Script", "Media", "Manifest", "TextTrack"]);
const MAX_BODY = 512 * 1024;
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const truncate = (s) => (s && s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\n… [truncated by DevScope]" : s);

export function findWebkitProxy() {
  if (process.env.DEVSCOPE_IWDP) return process.env.DEVSCOPE_IWDP;
  const names = ["/opt/homebrew/bin/ios_webkit_debug_proxy", "/usr/local/bin/ios_webkit_debug_proxy",
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "ios_webkit_debug_proxy"))];
  return names.find((p) => fs.existsSync(p)) || null;
}

export function createWebkitProvider({ devices, recordEvent, broadcast, layouts, screenshots, devicesChanged, log = console }) {
  const sessions = new Map(); // `${udid}:webinspector` -> session
  let proc = null, restartAt = 0;

  function ensureProxy() {
    if (proc || Date.now() < restartAt) return !!proc;
    const bin = findWebkitProxy();
    if (!bin) return false;
    proc = spawn(bin, ["-c", `null:${LIST_PORT},:${FIRST_PORT}-${LAST_PORT}`, "--no-frontend"], { stdio: "ignore" });
    proc.on("error", () => { proc = null; restartAt = Date.now() + 15000; });
    proc.on("exit", () => { proc = null; restartAt = Date.now() + 5000; });
    log.log(`[webkit] started ${path.basename(bin)} (devices on :${LIST_PORT})`);
    return true;
  }
  async function getJson(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Called on every device poll with the UDIDs of the physical iOS devices currently connected. */
  async function sync(udids) {
    if (!udids.length) { for (const s of [...sessions.values()]) removeSession(s, "device gone"); return; }
    if (!ensureProxy()) return;
    let list;
    try { list = await getJson(LIST_PORT); } catch { return; } // proxy still starting
    const present = new Set();
    for (const d of list) {
      if (!udids.includes(d.deviceId)) continue;
      const port = Number(String(d.url || "").split(":").pop());
      if (!port) continue;
      const serial = `${d.deviceId}:webinspector`;
      present.add(serial);
      let session = sessions.get(serial);
      if (!session) {
        const info = {
          serial, platform: "web", type: "browser", state: "device", model: "Safari & WebViews", avdName: "", manufacturer: "Apple",
          os: "WebKit", release: d.deviceOSVersion || "", sdk: "", androidId: "", reverse: true, parent: d.deviceId, via: "usbmux",
          pages: 0, url: null, connectedAt: Date.now(),
        };
        session = { serial, udid: d.deviceId, port, info, tabs: new Map(), active: null, watch: null, seq: 0 };
        sessions.set(serial, session);
        devices.set(serial, info);
        log.log(`[webkit] Web Inspector on ${d.deviceName || d.deviceId} (:${port})`);
        devicesChanged();
      }
      await syncTabs(session).catch(() => {});
    }
    for (const s of [...sessions.values()]) if (!present.has(s.serial)) removeSession(s, "not listed by the proxy");
  }

  async function syncTabs(session) {
    const tabs = (await getJson(session.port)).filter((t) => t.webSocketDebuggerUrl);
    const seen = new Set();
    for (const t of tabs) {
      const key = t.webSocketDebuggerUrl;
      seen.add(key);
      const known = session.tabs.get(key);
      if (known) { if (t.url && known.url !== t.url) known.url = t.url; if (t.title) known.title = t.title; continue; }
      attachTab(session, t);
    }
    for (const [key, tab] of session.tabs) if (!seen.has(key)) { try { tab.ws.close(); } catch {} session.tabs.delete(key); }
    for (const tab of session.tabs.values()) if (tab.targetId && Date.now() - (tab.probedAt || 0) > (tab.responsive ? 6000 : 10000)) tab.wake();
    publish(session);
  }

  // An app can expose dozens of WKWebViews; the ones off screen are suspended and never answer.
  // Only tabs that answered a probe ("responsive") count, and the visible one names the device.
  function publish(session) {
    const live = [...session.tabs.values()].filter((t) => t.targetId && t.responsive);
    const current = session.tabs.get(session.active);
    if (!current || !current.responsive || !current.visible) session.active = (live.find((t) => t.visible) || live[0])?.key ?? null;
    const url = session.tabs.get(session.active)?.url || null;
    const total = session.tabs.size;
    if (session.info.pages !== live.length || session.info.url !== url || session.info.inspectable !== total) {
      session.info.pages = live.length; session.info.url = url; session.info.inspectable = total;
      devicesChanged();
    }
  }

  function attachTab(session, t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    const tab = { key: t.webSocketDebuggerUrl, ws, url: t.url || "", title: t.title || "", appId: t.appId || null, targetId: null, outer: 0, inner: 0, pending: new Map(), reqs: new Map() };
    session.tabs.set(tab.key, tab);

    tab.send = (method, params = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
      if (!tab.targetId || ws.readyState !== 1) return reject(new Error("tab not ready"));
      const id = ++tab.inner;
      const timer = setTimeout(() => { tab.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      tab.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: ++tab.outer, method: "Target.sendMessageToTarget", params: { targetId: tab.targetId, message: JSON.stringify({ id, method, params }) } }));
    });
    // Probe first: a suspended WebView never answers, and must neither count nor be chosen.
    tab.wake = async () => {
      tab.probedAt = Date.now();
      const target = tab.targetId;
      try {
        const r = await tab.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, 4000);
        tab.responsive = true; tab.visible = r.result?.value === "visible";
        if (tab.enabledFor !== target) { tab.enabledFor = target; for (const m of ["Network.enable", "Page.enable"]) tab.send(m).catch(() => {}); }
      } catch { tab.responsive = false; tab.visible = false; }
      publish(session);
    };
    const enable = () => { tab.wake(); };

    const finalize = (p, patch) => {
      tab.reqs.delete(p.requestId);
      recordEvent({
        id: `${session.serial}:${p.requestId}:${++session.seq}`,
        startedAt: p.startedAt, durationMs: p.durationMs ?? null, method: p.method, url: p.url, status: p.status ?? null,
        requestHeaders: p.requestHeaders || {}, requestBody: p.requestBody ?? null, responseHeaders: p.responseHeaders || {},
        responseBody: null, responseSize: p.responseSize ?? null, error: null, appId: p.appId, platform: "web",
        deviceModel: "Safari", resourceType: p.type, ...patch,
      }, session.serial);
    };

    const onEvent = async (method, p) => {
      if (method === "Network.requestWillBeSent") {
        const prev = tab.reqs.get(p.requestId);
        if (prev && p.redirectResponse) {
          prev.status = p.redirectResponse.status; prev.responseHeaders = p.redirectResponse.headers;
          prev.durationMs = Math.round((p.timestamp - prev.t0) * 1000);
          finalize(prev, {});
        }
        if (SKIP_TYPES.has(p.type)) return;
        tab.reqs.set(p.requestId, {
          requestId: p.requestId, t0: p.timestamp, startedAt: p.walltime ? Math.round(p.walltime * 1000) : Date.now(),
          method: p.request?.method || "GET", url: p.request?.url || "", requestHeaders: p.request?.headers || {},
          requestBody: p.request?.postData ?? null, type: p.type, appId: originOf(p.documentURL || tab.url || p.request?.url),
        });
        session.active = tab.key;
      } else if (method === "Network.responseReceived") {
        const r = tab.reqs.get(p.requestId);
        if (!r) return;
        r.status = p.response?.status; r.responseHeaders = p.response?.headers || {}; r.mimeType = p.response?.mimeType || "";
        if (p.response?.requestHeaders) r.requestHeaders = { ...r.requestHeaders, ...p.response.requestHeaders };
      } else if (method === "Network.loadingFinished") {
        const r = tab.reqs.get(p.requestId);
        if (!r) return;
        r.durationMs = Math.round((p.timestamp - r.t0) * 1000);
        r.responseSize = p.metrics?.responseBodyBytesReceived ?? p.metrics?.responseBodyDecodedSize ?? null;
        let body = null;
        if (TEXT_MIME.test(r.mimeType || "")) {
          try { const b = await tab.send("Network.getResponseBody", { requestId: p.requestId }); body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body; } catch { body = null; }
        } else if (r.mimeType) body = `<binary ${r.mimeType}>`;
        finalize(r, { responseBody: truncate(body) });
      } else if (method === "Network.loadingFailed") {
        const r = tab.reqs.get(p.requestId);
        if (!r) return;
        r.durationMs = Math.round((p.timestamp - r.t0) * 1000);
        finalize(r, { error: p.canceled ? "canceled" : (p.errorText || "failed") });
      } else if (method === "Page.frameNavigated" && !p.frame?.parentId) {
        tab.url = p.frame.url; session.active = tab.key; session.watchDirty = true; publish(session);
      }
    };

    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.method === "Target.targetCreated") {
        const ti = m.params?.targetInfo;
        if (ti?.type === "page" && !ti.isProvisional && !tab.targetId) { tab.targetId = ti.targetId; enable(); }
      } else if (m.method === "Target.didCommitProvisionalTarget") {
        if (!tab.targetId || m.params.oldTargetId === tab.targetId) { tab.targetId = m.params.newTargetId; enable(); }
      } else if (m.method === "Target.targetDestroyed") {
        if (m.params?.targetId === tab.targetId) { tab.targetId = null; publish(session); }
      } else if (m.method === "Target.dispatchMessageFromTarget") {
        if (m.params?.targetId !== tab.targetId) return; // frames and provisional targets
        let im; try { im = JSON.parse(m.params.message); } catch { return; }
        if (im.id && tab.pending.has(im.id)) {
          const { resolve, reject, timer } = tab.pending.get(im.id);
          clearTimeout(timer); tab.pending.delete(im.id);
          im.error ? reject(new Error(im.error.message || "inspector error")) : resolve(im.result || {});
        } else if (im.method) onEvent(im.method, im.params || {}).catch(() => {});
      }
    });
    const drop = () => { if (session.tabs.get(tab.key) === tab) { session.tabs.delete(tab.key); publish(session); } };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  function removeSession(session, why) {
    if (session.watch) clearInterval(session.watch);
    for (const tab of session.tabs.values()) { try { tab.ws.close(); } catch {} }
    sessions.delete(session.serial);
    devices.delete(session.serial);
    screenshots.delete(session.serial);
    log.log(`[webkit] ${session.serial} detached: ${why}`);
    devicesChanged();
  }

  const activeTab = (session) => [session.tabs.get(session.active), ...session.tabs.values()].find((t) => t && t.targetId && t.responsive) || null;

  // Prefer the tab that is actually on screen (Safari keeps background tabs inspectable but hidden).
  async function visibleTab(session) {
    const live = [...session.tabs.values()].filter((t) => t.targetId && t.responsive).sort((a, b) => (b.key === session.active) - (a.key === session.active));
    const probes = await Promise.all(live.map((t) => t.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, 2500)
      .then((r) => { t.visible = r.result?.value === "visible"; return t.visible ? t : null; }).catch(() => null)));
    const tab = probes.find(Boolean) || live.find((t) => t.visible) || null;
    if (tab) session.active = tab.key;
    return tab;
  }

  async function snapshot(session, { withScreenshot }) {
    const tab = await visibleTab(session);
    if (!tab) throw new Error(session.tabs.size ? "No visible page answered — bring Safari or the app's WebView to the foreground and unlock the device." : "No inspectable page. Open Safari on the device and enable Settings → Apps → Safari → Advanced → Web Inspector.");
    const r = await tab.send("Runtime.evaluate", { expression: WALKER, returnByValue: true });
    if (r.wasThrown) throw new Error("DOM walk failed in the page");
    const data = r.result?.value || {};
    if (withScreenshot && data.viewport) {
      try {
        const shot = await tab.send("Page.snapshotRect", { x: 0, y: 0, width: data.viewport.w, height: data.viewport.h, coordinateSystem: "Viewport" });
        if (shot.dataURL) screenshots.set(session.serial, Buffer.from(shot.dataURL.split(",")[1], "base64"));
      } catch (e) { log.warn(`[webkit] snapshot failed: ${e.message}`); }
    }
    return data;
  }

  async function capture(serial) {
    const session = sessions.get(serial);
    if (!session) throw new Error("Unknown device");
    const data = await snapshot(session, { withScreenshot: true });
    const layout = { serial, activity: data.title || data.url || null, capturedAt: Date.now(), tree: data.tree };
    layouts.set(serial, layout);
    broadcast({ type: "layout", layout });
  }

  function setWatch(serial, on) {
    const session = sessions.get(serial);
    if (!session) return;
    if (session.watch) { clearInterval(session.watch); session.watch = null; }
    if (!on) return;
    let lastHash = "", lastShot = 0, busy = false;
    session.watch = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await snapshot(session, { withScreenshot: false });
        const hash = JSON.stringify(data.tree);
        if (hash !== lastHash || session.watchDirty) {
          lastHash = hash; session.watchDirty = false;
          if (Date.now() - lastShot > 2000) { await snapshot(session, { withScreenshot: true }); lastShot = Date.now(); }
          const layout = { serial, activity: data.title || data.url || null, capturedAt: Date.now(), tree: data.tree };
          layouts.set(serial, layout);
          broadcast({ type: "layout", layout });
        }
      } catch { /* navigating */ } finally { busy = false; }
    }, 1500);
  }

  async function reload(serial) {
    const session = sessions.get(serial);
    const tab = session && await visibleTab(session);
    if (!tab) throw new Error("No inspectable page");
    await tab.send("Page.reload");
  }

  function shutdown() {
    for (const s of [...sessions.values()]) { if (s.watch) clearInterval(s.watch); for (const t of s.tabs.values()) { try { t.ws.close(); } catch {} } }
    sessions.clear();
    if (proc) { try { proc.kill(); } catch {} proc = null; }
  }

  return {
    sync, capture, setWatch, reload, shutdown,
    has: (serial) => sessions.has(serial),
    serials: () => [...sessions.keys()],
    proxyAvailable: () => !!findWebkitProxy(),
    tabsFor: (udid) => sessions.get(`${udid}:webinspector`)?.info.inspectable ?? null,
    describe: (serial) => [...(sessions.get(serial)?.tabs.values() || [])].map((t) => ({ url: t.url, title: t.title, appId: t.appId, target: !!t.targetId, responsive: !!t.responsive, visible: !!t.visible, ws: t.ws.readyState, pendingRequests: t.reqs.size })),
  };
}
