// Minimal usbmuxd + lockdownd client. usbmuxd ships with macOS (and with iTunes / Apple
// Devices on Windows, usbmuxd on Linux), so iPhones and iPads are discovered — over USB and
// over paired Wi-Fi — without Xcode or libimobiledevice. Unpaired devices still answer the
// basic lockdown keys (name, model, iOS version), like `ideviceinfo -s`.
import net from "node:net";
import * as plistNs from "plist";
const plist = plistNs.default ?? plistNs; // CJS/ESM interop: the package exposes named exports only in some builds

const SOCKET = process.env.USBMUXD_SOCKET_ADDRESS || "/var/run/usbmuxd";
const LOCKDOWN_PORT = 62078;
const swap16 = (p) => ((p & 0xff) << 8) | ((p >> 8) & 0xff);

function connectMux() {
  return new Promise((resolve, reject) => {
    const opts = /^\d+$/.test(SOCKET) ? { port: Number(SOCKET), host: "127.0.0.1" } : SOCKET.includes(":") && !SOCKET.startsWith("/")
      ? { host: SOCKET.split(":")[0], port: Number(SOCKET.split(":")[1]) } : { path: SOCKET };
    const sock = net.connect(opts);
    sock.setTimeout(4000, () => sock.destroy(new Error("usbmuxd timeout")));
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

// usbmux framing: 16-byte little-endian header (length, version=1, type=8 plist, tag) + XML plist.
function muxSend(sock, payload, tag = 1) {
  const body = Buffer.from(plist.build(payload));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(8, 8); head.writeUInt32LE(tag, 12);
  sock.write(Buffer.concat([head, body]));
}
function muxRead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      sock.off("data", onData); sock.off("error", reject);
      try { resolve({ message: plist.parse(buf.subarray(16, len).toString("utf8")), rest: buf.subarray(len) }); } catch (e) { reject(e); }
    };
    sock.on("data", onData); sock.once("error", reject);
  });
}

/** [{ udid, deviceId, connection: "usb" | "network", productId, locationId }] */
export async function listIosDevices() {
  const sock = await connectMux();
  try {
    muxSend(sock, { MessageType: "ListDevices", ClientVersionString: "devscope", ProgName: "devscope", kLibUSBMuxVersion: 3 });
    const { message } = await muxRead(sock);
    return (message.DeviceList || []).map((d) => d.Properties || {}).map((p) => ({
      udid: String(p.SerialNumber || ""), deviceId: p.DeviceID, productId: p.ProductID ?? null, locationId: p.LocationID ?? null,
      connection: /network/i.test(p.ConnectionType || "") ? "network" : "usb",
    })).filter((d) => d.udid);
  } finally { sock.destroy(); }
}

// lockdown framing on the tunnelled socket: 4-byte big-endian length + XML plist.
function lockdownRequest(sock, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(plist.build({ Label: "devscope", ...payload }));
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      sock.off("data", onData); sock.off("error", reject);
      try { resolve(plist.parse(buf.subarray(4, 4 + len).toString("utf8"))); } catch (e) { reject(e); }
    };
    sock.on("data", onData); sock.once("error", reject);
    sock.write(Buffer.concat([head, body]));
  });
}

/** { name, productType, productVersion, deviceClass } — best effort, works on unpaired devices too. */
export async function iosDeviceInfo(deviceId) {
  const sock = await connectMux();
  try {
    muxSend(sock, { MessageType: "Connect", DeviceID: deviceId, PortNumber: swap16(LOCKDOWN_PORT), ProgName: "devscope" });
    const { message } = await muxRead(sock);
    if (message.Number !== 0) throw new Error(`usbmux connect refused (${message.Number})`);
    const out = {};
    for (const [key, field] of [["DeviceName", "name"], ["ProductType", "productType"], ["ProductVersion", "productVersion"], ["DeviceClass", "deviceClass"]]) {
      try { const r = await lockdownRequest(sock, { Request: "GetValue", Key: key }); if (r.Value != null) out[field] = String(r.Value); } catch { /* key not available */ }
    }
    return out;
  } finally { sock.destroy(); }
}

// Marketing names for the identifiers people actually plug in today; falls back to the raw type.
const MODELS = {
  "iPhone11,2": "iPhone XS", "iPhone11,8": "iPhone XR", "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE (2nd gen)", "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,6": "iPhone SE (3rd gen)",
  "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,5": "iPhone 16e",
};
export const iosModelName = (productType) => MODELS[productType] || productType || "";
