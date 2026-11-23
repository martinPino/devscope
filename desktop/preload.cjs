const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("devscope", {
  getState: () => ipcRenderer.invoke("state"),
  start: () => ipcRenderer.invoke("start"),
  stop: () => ipcRenderer.invoke("stop"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  chooseAdb: () => ipcRenderer.invoke("choose-adb"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
  onReloadUi: (cb) => ipcRenderer.on("reload-ui", () => cb()),
  update: {
    pending: () => ipcRenderer.invoke("update:pending"),
    install: () => ipcRenderer.invoke("update:install"),
    notes: () => ipcRenderer.invoke("update:notes"),
    dismiss: (skip) => ipcRenderer.invoke("update:dismiss", !!skip),
    onAvailable: (cb) => ipcRenderer.on("update:available", (_e, u) => cb(u)),
    onProgress: (cb) => ipcRenderer.on("update:progress", (_e, f) => cb(f)),
    onError: (cb) => ipcRenderer.on("update:error", (_e, m) => cb(m)),
    onClose: (cb) => ipcRenderer.on("update:close", () => cb()),
  },
  platform: process.platform,
});
