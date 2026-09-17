// USB discovery: recognizes phones physically plugged in even when adb / Xcode tooling does
// not list them (USB debugging off, not authorized, no Xcode), so DevScope can say what is
// missing. macOS: ioreg (fast, no dependencies). Linux: lsusb (no serial numbers). Others: none.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IOREG = process.env.DEVSCOPE_IOREG || "ioreg";

const APPLE_VENDOR = 0x05ac;
// Vendors that (almost) only ship phones/tablets under this id.
const ANDROID_VENDORS = new Map([
  [0x18d1, "Google"], [0x2717, "Xiaomi"], [0x2a70, "OnePlus"], [0x22d9, "OPPO / realme"], [0x2d95, "vivo"],
  [0x22b8, "Motorola"], [0x0bb4, "HTC"], [0x2ae5, "Fairphone"], [0x2e04, "HMD / Nokia"], [0x339b, "Honor"],
  [0x19d2, "ZTE"], [0x1bbb, "TCL"], [0x2a45, "Meizu"], [0x29a9, "Nothing"],
]);
// Vendors that also sell SSDs, modems, laptops…: the product name has to look like a phone.
const MIXED_VENDORS = new Map([
  [0x04e8, "Samsung"], [0x12d1, "Huawei"], [0x0fce, "Sony"], [0x1004, "LG"], [0x17ef, "Lenovo"], [0x0b05, "ASUS"],
]);
const PHONE_LIKE = /android|galaxy|\bsm-|pixel|phone|xperia|\bmtp\b|\badb\b|redmi|poco|moto/i;
const NOT_A_PHONE = /ssd|portable|flash|disk|storage|hub|keyboard|mouse|audio|headset|monitor|dock|lan\b|ethernet|camera|printer|receiver|dongle|modem|card reader/i;

export function normalizeUdid(serial) {
  const s = String(serial || "").trim();
  if (/^[0-9a-fA-F]{24}$/.test(s)) return `${s.slice(0, 8)}-${s.slice(8)}`.toUpperCase(); // iPhone XS and later
  return s.toLowerCase();
}

export function classify(dev) {
  const product = dev.product || "";
  if (dev.vendorId === APPLE_VENDOR && /iphone|ipad|ipod/i.test(product)) {
    return { ...dev, kind: "ios", udid: normalizeUdid(dev.serial), label: product };
  }
  if (NOT_A_PHONE.test(product)) return { ...dev, kind: null };
  if (ANDROID_VENDORS.has(dev.vendorId)) return { ...dev, kind: "android", label: product || ANDROID_VENDORS.get(dev.vendorId) };
  if (MIXED_VENDORS.has(dev.vendorId) && PHONE_LIKE.test(product)) return { ...dev, kind: "android", label: product };
  return { ...dev, kind: null };
}

// `ioreg -p IOUSB -w0 -l`: one "+-o Name@…  <class IOUSBHostDevice…>" header per node, then its properties.
export function parseIoreg(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.isDevice && (cur.vendorId || cur.product)) out.push(cur); cur = null; };
  for (const line of String(text).split("\n")) {
    const head = /\+-o (.+?)@[0-9a-fA-F]+\s+<class (\w+)/.exec(line);
    if (head) { flush(); cur = { isDevice: /^IOUSBHostDevice$|^IOUSBDevice$/.test(head[2]), nodeName: head[1].trim() }; continue; }
    if (!cur) continue;
    const prop = /"([^"]+)"\s*=\s*(?:"([^"]*)"|(\d+))/.exec(line);
    if (!prop) continue;
    const [, key, str, num] = prop;
    if (key === "USB Product Name") cur.product = str;
    else if (key === "USB Vendor Name") cur.vendor = str;
    else if (key === "USB Serial Number" || key === "kUSBSerialNumberString") cur.serial = cur.serial || str;
    else if (key === "idVendor") cur.vendorId = Number(num);
    else if (key === "idProduct") cur.productId = Number(num);
  }
  flush();
  return out.map(({ isDevice, nodeName, ...d }) => ({ product: d.product || nodeName, ...d })).map(classify);
}

// `lsusb`: "Bus 001 Device 004: ID 18d1:4ee7 Google Inc. Nexus/Pixel Device (charging + debug)"
export function parseLsusb(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s+(.*)$/.exec(line);
    if (m) out.push(classify({ vendorId: parseInt(m[1], 16), productId: parseInt(m[2], 16), product: m[3].trim(), vendor: "", serial: "" }));
  }
  return out;
}

let warned = false;
/** Phones currently on the USB bus: [{ kind: "android"|"ios", label, serial, udid?, vendor, vendorId, productId }] */
export async function scanUsbPhones() {
  try {
    if (process.platform === "darwin" || process.env.DEVSCOPE_IOREG) {
      const { stdout } = await exec(IOREG, ["-p", "IOUSB", "-w0", "-l"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      return parseIoreg(stdout).filter((d) => d.kind);
    }
    if (process.platform === "linux") {
      const { stdout } = await exec("lsusb", [], { timeout: 5000 });
      return parseLsusb(stdout).filter((d) => d.kind);
    }
  } catch (e) {
    if (!warned) { warned = true; console.warn(`[usb] scan unavailable: ${e.message.split("\n")[0]}`); }
  }
  return [];
}
