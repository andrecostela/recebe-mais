"use strict";

const { readDb, createRecordDb, transitionRecordDb } = require("../db");
const { json, authenticateSession } = require("../middlewares/security");
const { readBody, validateRecord } = require("../middlewares/validator");

async function handleRecordsRoutes(req, res, url) {
  // GET /api/records
  if (req.method === "GET" && url.pathname === "/api/records") {
    const session = authenticateSession(req, res);
    if (!session) return true;
    const db = await readDb();
    json(res, 200, { records: db.records, updatedAt: new Date().toISOString() });
    return true;
  }

  // GET /api/audit
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const session = authenticateSession(req, res);
    if (!session) return true;
    if (session.role !== "Supervisor") {
      json(res, 403, { error: "Acesso restrito ao supervisor" });
      return true;
    }
    const db = await readDb();
    json(res, 200, { audit: db.audit.slice(0, 100) });
    return true;
  }

  // POST /api/records
  if (req.method === "POST" && url.pathname === "/api/records") {
    const session = authenticateSession(req, res, { write: true });
    if (!session) return true;
    if (!["Conferente", "Assistente", "Supervisor"].includes(session.role)) {
      json(res, 403, { error: "Perfil sem permissão" });
      return true;
    }

    try {
      const input = await readBody(req);
      const record = validateRecord(input);
      await createRecordDb(record, session.role);
      json(res, 201, { record });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  // PATCH /api/records/:id/transition
  const match = url.pathname.match(/^\/api\/records\/([^/]+)\/transition$/);
  if (req.method === "PATCH" && match) {
    const session = authenticateSession(req, res, { write: true });
    if (!session) return true;
    if (!["Conferente", "Supervisor"].includes(session.role)) {
      json(res, 403, { error: "Somente conferentes e supervisores podem alterar a descarga" });
      return true;
    }

    try {
      const input = await readBody(req);
      const recordId = decodeURIComponent(match[1]);
      const updatedRecord = await transitionRecordDb(recordId, input.action, input, session.role);
      json(res, 200, { record: updatedRecord });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}

module.exports = handleRecordsRoutes;