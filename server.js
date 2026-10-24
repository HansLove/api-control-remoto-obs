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
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// Heroku assigns PORT; fallback to 3000 for local dev
const PORT = Number(process.env.PORT || 3000);
const TOKEN = String(process.env.OBS_REMOTE_TOKEN || "changeme"); // set in env for real use
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
// Voice interpretation runs on EVERY candidate phrase, so it defaults to the
// cheapest model. Override with INTERPRET_MODEL if you want more nuance.
const INTERPRET_MODEL = process.env.INTERPRET_MODEL || "claude-haiku-4-5-20251001";
const MINING_TEACHER_PIN = String(process.env.MINING_TEACHER_PIN || "2024");

// ---------- Bitcoin mining game session (in-memory) ----------
function rewardForBlock(n) {
  return 5 + n * 2;
}

function seedForBlock(sessionId, blockNumber) {
  return crypto.createHash("sha256").update(`${sessionId}:${blockNumber}`).digest("hex").slice(0, 16);
}

function newSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

const sessionId0 = newSessionId();
let miningSession = {
  sessionId: sessionId0,
  currentBlock: 1,
  seed: seedForBlock(sessionId0, 1),
  history: [],
  status: "mining",
  pendingWinner: null,
};

function getMiningStatePayload() {
  return {
    type: "mining_state",
    sessionId: miningSession.sessionId,
    currentBlock: miningSession.currentBlock,
    seed: miningSession.seed,
    history: miningSession.history,
    status: miningSession.status,
    serverTs: nowISO(),
  };
}

function resetMiningSession() {
  const sessionId = newSessionId();
  miningSession = {
    sessionId,
    currentBlock: 1,
    seed: seedForBlock(sessionId, 1),
    history: [],
    status: "mining",
    pendingWinner: null,
  };
  return getMiningStatePayload();
}

function handleMiningClaim(ws, msg) {
  const blockNumber = Number(msg.blockNumber);
  const miner = String(msg.miner || "Minero").trim().slice(0, 20) || "Minero";
  const attempts = Math.max(0, Number(msg.attempts) || 0);

  if (!Number.isFinite(blockNumber) || blockNumber < 1) {
    ws.send(JSON.stringify({ type: "mining_claim_rejected", reason: "invalid_block", serverTs: nowISO() }));
    return true;
  }

  if (blockNumber !== miningSession.currentBlock) {
    const lastWinner = miningSession.history[miningSession.history.length - 1];
    ws.send(
      JSON.stringify({
        type: "mining_claim_rejected",
        reason: "stale",
        winner: lastWinner ? { miner: lastWinner.miner, block: lastWinner.number } : undefined,
        serverTs: nowISO(),
      })
    );
    return true;
  }

  if (miningSession.history.some((h) => h.number === blockNumber)) {
    const winner = miningSession.history.find((h) => h.number === blockNumber);
    ws.send(
      JSON.stringify({
        type: "mining_claim_rejected",
        reason: "already_won",
        winner: winner ? { miner: winner.miner, block: winner.number } : undefined,
        serverTs: nowISO(),
      })
    );
    return true;
  }

  if (miningSession.pendingWinner === blockNumber) {
    const lastWinner = miningSession.history[miningSession.history.length - 1];
    ws.send(
      JSON.stringify({
        type: "mining_claim_rejected",
        reason: "already_won",
        winner: lastWinner ? { miner: lastWinner.miner, block: lastWinner.number } : undefined,
        serverTs: nowISO(),
      })
    );
    return true;
  }

  miningSession.pendingWinner = blockNumber;

  const reward = rewardForBlock(blockNumber);
  const record = {
    number: blockNumber,
    miner,
    attempts,
    reward,
    solvedAt: Date.now(),
  };

  miningSession.history.push(record);
  const nextBlock = blockNumber + 1;
  miningSession.currentBlock = nextBlock;
  miningSession.seed = seedForBlock(miningSession.sessionId, nextBlock);
  miningSession.pendingWinner = null;

  const wonPayload = {
    type: "mining_won",
    block: blockNumber,
    miner,
    attempts,
    reward,
    nextBlock,
    nextSeed: miningSession.seed,
    history: miningSession.history,
    serverTs: nowISO(),
  };

  appendLog({ ...wonPayload, source: "mining" });
  broadcast(wonPayload);
  ws.send(JSON.stringify({ type: "mining_claim_ok", ...wonPayload }));
  return true;
}

function handleMiningReset(ws, msg, viaRest) {
  const pin = String(msg.pin || "");
  if (pin !== MINING_TEACHER_PIN) {
    if (!viaRest) {
      ws.send(JSON.stringify({ type: "ack", ok: false, message: "PIN incorrecto", serverTs: nowISO() }));
    }
    return false;
  }

  const state = resetMiningSession();
  appendLog({ type: "mining_reset", source: viaRest ? "rest" : "ws", serverTs: nowISO() });
  broadcast({ type: "mining_reset", ...state });
  if (!viaRest && ws) {
    ws.send(JSON.stringify({ type: "ack", ok: true, message: "mining_reset", serverTs: nowISO() }));
  }
  return true;
}

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

// ---------- Claude AI helper ----------
function callClaude(question) {
  if (!ANTHROPIC_API_KEY) return Promise.resolve("ANTHROPIC_API_KEY no configurada en el servidor.");

  const body = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 350,
    system: "Eres un asistente conciso para un stream en vivo. Responde en máximo 3 oraciones, directo y claro. Sin markdown.",
    messages: [{ role: "user", content: question }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.[0]?.text || "Sin respuesta.");
          } catch {
            reject(new Error("Parse error"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------- Claude AI helper: chart data (returns parsed JSON) ----------
function callClaudeForChart(topic) {
  if (!ANTHROPIC_API_KEY) return Promise.reject(new Error("ANTHROPIC_API_KEY no configurada."));

  const body = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 420,
    system: `Eres un generador de datos para gráficas en tiempo real para un stream en vivo.
Responde ÚNICAMENTE con JSON válido y absolutamente nada más. Sin markdown, sin bloques de código, sin texto adicional, sin explicaciones.
El JSON debe tener EXACTAMENTE esta estructura:
{"title":"Título descriptivo (máx 44 chars)","subtitle":"Descripción breve opcional","labels":["Label1","Label2","Label3"],"values":[número1,número2,número3],"unit":"Unidad (ej: USD, %, GW, millones)","chart_type":"horizontalBar","theme":"neon","duration":20000}
Reglas:
- Entre 3 y 7 categorías
- Labels cortos (máx 11 caracteres)
- Values son números reales o estimados (solo números, sin unidades)
- chart_type: "horizontalBar" para rankings/comparaciones, "bar" para distribuciones, "line" para tendencias en tiempo
- theme: "neon" | "ocean" | "fire" | "emerald" | "gold"  (elige el que mejor encaje con el tema)
- duration siempre 20000`,
    messages: [{ role: "user", content: `Genera una gráfica sobre: ${topic}` }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            let text = parsed.content?.[0]?.text || "";
            // Strip markdown fences, then extract the first {...} block
            // in case Claude adds surrounding prose
            text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) text = jsonMatch[0];
            const chartData = JSON.parse(text);
            resolve(chartData);
          } catch {
            reject(new Error("No se pudo parsear JSON de gráfica"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------- Claude AI helper: interpret live speech → visual ----------
// Layer 2 of the token firewall. Only candidate phrases (already filtered
// client-side) reach this. Returns {action:"none"|"scene"|"chart", ...}.
function callClaudeForInterpret(transcript) {
  if (!ANTHROPIC_API_KEY) return Promise.reject(new Error("ANTHROPIC_API_KEY no configurada."));

  const body = JSON.stringify({
    model: INTERPRET_MODEL,
    max_tokens: 320,
    system: `Eres el director visual de un stream en vivo. Recibes un fragmento de lo que el presentador acaba de decir. Decide si amerita mostrar un visual y cuál.

Responde SOLO con JSON válido, sin markdown ni texto extra. Una de estas formas:

{"action":"none"}
  cuando el fragmento es relleno, saludo, charla ambigua, o no pide datos/comparación/concepto concreto. ANTE LA DUDA, usa esto.

{"action":"scene","scene":"keyword","params":{"text":"BITCOIN","sub":"opcional"},"confidence":0.0}
  para resaltar UN concepto o palabra clave gigante.

{"action":"scene","scene":"key-metric","params":{"value":"108500","prefix":"$","suffix":"","label":"Precio de Bitcoin"},"confidence":0.0}
  para UNA estadística o cifra concreta.

{"action":"scene","scene":"bar-compare","params":{"items":"Bitcoin:2100,Gold:16000,Real Estate:330000","unit":"B USD","highlight":"Bitcoin","title":"Bitcoin vs activos"},"confidence":0.0}
  para comparar 2 o más cosas con cifras.

{"action":"chart","chart":{"title":"...","labels":["A","B","C"],"values":[1,2,3],"unit":"...","chart_type":"horizontalBar","theme":"neon","duration":20000},"confidence":0.0}
  para un ranking o serie de varios datos.

Reglas:
- Ante la duda, {"action":"none"}. Mejor no mostrar que mostrar basura.
- Si el presentador no dijo cifras exactas, usa valores reales aproximados conocidos.
- Máximo 1 visual por fragmento.
- confidence de 0 a 1: qué tan seguro estás de que este visual ayuda.`,
    messages: [{ role: "user", content: transcript }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            let text = parsed.content?.[0]?.text || "";
            text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) text = jsonMatch[0];
            const result = JSON.parse(text);
            if (!result || typeof result !== "object" || !result.action) {
              return resolve({ action: "none" });
            }
            resolve(result);
          } catch {
            // On any parse failure, fail safe to "none" (never a stuck state)
            resolve({ action: "none" });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Serve static files from ./public
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

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
app.get("/ai-overlay", (req, res) => {
  const p = path.join(PUBLIC_DIR, "obs-ai-overlay.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/obs-ai-overlay.html");
  res.sendFile(p);
});
app.get("/charts-overlay", (req, res) => {
  const p = path.join(PUBLIC_DIR, "obs-charts-overlay.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/obs-charts-overlay.html");
  res.sendFile(p);
});
app.get("/context", (req, res) => {
  const p = path.join(PUBLIC_DIR, "context-mic-overlay.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/context-mic-overlay.html");
  res.sendFile(p);
});
app.get("/collage", (req, res) => {
  const p = path.join(PUBLIC_DIR, "collage-overlay.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/collage-overlay.html");
  res.sendFile(p);
});

// ---------- CAOS Visual Engine ----------
// Stage: single OBS browser source that hosts all scenes dynamically
app.get("/stage", (req, res) => {
  const p = path.join(PUBLIC_DIR, "scenes", "stage.html");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/scenes/stage.html");
  res.sendFile(p);
});
// Individual scene: /scene/keyword?text=BITCOIN — also usable standalone in OBS
app.get("/scene/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!/^[a-z0-9-]+$/.test(name)) return res.status(400).send("Invalid scene name");
  const p = path.join(PUBLIC_DIR, "scenes", `${name}.html`);
  if (!fs.existsSync(p)) return res.status(404).send(`Unknown scene: ${name}`);
  res.sendFile(p);
});
// Scene catalog (for control UI / future AI suggestions)
app.get("/api/scenes", (_req, res) => {
  const dir = path.join(PUBLIC_DIR, "scenes");
  if (!fs.existsSync(dir)) return res.json({ scenes: [] });
  const scenes = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".html") && f !== "stage.html")
    .map((f) => f.replace(/\.html$/, ""));
  res.json({ scenes });
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

// Mining game state (public read for sync / polling)
app.get("/mining/state", (_req, res) => {
  res.json({
    ok: true,
    sessionId: miningSession.sessionId,
    currentBlock: miningSession.currentBlock,
    seed: miningSession.seed,
    history: miningSession.history,
    status: miningSession.status,
    time: nowISO(),
  });
});

// Mining reset (teacher / curl) — Bearer OBS_REMOTE_TOKEN
app.post("/mining/reset", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (TOKEN && token !== TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const pin = String(req.body?.pin || MINING_TEACHER_PIN);
  if (pin !== MINING_TEACHER_PIN) {
    return res.status(403).json({ ok: false, error: "PIN incorrecto" });
  }

  const state = resetMiningSession();
  appendLog({ type: "mining_reset", source: "rest", serverTs: nowISO() });
  broadcast({ type: "mining_reset", ...state });
  res.json({ ok: true, ...state });
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

  // Miners get current mining session state on connect
  if (role === "miner") {
    ws.send(JSON.stringify(getMiningStatePayload()));
  }

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

    // Chart AI request: generate chart data via Claude, broadcast chart_data
    if (msg.type === "chart_ai_request") {
      const topic = String(msg.topic || msg.text || "").trim().slice(0, 300);
      if (!topic) {
        ws.send(JSON.stringify({ type: "ack", ok: false, message: "Empty topic" }));
        return;
      }
      // If client sends a duration, honour it; otherwise let Claude decide (default 20s)
      const durationOverride = (msg.duration !== undefined && msg.duration !== null)
        ? Math.max(0, Number(msg.duration) || 0)
        : undefined;
      ws.send(JSON.stringify({ type: "ack", ok: true, message: "generating chart" }));
      broadcast({ type: "chart_thinking", topic, serverTs: nowISO() });
      callClaudeForChart(topic)
        .then((chartData) => {
          if (durationOverride !== undefined) chartData.duration = durationOverride;
          broadcast({ type: "chart_data", ...chartData, serverTs: nowISO() });
        })
        .catch((err) => broadcast({ type: "chart_error", message: "Error: " + err.message, serverTs: nowISO() }));
      appendLog({ type: "chart_ai_request", topic, durationOverride, serverTs: nowISO(), client: { id, role, ip } });
      return;
    }

    // Voice interpret: candidate phrase → Claude decides the visual.
    // Server only interprets and returns the result; the control decides
    // whether to auto-fire or ask for confirmation (keeps 1 Claude call max).
    if (msg.type === "interpret_speech") {
      const transcript = String(msg.text || "").trim().slice(0, 400);
      if (!transcript) {
        ws.send(JSON.stringify({ type: "ack", ok: false, message: "Empty transcript" }));
        return;
      }
      const reqId = String(msg.reqId || "");
      ws.send(JSON.stringify({ type: "ack", ok: true, message: "interpreting" }));
      callClaudeForInterpret(transcript)
        .then((result) => {
          // Send only to the requesting control, not the overlays
          ws.send(JSON.stringify({
            type: "interpret_result",
            reqId,
            sourceText: transcript,
            result,
            serverTs: nowISO(),
          }));
        })
        .catch((err) => {
          ws.send(JSON.stringify({
            type: "interpret_result",
            reqId,
            sourceText: transcript,
            result: { action: "none", error: err.message },
            serverTs: nowISO(),
          }));
        });
      appendLog({ type: "interpret_speech", transcript, serverTs: nowISO(), client: { id, role, ip } });
      return;
    }

    // Mining game: claim block (first-wins)
    if (msg.type === "mining_claim") {
      handleMiningClaim(ws, msg);
      appendLog({ type: "mining_claim", blockNumber: msg.blockNumber, miner: msg.miner, serverTs: nowISO(), client: { id, role, ip } });
      return;
    }

    // Mining game: teacher reset via PIN
    if (msg.type === "mining_reset") {
      handleMiningReset(ws, msg, false);
      return;
    }

    // AI question: handle server-side, don't relay raw message
    if (msg.type === "ai_question") {
      const question = String(msg.text || "").trim().slice(0, 500);
      if (!question) {
        ws.send(JSON.stringify({ type: "ack", ok: false, message: "Empty question" }));
        return;
      }
      ws.send(JSON.stringify({ type: "ack", ok: true, message: "processing" }));
      broadcast({ type: "ai_thinking", question, serverTs: nowISO() });
      callClaude(question)
        .then((answer) => broadcast({ type: "ai_response", question, answer, serverTs: nowISO() }))
        .catch((err) => broadcast({ type: "ai_response", question, answer: "Error: " + err.message, serverTs: nowISO() }));
      appendLog({ type: "ai_question", question, serverTs: nowISO(), client: { id, role, ip } });
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
