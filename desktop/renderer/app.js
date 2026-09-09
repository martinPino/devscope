const $ = (s) => document.querySelector(s);
const api = window.devscope;
if (api.platform === "darwin") document.body.classList.add("mac");
let state = null;
let currentUrl = null;

function render() {
  if (!state) return;
  const running = state.status === "running";
  const busy = state.status === "starting" || state.status === "stopping";
  $("#dot").className = `dot ${state.error && !running ? "error" : state.status}`;
  $("#statusText").textContent =
    state.status === "running" ? `Running on :${state.port}${state.external ? " (external)" : ""}` :
    state.status === "starting" ? "Starting…" :
    state.status === "stopping" ? "Stopping…" : "Stopped";
  const t = $("#toggle");
  t.textContent = running ? (state.external ? "Detach" : "Stop server") : "Start server";
  t.className = running ? "danger" : "primary";
  t.disabled = busy;
  $("#idleStart").disabled = busy;
  $("#openExternal").disabled = !running;
  $("#idlePort").textContent = `localhost:${state.port}`;
  const adbBox = $("#adb");
  adbBox.classList.toggle("missing", !state.adb);
  $("#adbPath").textContent = state.adb ? "\u200E" + state.adb + "\u200E" : "not found";
  $("#adbPath").title = state.adb || "";
  $("#adbHint").hidden = !!state.adb;
  $("#idleErr").hidden = !state.error;
  $("#idleErr").textContent = state.error || "";

  const frame = $("#app");
  if (running) {
    if (currentUrl !== state.url) { currentUrl = state.url; frame.src = state.url; }
    frame.hidden = false; $("#idle").hidden = true;
  } else {
    if (currentUrl) { currentUrl = null; frame.src = "about:blank"; }
    frame.hidden = true; $("#idle").hidden = false;
  }
}

function appendLog(line) {
  const pre = $("#logBody");
  const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  pre.textContent += line + "\n";
  if (stick) pre.scrollTop = pre.scrollHeight;
}

async function init() {
  const s = await api.getState();
  state = s.state;
  $("#autoStart").checked = !!s.settings.autoStart;
  $("#logBody").textContent = s.logs.join("\n") + (s.logs.length ? "\n" : "");
  render();
}
api.onState((s) => { state = s; render(); });
api.onLog(appendLog);
api.onReloadUi(() => { if (currentUrl) $("#app").src = currentUrl; });

// The embedded UI asks us to copy (iframes can't reliably reach the clipboard); main does it via Electron.
window.addEventListener("message", async (ev) => {
  const frame = $("#app");
  if (!currentUrl || ev.source !== frame.contentWindow || ev.origin !== new URL(currentUrl).origin) return;
  if (ev.data?.type !== "devscope:copy") return;
  const ok = await api.copyText(String(ev.data.text ?? "")).catch(() => false);
  ev.source.postMessage({ type: "devscope:copied", id: ev.data.id, ok }, ev.origin);
});

const toggle = () => (state?.status === "running" ? api.stop() : api.start());
$("#toggle").onclick = toggle;
$("#idleStart").onclick = () => api.start();
$("#openExternal").onclick = () => state?.url && api.openExternal(state.url);
$("#autoStart").onchange = (e) => api.setSetting("autoStart", e.target.checked);
$("#chooseAdb").onclick = () => api.chooseAdb();
$("#toggleLogs").onclick = () => { $("#logs").hidden = !$("#logs").hidden; };
$("#closeLogs").onclick = () => { $("#logs").hidden = true; };
$("#clearLogs").onclick = () => { $("#logBody").textContent = ""; };
init();
