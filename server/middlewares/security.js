"use strict";

const { getSession, isRateLimited } = require("../auth");

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function checkRateLimit(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    json(res, 429, { error: "Muitas tentativas. Aguarde antes de tentar novamente." });
    return false;
  }
  return true;
}

function authenticateSession(req, res, { write = false } = {}) {
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

module.exports = {
  json,
  checkRateLimit,
  authenticateSession
};