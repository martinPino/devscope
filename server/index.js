import express from "express";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8765);
const ADB = process.env.ADB || "adb";
const POLL_MS = 2000;
const MAX_EVENTS = 2000;

// ---------- state ----------
const devices = new Map(); // serial -> device info
const events = [];         // network events (ring buffer)
let adbAvailable = true;
const agents = new Map();  // androidId -> ws (in-app layout agents)
const layouts = new Map(); // serial -> last captured layout tree

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

async function pollDevices() {
  let list;
  try {
    list = parseDevicesList(await adb("devices", "-l"));
    if (!adbAvailable) { adbAvailable = true; broadcast({ type: "adb", available: true }); }
  } catch (e) {
    if (adbAvailable) {
      adbAvailable = false;
      console.warn(`[adb] not available: ${e.message}`);
      broadcast({ type: "adb", available: false, error: e.message });
    }
    return;
  }

  const seen = new Set();
  let changed = false;

  for (const d of list) {
    seen.add(d.serial);
    const existing = devices.get(d.serial);
    if (!existing || existing.state !== d.state) {
      const info = d.state === "device"
        ? await enrich(d.serial, d.props)
        : { serial: d.serial, model: d.serial, type: d.serial.startsWith("emulator-") ? "virtual" : "physical" };
      info.state = d.state;
      info.reverse = d.state === "device" ? await setupReverse(d.serial) : false;
      info.connectedAt = existing?.connectedAt ?? Date.now();
      devices.set(d.serial, info);
      changed = true;
      console.log(`[device] ${d.state}: ${info.model} (${d.serial}) ${info.type}`);
    }
  }
  for (const serial of devices.keys()) {
    if (!seen.has(serial)) {
      devices.delete(serial);
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

app.get("/api/state", (_req, res) => {
  res.json({ adbAvailable, devices: [...devices.values()], events });
});

app.post("/ingest", (req, res) => {
  const ev = normalizeEvent(req.body);
  ev.device = matchDevice(ev);
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  broadcast({ type: "network", event: ev });
  res.status(204).end();
});

app.delete("/api/events", (_req, res) => {
  events.length = 0;
  broadcast({ type: "clear" });
  res.status(204).end();
});

app.get("/api/screenshot/:serial", async (req, res) => {
  try {
    const { stdout } = await exec(
      ADB,
      ["-s", req.params.serial, "exec-out", "screencap", "-p"],
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
    appId: b.appId || null,
    deviceModel: b.deviceModel || null,
  };
}

function matchDevice(ev) {
  if (ev.androidId) {
    for (const d of devices.values()) if (d.androidId === ev.androidId) return d.serial;
  }
  if (devices.size === 1) return [...devices.keys()][0];
  return null;
}

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

function serialForAndroidId(androidId) {
  for (const d of devices.values()) if (d.androidId === androidId) return d.serial;
  return devices.size === 1 ? [...devices.keys()][0] : null;
}

// ANDROID_ID is per-app on Android 8+, so it rarely equals the device's global
// android_id. Match exactly when we can, else fall back to the sole device.
function agentSerials() {
  const out = new Set();
  for (const aid of agents.keys()) {
    const serial = serialForAndroidId(aid);
    if (serial) out.add(serial);
  }
  return [...out];
}

function agentForSerial(serial) {
  const dev = devices.get(serial);
  if (dev) for (const [aid, ws] of agents) if (aid === dev.androidId) return ws;
  return agents.size === 1 ? [...agents.values()][0] : null;
}

// Browsers on the Layout page with Live on. The agent only streams layout
// changes while at least one browser watches its device.
const layoutWatchers = new Map(); // serial -> Set<browser ws>

function syncAgentWatch(serial) {
  const agent = agentForSerial(serial);
  const on = (layoutWatchers.get(serial)?.size ?? 0) > 0;
  if (agent && agent.readyState === 1) agent.send(JSON.stringify({ type: "layout.watch", on, serial }));
}

function unwatchAll(ws) {
  for (const [serial, set] of layoutWatchers) {
    if (set.delete(ws)) { if (!set.size) layoutWatchers.delete(serial); syncAgentWatch(serial); }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "hello", adbAvailable, devices: [...devices.values()], events,
    agents: agentSerials(), layouts: Object.fromEntries(layouts),
  }));
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "layout.capture") {
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

// In-app agents connect here (through the same adb reverse tunnel as /ingest).
agentWss.on("connection", (ws) => {
  let androidId = null;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "hello") {
      androidId = msg.androidId || "unknown";
      agents.set(androidId, ws);
      console.log(`[agent] connected: ${msg.appId ?? "?"} (${androidId})`);
      broadcast({ type: "agents", agents: agentSerials() });
      for (const serial of layoutWatchers.keys()) syncAgentWatch(serial);
    } else if (msg.type === "layout.tree") {
      const serial = msg.serial || serialForAndroidId(androidId);
      if (!serial) return;
      const layout = { serial, activity: msg.activity ?? null, capturedAt: Date.now(), tree: msg.tree };
      layouts.set(serial, layout);
      broadcast({ type: "layout", layout });
    } else if (msg.type === "layout.error") {
      broadcast({ type: "layout.error", serial: msg.serial || serialForAndroidId(androidId), error: msg.error });
    }
  });
  ws.on("close", () => {
    if (androidId && agents.get(androidId) === ws) {
      agents.delete(androidId);
      console.log(`[agent] disconnected: ${androidId}`);
      broadcast({ type: "agents", agents: agentSerials() });
    }
  });
});

server.listen(PORT, () => {
  console.log(`DevScope running at http://localhost:${PORT}`);
  console.log(`Apps on connected devices report to http://localhost:${PORT}/ingest (via adb reverse)`);
  pollDevices();
  setInterval(pollDevices, POLL_MS);
});
