"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const RECORDS_FILE = path.join(DATA_DIR, "recebimentos.json");
const INSUMOS_FILE = path.join(DATA_DIR, "insumos.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

const sessions = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes("$")) return false;
  const [salt, originalHash] = storedHash.split("$");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(originalHash));
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      list[parts.shift().trim()] = decodeURI(parts.join("="));
    });
  }
  return list;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

function sendJSON(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // API ROTAS
  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/login" && method === "POST") {
      try {
        const body = await parseBody(req);
        const users = readJSON(USERS_FILE);
        const user = users.find((u) => u.username.toLowerCase() === String(body.username || "").toLowerCase());

        if (!user || !verifyPassword(body.password, user.passwordHash)) {
          return sendJSON(res, 401, { error: "Usuário ou senha inválidos." });
        }

        const sid = crypto.randomBytes(32).toString("hex");
        const csrfToken = crypto.randomBytes(16).toString("hex");
        sessions.set(sid, {
          user: { id: user.id, username: user.username, name: user.name, role: user.role },
          csrfToken,
          expiresAt: Date.now() + SESSION_TTL
        });

        res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
        return sendJSON(res, 200, {
          user: { username: user.username, name: user.name, role: user.role },
          csrf: csrfToken
        });
      } catch {
        return sendJSON(res, 400, { error: "Payload inválido." });
      }
    }

    if (pathname === "/api/logout" && method === "POST") {
      const session = getSession(req);
      if (session) sessions.delete(session.sid);
      res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/me" && method === "GET") {
      const session = getSession(req);
      if (!session) return sendJSON(res, 401, { error: "Não autenticado." });
      return sendJSON(res, 200, { user: session.user, csrf: session.csrfToken });
    }

    const session = getSession(req);
    if (!session) return sendJSON(res, 401, { error: "Sessão expirada ou inválida." });

    if (pathname === "/api/records" && method === "GET") {
      const records = readJSON(RECORDS_FILE);
      return sendJSON(res, 200, { records });
    }

    if (pathname === "/api/records" && method === "POST") {
      try {
        const body = await parseBody(req);
        const records = readJSON(RECORDS_FILE);
        const newRecord = {
          ...body,
          id: body.id || `R-${Date.now().toString().slice(-6)}`,
          source: "server"
        };
        records.unshift(newRecord);
        writeJSON(RECORDS_FILE, records);
        return sendJSON(res, 201, { record: newRecord });
      } catch {
        return sendJSON(res, 400, { error: "Falha ao cadastrar registro." });
      }
    }

    if (pathname.startsWith("/api/records/") && pathname.endsWith("/transition") && method === "PATCH") {
      try {
        const parts = pathname.split("/");
        const recordId = decodeURIComponent(parts[3]);
        const body = await parseBody(req);
        const records = readJSON(RECORDS_FILE);
        const index = records.findIndex((r) => r.id === recordId);

        if (index === -1) return sendJSON(res, 404, { error: "Registro não encontrado." });

        if (body.action === "start") {
          records[index].status = "Em descarga";
          records[index].inicio = new Date().toISOString();
          records[index].volumetria = body.volumetria || records[index].volumetria;
          records[index].conferente = body.conferente || session.user.name || session.user.username;
        } else if (body.action === "finish") {
          records[index].status = "Concluído";
          records[index].fim = new Date().toISOString();

          if (body.insumos) {
            const insumosDb = readJSON(INSUMOS_FILE);
            const items = typeof body.insumos === "string" ? JSON.parse(body.insumos) : body.insumos;
            items.forEach((item) => {
              insumosDb.unshift({
                id: `INS-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
                recebimento_id: recordId,
                tipo_insumo: item.tipo,
                quantidade: item.qtd,
                condicao: item.status || "Íntegro",
                observacao: item.obs || "",
                foto_url: body.foto_url || item.foto_url || "",
                origem: records[index].origem,
                placa: records[index].placa,
                conferente: session.user.name || session.user.username,
                criado_em: new Date().toISOString()
              });
            });
            writeJSON(INSUMOS_FILE, insumosDb);
          }
        }

        writeJSON(RECORDS_FILE, records);
        return sendJSON(res, 200, { record: records[index] });
      } catch (err) {
        return sendJSON(res, 400, { error: "Erro ao processar transição." });
      }
    }

    if (pathname === "/api/insumos" && method === "GET") {
      let insumos = readJSON(INSUMOS_FILE);
      const dataInicio = parsedUrl.searchParams.get("dataInicio");
      const dataFim = parsedUrl.searchParams.get("dataFim");
      const origem = parsedUrl.searchParams.get("origem");
      const conferente = parsedUrl.searchParams.get("conferente");

      if (dataInicio) insumos = insumos.filter((i) => i.criado_em >= dataInicio);
      if (dataFim) insumos = insumos.filter((i) => i.criado_em <= dataFim + "T23:59:59");
      if (origem) insumos = insumos.filter((i) => i.origem.toLowerCase().includes(origem.toLowerCase()));
      if (conferente) insumos = insumos.filter((i) => i.conferente.toLowerCase().includes(conferente.toLowerCase()));

      return sendJSON(res, 200, { insumos });
    }

    if (pathname === "/api/users" && method === "GET") {
      const users = readJSON(USERS_FILE).map(({ passwordHash, ...u }) => u);
      return sendJSON(res, 200, { users });
    }

    if (pathname === "/api/users" && method === "POST") {
      if (session.user.role !== "Supervisor") {
        return sendJSON(res, 403, { error: "Apenas supervisores podem gerenciar usuários." });
      }
      const body = await parseBody(req);
      const users = readJSON(USERS_FILE);

      if (body.action === "create") {
        if (users.some((u) => u.username.toLowerCase() === body.username.toLowerCase())) {
          return sendJSON(res, 400, { error: "Nome de usuário já cadastrado." });
        }
        users.push({
          id: `u-${Date.now()}`,
          username: body.username,
          name: body.name,
          role: body.role,
          passwordHash: hashPassword(body.password)
        });
      } else if (body.action === "update") {
        const u = users.find((item) => item.username === body.username);
        if (u) {
          u.name = body.name;
          u.role = body.role;
          if (body.password) u.passwordHash = hashPassword(body.password);
        }
      }
      writeJSON(USERS_FILE, users);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/change-password" && method === "POST") {
      const body = await parseBody(req);
      const users = readJSON(USERS_FILE);
      const user = users.find((u) => u.id === session.user.id);

      if (!user || !verifyPassword(body.currentPassword, user.passwordHash)) {
        return sendJSON(res, 400, { error: "Senha atual incorreta." });
      }

      user.passwordHash = hashPassword(body.newPassword);
      writeJSON(USERS_FILE, users);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: "Rota API não encontrada." });
  }

  // SERVIR ARQUIVOS ESTÁTICOS DO FRONTEND
  let filePath = path.join(__dirname, "public", pathname === "/" ? "index.html" : pathname);
  if (!fs.existsSync(filePath) && fs.existsSync(path.join(__dirname, pathname))) {
    filePath = path.join(__dirname, pathname);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml"
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Página não encontrada.");
    } else {
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(content, "utf-8");
    }
  });
});

server.listen(PORT, () => {
  console.log(`Recebe+ rodando localmente no endereço: http://localhost:${PORT}`);
});