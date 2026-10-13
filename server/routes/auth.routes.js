"use strict";

const crypto = require("crypto");
const { readUsers, verifyPassword, validatePasswordStrength, sessions, setSessionCookie, registerFailure, SESSION_TTL } = require("../auth");
const { readDb, writeDb, auditUserManagement } = require("../db");
const { json, checkRateLimit, authenticateSession } = require("../middlewares/security");
const { readBody, cleanText } = require("../middlewares/validator");

async function handleAuthRoutes(req, res, url) {
  // POST /api/login
  if (req.method === "POST" && url.pathname === "/api/login") {
    if (!checkRateLimit(req, res)) return true;
    const ip = req.socket.remoteAddress || "unknown";

    try {
      const input = await readBody(req);
      const username = cleanText(input.username, 60);
      const user = (await readUsers()).find(item => item.username.toLowerCase() === username.toLowerCase());

      if (!user || !verifyPassword(input.password, user)) {
        registerFailure(ip);
        json(res, 401, { error: "Usuário ou senha inválidos" });
        return true;
      }

      const token = crypto.randomBytes(32).toString("hex");
      const csrf = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { username: user.username, role: user.role, csrf, expiresAt: Date.now() + SESSION_TTL });
      setSessionCookie(res, token);

      json(res, 200, { user: { username: user.username, role: user.role }, csrf });
    } catch {
      json(res, 400, { error: "Não foi possível processar o login" });
    }
    return true;
  }

  // GET /api/me
  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = authenticateSession(req, res);
    if (!session) return true;
    json(res, 200, { user: { username: session.username, role: session.role }, csrf: session.csrf });
    return true;
  }

  // POST /api/logout
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = authenticateSession(req, res, { write: true });
    if (!session) return true;
    sessions.delete(session.token);
    setSessionCookie(res, "", 0);
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/change-password
  if (req.method === "POST" && url.pathname === "/api/change-password") {
    const session = authenticateSession(req, res, { write: true });
    if (!session) return true;

    try {
      const input = await readBody(req);
      const { currentPassword, newPassword } = input;

      if (!currentPassword || !newPassword) {
        json(res, 400, { error: "Preencha a senha atual e a nova senha." });
        return true;
      }

      const usersDb = await readUsers();
      const userIndex = usersDb.findIndex(u => u.username.toLowerCase() === session.username.toLowerCase());

      if (userIndex < 0) {
        json(res, 404, { error: "Usuário não encontrado." });
        return true;
      }

      if (!verifyPassword(currentPassword, usersDb[userIndex])) {
        json(res, 401, { error: "A senha atual informada está incorreta." });
        return true;
      }

      validatePasswordStrength(newPassword);

      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(newPassword, salt, 64).toString("hex");

      usersDb[userIndex].salt = salt;
      usersDb[userIndex].hash = hash;

      const fs = require("fs");
      const { USERS_FILE } = require("../auth");
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: usersDb }, null, 2), { mode: 0o600 });

      const db = await readDb();
      auditUserManagement(db, "Redefinição de Senha Própria", session.role, session.username);
      writeDb(db);

      json(res, 200, { ok: true, message: "Senha alterada com sucesso." });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}

module.exports = handleAuthRoutes;