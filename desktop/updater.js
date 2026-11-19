// "Check for Updates…" for the desktop app. Releases are ad-hoc signed (no Developer ID), which
// Squirrel.Mac / electron-updater refuse, so this updater does it by hand: read the latest GitHub
// release, download the zip for this Mac's architecture, verify it against SHA256SUMS.txt, unpack
// it with ditto and, once DevScope has quit, swap the .app bundle in place and relaunch it.
// Files fetched by Node carry no quarantine flag, so Gatekeeper does not stop the new version.
import { app, dialog, shell } from "electron";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = "martinPino/devscope";
// DEVSCOPE_UPDATE_URL points at another "latest release" JSON (tests, mirrors).
const LATEST_URL = process.env.DEVSCOPE_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

function newer(a, b) { // a > b for "x.y.z"
  const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
// Markdown release notes → a few plain lines for a native dialog.
function plainNotes(md) {
  return String(md || "").split("\n## Download")[0]
    .replace(/^#+\s*/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 900);
}
// /Applications/DevScope.app — the bundle that holds the running executable.
function currentBundle() {
  const p = path.resolve(app.getPath("exe"), "..", "..", "..");
  return p.endsWith(".app") ? p : null;
}

export function createUpdater({ getWindow, log, settings, saveSettings }) {
  let busy = false;

  async function latest() {
    const res = await fetch(LATEST_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "DevScope" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    return { version: String(rel.tag_name || "").replace(/^v/, ""), notes: rel.body || "", page: rel.html_url || RELEASES_PAGE, assets: rel.assets || [] };
  }

  async function download(url, file, onProgress) {
    const res = await fetch(url, { headers: { "user-agent": "DevScope" }, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    const out = fs.createWriteStream(file);
    const hash = createHash("sha256");
    let got = 0;
    for await (const chunk of res.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (total) onProgress(got / total);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    return hash.digest("hex");
  }

  async function install(rel) {
    const win = getWindow();
    const bundle = currentBundle();
    if (process.platform !== "darwin" || !bundle || (!app.isPackaged && !process.env.DEVSCOPE_UPDATE_URL)) {
      await shell.openExternal(rel.page); return;
    }
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); }
    catch { await dialog.showMessageBox(win, { type: "warning", message: "DevScope cannot replace itself", detail: `No write access to ${path.dirname(bundle)}. Download the new version from the release page instead.` }); await shell.openExternal(rel.page); return; }

    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const zipName = `DevScope-${rel.version}-${arch}-mac.zip`;
    const zip = rel.assets.find((a) => a.name === zipName);
    const sums = rel.assets.find((a) => a.name === "SHA256SUMS.txt");
    if (!zip) throw new Error(`The release has no ${zipName}`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "devscope-update-"));
    try { await prepareAndSwap(rel, bundle, zip, sums, zipName, work, win); }
    catch (e) { fs.rmSync(work, { recursive: true, force: true }); throw e; }
  }

  async function prepareAndSwap(rel, bundle, zip, sums, zipName, work, win) {
    const zipFile = path.join(work, zipName);
    log(`[update] downloading ${zipName}`);
    const sha = await download(zip.browser_download_url, zipFile, (f) => win?.setProgressBar(f));
    win?.setProgressBar(-1);
    if (sums) {
      const text = await (await fetch(sums.browser_download_url, { headers: { "user-agent": "DevScope" } })).text();
      const expected = text.split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === zipName)?.[0];
      if (!expected) throw new Error(`${zipName} is not listed in SHA256SUMS.txt`);
      if (expected !== sha) throw new Error("Checksum mismatch — the download is corrupt, nothing was changed.");
    }
    const unpacked = path.join(work, "app");
    await exec("ditto", ["-x", "-k", zipFile, unpacked]);
    const fresh = path.join(unpacked, "DevScope.app");
    if (!fs.existsSync(path.join(fresh, "Contents", "MacOS"))) throw new Error("The downloaded zip holds no DevScope.app");
    await exec("xattr", ["-dr", "com.apple.quarantine", fresh]).catch(() => {});

    // After DevScope exits: move the old bundle aside, put the new one in place, relaunch.
    // If the move fails the old bundle is restored, so the user is never left without an app.
    const script = path.join(work, "swap.sh");
    fs.writeFileSync(script, `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
OLD="$1"; NEW="$2"; BAK="$1.old-$$"
mv "$OLD" "$BAK" || exit 1
if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
open "$OLD"
rm -rf "${work}"
`);
    fs.chmodSync(script, 0o755);
    log(`[update] installing ${rel.version} into ${bundle} and relaunching`);
    spawn("/bin/sh", [script, bundle, fresh], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  }

  async function check({ interactive }) {
    if (busy) return;
    busy = true;
    const win = getWindow();
    try {
      const rel = await latest();
      const current = app.getVersion();
      if (!newer(rel.version, current)) {
        if (interactive) await dialog.showMessageBox(win, { type: "info", message: "DevScope is up to date", detail: `You have version ${current}, the latest release.` });
        return;
      }
      if (!interactive && settings.skipVersion === rel.version) return;
      const auto = process.env.DEVSCOPE_UPDATE_AUTO === "1"; // tests: accept without a click
      const { response } = auto ? { response: 0 } : await dialog.showMessageBox(win, {
        type: "info",
        message: `DevScope ${rel.version} is available`,
        detail: `You have ${current}.\n\n${plainNotes(rel.notes)}`,
        buttons: ["Update and Restart", "Release Notes", interactive ? "Later" : "Skip This Version", ...(interactive ? [] : ["Later"])],
        defaultId: 0, cancelId: interactive ? 2 : 3,
      });
      if (response === 0) await install(rel);
      else if (response === 1) await shell.openExternal(rel.page);
      else if (response === 2 && !interactive) { settings.skipVersion = rel.version; saveSettings(); }
    } catch (e) {
      log(`[update] ${e.message}`);
      win?.setProgressBar(-1);
      if (interactive) await dialog.showMessageBox(win, { type: "error", message: "Could not update DevScope", detail: e.message });
    } finally { busy = false; }
  }

  return {
    checkNow: () => check({ interactive: true }),
    checkInBackground: () => check({ interactive: false }),
  };
}

export { newer, plainNotes };
