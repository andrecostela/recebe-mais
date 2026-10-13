"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { readUsers, USERS_FILE } = require("../auth");
const { usePg, pool } = require("../db");
const { json, authenticateSession } = require("../middlewares/security");
const { readBody, cleanText } = require("../middlewares/validator");

async function handleUsersRoutes(req, res, url) {
  if (url.pathname !== "/api/users") return false;

  // GET /api/users
  if (req.method === "GET") {
    const session = authenticateSession(req, res);
    if (!session) return true;
    if (session.role !== "Supervisor") {
      json(res, 403, { error: "Acesso negado." });
      return true;
    }
    const users = (await readUsers()).map(u => ({ username: u.username, name: u.name || "", role: u.role }));
    json(res, 200, { users });
    return true;
  }

  // POST /api/users
  if (req.method === "POST") {
    const session = authenticateSession(req, res, { write: true });
    if (!session) return true;
    if (session.role !== "Supervisor") {
      json(res, 403, { error: "Apenas supervisores podem gerenciar a equipe." });
      return true;
    }

    try {
      const input = await readBody(req);
      const action = input.action;
      const username = cleanText(input.username, 60);
      const name = cleanText(input.name, 100);
      const password = String(input.password || "").trim();
      const role = cleanText(input.role, 20);

      if (!username || !name || !["Conferente", "Assistente", "Supervisor"].includes(role)) {
        json(res, 400, { error: "Preencha todos os campos corretamente." });
        return true;
      }

      const usersDb = await readUsers();
      const existingIndex = usersDb.findIndex(u => u.username.toLowerCase() === username.toLowerCase());

      let salt, hash;

      if (action === "create") {
        if (existingIndex >= 0) {
          json(res, 400, { error: "Este nome de usuário (login) já existe." });
          return true;
        }
        if (password.length < 6) {
          json(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
          return true;
        }

        salt = crypto.randomBytes(16).toString("hex");
        hash = crypto.scryptSync(password, salt, 64).toString("hex");
        usersDb.push({ username, name, role, salt, hash });
      } else if (action === "update") {
        if (existingIndex < 0) {
          json(res, 404, { error: "Usuário não encontrado." });
          return true;
        }

        const currentUser = usersDb[existingIndex];
        if (currentUser.role === "Supervisor" && role !== "Supervisor") {
          const totalSupervisors = usersDb.filter(u => u.role === "Supervisor").length;
          if (totalSupervisors <= 1) {
            json(res, 400, { error: "Não é possível rebaixar o único Supervisor existente." });
            return true;
          }
        }

        usersDb[existingIndex].name = name;
        usersDb[existingIndex].role = role;
        salt = currentUser.salt;
        hash = currentUser.hash;

        if (password.length > 0) {
          if (password.length < 6) {
            json(res, 400, { error: "A nova senha deve ter pelo menos 6 caracteres." });
            return true;
          }
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

      json(res, 200, { ok: true, username, name, role });
    } catch {
      json(res, 500, { error: "Erro interno ao salvar usuário." });
    }
    return true;
  }

  return false;
}

module.exports = handleUsersRoutes;