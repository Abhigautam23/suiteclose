// SuiteClose web server for Railway.
// Serves the static site from ./public and the website assistant at POST /api/chat.
// No framework: Node's built-in http module only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import handleChat from "./server/chat.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 64 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".txt", ".xml", ".svg"]);

function securityHeaders(req) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
  };
  if (req.headers["x-forwarded-proto"] === "https") h["Strict-Transport-Security"] = "max-age=31536000";
  return h;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "unknown";
}

// Map a URL path to a file inside ./public, or null. Never leaves PUBLIC, never serves dotfiles.
function resolveFile(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes("\0") || p.split("/").some((seg) => seg.startsWith("."))) return null;
  const full = path.normalize(path.join(PUBLIC, p));
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return null;
  const candidates = p.endsWith("/") ? [path.join(full, "index.html")] : [full, full + ".html"];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

function isDir(urlPath) {
  try {
    const full = path.normalize(path.join(PUBLIC, decodeURIComponent(urlPath)));
    return full.startsWith(PUBLIC) && fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function sendFile(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const headers = {
    ...securityHeaders(req),
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  };
  const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (gzip) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  (gzip ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
}

function notFound(req, res) {
  const page = path.join(PUBLIC, "404.html");
  if (fs.existsSync(page)) return sendFile(req, res, page, 404);
  res.writeHead(404, { ...securityHeaders(req), "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

async function apiChat(req, res) {
  // Read the body with a size cap.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Message too large" }));
    }
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const proto = req.headers["x-forwarded-proto"] || "http";
  const request = new Request(`${proto}://${req.headers.host || "localhost"}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
  });
  const response = await handleChat(request, { ip: clientIp(req) });
  res.writeHead(response.status, { ...securityHeaders(req), ...Object.fromEntries(response.headers) });
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://placeholder");
    const host = (req.headers.host || "").toLowerCase();

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    // www → apex, so there is one canonical address.
    if (host.startsWith("www.")) {
      res.writeHead(301, { Location: `https://${host.slice(4)}${req.url}` });
      return res.end();
    }

    if (url.pathname === "/api/chat") return await apiChat(req, res);

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }

    // /audit → /audit/ so relative links inside the page resolve correctly.
    if (!url.pathname.endsWith("/") && isDir(url.pathname)) {
      res.writeHead(301, { Location: url.pathname + "/" + url.search });
      return res.end();
    }

    const file = resolveFile(url.pathname);
    return file ? sendFile(req, res, file) : notFound(req, res);
  } catch (err) {
    console.error("request error", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`SuiteClose listening on :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
