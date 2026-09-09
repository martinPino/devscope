// Sends fake network events to the server so you can try the UI without a device.
const PORT = process.env.PORT || 8765;
const endpoints = [
  ["GET", "https://api.example.com/v1/users/me", 200],
  ["GET", "https://api.example.com/v1/offers?category=car&limit=20", 200],
  ["POST", "https://api.example.com/v1/checkout", 201],
  ["PUT", "https://api.example.com/v1/users/me/settings", 200],
  ["GET", "https://api.example.com/v1/offers/8812", 404],
  ["DELETE", "https://api.example.com/v1/cart/items/3", 204],
  ["GET", "https://cdn.example.com/images/hero.webp", 200],
  ["POST", "https://auth.example.com/oauth/token", 500],
];

async function send() {
  const [method, url, status] = endpoints[Math.floor(Math.random() * endpoints.length)];
  const durationMs = Math.round(40 + Math.random() * 900);
  const body = status >= 400
    ? { error: status === 404 ? "not_found" : "internal_error", traceId: Math.random().toString(36).slice(2) }
    : { ok: true, items: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}`, price: 9.99 * (i + 1) })) };
  await fetch(`http://localhost:${PORT}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startedAt: Date.now() - durationMs,
      durationMs,
      method,
      url,
      status,
      appId: "com.example.shop",
      deviceModel: "sdk_gphone64_x86_64",
      requestHeaders: { Authorization: "Bearer eyJhbGciOi…", "User-Agent": "okhttp/4.12.0", Accept: "application/json" },
      requestBody: method === "POST" || method === "PUT" ? JSON.stringify({ productId: 42, qty: 1 }) : null,
      responseHeaders: { "content-type": url.includes("cdn") ? "image/webp" : "application/json", "x-request-id": Math.random().toString(36).slice(2) },
      responseBody: url.includes("cdn") ? null : JSON.stringify(body),
      responseSize: JSON.stringify(body).length,
    }),
  });
}

console.log(`Sending demo traffic to http://localhost:${PORT}/ingest — Ctrl+C to stop`);
setInterval(send, 800 + Math.random() * 800);
