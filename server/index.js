import express from "express";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebProvider } from "./web.js";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8765);
const ADB = process.env.ADB || "adb";
const XCRUN = process.env.XCRUN || "xcrun";
const POLL_MS = 2000;
const MAX_EVENTS = 2000;

// ---------- state ----------
const devices = new Map(); // serial -> device info
const events = [];         // network events (ring buffer)
let adbAvailable = true;
let iosAvailable = null;   // null = not probed yet, false = no Xcode tooling on this machine
let iosRetryAt = 0;
const agents = new Map();      // agent key -> { ws, ident } (in-app layout agents)
const layouts = new Map();     // serial -> last captured layout tree
const screenshots = new Map(); // serial -> PNG Buffer pushed by an agent with its layout

// ---------- adb ----------
async function adb(...args) {
  const { stdout } = await exec(ADB, args, { timeout: 8000 });
  return stdout.trim();
}

function parseDevicesList(raw) {
  return raw
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const props = Object.fromEntries(
        rest.filter((p) => p.includes(":")).map((p) => p.split(":"))
      );
      return { serial, state, props };
    });
}

async function enrich(serial, props) {
  const prop = async (k) => {
    try { return await adb("-s", serial, "shell", "getprop", k); } catch { return ""; }
  };
  const [model, release, sdk, manufacturer, androidId] = await Promise.all([
    prop("ro.product.model"),
    prop("ro.build.version.release"),
    prop("ro.build.version.sdk"),
    prop("ro.product.manufacturer"),
    adb("-s", serial, "shell", "settings", "get", "secure", "android_id").catch(() => ""),
  ]);
  const isVirtual =
    serial.startsWith("emulator-") ||
    /sdk|gphone|emulator|avd/i.test(model) ||
    /genymotion|google/i.test(manufacturer) && /sdk|gphone/i.test(model);

  let avdName = "";
  if (serial.startsWith("emulator-")) {
    avdName = (await prop("ro.kernel.qemu.avd_name")) || (await prop("ro.boot.qemu.avd_name"));
  }
  return {
    serial,
    platform: "android",
    model: model || props.model || serial,
    manufacturer,
    release,
    sdk,
    androidId,
    avdName,
    type: isVirtual ? "virtual" : "physical",
  };
}

async function setupReverse(serial) {
  try {
    await adb("-s", serial, "reverse", `tcp:${PORT}`, `tcp:${PORT}`);
    return true;
  } catch (e) {
    console.warn(`[adb] reverse failed for ${serial}: ${e.message}`);
    return false;
  }
}

// ---------- ios: simulators via simctl, physical devices via devicectl ----------
async function xcrun(args) {
  const { stdout } = await exec(XCRUN, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// "com.apple.CoreSimulator.SimRuntime.iOS-17-5" -> { os: "iOS", release: "17.5" }
function runtimeLabel(runtime) {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)(?:-(\d+))?/.exec(runtime || "");
  return m ? { os: m[1], release: [m[2], m[3], m[4]].filter(Boolean).join(".") } : { os: "iOS", release: "" };
}

async function listSimulators() {
  const json = JSON.parse(await xcrun(["simctl", "list", "devices", "--json"]));
  const out = [];
  for (const [runtime, list] of Object.entries(json.devices || {})) {
    const { os: osName, release } = runtimeLabel(runtime);
    for (const d of list) {
      if (d.state !== "Booted") continue;
      out.push({ serial: d.udid, platform: "ios", type: "virtual", state: "device", model: d.name, avdName: d.name,
        manufacturer: "Apple", os: osName, release, sdk: "", androidId: "", reverse: true });
    }
  }
  return out;
}

let devicectlProbed = false, hasDevicectl = false;
async function listPhysicalIos() {
  if (!devicectlProbed) {
    devicectlProbed = true;
    try { await xcrun(["devicectl", "--version"]); hasDevicectl = true; } catch { hasDevicectl = false; }
  }
  if (!hasDevicectl) return [];
  const file = path.join(os.tmpdir(), `devscope-devicectl-${process.pid}.json`);
  await xcrun(["devicectl", "list", "devices", "--json-output", file, "--timeout", "5"]);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const d of json.result?.devices || []) {
    const conn = d.connectionProperties || {};
    if (conn.tunnelState && conn.tunnelState !== "connected") continue;
    const hw = d.hardwareProperties || {}, props = d.deviceProperties || {};
    out.push({ serial: hw.udid || d.identifier, platform: "ios", type: "physical", state: "device",
      model: hw.marketingName || props.name || d.identifier, avdName: props.name || "", manufacturer: "Apple",
      os: hw.platform || "iOS", release: props.osVersionNumber || "", sdk: "", androidId: "", reverse: true });
  }
  return out;
}

// Returns the list of connected iOS devices, or null when the tooling is unavailable
// (no Xcode / simctl missing) so existing entries are kept and we back off for 30 s.
async function pollIos() {
  if (iosAvailable === false && Date.now() < iosRetryAt) return null;
  try {
    const sims = await listSimulators();
    let phys = [];
    try { phys = await listPhysicalIos(); } catch (e) { console.warn(`[ios] devicectl failed: ${e.message.split("\n")[0]}`); }
    if (iosAvailable !== true) {
      iosAvailable = true;
      console.log("[ios] xcrun simctl available");
      broadcast({ type: "tools", adb: adbAvailable, ios: true });
    }
    return [...sims, ...phys];
  } catch (e) {
    if (iosAvailable !== false) {
      iosAvailable = false;
      console.warn(`[ios] simctl not available (no Xcode?): ${e.message.split("\n")[0]}`);
      broadcast({ type: "tools", adb: adbAvailable, ios: false });
    }
    iosRetryAt = Date.now() + 30000;
    return null;
  }
}

async function pollDevices() {
  const seen = new Set();
  let changed = false;

  // Android (adb). On a transient adb failure keep the devices we already know.
  let list = null;
  try {
    list = parseDevicesList(await adb("devices", "-l"));
    if (!adbAvailable) { adbAvailable = true; broadcast({ type: "adb", available: true }); }
  } catch (e) {
    if (adbAvailable) {
      adbAvailable = false;
      console.warn(`[adb] not available: ${e.message}`);
      broadcast({ type: "adb", available: false, error: e.message });
    }
  }
  if (list) {
    for (const d of list) {
      seen.add(d.serial);
      const existing = devices.get(d.serial);
      if (!existing || existing.state !== d.state) {
        const info = d.state === "device"
          ? await enrich(d.serial, d.props)
          : { serial: d.serial, platform: "android", model: d.serial, type: d.serial.startsWith("emulator-") ? "virtual" : "physical" };
        info.state = d.state;
        info.reverse = d.state === "device" ? await setupReverse(d.serial) : false;
        info.connectedAt = existing?.connectedAt ?? Date.now();
        devices.set(d.serial, info);
        changed = true;
        console.log(`[device] ${d.state}: ${info.model} (${d.serial}) ${info.type}`);
      }
    }
  } else {
    for (const [serial, d] of devices) if (d.platform === "android") seen.add(serial);
  }

  // iOS (simctl / devicectl). Simulators reach us through localhost, so no port reverse is needed.
  const ios = await pollIos();
  if (ios) {
    for (const info of ios) {
      seen.add(info.serial);
      if (!devices.has(info.serial)) {
        info.connectedAt = Date.now();
        devices.set(info.serial, info);
        changed = true;
        console.log(`[device] ios: ${info.model} (${info.serial}) ${info.type}`);
      }
    }
  } else {
    for (const [serial, d] of devices) if (d.platform === "ios") seen.add(serial);
  }

  for (const [serial, d] of devices) {
    if (d.platform === "web") continue; // browsers are managed by the web provider, not by polling
    if (d.platform === "node") {        // node processes heartbeat every 20 s through the hook
      if (Date.now() - (d.lastSeen || 0) > NODE_TTL) { devices.delete(serial); changed = true; console.log(`[node] ${d.model} (pid ${d.pid ?? "?"}) gone`); }
      continue;
    }
    if (!seen.has(serial)) {
      devices.delete(serial);
      screenshots.delete(serial);
      changed = true;
      console.log(`[device] disconnected: ${serial}`);
    }
  }
  if (changed) broadcast({ type: "devices", devices: [...devices.values()] });
}

// ---------- http ----------
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
// Kotlin drop-ins, so the setup prompt can embed them and agents can `curl` them.
app.use("/android", express.static(path.join(__dirname, "..", "android"), { setHeaders: (res) => res.type("text/plain; charset=utf-8") }));
app.use("/ios", express.static(path.join(__dirname, "..", "ios"), { setHeaders: (res) => res.type("text/plain; charset=utf-8") }));
app.use("/node", express.static(path.join(__dirname, "..", "node"), { setHeaders: (res) => res.type("text/plain; charset=utf-8") }));

// Node processes preload ~/.devscope/devscope-node.mjs (NODE_OPTIONS=--import); keep it current.
const NODE_HOOK = path.join(os.homedir(), ".devscope", "devscope-node.mjs");
try {
  fs.mkdirSync(path.dirname(NODE_HOOK), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "node", "devscope-node.mjs"), NODE_HOOK);
} catch (e) { console.warn(`[node] could not install hook at ${NODE_HOOK}: ${e.message}`); }

// ---------- node processes (dev servers, BFFs) reporting through the hook ----------
const NODE_TTL = 45000;
function upsertNode(b, { announce } = {}) {
  if (!b?.nodeId) return null;
  const serial = `node:${b.nodeId}`;
  const existing = devices.get(serial);
  const info = existing || {
    serial, platform: "node", type: "server", state: "device", model: b.appId || "node", avdName: b.appId || "",
    manufacturer: "", os: "Node", release: String(b.deviceModel || "").replace(/^Node\s*/, ""), sdk: "", androidId: "",
    reverse: true, connectedAt: Date.now(),
  };
  info.lastSeen = Date.now();
  if (b.pid) info.pid = b.pid;
  if (b.cwd) info.cwd = b.cwd;
  if (b.argv) info.argv = b.argv;
  if (b.host) info.host = b.host;
  if (!existing) {
    devices.set(serial, info);
    console.log(`[node] ${info.model} (pid ${info.pid ?? "?"}, ${info.release}) connected`);
    broadcast({ type: "devices", devices: [...devices.values()] });
  } else if (announce) {
    broadcast({ type: "devices", devices: [...devices.values()] });
  }
  return serial;
}
app.post("/api/node/hello", (req, res) => {
  upsertNode(req.body, { announce: false });
  res.set("Access-Control-Allow-Origin", "*").status(204).end();
});

app.get("/api/state", (_req, res) => {
  res.json({ adbAvailable, devices: [...devices.values()], events });
});

function recordEvent(raw, serial = null) {
  const ev = normalizeEvent(raw);
  if (!serial && raw?.platform === "node" && raw.nodeId) serial = upsertNode(raw);
  ev.device = serial ?? matchDevice(ev);
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  broadcast({ type: "network", event: ev });
  return ev;
}

// Browser-side reporters need CORS; the desktop/mobile drop-ins don't care.
app.options("/ingest", (_req, res) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" }).status(204).end();
});
app.post("/ingest", (req, res) => {
  recordEvent(req.body);
  res.set("Access-Control-Allow-Origin", "*").status(204).end();
});

// ---------- web (Chromium via DevTools protocol) ----------
const web = createWebProvider({
  devices, recordEvent, broadcast, layouts, screenshots,
  devicesChanged: () => { broadcast({ type: "devices", devices: [...devices.values()] }); broadcast({ type: "agents", agents: agentSerials() }); },
});
app.get("/api/web/chrome", (_req, res) => res.json({ chrome: web.chromePath() }));
app.post("/api/web/launch", async (req, res) => {
  try { res.json({ serial: await web.launch({ url: req.body?.url }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/web/attach", async (req, res) => {
  try { res.json({ serial: await web.attach({ port: req.body?.port || 9222 }) }); }
  catch (e) { res.status(500).json({ error: `Could not attach to a browser on port ${req.body?.port || 9222}: ${e.message}` }); }
});
app.delete("/api/web/:serial", async (req, res) => {
  res.status((await web.close(req.params.serial)) ? 204 : 404).end();
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { web.shutdown(); process.exit(0); });
process.on("exit", () => web.shutdown());

app.delete("/api/events", (_req, res) => {
  events.length = 0;
  broadcast({ type: "clear" });
  res.status(204).end();
});

app.get("/api/screenshot/:serial", async (req, res) => {
  const serial = req.params.serial;
  const dev = devices.get(serial);
  try {
    const pushed = screenshots.get(serial);
    if (pushed) return res.type("png").send(pushed);
    if (dev?.platform === "ios") {
      if (dev.type !== "virtual") return res.status(404).json({ error: "No screenshot yet — the in-app agent sends one with each layout capture." });
      const file = path.join(os.tmpdir(), `devscope-shot-${process.pid}.png`);
      await xcrun(["simctl", "io", serial, "screenshot", "--type=png", file]);
      return res.type("png").send(fs.readFileSync(file));
    }
    const { stdout } = await exec(
      ADB,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 10000 }
    );
    res.type("png").send(stdout);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let seq = 0;
function normalizeEvent(b = {}) {
  return {
    id: b.id || `${Date.now()}-${++seq}`,
    receivedAt: Date.now(),
    startedAt: b.startedAt ?? Date.now(),
    durationMs: b.durationMs ?? null,
    method: (b.method || "GET").toUpperCase(),
    url: b.url || "",
    status: b.status ?? null,
    requestHeaders: b.requestHeaders || {},
    requestBody: b.requestBody ?? null,
    responseHeaders: b.responseHeaders || {},
    responseBody: b.responseBody ?? null,
    responseSize: b.responseSize ?? null,
    error: b.error ?? null,
    androidId: b.androidId || null,
    nodeId: b.nodeId || null,
    resourceType: b.resourceType || null,
    simulatorUdid: b.simulatorUdid || null,
    platform: b.platform || (b.androidId ? "android" : null),
    appId: b.appId || null,
    deviceModel: b.deviceModel || null,
  };
}

// Simulators identify themselves exactly (SIMULATOR_UDID). Android's ANDROID_ID is per-app on
// Android 8+ and iOS' identifierForVendor never equals a device UDID, so otherwise fall back to
// the only connected device of that platform.
function resolveSerial({ androidId, simulatorUdid, platform } = {}) {
  if (simulatorUdid && devices.has(simulatorUdid)) return simulatorUdid;
  if (androidId) for (const d of devices.values()) if (d.androidId && d.androidId === androidId) return d.serial;
  const plat = platform || (androidId ? "android" : simulatorUdid ? "ios" : null);
  const pool = [...devices.values()].filter((d) => !plat || d.platform === plat);
  if (pool.length === 1) return pool[0].serial;
  return devices.size === 1 ? [...devices.keys()][0] : null;
}

function matchDevice(ev) { return resolveSerial(ev); }

// ---------- websocket ----------
const server = http.createServer(app);
// Two WS endpoints on one HTTP server need noServer + manual upgrade routing:
// a path-bound WebSocketServer 400s every upgrade that misses its own path.
const wss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const target = pathname === "/ws" ? wss : pathname === "/agent" ? agentWss : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

function agentSerials() {
  const out = new Set(web.serials());
  for (const { ident } of agents.values()) {
    const serial = resolveSerial(ident);
    if (serial) out.add(serial);
  }
  return [...out];
}

function agentForSerial(serial) {
  const dev = devices.get(serial);
  if (!dev) return null;
  for (const { ws, ident } of agents.values()) {
    if (ident.simulatorUdid && ident.simulatorUdid === serial) return ws;
    if (ident.androidId && dev.androidId && ident.androidId === dev.androidId) return ws;
  }
  const same = [...agents.values()].filter(({ ident }) => ident.platform === dev.platform);
  if (same.length === 1) return same[0].ws;
  return agents.size === 1 ? [...agents.values()][0].ws : null;
}

// Browsers on the Layout page with Live on. The agent only streams layout
// changes while at least one browser watches its device.
const layoutWatchers = new Map(); // serial -> Set<browser ws>

function syncAgentWatch(serial) {
  const on = (layoutWatchers.get(serial)?.size ?? 0) > 0;
  if (web.has(serial)) { web.setWatch(serial, on); return; }
  const agent = agentForSerial(serial);
  if (agent && agent.readyState === 1) agent.send(JSON.stringify({ type: "layout.watch", on, serial }));
}

function unwatchAll(ws) {
  for (const [serial, set] of layoutWatchers) {
    if (set.delete(ws)) { if (!set.size) layoutWatchers.delete(serial); syncAgentWatch(serial); }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "hello", adbAvailable, ios: iosAvailable, devices: [...devices.values()], events,
    agents: agentSerials(), layouts: Object.fromEntries(layouts),
  }));
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "layout.capture" && web.has(msg.serial)) {
      web.capture(msg.serial).catch((e) => ws.send(JSON.stringify({ type: "layout.error", serial: msg.serial, error: e.message })));
    } else if (msg.type === "layout.capture") {
      const agent = agentForSerial(msg.serial);
      if (!agent || agent.readyState !== 1) {
        ws.send(JSON.stringify({ type: "layout.error", serial: msg.serial, error: "No layout agent connected for this device. Launch a debug build with DevScope." }));
        return;
      }
      agent.send(JSON.stringify({ type: "layout.dump", serial: msg.serial }));
    } else if (msg.type === "layout.watch" && msg.serial) {
      unwatchAll(ws);
      if (!layoutWatchers.has(msg.serial)) layoutWatchers.set(msg.serial, new Set());
      layoutWatchers.get(msg.serial).add(ws);
      syncAgentWatch(msg.serial);
    } else if (msg.type === "layout.unwatch") {
      unwatchAll(ws);
    }
  });
  ws.on("close", () => unwatchAll(ws));
});

// In-app agents connect here (Android through the adb reverse tunnel, iOS simulators via
// localhost, iPhones via Bonjour discovery of this server).
agentWss.on("connection", (ws) => {
  let key = null, ident = null;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "hello") {
      ident = {
        androidId: msg.androidId || null,
        simulatorUdid: msg.simulatorUdid || null,
        vendorId: msg.vendorId || null,
        platform: msg.platform || (msg.androidId ? "android" : "ios"),
        appId: msg.appId || null,
      };
      key = ident.simulatorUdid || ident.androidId || ident.vendorId || `anon-${Date.now()}`;
      agents.set(key, { ws, ident });
      console.log(`[agent] connected: ${ident.appId ?? "?"} (${ident.platform}, ${key})`);
      broadcast({ type: "agents", agents: agentSerials() });
      for (const serial of layoutWatchers.keys()) syncAgentWatch(serial);
    } else if (msg.type === "layout.tree") {
      const serial = msg.serial || resolveSerial(ident || {});
      if (!serial) return;
      if (typeof msg.screenshot === "string" && msg.screenshot) {
        try { screenshots.set(serial, Buffer.from(msg.screenshot, "base64")); } catch { /* ignore bad data */ }
      }
      const layout = { serial, activity: msg.activity ?? null, capturedAt: Date.now(), tree: msg.tree };
      layouts.set(serial, layout);
      broadcast({ type: "layout", layout });
    } else if (msg.type === "layout.error") {
      broadcast({ type: "layout.error", serial: msg.serial || resolveSerial(ident || {}), error: msg.error });
    }
  });
  ws.on("close", () => {
    if (key && agents.get(key)?.ws === ws) {
      agents.delete(key);
      console.log(`[agent] disconnected: ${key}`);
      broadcast({ type: "agents", agents: agentSerials() });
    }
  });
});

// iPhones on the same Wi-Fi find this server through Bonjour (_devscope._tcp).
async function advertise() {
  try {
    const { Bonjour } = await import("bonjour-service");
    new Bonjour().publish({ name: `DevScope on ${os.hostname()}`, type: "devscope", port: PORT });
    console.log("[bonjour] advertising _devscope._tcp");
  } catch (e) {
    console.warn(`[bonjour] not advertising (${e.message.split("\n")[0]}) — physical iPhones need DevScope.serverHost`);
  }
}

server.listen(PORT, () => {
  console.log(`DevScope running at http://localhost:${PORT}`);
  console.log(`Apps report to http://localhost:${PORT}/ingest — Android via adb reverse, iOS simulators via localhost, iPhones via Bonjour`);
  pollDevices();
  setInterval(pollDevices, POLL_MS);
  advertise();
});
