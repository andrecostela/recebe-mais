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
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
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
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  if (PROXY_HOPS > 0 && fwd.length) return fwd[Math.max(0, fwd.length - PROXY_HOPS)];
  return req.socket.remoteAddress || "unknown";
}

// CORS: só origens listadas em ALLOWED_ORIGINS recebem credenciais
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("Vary", "Origin");
}

// ---------------------------------------------------------------------
// 3. Senhas, usuários e sessões
// ---------------------------------------------------------------------
const DUMMY_SALT = "0".repeat(32);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(String(password), salt, 64)).toString("hex");
  return { salt, hash };
}

async function verifyPassword(password, user) {
  try {
    const actual = await scrypt(String(password), user.salt, 64);
    const expected = Buffer.from(user.hash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  "123456", "12345678", "123456789", "password", "senha123", "admin123", "recebeplus",
  "mudar123", "1234567890", "qwertyuiop", "supervisorsenha", "admin12345678"
]);

function validatePasswordStrength(password) {
  const pwd = String(password || "");
  if (pwd.length < 12) throw new UserError("A senha deve possuir no mínimo 12 caracteres.");
  if (COMMON_PASSWORDS.has(pwd.toLowerCase().trim())) {
    throw new UserError("A senha escolhida é muito comum e insegura. Escolha uma frase-senha mais longa.");
  }
}

function readUsersFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

function writeUsersFile(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), { mode: 0o600 });
}

async function readUsers() {
  if (usePg) return (await pool.query("SELECT * FROM usuarios")).rows; // erros propagam
  return readUsersFile();
}

// Única porta de escrita de usuários: PostgreSQL quando há DATABASE_URL, arquivo caso contrário.
async function saveUser({ username, name, role, salt, hash }) {
  if (usePg) {
    await pool.query(
      `INSERT INTO usuarios (id, username, name, role, hash, salt) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO UPDATE SET name = $3, role = $4, hash = $5, salt = $6`,
      [crypto.randomUUID(), username, name, role, hash, salt]
    );
    return;
  }
  const users = readUsersFile();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx >= 0) users[idx] = { ...users[idx], name, role, salt, hash };
  else users.push({ username, name, role, salt, hash, createdAt: new Date().toISOString() });
  writeUsersFile(users);
}

// Somente modo arquivo (sem PostgreSQL)
function ensureInitialUsersFile() {
  const users = readUsersFile();
  if (users.some(u => u.role === "Supervisor")) return;
  const pwd = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString("hex") + "Aa1!";
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pwd, salt, 64).toString("hex");
  users.unshift({ username: "admin", name: "Administrador do Sistema", role: "Supervisor", salt, hash, createdAt: new Date().toISOString() });
  writeUsersFile(users);
  console.log(`✅ Administrador inicial criado. Usuário: admin${process.env.ADMIN_INITIAL_PASSWORD ? "" : ` | Senha: ${pwd} (altere após o primeiro login)`}`);
}
if (!usePg) ensureInitialUsersFile();

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";")
      .map(part => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => key)
      .map(([key, value]) => [key, safeDecode(value || "")])
  );
}

function getSession(req) {
  const token = parseCookies(req).recebe_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { ...session, token };
}

// Entre domínios (GitHub Pages -> Render) o cookie precisa de SameSite=None; Secure
function setSessionCookie(res, token, maxAge = SESSION_TTL / 1000) {
  const attrs = IS_PROD ? "SameSite=None; Secure" : "SameSite=Lax";
  res.setHeader("Set-Cookie", `recebe_session=${encodeURIComponent(token)}; HttpOnly; ${attrs}; Path=/; Max-Age=${maxAge}`);
}

function requireSession(req, res, { write = false } = {}) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Autenticação necessária" });
    return null;
  }
  if (write && !safeEqual(req.headers["x-csrf-token"], session.csrf)) {
    json(res, 403, { error: "Sessão inválida" });
    return null;
  }
  return session;
}

// Derruba as sessões de um usuário (troca de senha/papel). A sessão atual pode ser preservada.
function invalidateUserSessions(username, keepToken = null, newRole = null) {
  for (const [token, s] of sessions) {
    if (s.username.toLowerCase() !== username.toLowerCase()) continue;
    if (token === keepToken) {
      if (newRole) s.role = newRole;
    } else {
      sessions.delete(token);
    }
  }
}

function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.since > LOGIN_WINDOW) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 5;
}

function registerFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  loginAttempts.set(ip, !entry || now - entry.since > LOGIN_WINDOW ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since });
}

// ---------------------------------------------------------------------
// 4. Banco de dados (PostgreSQL ou arquivo JSON)
// ---------------------------------------------------------------------
async function initDb() {
  if (!usePg) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(60) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        hash VARCHAR(128) NOT NULL,
        salt VARCHAR(32) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS recebimentos (
        id VARCHAR(36) PRIMARY KEY,
        data TIMESTAMP WITH TIME ZONE NOT NULL,
        origem VARCHAR(120) NOT NULL,
        placa VARCHAR(10) NOT NULL,
        motorista VARCHAR(120) NOT NULL,
        doca VARCHAR(10) DEFAULT '—',
        volumetria INT DEFAULT 0,
        sla INT DEFAULT 60,
        status VARCHAR(30) DEFAULT 'Em Trânsito',
        inicio TIMESTAMP WITH TIME ZONE,
        fim TIMESTAMP WITH TIME ZONE,
        conferente VARCHAR(100) DEFAULT '—',
        insumo_tipo TEXT,
        insumo_qtd INT,
        insumo_status TEXT,
        insumo_obs TEXT,
        insumos_lista JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS insumos_recebimento (
        id VARCHAR(36) PRIMARY KEY,
        recebimento_id VARCHAR(36) NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,
        tipo_insumo VARCHAR(50) NOT NULL,
        quantidade INT NOT NULL CHECK (quantidade > 0),
        condicao VARCHAR(30) DEFAULT '',
        observacao TEXT,
        foto_url TEXT,
        criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS auditoria (
        id VARCHAR(36) PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        action VARCHAR(120) NOT NULL,
        record_id VARCHAR(36),
        placa VARCHAR(20),
        role VARCHAR(60)
      );
      ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS foto_url TEXT;
      ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS actor VARCHAR(60);
      ALTER TABLE auditoria ALTER COLUMN record_id TYPE VARCHAR(80);
      CREATE INDEX IF NOT EXISTS idx_recebimentos_data ON recebimentos (data DESC);
      CREATE INDEX IF NOT EXISTS idx_insumos_criado_em ON insumos_recebimento (criado_em);
      CREATE INDEX IF NOT EXISTS idx_insumos_recebimento ON insumos_recebimento (recebimento_id);
    `);

    const count = await client.query("SELECT COUNT(*) FROM usuarios");
    if (parseInt(count.rows[0].count, 10) === 0) {
      let pwd = process.env.ADMIN_INITIAL_PASSWORD;
      let generated = false;
      try { validatePasswordStrength(pwd); } catch { pwd = crypto.randomBytes(12).toString("hex") + "Aa1!"; generated = true; }
      const { salt, hash } = await hashPassword(pwd);
      await client.query(
        "INSERT INTO usuarios (id, username, name, role, hash, salt) VALUES ($1, $2, $3, $4, $5, $6)",
        [crypto.randomUUID(), "admin", "Administrador do Sistema", "Supervisor", hash, salt]
      );
      console.log(generated
        ? `✅ [PostgreSQL] Admin criado. Usuário: admin | Senha: ${pwd} (exibida uma única vez — altere no primeiro login; para definir a sua, use ADMIN_INITIAL_PASSWORD com 12+ caracteres)`
        : "✅ [PostgreSQL] Admin criado com a senha de ADMIN_INITIAL_PASSWORD.");
    }
  } finally {
    client.release();
  }
}
const dbReady = initDb().catch(err => console.error("❌ Falha ao inicializar o PostgreSQL:", err));

function nowAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Dados de demonstração: apenas em desenvolvimento (modo arquivo)
function seed() {
  return [
    { id: "D-101", data: nowAt(7, 20), origem: "CD Guarulhos", doca: "3", motorista: "Carlos Mendes", placa: "RFG-8J21", volumetria: 1860, inicio: nowAt(7, 42), fim: nowAt(8, 31), sla: 60, conferente: "Ana Souza", status: "Concluído", source: "server" },
    { id: "D-102", data: nowAt(8, 10), origem: "Hub Campinas", doca: "5", motorista: "João Ribeiro", placa: "GHT-4C07", volumetria: 2430, inicio: nowAt(8, 28), fim: null, sla: 75, conferente: "Marcos Lima", status: "Em descarga", source: "server" },
    { id: "D-103", data: nowAt(9, 0), origem: "CD Extrema", doca: "2", motorista: "Paulo Nunes", placa: "BXR-1D94", volumetria: 0, inicio: null, fim: null, sla: 45, conferente: "—", status: "Aguardando", source: "server" }
  ];
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

// Só recria dados se o arquivo NÃO existir. Arquivo corrompido gera erro (nunca sobrescreve).
function readJsonDb() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const fresh = { records: IS_PROD ? [] : seed(), audit: [] };
    writeDb(fresh);
    return fresh;
  }
  let db;
  try { db = JSON.parse(raw); } catch { throw new Error("recebimentos.json corrompido: restaure um backup antes de continuar."); }
  if (!db || typeof db !== "object") db = {};
  if (!Array.isArray(db.records)) db.records = [];
  if (!Array.isArray(db.audit)) db.audit = [];
  let changed = false;
  db.records = db.records.map(record => {
    const status = record.status === "Previsto" ? "Em Trânsito" : record.status === "Divergência" ? "Em Atraso" : record.status;
    const doca = String(record.doca ?? "").replace(/^D/i, "").replace(/^0+(?=\d)/, "") || "—";
    if (status !== record.status || doca !== record.doca) changed = true;
    return { ...record, status, doca };
  });
  if (changed) writeDb(db);
  return db;
}

function mapRecord(r) {
  let insumos = r.insumos_lista ?? null;
  if (typeof insumos === "string") { try { insumos = JSON.parse(insumos); } catch { insumos = null; } }
  return {
    id: r.id,
    data: r.data ? new Date(r.data).toISOString() : new Date().toISOString(),
    origem: r.origem,
    placa: r.placa,
    motorista: r.motorista,
    doca: r.doca || "—",
    volumetria: r.volumetria || 0,
    sla: r.sla || 60,
    status: r.status,
    inicio: r.inicio ? new Date(r.inicio).toISOString() : null,
    fim: r.fim ? new Date(r.fim).toISOString() : null,
    conferente: r.conferente || "—",
    insumo_tipo: r.insumo_tipo,
    insumo_qtd: r.insumo_qtd,
    insumo_status: r.insumo_status,
    insumo_obs: r.insumo_obs,
    insumos,
    foto_url: r.foto_url || "",
    source: "server" // sem isso o front trata o registro como local e deixa de chamar a API
  };
}

// Erros do banco propagam (HTTP 500) — nunca viram "lista vazia"
async function readDb({ withAudit = true } = {}) {
  if (usePg) {
    const recRes = await pool.query("SELECT * FROM recebimentos ORDER BY data DESC");
    let audit = [];
    if (withAudit) {
      const auditRes = await pool.query("SELECT * FROM auditoria ORDER BY timestamp DESC LIMIT 100");
      audit = auditRes.rows.map(a => ({
        id: a.id,
        timestamp: a.timestamp ? new Date(a.timestamp).toISOString() : null,
        action: a.action,
        recordId: a.record_id,
        placa: a.placa,
        role: a.role,
        actor: a.actor || ""
      }));
    }
    return { records: recRes.rows.map(mapRecord), audit };
  }
  return readJsonDb();
}

async function writeAudit(action, { recordId = "", placa = "", role = "", actor = "" } = {}) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action: cleanText(action, 120),
    recordId: cleanText(recordId, 80),
    placa: cleanText(placa, 20),
    role: cleanText(role, 60),
    actor: cleanText(actor, 60)
  };
  if (usePg) {
    await pool.query(
      "INSERT INTO auditoria (id, timestamp, action, record_id, placa, role, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [entry.id, entry.timestamp, entry.action, entry.recordId, entry.placa, entry.role, entry.actor]
    );
    return;
  }
  const db = readJsonDb();
  db.audit.unshift(entry);
  db.audit = db.audit.slice(0, 1000);
  writeDb(db);
}

async function createRecordDb(record, session) {
  if (usePg) {
    await pool.query(
      "INSERT INTO recebimentos (id, data, origem, placa, motorista, doca, volumetria, sla, status, inicio, fim, conferente) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [record.id, record.data, record.origem, record.placa, record.motorista, record.doca, record.volumetria, record.sla, record.status, record.inicio, record.fim, record.conferente]
    );
  } else {
    const db = readJsonDb();
    db.records.unshift(record);
    writeDb(db);
  }
  await writeAudit("Recebimento criado", { recordId: record.id, placa: record.placa, role: session.role, actor: session.username });
}

// --- Transições de status (regras compartilhadas entre PG e JSON) ---
const TRANSITIONS = { start: "Em descarga", finish: "Concluído", issue: "Em Atraso" };

function normalizeInsumos(input) {
  let list = input.insumos;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map(item => ({
    tipo: cleanText(item?.tipo, 50),
    qtd: Math.floor(Number(item?.qtd ?? item?.quantidade ?? 0)),
    status: cleanText(item?.status ?? item?.condicao, 30),
    obs: cleanText(item?.obs ?? item?.observacao, 255),
    foto_url: safeUrl(item?.foto_url || input.foto_url)
  })).filter(i => i.tipo && Number.isFinite(i.qtd) && i.qtd > 0);
}

// Retorna as colunas a alterar. O conferente vem SEMPRE da sessão, nunca do corpo da requisição.
function planTransition(record, action, input, session) {
  if (!Object.hasOwn(TRANSITIONS, action)) throw new UserError("Transição inválida");
  const changes = { status: TRANSITIONS[action] };
  let items = [];

  if (action === "start") {
    if (!["Em Trânsito", "Aguardando"].includes(record.status)) throw new UserError("A descarga não pode ser iniciada neste status");
    const volume = Number(input.volumetria);
    if (!Number.isInteger(volume) || volume < 1) throw new UserError("Informe a volumetria (número inteiro) para iniciar a descarga");
    changes.volumetria = volume;
    changes.inicio = new Date().toISOString();
    changes.conferente = cleanText(session.name || session.username, 100);
  } else {
    if (record.status !== "Em descarga") throw new UserError("A descarga não está em andamento");
    changes.fim = new Date().toISOString();
    const foto = safeUrl(input.foto_url);
    if (foto) changes.foto_url = foto;
    items = normalizeInsumos(input);
    if (items.length) {
      changes.insumo_tipo = items.map(i => `${i.qtd}x ${i.tipo}`).join(", ");
      changes.insumo_qtd = items.reduce((sum, i) => sum + i.qtd, 0);
      changes.insumo_status = [...new Set(items.map(i => i.status).filter(Boolean))].join(", ");
      changes.insumo_obs = items.map(i => i.obs).filter(Boolean).join(" | ").slice(0, 1000);
      changes.insumos_lista = items;
    }
  }
  return { changes, items };
}

async function transitionRecordDb(id, action, input, session) {
  let updated;

  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE", [id]);
      if (!found.rows.length) throw new UserError("Registro não encontrado");
      const { changes, items } = planTransition(found.rows[0], action, input, session);

      const params = [];
      const sets = Object.entries(changes).map(([column, value]) => {
        params.push(column === "insumos_lista" ? JSON.stringify(value) : value);
        return `${column} = $${params.length}`;
      });
      params.push(id);
      const result = await client.query(`UPDATE recebimentos SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);

      for (const item of items) {
        await client.query(
          "INSERT INTO insumos_recebimento (id, recebimento_id, tipo_insumo, quantidade, condicao, observacao, foto_url) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [crypto.randomUUID(), id, item.tipo, item.qtd, item.status, item.obs, item.foto_url]
        );
      }
      await client.query("COMMIT");
      updated = mapRecord(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = readJsonDb();
    const record = db.records.find(r => r.id === id);
    if (!record) throw new UserError("Registro não encontrado");
    const { changes } = planTransition(record, action, input, session);
    const { insumos_lista, ...rest } = changes;
    Object.assign(record, rest);
    if (insumos_lista) record.insumos = insumos_lista;
    writeDb(db);
    updated = record;
  }

  await writeAudit(`Status alterado para ${updated.status}`, { recordId: updated.id, placa: updated.placa, role: session.role, actor: session.username });
  return updated;
}

// ---------------------------------------------------------------------
// 5. Validação de registros
// ---------------------------------------------------------------------
function validateRecord(input) {
  const status = cleanText(input.status, 30) || "Em Trânsito";
  const data = toIso(cleanText(input.data, 40));
  let inicio = input.inicio ? toIso(cleanText(input.inicio, 40)) : null;
  if (input.inicio && !inicio) throw new UserError("Início inválido");
  if (status === "Em descarga" && !inicio) inicio = new Date().toISOString();

  const record = {
    id: `R-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    data,
    origem: cleanText(input.origem),
    doca: cleanText(input.doca, 12).replace(/\D/g, "").slice(0, 10) || "—",
    motorista: cleanText(input.motorista) || "—",             // opcional
    placa: cleanText(input.placa, 10).toUpperCase() || "—",   // opcional
    volumetria: Number(input.volumetria ?? 0),
    inicio,
    fim: null,
    sla: Number(input.sla) || 60,
    conferente: cleanText(input.conferente, 100) || "—",
    status,
    source: "server"
  };

  if (!record.data) throw new UserError("Data inválida");
  if (!record.origem) throw new UserError("A origem é obrigatória");
  if (record.placa !== "—" && !/^[A-Z0-9-]{7,8}$/.test(record.placa)) throw new UserError("Placa inválida");
  if (!Number.isInteger(record.volumetria) || record.volumetria < 0) throw new UserError("Volumetria inválida (use número inteiro)");
  if (status === "Em descarga" && record.volumetria < 1) throw new UserError("Informe a volumetria para iniciar a descarga");
  if (!Number.isInteger(record.sla) || record.sla < 1 || record.sla > 1440) throw new UserError("SLA inválido (1 a 1440 minutos)");
  if (!["Em Trânsito", "Aguardando", "Em descarga"].includes(status)) throw new UserError("Status inválido");
  return record;
}

// ---------------------------------------------------------------------
// 6. Rotas da API
// ---------------------------------------------------------------------
async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });

  // ----- Login -----
  if (req.method === "POST" && url.pathname === "/api/login") {
    const ip = clientIp(req);
    if (isRateLimited(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde antes de tentar novamente." });
    try {
      const input = await readBody(req);
      const username = cleanText(input.username, 60);
      const user = (await readUsers()).find(item => item.username.toLowerCase() === username.toLowerCase());
      // Executa scrypt mesmo sem usuário, para não revelar por tempo de resposta quais logins existem
      const ok = user ? await verifyPassword(input.password, user) : (await scrypt("x", DUMMY_SALT, 64), false);
      if (!ok) {
        registerFailure(ip);
        return json(res, 401, { error: "Usuário ou senha inválidos" });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      const csrf = crypto.randomBytes(24).toString("hex");
      const name = user.name || user.username;
      sessions.set(token, { username: user.username, name, role: user.role, csrf, expiresAt: Date.now() + SESSION_TTL });
      setSessionCookie(res, token);
      return json(res, 200, { user: { username: user.username, name, role: user.role }, csrf });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = requireSession(req, res);
    if (!session) return;
    return json(res, 200, { user: { username: session.username, name: session.name, role: session.role }, csrf: session.csrf });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = requireSession(req, res, { write: true });
    if (!session) return;
    sessions.delete(session.token);
    setSessionCookie(res, "", 0);
    return json(res, 200, { ok: true });
  }

  // ----- Trocar a própria senha -----
  if (req.method === "POST" && url.pathname === "/api/change-password") {
    const session = requireSession(req, res, { write: true });
    if (!session) return;
    try {
      const { currentPassword, newPassword } = await readBody(req);
      if (!currentPassword || !newPassword) return json(res, 400, { error: "Preencha a senha atual e a nova senha." });

      const user = (await readUsers()).find(u => u.username.toLowerCase() === session.username.toLowerCase());
      if (!user) return json(res, 404, { error: "Usuário não encontrado." });
      if (!(await verifyPassword(currentPassword, user))) return json(res, 401, { error: "A senha atual informada está incorreta." });

      validatePasswordStrength(newPassword);
      if (safeEqual(currentPassword, newPassword)) throw new UserError("A nova senha deve ser diferente da atual.");

      const cred = await hashPassword(newPassword);
      await saveUser({ username: user.username, name: user.name || user.username, role: user.role, ...cred }); // PG ou arquivo
      invalidateUserSessions(user.username, session.token);
      await writeAudit("[SEGURANÇA] Senha própria alterada", { recordId: user.username, role: session.role, actor: session.username });
      return json(res, 200, { ok: true, message: "Senha alterada com sucesso." });
    } catch (error) {
      return sendError(res, error);
    }
  }

  // ----- Rotas autenticadas -----
  const session = requireSession(req, res, { write: req.method !== "GET" });
  if (!session) return;
  const role = session.role;

  if (req.method === "GET" && url.pathname === "/api/users") {
    if (role !== "Supervisor") return json(res, 403, { error: "Acesso negado." });
    try {
      const users = (await readUsers()).map(u => ({ username: u.username, name: u.name || "", role: u.role }));
      return json(res, 200, { users });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    if (role !== "Supervisor") return json(res, 403, { error: "Apenas supervisores podem gerenciar a equipe." });
    try {
      const input = await readBody(req);
      const action = input.action === "edit" ? "update" : input.action;
      if (!["create", "update"].includes(action)) throw new UserError("Ação inválida.");

      const username = cleanText(input.username, 60);
      const name = cleanText(input.name, 100);
      const newRole = cleanText(input.role, 20);
      const password = String(input.password || "").trim();
      if (!username || !name || !ROLES.includes(newRole)) throw new UserError("Preencha todos os campos corretamente.");

      const usersDb = await readUsers();
      const existing = usersDb.find(u => u.username.toLowerCase() === username.toLowerCase());

      if (action === "create") {
        if (existing) throw new UserError("Este nome de usuário (login) já existe.");
        if (!USERNAME_RE.test(username)) throw new UserError("Login inválido: use 3 a 60 letras, números, ponto, hífen ou sublinhado.");
        validatePasswordStrength(password);
        await saveUser({ username, name, role: newRole, ...(await hashPassword(password)) });
        await writeAudit("[SEGURANÇA] Usuário criado", { recordId: username, placa: newRole, role, actor: session.username });
      } else {
        if (!existing) return json(res, 404, { error: "Usuário não encontrado." });
        if (existing.role === "Supervisor" && newRole !== "Supervisor" && usersDb.filter(u => u.role === "Supervisor").length <= 1) {
          throw new UserError("Não é possível rebaixar o único Supervisor existente.");
        }
        let { salt, hash } = existing;
        const passwordChanged = password.length > 0;
        if (passwordChanged) {
          validatePasswordStrength(password);
          ({ salt, hash } = await hashPassword(password));
        }
        await saveUser({ username: existing.username, name, role: newRole, salt, hash });
        if (passwordChanged || existing.role !== newRole) {
          const isSelf = existing.username.toLowerCase() === session.username.toLowerCase();
          invalidateUserSessions(existing.username, isSelf ? session.token : null, newRole);
        }
        await writeAudit(`[SEGURANÇA] Usuário editado${passwordChanged ? " (senha redefinida)" : ""}`, { recordId: existing.username, placa: newRole, role, actor: session.username });
      }
      return json(res, 200, { ok: true, username, name, role: newRole });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/records") {
    try {
      const db = await readDb({ withAudit: false });
      return json(res, 200, { records: db.records, updatedAt: new Date().toISOString() });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    if (role !== "Supervisor") return json(res, 403, { error: "Acesso restrito ao supervisor" });
    try {
      const db = await readDb();
      return json(res, 200, { audit: db.audit.slice(0, 100) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/records") {
    if (!ROLES.includes(role)) return json(res, 403, { error: "Perfil sem permissão" });
    try {
      const record = validateRecord(await readBody(req));
      await createRecordDb(record, session);
      return json(res, 201, { record });
    } catch (error) {
      return sendError(res, error);
    }
  }

  const match = url.pathname.match(/^\/api\/records\/([^/]+)\/transition$/);
  if (req.method === "PATCH" && match) {
    if (!["Conferente", "Supervisor"].includes(role)) return json(res, 403, { error: "Somente conferentes e supervisores podem alterar a descarga" });
    try {
      const input = await readBody(req);
      const record = await transitionRecordDb(safeDecode(match[1]), input.action, input, session);
      return json(res, 200, { record });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/insumos") {
    if (!usePg) return json(res, 200, { insumos: [] });
    try {
      const dataInicio = url.searchParams.get("data_inicio");
      const dataFim = url.searchParams.get("data_fim");
      const origem = url.searchParams.get("origem");
      const conferente = url.searchParams.get("conferente");
      const escapeLike = s => s.toLowerCase().trim().replace(/[\\%_]/g, "\\$&");
      const dia = "(i.criado_em AT TIME ZONE 'America/Sao_Paulo')::date"; // filtro inclusivo no dia local

      let sql = `
        SELECT i.id, i.tipo_insumo, i.quantidade, i.condicao, i.observacao, i.foto_url, i.criado_em,
               r.origem, r.placa, r.conferente
        FROM insumos_recebimento i
        JOIN recebimentos r ON r.id = i.recebimento_id
        WHERE 1=1`;
      const params = [];

      if (dataInicio) {
        if (!DATE_RE.test(dataInicio)) throw new UserError("Data inicial inválida");
        params.push(dataInicio);
        sql += ` AND ${dia} >= $${params.length}::date`;
      }
      if (dataFim) {
        if (!DATE_RE.test(dataFim)) throw new UserError("Data final inválida");
        params.push(dataFim);
        sql += ` AND ${dia} <= $${params.length}::date`;
      }
      if (origem) {
        params.push(`%${escapeLike(origem)}%`);
        sql += ` AND LOWER(r.origem) LIKE $${params.length} ESCAPE '\\'`;
      }
      if (conferente) {
        params.push(`%${escapeLike(conferente)}%`);
        sql += ` AND LOWER(r.conferente) LIKE $${params.length} ESCAPE '\\'`;
      }
      sql += " ORDER BY i.criado_em DESC LIMIT 2000";

      const result = await pool.query(sql, params);
      return json(res, 200, { insumos: result.rows });
    } catch (error) {
      return sendError(res, error);
    }
  }

  return json(res, 404, { error: "Rota da API não encontrada" });
}

// ---------------------------------------------------------------------
// 7. Arquivos estáticos (protegido contra path traversal)
// ---------------------------------------------------------------------
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Método não permitido" });

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: "URL inválida" }); }
  if (pathname.includes("\0")) return json(res, 400, { error: "URL inválida" });

  let rel = pathname.replace(/^\/+/, "") || "index.html";
  let baseDir = PUBLIC_DIR;
  if (rel.startsWith("src/")) { baseDir = SRC_DIR; rel = rel.slice(4); }
  else if (rel.startsWith("public/")) rel = rel.slice(7);

  // O caminho FINAL (já resolvido) precisa estar dentro do diretório permitido
  const filePath = path.resolve(baseDir, rel);
  const ext = path.extname(filePath).toLowerCase();
  if (!filePath.startsWith(baseDir + path.sep) || !MIME[ext] || path.basename(filePath).startsWith(".")) {
    return json(res, 404, { error: "Arquivo não encontrado" });
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { error: "Arquivo não encontrado" });
    const headers = {
      "Content-Type": MIME[ext],
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://docs.google.com https://docs.googleusercontent.com; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    };
    if (path.basename(filePath) === "service-worker.js") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------
// 8. Servidor HTTP
// ---------------------------------------------------------------------
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
