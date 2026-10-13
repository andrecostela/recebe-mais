"use strict";
// ========================================== 
// 1. CONFIGURAÇÕES, MÓDULOS E VARIÁVEIS DE AMBIENTE 
// ==========================================
const http = require("http"); const fs = require("fs"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");

// 1.1 Conexão com o banco PostgreSQL (Render / Produção)
const usePg = Boolean(process.env.DATABASE_URL);
const pool = usePg ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } }) : null;

// 1.2 Constantes de ambiente, arquivos locais e sessão
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "recebimentos.json");
const USERS_FILE = path.join(ROOT, "data", "users.json");
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const PUBLIC_FILES = new Set(["index.html", "styles.css", "app.js", "manifest.json", "service-worker.js", "icon.svg"]);

// 1.3 Mapeamento de Mime Types para arquivos estáticos
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

// ========================================== 
// 2. SEGURANÇA, AUTENTICAÇÃO E USUÁRIOS 
// ==========================================
async function readUsers() {
  if (usePg) {
    try {
      const res = await pool.query("SELECT * FROM usuarios");
      return res.rows;
    } catch (err) {
      console.error("Erro ao ler usuários no PG:", err);
      return [];
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

function verifyPassword(password, user) {
  try {
    const actual = crypto.scryptSync(String(password), user.salt, 64);
    const expected = Buffer.from(user.hash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  "123456", "12345678", "123456789", "password", "senha123", "admin123", "recebeplus", "mudar123", "1234567890", "qwertyuiop", "supervisorsenha"
]);

function validatePasswordStrength(password) {
  const pwd = String(password || "");
  if (pwd.length < 12) {
    throw new Error("A senha deve possuir no mínimo 12 caracteres.");
  }
  if (COMMON_PASSWORDS.has(pwd.toLowerCase().trim())) {
    throw new Error("A senha escolhida é muito comum e insegura. Escolha uma frase-senha mais longa.");
  }
  return true;
}

function ensureInitialUsersDb() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  let users = [];
  try {
    if (fs.existsSync(USERS_FILE)) {
      const content = fs.readFileSync(USERS_FILE, "utf8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.users)) users = parsed.users;
    }
  } catch (err) {
    console.warn("Arquivo users.json corrompido ou ausente. Reinicializando base de usuários.");
  }

  const hasSupervisor = users.some(u => u.role === "Supervisor");

  if (!hasSupervisor || users.length === 0) {
    console.warn("⚠️ Nenhum supervisor encontrado. Criando conta inicial de administrador...");

    const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString("hex") + "A1!";
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(initialAdminPassword, salt, 64).toString("hex");

    const adminUser = {
      username: "admin",
      name: "Administrador do Sistema",
      role: "Supervisor",
      salt,
      hash,
      createdAt: new Date().toISOString()
    };

    users.unshift(adminUser);
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), { mode: 0o600 });

    console.log(`✅ Administrador inicial criado com sucesso:
Usuário: admin
Senha:   ${initialAdminPassword}
⚠️ ALERTA: Guarde esta senha e altere-a após o primeiro login!`);
  }
}
ensureInitialUsersDb();

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";")
      .map(part => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => key)
      .map(([key, value]) => [key, decodeURIComponent(value || "")])
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

function setSessionCookie(res, token, maxAge = SESSION_TTL / 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `recebe_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function requireSession(req, res, { write = false } = {}) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Autenticação necessária" });
    return null;
  }
  if (write && req.headers["x-csrf-token"] !== session.csrf) {
    json(res, 403, { error: "Sessão inválida" });
    return null;
  }
  return session;
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60 * 1000) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 5;
}

function registerFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  loginAttempts.set(ip, !entry || now - entry.since > 15 * 60 * 1000 ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since });
}

// ========================================== 
// 3. PERSISTÊNCIA DE DADOS E AUDITORIA (PG / JSON) 
// ==========================================
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
    `);

    const resUsers = await client.query("SELECT COUNT(*) FROM usuarios");
    if (parseInt(resUsers.rows[0].count, 10) === 0) {
      const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD || "admin12345678";
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(initialAdminPassword, salt, 64).toString("hex");
      await client.query(
        "INSERT INTO usuarios (id, username, name, role, hash, salt) VALUES ($1, $2, $3, $4, $5, $6)",
        [crypto.randomUUID(), "admin", "Administrador do Sistema", "Supervisor", hash, salt]
      );
      console.log(`✅ [PostgreSQL] Administrador inicial criado com sucesso.`);
    }
  } catch (err) {
    console.error("❌ Erro ao inicializar tabelas no PostgreSQL:", err);
  } finally {
    client.release();
  }
}
initDb();

function nowAt(hour, minute = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function seed() {
  return [
    { id: "D-101", data: nowAt(7, 20), origem: "CD Guarulhos", doca: "3", motorista: "Carlos Mendes", placa: "RFG-8J21", volumetria: 1860, inicio: nowAt(7, 42), fim: nowAt(8, 31), sla: 60, conferente: "Ana Souza", status: "Concluído", source: "server" },
    { id: "D-102", data: nowAt(8, 10), origem: "Hub Campinas", doca: "5", motorista: "João Ribeiro", placa: "GHT-4C07", volumetria: 2430, inicio: nowAt(8, 28), fim: null, sla: 75, conferente: "Marcos Lima", status: "Em descarga", source: "server" },
    { id: "D-103", data: nowAt(9, 0), origem: "CD Extrema", doca: "2", motorista: "Paulo Nunes", placa: "BXR-1D94", volumetria: 0, inicio: null, fim: null, sla: 45, conferente: "—", status: "Aguardando", source: "server" },
    { id: "D-104", data: nowAt(9, 35), origem: "Hub Sorocaba", doca: "8", motorista: "Rafael Alves", placa: "TJK-6F13", volumetria: 0, inicio: null, fim: null, sla: 90, conferente: "Beatriz Reis", status: "Em Trânsito", source: "server" },
    { id: "D-105", data: nowAt(10, 20), origem: "CD Louveira", doca: "1", motorista: "Diego Martins", placa: "KLM-9A42", volumetria: 0, inicio: null, fim: null, sla: 55, conferente: "—", status: "Em Trânsito", source: "server" }
  ];
}

async function readDb() {
  if (usePg) {
    try {
      const recRes = await pool.query("SELECT * FROM recebimentos ORDER BY data DESC");
      const auditRes = await pool.query("SELECT * FROM auditoria ORDER BY timestamp DESC LIMIT 100");

      const records = recRes.rows.map(r => ({
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
        insumos: r.insumos_lista ? (typeof r.insumos_lista === "string" ? JSON.parse(r.insumos_lista) : r.insumos_lista) : null,
        source: "server"
      }));

      const audit = auditRes.rows.map(a => ({
        id: a.id,
        timestamp: a.timestamp ? new Date(a.timestamp).toISOString() : new Date().toISOString(),
        action: a.action,
        recordId: a.record_id,
        placa: a.placa,
        role: a.role
      }));

      return { records, audit };
    } catch (err) {
      console.error("❌ Erro ao ler banco de dados no PostgreSQL:", err);
      return { records: [], audit: [] };
    }
  }

  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(db.records)) db.records = [];
    if (!Array.isArray(db.audit)) db.audit = [];
    if (!db.records.length) {
      db.records = seed();
      writeDb(db);
    } else {
      let changed = false;
      db.records = db.records.map(record => {
        const status = record.status === "Previsto" ? "Em Trânsito" : record.status === "Divergência" ? "Em Atraso" : record.status;
        const doca = String(record.doca ?? "").replace(/^D/i, "").replace(/^0+(?=\d)/, "") || "—";
        if (status !== record.status || doca !== record.doca) changed = true;
        return { ...record, status, doca };
      });
      if (changed) writeDb(db);
    }
    return db;
  } catch {
    const db = { records: seed(), audit: [] };
    writeDb(db);
    return db;
  }
}

async function createRecordDb(record, role) {
  if (usePg) {
    await pool.query(
      "INSERT INTO recebimentos (id, data, origem, placa, motorista, doca, volumetria, sla, status, inicio, fim, conferente) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [record.id, record.data, record.origem, record.placa, record.motorista, record.doca, record.volumetria, record.sla, record.status, record.inicio, record.fim, record.conferente]
    );
    await auditDb("Recebimento criado", record, role);
    return;
  }

  const db = await readDb();
  db.records.unshift(record);
  audit(db, "Recebimento criado", record, role);
  writeDb(db);
}

async function transitionRecordDb(id, action, input, role) {
  const allowed = { start: "Em descarga", finish: "Concluído", issue: "Em Atraso" };
  const targetStatus = allowed[action];
  if (!targetStatus) throw new Error("Transição inválida");

  if (usePg) {
    const checkRes = await pool.query("SELECT * FROM recebimentos WHERE id = $1", [id]);
    if (checkRes.rows.length === 0) throw new Error("Registro não encontrado");
    const record = checkRes.rows[0];

    let updateQuery = "UPDATE recebimentos SET status = $1";
    const queryParams = [targetStatus];
    let paramIdx = 2;

    if (action === "start") {
      if (!["Em Trânsito", "Aguardando"].includes(record.status)) throw new Error("A descarga não pode ser iniciada neste status");
      const volume = Number(input.volumetria);
      if (!Number.isFinite(volume) || volume < 1) throw new Error("Informe a volumetria para iniciar a descarga");

      updateQuery += `, volumetria = $${paramIdx++}, inicio = $${paramIdx++}`;
      queryParams.push(volume, new Date().toISOString());

      if (input.conferente) {
        updateQuery += `, conferente = $${paramIdx++}`;
        queryParams.push(input.conferente);
      }
    }

    if (action === "finish" || action === "issue") {
      if (record.status !== "Em descarga") throw new Error("A descarga não está em andamento");

      updateQuery += `, fim = $${paramIdx++}`;
      queryParams.push(new Date().toISOString());

      if (input.insumo_tipo) {
        updateQuery += `, insumo_tipo = $${paramIdx++}, insumo_qtd = $${paramIdx++}, insumo_status = $${paramIdx++}, insumo_obs = $${paramIdx++}, insumos_lista = $${paramIdx++}`;
        queryParams.push(
          input.insumo_tipo,
          input.insumo_qtd || 0,
          input.insumo_status || "",
          input.insumo_obs || "",
          input.insumos ? (typeof input.insumos === "string" ? input.insumos : JSON.stringify(input.insumos)) : null
        );

        try {
          let insumosArray = [];
          if (typeof input.insumos === "string") {
            insumosArray = JSON.parse(input.insumos);
          } else if (Array.isArray(input.insumos)) {
            insumosArray = input.insumos;
          }

          for (const item of insumosArray) {
            const qtd = Number(item.qtd || item.quantidade || 0);
            if (qtd > 0 && item.tipo) {
              await pool.query(`
                INSERT INTO insumos_recebimento (id, recebimento_id, tipo_insumo, quantidade, condicao, observacao, foto_url)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
              `, [
                crypto.randomUUID(),
                id,
                cleanText(item.tipo, 50),
                qtd,
                cleanText(item.status || item.condicao, 30),
                cleanText(item.obs || item.observacao, 255),
                cleanText(item.foto_url || input.foto_url || "", 500)
              ]);
            }
          }
        } catch (insumoErr) {
          console.error("Erro ao gravar insumos relacionais:", insumoErr);
        }
      }
    }

    updateQuery += ` WHERE id = $${paramIdx} RETURNING *`;
    queryParams.push(id);

    const updatedRes = await pool.query(updateQuery, queryParams);
    const updatedRecord = updatedRes.rows[0];

    await auditDb(`Status alterado para ${targetStatus}`, updatedRecord, role);
    return updatedRecord;
  }

  const db = await readDb();
  const record = db.records.find(r => r.id === id);
  if (!record) throw new Error("Registro não encontrado");

  if (action === "start") {
    if (!["Em Trânsito", "Aguardando"].includes(record.status)) throw new Error("A descarga não pode ser iniciada neste status");
    const volume = Number(input.volumetria);
    if (!Number.isFinite(volume) || volume < 1) throw new Error("Informe a volumetria para iniciar a descarga");
    record.volumetria = volume;
    record.inicio = new Date().toISOString();
    if (input.conferente) record.conferente = input.conferente;
  }

  if (action === "finish" || action === "issue") {
    if (record.status !== "Em descarga") throw new Error("A descarga não está em andamento");
    record.fim = new Date().toISOString();
    if (input.insumo_tipo) {
      record.insumo_tipo = input.insumo_tipo;
      record.insumo_qtd = input.insumo_qtd;
      record.insumo_status = input.insumo_status;
      record.insumo_obs = input.insumo_obs;
      record.insumos_lista = input.insumos;
    }
  }

  record.status = targetStatus;
  audit(db, `Status alterado para ${record.status}`, record, role);
  writeDb(db);
  return record;
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

function audit(db, action, record, role) {
  db.audit.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    recordId: record.id,
    placa: record.placa,
    role: cleanText(role, 30) || "Conferente"
  });
  db.audit = db.audit.slice(0, 1000);
}

async function auditDb(action, record, role) {
  if (usePg) {
    await pool.query(
      "INSERT INTO auditoria (id, timestamp, action, record_id, placa, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [crypto.randomUUID(), new Date().toISOString(), action, record.id, record.placa, cleanText(role, 30) || "Conferente"]
    );
    return;
  }
}

function auditUserManagement(db, action, targetUsername, targetRole, actorUsername) {
  if (!Array.isArray(db.audit)) db.audit = [];
  db.audit.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action: `[SEGURANÇA] ${action}`,
    recordId: targetUsername,
    placa: targetRole,
    role: actorUsername
  });
  db.audit = db.audit.slice(0, 1000);
}

// ========================================== 
// 4. AUXILIARES, SANITIZAÇÃO E VALIDAÇÕES 
// ==========================================
function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Payload excede o limite"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function validateRecord(input) {
  const record = {
    id: `R-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    data: cleanText(input.data, 40),
    origem: cleanText(input.origem),
    doca: cleanText(input.doca, 12).replace(/\D/g, "") || "—",
    motorista: cleanText(input.motorista),
    placa: cleanText(input.placa, 10).toUpperCase(),
    volumetria: Number(input.volumetria) || 0,
    inicio: input.inicio ? cleanText(input.inicio, 40) : null,
    fim: null,
    sla: Number(input.sla),
    conferente: cleanText(input.conferente) || "—",
    status: cleanText(input.status, 30) || "Em Trânsito",
    source: "server"
  };
  if (!record.data || Number.isNaN(new Date(record.data).getTime())) throw new Error("Data inválida");
  if (!record.origem || !record.motorista || !record.placa) throw new Error("Campos obrigatórios ausentes");
  if (!/^[A-Z0-9-]{7,8}$/.test(record.placa)) throw new Error("Placa inválida");
  if (!Number.isFinite(record.volumetria) || record.volumetria < 0 || (record.status === "Em descarga" && record.volumetria < 1)) throw new Error("Volumetria inválida");
  if (!Number.isFinite(record.sla) || record.sla < 1) throw new Error("SLA inválido");
  if (!["Em Trânsito", "Aguardando", "Em descarga"].includes(record.status)) throw new Error("Status inválido");
  return record;
}

// ========================================== 
// 5. ROTAS DA API RESTFUL (HANDLER PRINCIPAL) 
// ==========================================
async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/login") {
    const ip = req.socket.remoteAddress || "unknown";
    if (isRateLimited(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde antes de tentar novamente." });
    try {
      const input = await readBody(req);
      const username = cleanText(input.username, 60);
      const user = (await readUsers()).find(item => item.username.toLowerCase() === username.toLowerCase());
      if (!user || !verifyPassword(input.password, user)) {
        registerFailure(ip);
        return json(res, 401, { error: "Usuário ou senha inválidos" });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      const csrf = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { username: user.username, role: user.role, csrf, expiresAt: Date.now() + SESSION_TTL });
      setSessionCookie(res, token);
      return json(res, 200, { user: { username: user.username, role: user.role }, csrf });
    } catch (error) {
      return json(res, 400, { error: "Não foi possível processar o login" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    const session = requireSession(req, res);
    if (!session) return;
    if (session.role !== "Supervisor") return json(res, 403, { error: "Acesso negado." });
    const users = (await readUsers()).map(u => ({ username: u.username, name: u.name || "", role: u.role }));
    return json(res, 200, { users });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const session = requireSession(req, res, { write: true });
    if (!session) return;
    if (session.role !== "Supervisor") return json(res, 403, { error: "Apenas supervisores podem gerenciar a equipe." });

    try {
      const input = await readBody(req);
      const action = input.action;
      const username = cleanText(input.username, 60);
      const name = cleanText(input.name, 100);
      const password = String(input.password || "").trim();
      const role = cleanText(input.role, 20);

      if (!username || !name || !["Conferente", "Assistente", "Supervisor"].includes(role)) {
        return json(res, 400, { error: "Preencha todos os campos corretamente." });
      }

      const usersDb = await readUsers();
      const existingIndex = usersDb.findIndex(u => u.username.toLowerCase() === username.toLowerCase());

      let salt, hash;

      if (action === "create") {
        if (existingIndex >= 0) return json(res, 400, { error: "Este nome de usuário (login) já existe." });
        if (password.length < 6) return json(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });

        salt = crypto.randomBytes(16).toString("hex");
        hash = crypto.scryptSync(password, salt, 64).toString("hex");
        usersDb.push({ username, name, role, salt, hash });

      } else if (action === "update") {
        if (existingIndex < 0) return json(res, 404, { error: "Usuário não encontrado." });

        const currentUser = usersDb[existingIndex];
        if (currentUser.role === "Supervisor" && role !== "Supervisor") {
          const totalSupervisors = usersDb.filter(u => u.role === "Supervisor").length;
          if (totalSupervisors <= 1) {
            return json(res, 400, { error: "Não é possível rebaixar o único Supervisor existente." });
          }
        }

        usersDb[existingIndex].name = name;
        usersDb[existingIndex].role = role;
        salt = currentUser.salt;
        hash = currentUser.hash;

        if (password.length > 0) {
          if (password.length < 6) return json(res, 400, { error: "A nova senha deve ter pelo menos 6 caracteres." });
          salt = crypto.randomBytes(16).toString("hex");
          hash = crypto.scryptSync(password, salt, 64).toString("hex");
          usersDb[existingIndex].salt = salt;
          usersDb[existingIndex].hash = hash;
        }
      }

      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: usersDb }, null, 2), { mode: 0o600 });

      if (usePg) {
        try {
          await pool.query(
            "INSERT INTO usuarios (id, username, name, role, hash, salt) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO UPDATE SET name = $3, role = $4, hash = $5, salt = $6",
            [crypto.randomUUID(), username, name, role, hash, salt]
          );
        } catch (pgErr) {
          console.error("Erro ao persistir usuário no PostgreSQL:", pgErr);
        }
      }

      return json(res, 200, { ok: true, username, name, role });
    } catch (error) {
      return json(res, 500, { error: "Erro interno ao salvar usuário." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = requireSession(req, res);
    if (!session) return;
    return json(res, 200, { user: { username: session.username, role: session.role }, csrf: session.csrf });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = requireSession(req, res, { write: true });
    if (!session) return;
    sessions.delete(session.token);
    setSessionCookie(res, "", 0);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/change-password") {
    const session = requireSession(req, res, { write: true });
    if (!session) return;

    try {
      const input = await readBody(req);
      const { currentPassword, newPassword } = input;

      if (!currentPassword || !newPassword) {
        return json(res, 400, { error: "Preencha a senha atual e a nova senha." });
      }

      const usersDb = await readUsers();
      const userIndex = usersDb.findIndex(u => u.username.toLowerCase() === session.username.toLowerCase());

      if (userIndex < 0) return json(res, 404, { error: "Usuário não encontrado." });

      if (!verifyPassword(currentPassword, usersDb[userIndex])) {
        return json(res, 401, { error: "A senha atual informada está incorreta." });
      }

      validatePasswordStrength(newPassword);

      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(newPassword, salt, 64).toString("hex");

      usersDb[userIndex].salt = salt;
      usersDb[userIndex].hash = hash;

      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: usersDb }, null, 2), { mode: 0o600 });

      const db = await readDb();
      auditUserManagement(db, "Redefinição de Senha Própria", session.role, session.username);
      writeDb(db);

      return json(res, 200, { ok: true, message: "Senha alterada com sucesso." });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const write = req.method !== "GET";
  const session = requireSession(req, res, { write });
  if (!session) return;
  const role = session.role;

  if (req.method === "GET" && url.pathname === "/api/records") {
    const db = await readDb();
    return json(res, 200, { records: db.records, updatedAt: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    if (role !== "Supervisor") return json(res, 403, { error: "Acesso restrito ao supervisor" });
    const db = await readDb();
    return json(res, 200, { audit: db.audit.slice(0, 100) });
  }

  if (req.method === "POST" && url.pathname === "/api/records") {
    if (!["Conferente", "Assistente", "Supervisor"].includes(role)) return json(res, 403, { error: "Perfil sem permissão" });
    try {
      const input = await readBody(req);
      const record = validateRecord(input);
      await createRecordDb(record, role);
      return json(res, 201, { record });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const match = url.pathname.match(/^\/api\/records\/([^/]+)\/transition$/);
  if (req.method === "PATCH" && match) {
    if (!["Conferente", "Supervisor"].includes(role)) return json(res, 403, { error: "Somente conferentes e supervisores podem alterar a descarga" });
    try {
      const input = await readBody(req);
      const recordId = decodeURIComponent(match[1]);
      const updatedRecord = await transitionRecordDb(recordId, input.action, input, role);
      return json(res, 200, { record: updatedRecord });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/insumos") {
    if (usePg) {
      try {
        const dataInicio = url.searchParams.get("data_inicio");
        const dataFim = url.searchParams.get("data_fim");
        const origem = url.searchParams.get("origem");
        const conferente = url.searchParams.get("conferente");

        let querySQL = `
          SELECT 
            i.id,
            i.tipo_insumo,
            i.quantidade,
            i.condicao,
            i.observacao,
            i.foto_url,
            i.criado_em,
            r.origem,
            r.placa,
            r.conferente
          FROM insumos_recebimento i
          JOIN recebimentos r ON r.id = i.recebimento_id
          WHERE 1=1
        `;
        const params = [];
        let idx = 1;

        if (dataInicio) {
          querySQL += ` AND i.criado_em >= $${idx++}`;
          params.push(dataInicio);
        }
        if (dataFim) {
          querySQL += ` AND i.criado_em <= $${idx++}`;
          params.push(dataFim);
        }
        if (origem) {
          querySQL += ` AND LOWER(r.origem) LIKE $${idx++}`;
          params.push(`%${origem.toLowerCase().trim()}%`);
        }
        if (conferente) {
          querySQL += ` AND LOWER(r.conferente) LIKE $${idx++}`;
          params.push(`%${conferente.toLowerCase().trim()}%`);
        }

        querySQL += ` ORDER BY i.criado_em DESC`;

        const resInsumos = await pool.query(querySQL, params);
        return json(res, 200, { insumos: resInsumos.rows });
      } catch (err) {
        console.error("Erro ao consultar insumos no PostgreSQL:", err);
        return json(res, 500, { error: "Erro ao consultar relatório de insumos." });
      }
    }
    return json(res, 200, { insumos: [] });
  }

  return json(res, 404, { error: "Rota da API não encontrada" });
}

// ========================================== 
// 6. SERVIDOR ESTÁTICO E INICIALIZAÇÃO HTTP 
// ==========================================
function serveStatic(req, res, url) {
  let requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  
  // Tratamento para subpastas de assets estáticos (ex: src/app.js, public/styles.css)
  const baseName = path.basename(requested);
  if (!PUBLIC_FILES.has(baseName) && !requested.startsWith("src/")) {
    return json(res, 404, { error: "Arquivo não encontrado" });
  }

  const filePath = path.resolve(ROOT, requested.startsWith("public/") ? requested : (requested.startsWith("src/") ? requested : path.join("public", requested)));
  
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { error: "Arquivo não encontrado" });
    const headers = {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://docs.google.com https://docs.googleusercontent.com; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    };
    if (path.basename(filePath) === "service-worker.js") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    return json(res, 500, { error: "Falha interna" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Recebe+ ativo na porta ${PORT}`));
