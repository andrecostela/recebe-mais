"use strict";

const crypto = require("crypto");

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

module.exports = {
  readBody,
  cleanText,
  validateRecord
};