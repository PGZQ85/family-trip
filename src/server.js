// Node entry: `node src/server.js` serves ./public and the API, storing everything in one SQLite file.
// Uses Node's built-in node:sqlite (Node 22.13+), so there is nothing to install.
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./sqlite-db.js";
import { handle } from "./api.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const port = Number(process.env.PORT) || 8787;
const dbPath = process.env.DB_PATH || path.join(root, "data", "trip.db");

if (dbPath !== ":memory:") await mkdir(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || "localhost"}${req.url}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const apiRes = await handle(request, db, { ip: req.socket.remoteAddress });
    if (apiRes) {
      res.writeHead(apiRes.status, Object.fromEntries(apiRes.headers));
      res.end(Buffer.from(await apiRes.arrayBuffer()));
      return;
    }
    const pathname = decodeURIComponent(new URL(url).pathname);
    const file = path.normalize(path.join(pub, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(pub + path.sep)) { res.writeHead(403).end(); return; }
    const buf = await readFile(file).catch(() => null);
    if (!buf) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("Server error");
  }
}).listen(port, () => console.log(`Family Trip Planner on http://localhost:${port} (database: ${dbPath})`));
