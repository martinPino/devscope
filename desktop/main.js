// DevScope desktop shell. Runs the DevScope server as a child process and shows
// the web UI in a window, so no terminal is needed to start it.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell, utilityProcess } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server", "index.js");
const DEFAULTS = { autoStart: false, adbPath: "", port: 8765 };

let win = null;
let child = null;
let settings = { ...DEFAULTS };
const logs = [];
const state = { status: "stopped", port: DEFAULTS.port, adb: null, external: false, url: null, error: null };

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { /* first run */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { log(`[desktop] could not save settings: ${e.message}`); }
}
const publicSettings = () => ({ ...settings, detectedAdb: findAdb() });

// ---------- adb discovery ----------
// GUI apps launched from Finder get a minimal PATH, so look in the usual SDK spots too.
function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
function findAdb() {
  const bin = process.platform === "win32" ? "adb.exe" : "adb";
  const home = os.homedir();
  const candidates = [
    settings.adbPath,
    process.env.ADB,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, bin)),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", bin),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", bin),
    path.join(home, "Library", "Android", "sdk", "platform-tools", bin),
    path.join(home, "Android", "Sdk", "platform-tools", bin),
    path.join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", bin),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ].filter(Boolean);
  return candidates.find(isExecutable) || null;
}

// ---------- server lifecycle ----------
function log(line) {
  const entry = `${new Date().toLocaleTimeString()}  ${line}`;
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  win?.webContents.send("log", entry);
}
function setState(patch) {
  Object.assign(state, patch);
  win?.webContents.send("state", state);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

async function startServer() {
  if (state.status === "running" || state.status === "starting") return;
  const port = Number(settings.port) || DEFAULTS.port;
  const url = `http://localhost:${port}`;
  if (await probe(port)) {
    log(`[desktop] a DevScope server already answers on :${port} — attaching to it`);
    setState({ status: "running", external: true, url, port, error: null });
    return;
  }
  const adb = findAdb();
  setState({ status: "starting", adb, external: false, url: null, port, error: null });
  log(`[desktop] starting server on :${port} (adb: ${adb ?? "not found"})`);

  child = utilityProcess.fork(SERVER_ENTRY, [], {
    serviceName: "devscope-server",
    stdio: "pipe",
    env: { ...process.env, PORT: String(port), ...(adb ? { ADB: adb } : {}) },
  });
  const pipe = (stream) => stream?.on("data", (d) => String(d).split("\n").filter(Boolean).forEach(log));
  pipe(child.stdout);
  pipe(child.stderr);
  child.once("exit", (code) => {
    const wasStopping = state.status === "stopping";
    child = null;
    log(`[desktop] server exited (code ${code})`);
    setState({ status: "stopped", url: null, error: wasStopping || code === 0 ? null : `Server exited with code ${code} — see logs` });
  });

  for (let i = 0; i < 40 && child; i++) {
    await sleep(150);
    if (await probe(port)) { setState({ status: "running", url }); return; }
  }
  if (child) setState({ error: "Server did not answer in time — see logs" });
}

function stopServer() {
  if (state.external) { setState({ status: "stopped", external: false, url: null }); return; }
  if (!child) return;
  setState({ status: "stopping" });
  child.kill();
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600,
    title: "DevScope",
    backgroundColor: "#1e232c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Server",
      submenu: [
        { label: "Start server", accelerator: "CmdOrCtrl+R", click: () => startServer() },
        { label: "Stop server", accelerator: "CmdOrCtrl+.", click: () => stopServer() },
        { type: "separator" },
        { label: "Open in browser", accelerator: "CmdOrCtrl+Shift+O", click: () => state.url && shell.openExternal(state.url) },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload UI", accelerator: "CmdOrCtrl+Shift+R", click: () => win?.webContents.send("reload-ui") },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- ipc ----------
ipcMain.handle("state", () => ({ state, settings: publicSettings(), logs }));
ipcMain.handle("start", () => startServer());
ipcMain.handle("stop", () => stopServer());
ipcMain.handle("set-setting", (_e, key, value) => {
  if (key in DEFAULTS) { settings[key] = value; saveSettings(); }
  if (key === "adbPath") setState({ adb: findAdb() });
  return publicSettings();
});
ipcMain.handle("choose-adb", async () => {
  const res = await dialog.showOpenDialog(win, { title: "Select the adb executable", properties: ["openFile", "showHiddenFiles"] });
  if (!res.canceled && res.filePaths[0]) { settings.adbPath = res.filePaths[0]; saveSettings(); setState({ adb: findAdb() }); }
  return publicSettings();
});
ipcMain.handle("open-external", (_e, url) => shell.openExternal(String(url)));
ipcMain.handle("copy-text", async (_e, text) => { await clipboard.writeText(String(text ?? "")); return true; });

// ---------- dev hook: DEVSCOPE_SCREENSHOT=/path.png captures the window, DEVSCOPE_QUIT_AFTER=1 exits ----------
function scheduleScreenshot() {
  const file = process.env.DEVSCOPE_SCREENSHOT;
  if (!file) return;
  setTimeout(async () => {
    try { fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error(e); }
    if (process.env.DEVSCOPE_QUIT_AFTER) app.quit();
  }, Number(process.env.DEVSCOPE_SCREENSHOT_DELAY || 4000));
}

// ---------- dev hook: DEVSCOPE_E2E_COPY=1 clicks "Copy prompt" in the embedded UI and reports the clipboard ----------
async function e2eCopyCheck() {
  if (process.env.DEVSCOPE_E2E_COPY !== "1") return;
  const deadline = Date.now() + 20000;
  let frame = null;
  while (Date.now() < deadline && !frame) {
    await sleep(250);
    frame = win?.webContents.mainFrame.frames.find((f) => state.url && f.url.startsWith(state.url)) ?? null;
  }
  if (!frame) { console.log(JSON.stringify({ e2e: "copy", error: "embedded UI frame not found" })); app.exit(1); return; }
  await sleep(1000);
  await clipboard.writeText("sentinel");
  const r = await frame.executeJavaScript(`(async () => {
    document.querySelector("#setup").click(); await new Promise((r) => setTimeout(r, 600));
    document.querySelector("#setupCopy").click(); await new Promise((r) => setTimeout(r, 800));
    const t = document.querySelector("#setupPrompt").textContent;
    return { button: document.querySelector("#setupCopy").textContent, promptLen: t.length, head: t.slice(0, 40) };
  })()`, true);
  const clip = await clipboard.readText();
  console.log(JSON.stringify({ e2e: "copy", ...r, clipboardLen: clip.length, clipboardMatchesPrompt: clip.length === r.promptLen && clip.slice(0, 40) === r.head }));
  app.exit(0);
}

// ---------- app ----------
// Dev runs (`npm run desktop`) keep their own settings and single-instance lock,
// so they never collide with an installed DevScope.app.
if (!app.isPackaged) app.setPath("userData", app.getPath("userData") + "-dev");

// Single instance: launching DevScope again just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}
app.whenReady().then(() => {
  loadSettings();
  if (process.env.DEVSCOPE_PORT) settings.port = Number(process.env.DEVSCOPE_PORT) || settings.port; // per-launch override, not persisted
  state.port = Number(settings.port) || DEFAULTS.port;
  state.adb = findAdb();
  buildMenu();
  createWindow();
  if (settings.autoStart || process.env.DEVSCOPE_AUTOSTART === "1") startServer();
  scheduleScreenshot();
  e2eCopyCheck();
  app.on("activate", () => { if (!win) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (child) { child.kill(); child = null; } });
