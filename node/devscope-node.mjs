// DevScope hook for Node.js processes (dev servers, BFFs, React Router / Remix / Next loaders).
// Nothing to add to your project — preload it when you start the process:
//
//     NODE_OPTIONS="--import $HOME/.devscope/devscope-node.mjs" npm run dev
//
// It mirrors every outgoing HTTP call made with fetch() (undici) or the http/https modules
// (axios, got, node-fetch, …) to the DevScope server — method, URL, headers, bodies, timing —
// and registers the process as a device. Needs Node 18.19+/20.6+. Set DEVSCOPE_URL to reach a
// server other than http://localhost:8765. Never throws into the host application.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.env.DEVSCOPE_URL || "http://localhost:8765").replace(/\/+$/, "");
// Package managers inherit NODE_OPTIONS too (pnpm run dev, npm install…); their registry
// traffic is noise, so the hook stays inert in them and only instruments the app processes.
const IS_PACKAGE_MANAGER = /(^|[\/\\])(pnpm|npm|npx|yarn|corepack|npm-cli|pnpm-cli)(\.c?js|\.mjs)?$/i.test(process.argv[1] || "");
const MAX = 512 * 1024;
const TEXT = /json|text|xml|javascript|x-www-form-urlencoded|graphql|event-stream/i;
const own = (() => { try { return new URL(BASE); } catch { return null; } })();
const nodeId = randomUUID().slice(0, 8);
const appId = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).name || path.basename(process.cwd()); }
  catch { return path.basename(process.cwd()); }
})();
const common = { platform: "node", nodeId, appId, deviceModel: `Node ${process.versions.node}`, pid: process.pid };

function isOwn(url) {
  try { const u = new URL(url); return !!own && u.hostname === own.hostname && (u.port || (u.protocol === "https:" ? "443" : "80")) === (own.port || "80"); }
  catch { return false; }
}
function isText(ct) { return !ct || TEXT.test(ct); }
function post(pathname, body) {
  try {
    const mod = BASE.startsWith("https:") ? https : http;
    const req = mod.request(BASE + pathname, { method: "POST", headers: { "content-type": "application/json" }, timeout: 2000 }, (res) => res.resume());
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(JSON.stringify(body));
  } catch { /* never disturb the app */ }
}

// Presence: the process shows up as a device after its first captured request, then heartbeats.
let helloTimer = null;
function hello() {
  post("/api/node/hello", { ...common, cwd: process.cwd(), host: os.hostname(), argv: process.argv.slice(1).map((a) => path.basename(a)).join(" ").slice(0, 80) });
  if (!helloTimer) { helloTimer = setInterval(hello, 20000); helloTimer.unref(); }
}
function report(ev) {
  if (!helloTimer) hello();
  post("/ingest", { ...common, ...ev });
}
function headersToObject(h) {
  const o = {};
  try { for (const [k, v] of h) o[k] = v; } catch {}
  return o;
}
function truncateText(s) { return s.length > MAX ? s.slice(0, MAX) + "\n… [truncated by DevScope]" : s; }

// ---------- fetch (undici) ----------
const origFetch = globalThis.fetch;
if (!IS_PACKAGE_MANAGER && typeof origFetch === "function") {
  globalThis.fetch = async function devscopeFetch(input, init) {
    let url = "";
    try { url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? input); } catch {}
    if (!/^https?:/i.test(url) || isOwn(url)) return origFetch.call(this, input, init);
    const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const method = (init?.method || req?.method || "GET").toUpperCase();
    const startedAt = Date.now(), t0 = performance.now();
    let requestHeaders = {};
    try { requestHeaders = headersToObject(new Headers(init?.headers || req?.headers || {})); } catch {}
    let requestBody = null;
    try {
      const b = init?.body;
      if (typeof b === "string") requestBody = truncateText(b);
      else if (b instanceof URLSearchParams) requestBody = b.toString();
      else if (typeof FormData !== "undefined" && b instanceof FormData) requestBody = "<FormData>";
      else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) requestBody = `<binary ${b.byteLength} bytes>`;
      else if (b && typeof b.getReader === "function") requestBody = "<streamed body>";
      else if (!b && req && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && !req.bodyUsed) { try { requestBody = truncateText(await req.clone().text()); } catch {} }
    } catch {}
    let res;
    try { res = await origFetch.call(this, input, init); }
    catch (err) {
      report({ startedAt, durationMs: Math.round(performance.now() - t0), method, url, requestHeaders, requestBody, error: String(err?.cause || err) });
      throw err;
    }
    try {
      const durationMs = Math.round(performance.now() - t0);
      const responseHeaders = headersToObject(res.headers);
      const ct = res.headers.get("content-type") || "";
      const size = Number(res.headers.get("content-length")) || null;
      const base = { startedAt, durationMs, method, url, status: res.status, requestHeaders, requestBody, responseHeaders, responseSize: size };
      if (!res.body || !isText(ct)) { report({ ...base, responseBody: res.body ? `<binary ${ct}>` : null }); return res; }
      const clone = res.clone();
      (async () => {
        let text = null;
        try {
          const reader = clone.body.getReader();
          const chunks = []; let got = 0, truncated = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            got += value.byteLength;
            if (got <= MAX) chunks.push(value); else { truncated = true; try { await reader.cancel(); } catch {} break; }
          }
          text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") + (truncated ? "\n… [truncated by DevScope]" : "");
        } catch { text = null; }
        report({ ...base, responseBody: text, responseSize: size ?? (text ? Buffer.byteLength(text) : null) });
      })();
      return res;
    } catch { return res; }
  };
}

// ---------- http / https (axios, got, node-fetch v2, …) ----------
function requestUrl(req, args) {
  let url = null, opts = null;
  try {
    if (typeof args[0] === "string") url = new URL(args[0]);
    else if (args[0] instanceof URL) url = args[0];
    else if (args[0] && typeof args[0] === "object") opts = args[0];
    if (args[1] && typeof args[1] === "object") opts = { ...(opts || {}), ...args[1] };
  } catch {}
  const proto = req.protocol || url?.protocol || "http:";
  const hostHeader = req.getHeader ? req.getHeader("host") : null;
  const host = hostHeader || url?.host || opts?.hostname || opts?.host || "localhost";
  const port = url?.port || opts?.port || "";
  const defaultPort = proto === "https:" ? "443" : "80";
  const hostport = String(host).includes(":") || !port || String(port) === defaultPort ? host : `${host}:${port}`;
  const p = req.path || (url ? url.pathname + url.search : opts?.path) || "/";
  return `${proto}//${hostport}${p}`;
}
// Clients such as axios delete `content-encoding` from res.headers once they have decompressed
// the body themselves, so besides the header we sniff the magic bytes of gzip/deflate.
function decodeBody(buf, encoding) {
  try {
    const gzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const deflate = buf.length > 2 && buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1]);
    if (gzip || /gzip/i.test(encoding)) return zlib.gunzipSync(buf);
    if (deflate || /deflate/i.test(encoding)) return zlib.inflateSync(buf);
    if (/br/i.test(encoding)) return zlib.brotliDecompressSync(buf);
  } catch { return null; }
  return buf;
}
function instrument(req, args) {
  try {
    const url = requestUrl(req, args);
    if (!/^https?:/i.test(url) || isOwn(url)) return req;
    const startedAt = Date.now(), t0 = performance.now();
    const reqChunks = []; let reqSize = 0, reported = false;
    const capture = (c, enc) => {
      if (!c || typeof c === "function") return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === "string" ? enc : "utf8");
      if (reqSize < MAX) reqChunks.push(b.subarray(0, MAX - reqSize));
      reqSize += b.length;
    };
    const origWrite = req.write, origEnd = req.end;
    req.write = function (chunk, enc, cb) { capture(chunk, enc); return origWrite.call(this, chunk, enc, cb); };
    req.end = function (chunk, enc, cb) { if (chunk && typeof chunk !== "function") capture(chunk, enc); return origEnd.call(this, chunk, enc, cb); };
    const requestBody = () => {
      if (!reqChunks.length) return null;
      const ct = String(req.getHeader("content-type") || "");
      if (!isText(ct)) return `<binary ${ct}>`;
      return Buffer.concat(reqChunks).toString("utf8") + (reqSize > MAX ? "\n… [truncated by DevScope]" : "");
    };
    const send = (patch) => {
      if (reported) return;
      reported = true;
      report({ startedAt, durationMs: Math.round(performance.now() - t0), method: req.method, url, requestHeaders: req.getHeaders(), requestBody: requestBody(), ...patch });
    };
    req.once("response", (res) => {
      const chunks = []; let size = 0;
      const encodingAtStart = String(res.headers["content-encoding"] || "");
      const origPush = res.push;
      // The parser feeds the body through push(); observing it here sees every byte without
      // touching the stream's flowing/paused state, so the app reads exactly what it would have.
      res.push = function (chunk, enc) {
        try { if (chunk) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc); size += b.length; if (size <= MAX) chunks.push(b); } } catch {}
        return origPush.call(this, chunk, enc);
      };
      const finish = (err) => {
        const ct = String(res.headers["content-type"] || "");
        let text = null;
        if (isText(ct)) {
          if (size > MAX) text = `<body of ${size} bytes not captured: larger than 512 KB>`;
          else { const dec = decodeBody(Buffer.concat(chunks), encodingAtStart || String(res.headers["content-encoding"] || "")); text = dec ? dec.toString("utf8") : "<undecodable body>"; }
        } else if (ct) text = `<binary ${ct}>`;
        send({ status: res.statusCode, responseHeaders: res.headers, responseBody: text, responseSize: size, error: err ? String(err) : null });
      };
      res.once("end", () => finish(null));
      res.once("error", (e) => finish(e));
      res.once("aborted", () => finish(new Error("aborted")));
    });
    req.once("error", (e) => send({ error: String(e) }));
  } catch { /* never disturb the app */ }
  return req;
}
for (const mod of IS_PACKAGE_MANAGER ? [] : [http, https]) {
  const origRequest = mod.request, origGet = mod.get;
  mod.request = function (...args) { return instrument(origRequest.apply(this, args), args); };
  mod.get = function (...args) { return instrument(origGet.apply(this, args), args); };
}
