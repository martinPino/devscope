// Web provider: attaches DevScope to Chromium browsers through the DevTools protocol.
// No code in the web app is needed — network (with bodies), DOM/React tree and screenshots
// all come from CDP. Browsers are launched with a dedicated profile and
// --remote-debugging-port, or attached when already running with that flag.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";

const TEXT_MIME = /json|text|xml|javascript|x-www-form-urlencoded|graphql|event-stream/i;
// Static assets are noise in an API inspector; documents, XHR/fetch, SSE, beacons stay.
const SKIP_TYPES = new Set(["Image", "Media", "Font", "Stylesheet", "Script", "Manifest", "TextTrack", "Prefetch", "Preflight", "SignedExchange", "CSPViolationReport"]);
const MAX_BODY = 512 * 1024;
const POLL_MS = 2000;

const CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
  win32: [
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  ],
};

export function findChrome() {
  if (process.env.DEVSCOPE_CHROME) return process.env.DEVSCOPE_CHROME;
  const list = CANDIDATES[process.platform] || [];
  for (const c of list) {
    if (c.includes(path.sep)) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Runs in the page: DOM tree with React component names (from the fiber attached to each
// element) and bounds in device pixels, so they line up with Page.captureScreenshot.
const WALKER = `(() => {
  const dpr = window.devicePixelRatio || 1;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD"]);
  let count = 0;
  function components(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    const names = [];
    let hops = 0;
    while (fiber && names.length < 3 && hops++ < 60) {
      const t = fiber.type;
      if (t && typeof t !== "string") {
        const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name));
        if (name && name !== "Fragment" && !/^(Suspense|Provider|Consumer|ForwardRef|Memo)$/.test(name)) names.push(name);
      }
      fiber = fiber.return;
    }
    return names;
  }
  function text(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.type === "password" ? "••••••" : (el.value || el.placeholder || "");
    if (el.childElementCount === 0) return (el.textContent || "").trim();
    return "";
  }
  function node(el) {
    if (SKIP.has(el.tagName) || ++count > 5000) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const o = { kind: "dom", type: el.tagName.toLowerCase(), bounds: [Math.round(r.left * dpr), Math.round(r.top * dpr), Math.round(r.width * dpr), Math.round(r.height * dpr)] };
    const id = el.id || el.getAttribute("data-testid") || el.getAttribute("name");
    if (id) o.id = id;
    const comps = components(el);
    if (comps.length) { o.kind = "react"; o.type = comps[0]; o.desc = "<" + el.tagName.toLowerCase() + ">" + (comps.length > 1 ? " in " + comps.slice(1).join(" › ") : ""); }
    const t = text(el);
    if (t) o.text = t.slice(0, 120);
    if (cs.display === "none" || cs.visibility === "hidden" || (r.width === 0 && r.height === 0)) o.hidden = true;
    const kids = [];
    for (const c of el.children) { const k = node(c); if (k) kids.push(k); }
    if (kids.length) o.children = kids;
    return o;
  }
  return { title: document.title, url: location.href, tree: node(document.body || document.documentElement) };
})()`;

const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const truncate = (s) => (s && s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\n… [truncated by DevScope]" : s);

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
async function versionInfo(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWebProvider({ devices, recordEvent, broadcast, layouts, screenshots, devicesChanged, log = console }) {
  const browsers = new Map(); // serial -> entry

  function browserName(v) {
    const m = /^(\S+?)\/(\S+)/.exec(v.Browser || "");
    const product = m ? m[1] : "Chrome";
    const name = /Edg/i.test(v["User-Agent"] || "") ? "Edge" : /Brave/i.test(product) ? "Brave" : product === "HeadlessChrome" ? "Chrome (headless)" : product;
    return { name, version: m ? m[2] : "" };
  }

  async function launch({ url } = {}) {
    const chrome = findChrome();
    if (!chrome) throw new Error("No Chromium browser found. Install Google Chrome or set DEVSCOPE_CHROME to the executable.");
    let port = 9222;
    while (!(await portFree(port))) port++;
    const profile = path.join(os.homedir(), ".devscope", `chrome-${port}`);
    fs.mkdirSync(profile, { recursive: true });
    const target = (url || "").trim() || "about:blank";
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen",
      "--window-size=1280,900",
      target,
    ];
    log.log(`[web] launching ${path.basename(chrome)} on :${port} → ${target}`);
    const proc = spawn(chrome, args, { stdio: "ignore" });
    proc.on("error", (e) => log.warn(`[web] chrome failed to start: ${e.message}`));
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      await sleep(250);
      try { await versionInfo(port); ready = true; } catch { /* not yet */ }
      if (proc.exitCode !== null) break;
    }
    if (!ready) { try { proc.kill(); } catch {} throw new Error("Chrome did not expose its DevTools port in time."); }
    return attach({ port, proc, spawned: true, url: target });
  }

  async function attach({ port, proc = null, spawned = false, url = null, serial = null }) {
    port = Number(port);
    const existing = [...browsers.values()].find((b) => b.port === port);
    if (existing) return existing.serial;
    const v = await versionInfo(port);
    const { name, version } = browserName(v);
    serial = serial || `chrome-${port}`;
    const info = {
      serial, platform: "web", type: "browser", state: "device", model: name, avdName: "",
      manufacturer: "Google", os: name, release: version.split(".").slice(0, 2).join("."), sdk: "",
      androidId: "", reverse: true, port, pages: 0, url, connectedAt: Date.now(),
    };
    const entry = { serial, port, proc, spawned, info, targets: new Map(), active: null, watch: null, seq: 0, dead: false };
    browsers.set(serial, entry);
    devices.set(serial, info);
    log.log(`[web] attached: ${name} ${version} (${serial}, spawned=${spawned})`);
    await syncTargets(entry);
    devicesChanged();
    entry.timer = setInterval(() => syncTargets(entry).catch(() => {}), POLL_MS);
    return serial;
  }

  async function syncTargets(entry) {
    if (entry.dead) return;
    let list;
    try { list = await CDP.List({ port: entry.port }); }
    catch (e) { remove(entry, `browser gone (${e.message.split("\n")[0]})`); return; }
    const pages = list.filter((t) => t.type === "page" && /^(https?|file|about):/.test(t.url || ""));
    const seen = new Set();
    let changed = false;
    for (const t of pages) {
      seen.add(t.id);
      const known = entry.targets.get(t.id);
      if (known) { if (known.url !== t.url) { known.url = t.url; changed = true; } continue; }
      try { await attachTarget(entry, t); changed = true; }
      catch (e) { log.warn(`[web] could not attach tab ${t.url}: ${e.message}`); }
    }
    for (const [id, tgt] of entry.targets) {
      if (!seen.has(id)) { try { tgt.client.close(); } catch {} entry.targets.delete(id); changed = true; }
    }
    if (entry.active && !entry.targets.has(entry.active)) entry.active = null;
    if (!entry.active && entry.targets.size) entry.active = [...entry.targets.keys()][0];
    const activeUrl = entry.targets.get(entry.active)?.url || null;
    if (entry.info.pages !== entry.targets.size || entry.info.url !== activeUrl) {
      entry.info.pages = entry.targets.size; entry.info.url = activeUrl; changed = true;
    }
    if (changed) devicesChanged();
  }

  async function attachTarget(entry, t) {
    const client = await CDP({ target: t.webSocketDebuggerUrl });
    const { Network, Page, Runtime } = client;
    const tgt = { id: t.id, url: t.url, title: t.title, client };
    entry.targets.set(t.id, tgt);
    const pending = new Map();     // requestId -> partial event
    const extraReq = new Map();    // requestId -> raw request headers that arrived early
    const extraRes = new Map();

    const finalize = (p, patch) => {
      pending.delete(p.requestId);
      recordEvent({
        id: `${entry.serial}:${p.requestId}:${++entry.seq}`,
        startedAt: p.startedAt, durationMs: p.durationMs ?? null,
        method: p.method, url: p.url, status: p.status ?? null,
        requestHeaders: p.requestHeaders || {}, requestBody: p.requestBody ?? null,
        responseHeaders: p.responseHeaders || {}, responseBody: null, responseSize: p.responseSize ?? null,
        error: null, appId: p.appId, platform: "web", deviceModel: entry.info.model, resourceType: p.type,
        ...patch,
      }, entry.serial);
    };

    Network.requestWillBeSent(({ requestId, request, timestamp, wallTime, type, redirectResponse, documentURL }) => {
      const prev = pending.get(requestId);
      if (prev && redirectResponse) {
        prev.status = redirectResponse.status; prev.responseHeaders = redirectResponse.headers;
        prev.durationMs = Math.round((timestamp - prev.t0) * 1000);
        finalize(prev, { responseBody: null });
      }
      if (SKIP_TYPES.has(type)) return;
      const p = {
        requestId, t0: timestamp, startedAt: Math.round(wallTime * 1000), method: request.method, url: request.url,
        requestHeaders: { ...(request.headers || {}), ...(extraReq.get(requestId) || {}) },
        requestBody: request.postData ?? null, hasPostData: !!request.hasPostData, type,
        appId: originOf(documentURL || tgt.url || request.url),
      };
      extraReq.delete(requestId);
      pending.set(requestId, p);
      entry.active = t.id;
    });
    Network.requestWillBeSentExtraInfo(({ requestId, headers }) => {
      const p = pending.get(requestId);
      if (p) p.requestHeaders = { ...p.requestHeaders, ...headers }; else extraReq.set(requestId, headers);
    });
    Network.responseReceived(({ requestId, response }) => {
      const p = pending.get(requestId);
      if (!p) return;
      p.status = response.status;
      p.responseHeaders = { ...(response.headers || {}), ...(extraRes.get(requestId) || {}) };
      extraRes.delete(requestId);
      p.mimeType = response.mimeType || "";
      p.responseSize = response.encodedDataLength ?? null;
    });
    Network.responseReceivedExtraInfo(({ requestId, headers }) => {
      const p = pending.get(requestId);
      if (p && p.responseHeaders) p.responseHeaders = { ...p.responseHeaders, ...headers }; else extraRes.set(requestId, headers);
    });
    Network.loadingFinished(async ({ requestId, timestamp, encodedDataLength }) => {
      const p = pending.get(requestId);
      if (!p) return;
      p.durationMs = Math.round((timestamp - p.t0) * 1000);
      if (encodedDataLength) p.responseSize = encodedDataLength;
      let body = null;
      if (TEXT_MIME.test(p.mimeType || "")) {
        try {
          const r = await Network.getResponseBody({ requestId });
          body = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
        } catch { body = null; }
      } else if (p.mimeType) {
        body = `<binary ${p.mimeType}>`;
      }
      if (p.hasPostData && p.requestBody == null) {
        try { p.requestBody = (await Network.getRequestPostData({ requestId })).postData; } catch {}
      }
      finalize(p, { responseBody: truncate(body) });
    });
    Network.loadingFailed(({ requestId, timestamp, errorText, canceled }) => {
      const p = pending.get(requestId);
      if (!p) return;
      p.durationMs = Math.round((timestamp - p.t0) * 1000);
      finalize(p, { error: canceled ? "canceled" : (errorText || "failed") });
    });
    Page.frameNavigated(({ frame }) => {
      if (frame.parentId) return;
      tgt.url = frame.url;
      entry.active = t.id;
      if (entry.watch) entry.watchDirty = true;
    });
    client.on("disconnect", () => { entry.targets.delete(t.id); });

    await Promise.all([
      Network.enable({ maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 }),
      Page.enable(),
      Runtime.enable(),
    ]);
  }

  function remove(entry, why) {
    if (entry.dead) return;
    entry.dead = true;
    clearInterval(entry.timer);
    setWatch(entry.serial, false);
    for (const { client } of entry.targets.values()) { try { client.close(); } catch {} }
    entry.targets.clear();
    browsers.delete(entry.serial);
    devices.delete(entry.serial);
    screenshots.delete(entry.serial);
    log.log(`[web] detached ${entry.serial}: ${why}`);
    devicesChanged();
  }

  async function close(serial) {
    const entry = browsers.get(serial);
    if (!entry) return false;
    if (entry.spawned && entry.proc && entry.proc.exitCode === null) { try { entry.proc.kill(); } catch {} }
    remove(entry, entry.spawned ? "closed by DevScope" : "detached");
    return true;
  }

  function activeTarget(entry) {
    return entry.targets.get(entry.active) || [...entry.targets.values()][0] || null;
  }

  async function snapshot(entry, { withScreenshot }) {
    const tgt = activeTarget(entry);
    if (!tgt) throw new Error("This browser has no open page.");
    const { result, exceptionDetails } = await tgt.client.Runtime.evaluate({ expression: WALKER, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text || "DOM walk failed");
    const data = result.value || {};
    if (withScreenshot) {
      try {
        const shot = await tgt.client.Page.captureScreenshot({ format: "png" });
        screenshots.set(entry.serial, Buffer.from(shot.data, "base64"));
      } catch (e) { log.warn(`[web] screenshot failed: ${e.message}`); }
    }
    return data;
  }

  async function capture(serial) {
    const entry = browsers.get(serial);
    if (!entry) throw new Error("Unknown browser");
    const data = await snapshot(entry, { withScreenshot: true });
    const layout = { serial, activity: data.title || data.url || null, capturedAt: Date.now(), tree: data.tree };
    layouts.set(serial, layout);
    broadcast({ type: "layout", layout });
    return layout;
  }

  // Live mode: re-walk the DOM every second and push when it changed (screenshot throttled).
  function setWatch(serial, on) {
    const entry = browsers.get(serial);
    if (!entry) return;
    if (entry.watch) { clearInterval(entry.watch); entry.watch = null; }
    if (!on) return;
    let lastHash = "", lastShot = 0, busy = false;
    entry.watch = setInterval(async () => {
      if (busy || entry.dead) return;
      busy = true;
      try {
        const data = await snapshot(entry, { withScreenshot: false });
        const hash = JSON.stringify(data.tree);
        if (hash !== lastHash || entry.watchDirty) {
          lastHash = hash; entry.watchDirty = false;
          if (Date.now() - lastShot > 1500) { await snapshot(entry, { withScreenshot: true }); lastShot = Date.now(); }
          const layout = { serial, activity: data.title || data.url || null, capturedAt: Date.now(), tree: data.tree };
          layouts.set(serial, layout);
          broadcast({ type: "layout", layout });
        }
      } catch { /* page navigating */ } finally { busy = false; }
    }, 1000);
  }

  function shutdown() {
    for (const entry of [...browsers.values()]) {
      if (entry.spawned && entry.proc && entry.proc.exitCode === null) { try { entry.proc.kill(); } catch {} }
      entry.dead = true; clearInterval(entry.timer); if (entry.watch) clearInterval(entry.watch);
    }
    browsers.clear();
  }

  return {
    launch, attach, close, capture, setWatch, shutdown,
    has: (serial) => browsers.has(serial),
    serials: () => [...browsers.keys()],
    chromePath: findChrome,
  };
}
