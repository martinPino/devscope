// Fake usbmuxd: one iPhone over USB and one iPad over Wi-Fi; answers ListDevices, Connect and lockdown GetValue.
import net from "node:net";
import fs from "node:fs";
import * as plistNs from "plist";
const plist = plistNs.default ?? plistNs;
const path = process.argv[2];
try { fs.unlinkSync(path); } catch {}
const DEVICES = {
  7: { udid: "00008110-001A2B3C4D5E801E", conn: "USB", values: { DeviceName: "iPhone de Martin", ProductType: "iPhone15,2", ProductVersion: "18.1", DeviceClass: "iPhone" } },
  9: { udid: "00008027-000123456789002E", conn: "Network", values: { DeviceName: "iPad QA", ProductType: "iPad13,9", ProductVersion: "17.6.1", DeviceClass: "iPad" } },
};
const muxReply = (sock, payload, tag) => { const body = Buffer.from(plist.build(payload)); const h = Buffer.alloc(16); h.writeUInt32LE(16 + body.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(tag, 12); sock.write(Buffer.concat([h, body])); };
net.createServer((sock) => {
  let buf = Buffer.alloc(0), lockdown = null;
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (lockdown) {
        if (buf.length < 4) return; const len = buf.readUInt32BE(0); if (buf.length < 4 + len) return;
        const req = plist.parse(buf.subarray(4, 4 + len).toString()); buf = buf.subarray(4 + len);
        const body = Buffer.from(plist.build({ Request: "GetValue", Key: req.Key, Value: lockdown.values[req.Key] }));
        const h = Buffer.alloc(4); h.writeUInt32BE(body.length, 0); sock.write(Buffer.concat([h, body]));
      } else {
        if (buf.length < 16) return; const len = buf.readUInt32LE(0); if (buf.length < len) return;
        const tag = buf.readUInt32LE(12); const req = plist.parse(buf.subarray(16, len).toString()); buf = buf.subarray(len);
        if (req.MessageType === "ListDevices") muxReply(sock, { DeviceList: Object.entries(DEVICES).map(([id, d]) => ({ DeviceID: Number(id), MessageType: "Attached", Properties: { ConnectionType: d.conn, DeviceID: Number(id), SerialNumber: d.udid, ProductID: 4776, LocationID: 1 } })) }, tag);
        else if (req.MessageType === "Connect") { lockdown = DEVICES[req.DeviceID]; muxReply(sock, { MessageType: "Result", Number: lockdown ? 0 : 2 }, tag); }
      }
    }
  });
  sock.on("error", () => {});
}).listen(path, () => console.log("fake usbmuxd on", path));
