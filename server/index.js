import express from "express";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebProvider } from "./web.js";
import { createWebkitProvider } from "./webkit.js";
import { scanUsbPhones } from "./usb.js";
import { listIosDevices, iosDeviceInfo, iosModelName } from "./usbmux.js";

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
      let [serial, state, ...rest] = line.split(/\s+/);
      if (state === "no" && rest[0] === "permissions") { state = "no permissions"; rest = rest.slice(1); }
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

// ---------- connection type, guidance, USB-only phones ----------
function adbConnection(serial) {
  if (serial.startsWith("emulator-")) return "emulator";
  if (/:\d+$/.test(serial) || /_adb-tls-connect\._tcp/.test(serial)) return "wifi";
  return "usb";
}
const ADB_HINTS = {
  unauthorized: "Unlock the phone and accept “Allow USB debugging” (tick “Always allow from this computer”).",
  authorizing: "Waiting for the “Allow USB debugging” prompt on the phone.",
  offline: "adb sees the phone but it does not answer — replug the cable or toggle USB debugging.",
  "no permissions": "adb has no permission for this USB device — run `adb kill-server` and replug (Linux: check udev rules).",
};
const IOS_NOTE = "Recognized over USB. The app's DevScope agent reports over Wi-Fi (same network, Bonjour) or DevScope.serverHost — iOS has no adb-reverse equivalent.";

// ---------- Chrome / WebViews on Android, through adb forward + DevTools protocol ----------
const adbBrowsers = new Map(); // `${serial}:${socket}` -> { port, serial }
async function syncAndroidBrowsers(serial, info) {
  let sockets;
  try {
    const out = await adb("-s", serial, "shell", "cat /proc/net/unix 2>/dev/null | grep -a devtools_remote || true");
    sockets = [...new Set(out.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter((n) => n && n.startsWith("@")).map((n) => n.slice(1)))];
  } catch { return; }
  for (const sock of sockets) {
    const key = `${serial}:${sock}`;
    if (adbBrowsers.has(key)) continue;
    adbBrowsers.set(key, { port: 0, serial });
    try {
      const port = Number((await adb("-s", serial, "forward", "tcp:0", `localabstract:${sock}`)).trim());
      if (!port) throw new Error("adb forward returned no port");
      adbBrowsers.get(key).port = port;
      let label = sock === "chrome_devtools_remote" ? "Chrome" : sock.startsWith("webview_devtools_remote_") ? "WebView" : sock.replace(/_devtools_remote.*$/, "");
      if (label === "WebView") {
        try { const pkg = (await adb("-s", serial, "shell", `cat /proc/${sock.split("_").pop()}/cmdline`)).split("\0")[0].trim(); if (pkg) label = `WebView · ${pkg}`; } catch { /* keep generic label */ }
      }
      await web.attach({
        port, serial: key, label, parent: serial,
        onRemove: () => { adbBrowsers.delete(key); adb("-s", serial, "forward", "--remove", `tcp:${port}`).catch(() => {}); },
      });
      console.log(`[web] ${label} on ${info.avdName || info.model} attached through adb forward :${port}`);
    } catch (e) {
      const b = adbBrowsers.get(key);
      adbBrowsers.delete(key);
      if (b?.port) adb("-s", serial, "forward", "--remove", `tcp:${b.port}`).catch(() => {});
    }
  }
  for (const [key, b] of adbBrowsers) {
    if (b.serial === serial && b.port && !sockets.includes(key.slice(serial.length + 1))) web.close(key);
  }
}

// ---------- iOS devices through usbmuxd (no Xcode needed) ----------
const iosInfoCache = new Map(); // udid -> lockdown info
async function pollUsbmux() {
  let list;
  try { list = await listIosDevices(); } catch { return null; }
  const byUdid = new Map();
  for (const d of list) if (!byUdid.has(d.udid) || d.connection === "usb") byUdid.set(d.udid, d); // prefer the cable
  const out = [];
  for (const d of byUdid.values()) {
    if (!iosInfoCache.has(d.udid)) {
      try { iosInfoCache.set(d.udid, await iosDeviceInfo(d.deviceId)); } catch { /* locked / not trusted yet: retry next poll */ }
    }
    const i = iosInfoCache.get(d.udid) || {};
    const isPad = /ipad/i.test(i.deviceClass || i.productType || "");
    out.push({
      serial: d.udid, platform: "ios", type: "physical", state: "device", source: "usbmux",
      connection: d.connection === "network" ? "wifi" : "usb",
      model: iosModelName(i.productType) || i.deviceClass || "iPhone", avdName: i.name || "", manufacturer: "Apple",
      os: isPad ? "iPadOS" : "iOS", release: i.productVersion || "", sdk: "", androidId: "", reverse: true,
      note: IOS_NOTE, hint: i.productVersion ? null : "Unlock the device and tap “Trust” to read its name and iOS version.",
    });
  }
  return out;
}

// A poll now talks to adb, the USB bus, usbmuxd and the inspectors; never let two overlap.
let polling = false;
async function pollDevices() {
  if (polling) return;
  polling = true;
  try { await pollDevicesOnce(); }
  catch (e) { console.warn(`[poll] ${e.message}`); }
  finally { polling = false; }
}

async function pollDevicesOnce() {
  const seen = new Set();
  let changed = false;
  const usbPhones = await scanUsbPhones();

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
        const usb = usbPhones.find((p) => p.serial && p.serial === d.serial);
        const info = d.state === "device"
          ? await enrich(d.serial, d.props)
          : { serial: d.serial, platform: "android", model: usb?.label || d.props.model || d.serial, type: d.serial.startsWith("emulator-") ? "virtual" : "physical" };
        info.state = d.state;
        info.connection = adbConnection(d.serial);
        info.hint = ADB_HINTS[d.state] || null;
        info.reverse = d.state === "device" ? await setupReverse(d.serial) : false;
        info.connectedAt = existing?.connectedAt ?? Date.now();
        devices.set(d.serial, info);
        changed = true;
        console.log(`[device] ${d.state}: ${info.model} (${d.serial}) ${info.type} via ${info.connection}`);
      }
    }
    // Chrome and debuggable WebViews running on each phone (zero code, DevTools protocol over adb).
    await Promise.all(list.filter((d) => d.state === "device").map((d) => syncAndroidBrowsers(d.serial, devices.get(d.serial)).catch(() => {})));
  } else {
    for (const [serial, d] of devices) if (d.platform === "android" && !d.source) seen.add(serial);
  }

  // Android phones on the USB bus that adb does not list: debugging off, or no adb at all.
  const adbSerials = new Set((list || []).map((d) => d.serial));
  const adbHasUsb = (list || []).some((d) => adbConnection(d.serial) === "usb");
  for (const p of usbPhones.filter((x) => x.kind === "android")) {
    if (p.serial ? adbSerials.has(p.serial) : adbHasUsb) continue;
    const serial = `usb:${p.serial || `${p.vendorId}:${p.productId}`}`;
    seen.add(serial);
    if (!devices.has(serial)) {
      devices.set(serial, {
        serial, platform: "android", type: "physical", state: "usb-only", connection: "usb", source: "usb",
        model: p.label, manufacturer: p.vendor || "", release: "", sdk: "", androidId: "", reverse: false, connectedAt: Date.now(),
        hint: adbAvailable
          ? "Plugged in, but adb does not list it: enable Developer options → USB debugging on the phone, then accept the prompt."
          : "Plugged in, but adb is not available on this machine — install Android platform-tools or set ADB.",
      });
      changed = true;
      console.log(`[usb] android phone without adb: ${p.label}`);
    }
  }

  // iOS simulators / devicectl (needs Xcode). Simulators reach us through localhost.
  const ios = await pollIos();
  if (ios) {
    for (const info of ios) {
      seen.add(info.serial);
      const existing = devices.get(info.serial);
      if (!existing || existing.source === "usb") {
        info.connectedAt = existing?.connectedAt ?? Date.now();
        devices.set(info.serial, info);
        changed = true;
        console.log(`[device] ios: ${info.model} (${info.serial}) ${info.type}`);
      }
    }
  } else {
    for (const [serial, d] of devices) if (d.platform === "ios" && !d.source) seen.add(serial);
  }

  // iPhones / iPads known to usbmuxd — USB and paired Wi-Fi — even on Macs without Xcode.
  const mux = await pollUsbmux();
  if (mux) {
    for (const info of mux) {
      seen.add(info.serial);
      const existing = devices.get(info.serial);
      const differs = !existing || existing.connection !== info.connection || existing.release !== info.release || existing.avdName !== info.avdName || (existing.source === "usb");
      if (differs) {
        const merged = existing && !existing.source ? { ...existing, connection: info.connection, note: info.note } : { ...info, connectedAt: existing?.connectedAt ?? Date.now() };
        devices.set(info.serial, merged);
        changed = true;
        if (!existing) console.log(`[device] ios: ${info.avdName || info.model} (${info.serial.slice(0, 13)}…) over ${info.connection}`);
      }
    }
    // Safari / WKWebViews on those devices (Web Inspector through ios-webkit-debug-proxy).
    const udids = mux.map((d) => d.serial);
    await webkit.sync(udids).catch(() => {});
    for (const udid of udids) {
      const d = devices.get(udid);
      if (!d) continue;
      const tabs = webkit.tabsFor(udid);
      const webNote = !webkit.proxyAvailable()
        ? " To inspect Safari and WebViews on it: brew install ios-webkit-debug-proxy."
        : tabs ? "" : " To inspect Safari: enable Settings → Apps → Safari → Advanced → Web Inspector and open a page.";
      const note = IOS_NOTE + webNote;
      if (d.note !== note) { d.note = note; changed = true; }
    }
  } else {
    // No usbmuxd here: at least show Apple devices seen on the bus.
    for (const p of usbPhones.filter((x) => x.kind === "ios")) {
      seen.add(p.udid);
      if (!devices.has(p.udid)) {
        devices.set(p.udid, { serial: p.udid, platform: "ios", type: "physical", state: "device", connection: "usb", source: "usb", model: p.label, avdName: "",
          manufacturer: "Apple", os: "iOS", release: "", sdk: "", androidId: "", reverse: true, note: IOS_NOTE, connectedAt: Date.now() });
        changed = true;
      }
    }
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
      iosInfoCache.delete(serial);
      for (const [key, b] of adbBrowsers) if (b.serial === serial) web.close(key);
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

// ---------- Docker projects: pick a folder once, DevScope does the rest ----------
// A saved project is a folder with a compose file. "Connect" finds its Node services, writes
// ~/.devscope/<folder>.devscope.yml (hook mounted + DEVSCOPE_URL), recreates those services and
// opens Chrome. The app URL is learned from the first page opened in that Chrome, then reused.
const DOCKER_ENV = { ...process.env, PATH: [process.env.PATH, "/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin"].filter(Boolean).join(path.delimiter) };
const PROJECTS_FILE = path.join(os.homedir(), ".devscope", "projects.json");
let projects = [];
try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); } catch { /* none yet */ }
const saveProjects = () => { try { fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true }); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects.map(({ dir, url, lastUrl }) => ({ dir, url: url || null, lastUrl: lastUrl || null })), null, 2)); } catch (e) { console.warn(`[docker] could not save projects: ${e.message}`); } };
const learning = new Map(); // chrome serial -> project dir whose URL we are waiting to learn
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const dockerErr = (e) => httpError(e.code === "ENOENT" ? "Docker CLI not found — is Docker Desktop / OrbStack installed?" : String(e.stderr || e.message).trim().split("\n").slice(-6).join("\n"), 500);

function composeFiles(dir) {
  const pick = (names) => names.filter((n) => fs.existsSync(path.join(dir, n))).slice(0, 1);
  const base = pick(["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]);
  if (!base.length && !process.env.COMPOSE_FILE) throw httpError("No docker compose file in that folder.");
  return [...base, ...pick(["compose.override.yaml", "compose.override.yml", "docker-compose.override.yml", "docker-compose.override.yaml"])];
}
const composeArgs = (dir, ...rest) => ["compose", ...(process.env.COMPOSE_FILE ? [] : composeFiles(dir).flatMap((f) => ["-f", f])), ...rest];
// Services that run Node: build context with a package.json, a node image, or a node-ish command.
async function composeConfig(dir) {
  const { stdout } = await exec("docker", composeArgs(dir, "config", "--format", "json"), { cwd: dir, env: DOCKER_ENV, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).catch((e) => { throw dockerErr(e); });
  return JSON.parse(stdout);
}
function nodeServices(dir, cfg) {
  const cmdText = (v) => (Array.isArray(v) ? v.join(" ") : String(v || ""));
  return Object.entries(cfg.services || {}).filter(([, svc]) => {
    const ctx = typeof svc.build === "string" ? svc.build : svc.build?.context;
    if (ctx && fs.existsSync(path.join(path.resolve(dir, ctx), "package.json"))) return true;
    if (/(^|\/)node(:|$)/.test(String(svc.image || ""))) return true;
    return /\b(node|pnpm|npm|npx|yarn|vite|next)\b/.test(cmdText(svc.command) + " " + cmdText(svc.entrypoint));
  }).map(([name]) => name);
}
// The address the app is served on: a reverse proxy in the compose file (nginx server blocks that
// proxy_pass to the Node service) wins; otherwise the service's published port on localhost.
function confFiles(cfg) {
  const out = [];
  const walk = (p, depth) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) { if (/\.conf$/.test(p)) out.push(p); }
      else if (st.isDirectory() && depth < 3) for (const n of fs.readdirSync(p)) { if (out.length < 200 && n !== "node_modules") walk(path.join(p, n), depth + 1); }
    } catch { /* unreadable */ }
  };
  for (const svc of Object.values(cfg.services || {})) {
    for (const v of svc.volumes || []) if (v.type === "bind" && v.source && /nginx|conf|caddy|proxy/i.test(String(v.target) + String(v.source))) walk(v.source, 0);
  }
  return out;
}
function serverBlocks(text) {
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth) { const c = text[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
    blocks.push(text.slice(re.lastIndex, i));
    re.lastIndex = i;
  }
  return blocks;
}
// A proxy block often lists several hostnames (strom.…, gas.…). Prefer the one the app's own
// sources mention most (start scripts, configs, .env), so the product the team works on wins.
function mentionScores(dir, names) {
  const score = Object.fromEntries(names.map((n) => [n, 0]));
  let files = 0;
  const walk = (p, depth) => {
    if (files > 400) return;
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 3) return;
      let list = []; try { list = fs.readdirSync(p); } catch { return; }
      for (const n of list) if (!/^(node_modules|\.git|build|dist|coverage|storybook-static.*|public)$/.test(n)) walk(path.join(p, n), depth + 1);
    } else if (st.size < 200 * 1024 && /\.(sh|env|ts|js|mjs|json|ya?ml|md|conf|dockerfile)$|^(Dockerfile|\.env.*)$/i.test(path.basename(p))) {
      files++;
      let text = ""; try { text = fs.readFileSync(p, "utf8"); } catch { return; }
      for (const n of names) {
        const re = new RegExp(`(^|[^A-Za-z0-9.-])${n.replace(/\./g, "\\.")}(?![A-Za-z0-9-])`, "g");
        score[n] += (text.match(re) || []).length;
      }
    }
  };
  walk(dir, 0);
  return score;
}
function deriveUrl(cfg, services, dir) {
  const found = [];
  for (const file of confFiles(cfg)) {
    let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const block of serverBlocks(text)) {
      const upstream = [...block.matchAll(/proxy_pass\s+https?:\/\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
      const names = (block.match(/server_name\s+([^;]+);/)?.[1] || "").split(/\s+/).filter((n) => n && !/[*~_$]/.test(n));
      const listen = block.match(/listen\s+(?:\[::\]:)?(\d+)([^;]*);/);
      if (!names.length || !listen) continue;
      const port = Number(listen[1]), tls = /\bssl\b/.test(listen[2]) || port === 443;
      for (const up of upstream) if (services.includes(up)) found.push({ service: up, names, tls, port });
    }
  }
  for (const svc of services) {
    const hit = found.find((f) => f.service === svc);
    if (!hit) continue;
    const ctx = typeof cfg.services[svc].build === "string" ? cfg.services[svc].build : cfg.services[svc].build?.context;
    const scores = ctx ? mentionScores(path.resolve(dir, ctx), hit.names) : {};
    const name = [...hit.names].sort((x, y) => (scores[y] || 0) - (scores[x] || 0))[0];
    return `${hit.tls ? "https" : "http"}://${name}${hit.port === (hit.tls ? 443 : 80) ? "" : `:${hit.port}`}/`;
  }
  for (const svc of services) {
    const pub = (cfg.services[svc].ports || []).find((p) => p.published);
    if (pub) return `http://localhost:${pub.published}/`;
  }
  return null;
}
// A recreated container gets a new IP and nginx resolves `proxy_pass http://svc` only at start,
// so reload any nginx in the project; then hold back Chrome until the app answers (no 502 page).
async function reloadProxies(dir, cfg) {
  for (const [name, svc] of Object.entries(cfg.services || {})) {
    if (!/nginx/i.test(String(svc.image || ""))) continue;
    await exec("docker", composeArgs(dir, "exec", "-T", name, "nginx", "-s", "reload"), { cwd: dir, env: DOCKER_ENV, timeout: 20000 }).catch((e) => console.warn(`[docker] could not reload ${name}: ${String(e.stderr || e.message).trim().split("\n")[0]}`));
  }
}
function probe(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 20000, headers: { "user-agent": "DevScope" } }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.on("error", (e) => resolve({ status: 0, code: e.code }));
  });
}
async function waitForApp(url, timeoutMs = 4 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let ok = 0; // two answers in a row, so a proxy or port that is still flapping does not count
  while (Date.now() < deadline) {
    const r = await probe(url);
    if (r.code === "ENOTFOUND") return false; // hostname not resolvable here: nothing to wait on
    ok = r.status && r.status < 500 ? ok + 1 : 0;
    if (ok >= 2) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}
function pickFolder() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === "darwin"
      ? ["osascript", ["-e", 'POSIX path of (choose folder with prompt "Select the project folder that contains your docker compose file")']]
      : ["zenity", ["--file-selection", "--directory", "--title=Select the project folder with your docker compose file"]];
    execFile(cmd, args, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      if (err) return err.code === 1 ? resolve(null) : reject(httpError("Could not open a folder picker on this system.", 500));
      resolve(stdout.trim().replace(/\/$/, "") || null);
    });
  });
}
const publicProject = (p) => ({ dir: p.dir, name: path.basename(p.dir), url: p.url || null });
app.get("/api/projects", (_req, res) => res.json(projects.map(publicProject)));
app.post("/api/projects/add", async (_req, res) => {
  try {
    const dir = await pickFolder();
    if (!dir) return res.json({ cancelled: true });
    composeFiles(dir);
    if (!projects.some((p) => p.dir === dir)) { projects.push({ dir, url: null }); saveProjects(); }
    res.json(publicProject(projects.find((p) => p.dir === dir)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete("/api/projects", (req, res) => {
  projects = projects.filter((p) => p.dir !== req.body?.dir);
  saveProjects();
  res.status(204).end();
});
// One Chrome per project: reuse (and bring forward) the one DevScope opened before, else launch.
const projectChrome = new Map(); // project dir -> chrome serial
const opening = new Map(); // project dir -> in-flight open, so quick double clicks share one Chrome
function openProjectChrome(project, url) {
  if (!opening.has(project.dir)) opening.set(project.dir, openProjectChromeNow(project, url).finally(() => opening.delete(project.dir)));
  return opening.get(project.dir);
}
async function openProjectChromeNow(project, url) {
  const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
  const known = projectChrome.get(project.dir)
    // after a DevScope restart: an attached Chrome already showing the app counts too
    || web.serials().find((sr) => url && hostOf(devices.get(sr)?.url) === hostOf(url));
  if (known && (await web.focus(known, url))) { projectChrome.set(project.dir, known); return known; }
  // DevScope restarted while its Chrome stayed open: re-attach the debug ports it uses (9222+).
  if (url) {
    for (let port = 9222; port < 9232; port++) {
      const sr = await web.attach({ port }).catch(() => null);
      if (!sr) continue;
      await new Promise((r) => setTimeout(r, 300));
      if (hostOf(devices.get(sr)?.url) === hostOf(url) && (await web.focus(sr, url))) { projectChrome.set(project.dir, sr); return sr; }
    }
  }
  const serial = await web.launch({ url: url || undefined });
  projectChrome.set(project.dir, serial);
  return serial;
}
// Node device -> project: the hook reports the container hostname, which is the short container id.
async function projectForNode(dev) {
  if (projects.length === 1) return projects[0];
  for (const p of projects) {
    try {
      const { stdout } = await exec("docker", composeArgs(p.dir, "ps", "-q"), { cwd: p.dir, env: DOCKER_ENV, timeout: 10000 });
      if (dev.host && stdout.split("\n").some((id) => id && id.startsWith(dev.host))) return p;
    } catch { /* not a running project */ }
  }
  return null;
}
app.post("/api/node/focus", async (req, res) => {
  try {
    const dev = devices.get(req.body?.serial);
    if (!dev || dev.platform !== "node") throw httpError("Unknown Node process", 404);
    const project = await projectForNode(dev);
    if (!project) return res.json({ ok: false, reason: "no-project" });
    let url = project.url || project.lastUrl || null;
    if (!url) { try { const cfg = await composeConfig(project.dir); url = project.lastUrl = deriveUrl(cfg, nodeServices(project.dir, cfg), project.dir); } catch { /* open blank */ } }
    const serial = await openProjectChrome(project, url);
    res.json({ ok: true, serial });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
const connecting = new Set(); // project dirs with a connect in flight
app.post("/api/projects/connect", async (req, res) => {
  if (connecting.has(req.body?.dir)) return res.status(409).json({ error: "This project is already starting — Chrome opens when the app answers." });
  connecting.add(req.body?.dir);
  try {
    const project = projects.find((p) => p.dir === req.body?.dir);
    if (!project) throw httpError("Unknown project", 404);
    const dir = project.dir;
    const cfg = await composeConfig(dir);
    const services = nodeServices(dir, cfg);
    const appUrl = project.url || deriveUrl(cfg, services, dir);
    if (!services.length) throw httpError("No Node service found in this project's compose file.");
    const override = path.join(os.homedir(), ".devscope", `${path.basename(dir).replace(/[^A-Za-z0-9_.-]/g, "-")}.devscope.yml`);
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "node", "devscope-node.mjs"), NODE_HOOK);
    fs.writeFileSync(override, `# Generated by DevScope — preloads the Node hook. Undo: docker compose up -d --force-recreate ${services.join(" ")}
services:
${services.map((svc) => `  ${svc}:
    environment:
      NODE_OPTIONS: "--import /devscope/devscope-node.mjs"
      DEVSCOPE_URL: "http://host.docker.internal:${PORT}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - \${HOME}/.devscope:/devscope:ro
`).join("")}`);
    const args = composeArgs(dir, "-f", override, "up", "-d", "--force-recreate", ...services);
    console.log(`[docker] docker ${args.join(" ")} (in ${dir})`);
    await exec("docker", args, { cwd: dir, env: DOCKER_ENV, timeout: 300000 }).catch((e) => { throw dockerErr(e); });
    await reloadProxies(dir, cfg);
    if (appUrl) await waitForApp(appUrl);
    if (project.lastUrl !== appUrl) { project.lastUrl = appUrl; saveProjects(); }
    let serial = null;
    try { serial = await openProjectChrome(project, appUrl); } catch (e) { console.warn(`[docker] connected, but Chrome did not open: ${e.message}`); }
    if (serial && !appUrl) learning.set(serial, dir);
    res.json({ ok: true, services, url: appUrl, chrome: !!serial, serial });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  finally { connecting.delete(req.body?.dir); }
});

app.get("/api/state", (_req, res) => {
  res.json({ adbAvailable, devices: [...devices.values()], events });
});

function recordEvent(raw, serial = null) {
  const ev = normalizeEvent(raw);
  if (!serial && raw?.platform === "node" && raw.nodeId) serial = upsertNode(raw);
  ev.device = serial ?? matchDevice(ev);
  if (ev.resourceType === "Document" && learning.has(ev.device) && ev.status && ev.status < 400 && /^https?:/.test(ev.url)) {
    const project = projects.find((p) => p.dir === learning.get(ev.device));
    learning.delete(ev.device);
    if (project && !project.url) { project.url = ev.url; saveProjects(); }
  }
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
const webkit = createWebkitProvider({
  devices, recordEvent, broadcast, layouts, screenshots,
  devicesChanged: () => { broadcast({ type: "devices", devices: [...devices.values()] }); broadcast({ type: "agents", agents: agentSerials() }); },
});
app.get("/api/web/chrome", (_req, res) => res.json({ chrome: web.chromePath() }));
app.get("/api/web/tabs", (req, res) => res.json(webkit.describe(String(req.query.serial || ""))));
app.post("/api/web/reload", async (req, res) => {
  const serial = req.body?.serial;
  if (!webkit.has(serial) && !web.has(serial)) return res.status(404).json({ error: "Unknown browser (not attached yet?)" });
  try { await (webkit.has(serial) ? webkit.reload(serial) : web.reload(serial)); res.status(204).end(); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
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
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { web.shutdown(); webkit.shutdown(); process.exit(0); });
process.on("exit", () => { web.shutdown(); webkit.shutdown(); });

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
  const out = new Set([...web.serials(), ...webkit.serials()]);
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
  if (webkit.has(serial)) { webkit.setWatch(serial, on); return; }
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
    if (msg.type === "layout.capture" && webkit.has(msg.serial)) {
      webkit.capture(msg.serial).catch((e) => ws.send(JSON.stringify({ type: "layout.error", serial: msg.serial, error: e.message })));
    } else if (msg.type === "layout.capture" && web.has(msg.serial)) {
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
