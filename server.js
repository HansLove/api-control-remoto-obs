/**
 * OBS Remote Backend (Heroku-ready)
 * - WebSocket hub for overlay + control
 * - Optional REST triggers
 * - Simple token auth
 * - Event logging to ./logs (JSONL)
 * Local:
 *   npm install
 *   node server.js
 *
 * URLs (local):
 *   Control UI: http://localhost:3000/control
 *   Overlay UI: http://localhost:3000/overlay
 *   WS:         ws://localhost:3000?token=YOUR_TOKEN
 *
 * Heroku:
 *   Uses single PORT from environment
 *   WS connects on same port as HTTP
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// Heroku assigns PORT; fallback to 3000 for local dev
const PORT = Number(process.env.PORT || 3000);
const TOKEN = String(process.env.OBS_REMOTE_TOKEN || "changeme"); // set in env for real use
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");

// ---------- tiny utilities ----------
const nowISO = () => new Date().toISOString();
const safeJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(LOG_DIR);

// Write events as JSONL (one JSON per line) for easy ingestion
function appendLog(event) {
  const day = nowISO().slice(0, 10); // YYYY-MM-DD
  const file = path.join(LOG_DIR, `events-${day}.jsonl`);
  fs.appendFile(file, JSON.stringify(event) + "\n", () => {});
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve static files from ./public
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// Serve AI hand-driven overlay from ./ai (live-anim, live-anim-obs)
const AI_DIR = path.join(process.cwd(), "ai");
if (fs.existsSync(AI_DIR)) app.use("/ai", express.static(AI_DIR));

// Convenience routes (expects public/control-remoto.html and public/overlay.html)
app.get("/control", (req, res) => {
  const p = path.join(PUBLIC_DIR, "control-remoto.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/control-remoto.html");
  res.sendFile(p);
});
app.get("/overlay", (req, res) => {
  const p = path.join(PUBLIC_DIR, "overlay.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/overlay.html");
  res.sendFile(p);
});

// Root redirect
app.get("/", (req, res) => {
  res.redirect("/control");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    clients: clients.size,
    time: nowISO(),
  });
});

// REST trigger (useful for curl / bots)
// Example:
// curl -X POST https://your-app.herokuapp.com/trigger \
//   -H "Authorization: Bearer changeme" \
//   -H "Content-Type: application/json" \
//   -d '{"type":"toast","toast":{"message":"Hello","variant":"info","durationMs":2000}}'
app.post("/trigger", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (TOKEN && token !== TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const event = req.body && typeof req.body === "object" ? req.body : null;
  if (!event || !event.type) return res.status(400).json({ ok: false, error: "Invalid event payload" });

  const enriched = {
    ...event,
    serverTs: nowISO(),
    source: "rest",
  };

  appendLog(enriched);
  broadcast(enriched);

  res.json({ ok: true, deliveredTo: clients.size });
});

// Create HTTP server
const httpServer = http.createServer(app);

// ---------- WebSocket server (attached to same HTTP server) ----------
const wss = new WebSocket.Server({ server: httpServer });
const clients = new Set(); // { ws, id, role, ip, lastSeen }

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(data);
    }
  }
}

function getQueryParam(url, key) {
  try {
    const u = new URL(url, "http://localhost"); // base needed
    return u.searchParams.get(key);
  } catch {
    return null;
  }
}

function genId() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

wss.on("connection", (ws, req) => {
  const token = getQueryParam(req.url || "", "token") || "";
  if (TOKEN && token !== TOKEN) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const role = (getQueryParam(req.url || "", "role") || "unknown").slice(0, 32); // e.g. control/overlay
  const id = genId();
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const client = { ws, id, role, ip, lastSeen: Date.now() };
  clients.add(client);

  console.log(`[WS] + connected ${id} role=${role} ip=${ip} total=${clients.size}`);

  // Send hello
  ws.send(
    JSON.stringify({
      type: "hello",
      serverTs: nowISO(),
      id,
      role,
      totalClients: clients.size,
    })
  );

  ws.on("message", (raw) => {
    client.lastSeen = Date.now();

    const msgStr = raw.toString("utf8");
    const msg = safeJson(msgStr);

    if (!msg || typeof msg !== "object") {
      ws.send(JSON.stringify({ type: "ack", ok: false, message: "Invalid JSON" }));
      return;
    }

    // Minimal validation
    if (!msg.type) {
      ws.send(JSON.stringify({ type: "ack", ok: false, message: "Missing type" }));
      return;
    }


    const enriched = {
      ...msg,
      serverTs: nowISO(),
      source: "ws",
      client: { id, role, ip },
    };

    appendLog(enriched);

    // Broadcast to all (including sender; overlay can ignore if desired)
    broadcast(enriched);

    // Ack to sender (optional)
    ws.send(JSON.stringify({ type: "ack", ok: true, message: "received", serverTs: enriched.serverTs }));
  });

  ws.on("close", () => {
    clients.delete(client);
    console.log(`[WS] - disconnected ${id} total=${clients.size}`);
    // Notify others (optional)
    broadcast({ type: "presence", action: "leave", id, role, serverTs: nowISO(), totalClients: clients.size });
  });

  ws.on("error", (e) => {
    console.log(`[WS] ! error ${id}`, e.message);
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] WebSocket on same port: ws://localhost:${PORT}`);
  console.log(`[SERVER] token auth: ${TOKEN === "changeme" ? "⚠️ changeme (set OBS_REMOTE_TOKEN env)" : "enabled"}`);
  console.log(`[LOG] ${LOG_DIR}`);
});

// Optional: prune dead clients (rarely needed, but nice)
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (c.ws.readyState !== WebSocket.OPEN) {
      clients.delete(c);
      continue;
    }
    // If idle > 30 min, ping
    if (now - c.lastSeen > 30 * 60 * 1000) {
      try { c.ws.ping(); } catch {}
    }
  }
}, 60 * 1000);
