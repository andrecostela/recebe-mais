"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { usePg, pool } = require("./db");

const ROOT = path.resolve(__dirname, "..");
const USERS_FILE = path.join(ROOT, "data", "users.json");

const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 Horas

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
    return actual.length === expected.length && crypto.timingEqual(actual, expected);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  "123456", "12345678", "123456789", "password", "senha123",
  "admin123", "recebeplus", "mudar123", "1234567890", "qwertyuiop", "supervisorsenha"
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
  } catch {
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

    console.log(`✅ Administrador inicial criado com sucesso:\nUsuário: admin\nSenha:   ${initialAdminPassword}\n⚠️ ALERTA: Guarde esta senha e altere-a após o primeiro login!`);
  }
}
ensureInitialUsersDb();

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
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
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Autenticação necessária" }));
    return null;
  }
  if (write && req.headers["x-csrf-token"] !== session.csrf) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Sessão inválida" }));
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

module.exports = {
  USERS_FILE,
  sessions,
  SESSION_TTL,
  readUsers,
  verifyPassword,
  validatePasswordStrength,
  getSession,
  setSessionCookie,
  requireSession,
  isRateLimited,
  registerFailure
};