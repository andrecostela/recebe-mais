"use strict";
// =====================================================================
// Recebe+ — servidor único (HTTP + API REST + arquivos estáticos)
// Variáveis de ambiente: DATABASE_URL, ADMIN_INITIAL_PASSWORD, NODE_ENV,
// ALLOWED_ORIGINS (separadas por vírgula), TRUSTED_PROXY_HOPS, DATA_DIR,
// PG_SSL_STRICT, PORT
// =====================================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const { Pool } = require("pg");

const scrypt = util.promisify(crypto.scrypt);
const IS_PROD = process.env.NODE_ENV === "production";
const usePg = Boolean(process.env.DATABASE_URL);

// Erros de validação (mensagem pode ser exibida ao usuário). Qualquer outro erro é interno.
class UserError extends Error {}

// ---------------------------------------------------------------------
// 1. Configuração
// ---------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
// Funciona com server.js na raiz do projeto ou dentro de server/
const ROOT = fs.existsSync(path.join(__dirname, "public")) ? __dirname : path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SRC_DIR = path.join(ROOT, "src");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "recebimentos.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const ROLES = ["Conferente", "Assistente", "Supervisor"];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://andrecostela.github.io")
  .split(",").map(s => s.trim()).filter(Boolean);
const PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? (IS_PROD ? 1 : 0));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const pool = usePg
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
        ? false
        : { rejectUnauthorized: process.env.PG_SSL_STRICT === "true" }
    })
  : null;
if (pool) pool.on("error", err => console.error("Erro no pool PostgreSQL:", err.message));

if (!usePg && IS_PROD) {
  console.warn("⚠️ DATABASE_URL ausente em produção: os dados ficam em arquivo local e serão perdidos em novo deploy.");
}

const sessions = new Map();
const loginAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt < now) sessions.delete(token);
  for (const [ip, e] of loginAttempts) if (now - e.since > LOGIN_WINDOW) loginAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------
// 2. Utilidades
// ---------------------------------------------------------------------
function cleanText(value, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function toIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function safeUrl(value) {
  const s = cleanText(value, 500);
  if (!s) return "";
  try {
    const u = new URL(s);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

// Mensagens de UserError vão ao cliente; qualquer outra falha é registrada e mascarada.
function sendError(res, error, status = 400) {
  if (error instanceof UserError) return json(res, status, { error: error.message });
  console.error(error);
  return json(res, 500, { error: "Erro interno. Tente novamente." });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 100_000) {
        rejected = true;
        reject(new UserError("Payload excede o limite"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("formato");
        resolve(parsed);
      } catch {
        reject(new UserError("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      applyCors(req, res);
      if (req.method === "OPTIONS") { // preflight: responde ANTES de qualquer autenticação
        res.writeHead(204);
        return res.end();
      }
      await dbReady;
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return json(res, 500, { error: "Falha interna" });
    res.end();
  }
});

process.on("unhandledRejection", reason => console.error("Promise rejeitada sem tratamento:", reason));

server.listen(PORT, "0.0.0.0", () => console.log(`Recebe+ ativo na porta ${PORT}`));
