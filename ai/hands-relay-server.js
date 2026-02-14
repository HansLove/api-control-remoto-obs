/**
 * Relé WebSocket para manos: una página con cámara envía datos,
 * el overlay en OBS (sin cámara) los recibe y anima.
 *
 * Uso:
 *   1. npm install ws   (o: node -e "require('ws')")
 *   2. node hands-relay-server.js
 *   3. Abre live-anim.html?broadcast=1 en Chrome (con cámara)
 *   4. En OBS, Fuente Navegador → live-anim-obs.html?remote=1
 *   5. El overlay recibe las manos por WebSocket
 */

const http = require("http");
const PORT = Number(process.env.HANDS_RELAY_PORT || 8765);

let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  console.error("Instala 'ws': npm install ws");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hands relay OK. WS on ws://localhost:" + PORT);
});

const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("Client connected. Total:", clients.size);

  ws.on("message", (data) => {
    const raw = data.toString();
    if (raw.length > 2000) return; // ignorar payloads enormes
    // Reenviar a todos los demás (el overlay en OBS)
    clients.forEach((c) => {
      if (c !== ws && c.readyState === WebSocket.OPEN) c.send(raw);
    });
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Client disconnected. Total:", clients.size);
  });
});

server.listen(PORT, () => {
  console.log("Hands relay: ws://localhost:" + PORT);
  console.log("  Emisor: live-anim.html?broadcast=1");
  console.log("  OBS overlay: live-anim-obs.html?remote=1");
});
