"use strict";

const crypto = require("crypto");

/**
 * Lê e limita o tamanho da string enviada no payload para evitar estouro de memória.
 * 
 * @param {any} value - Valor de entrada
 * @param {number} max - Tamanho máximo permitido (padrão: 120 caracteres)
 * @returns {string} String limpa e sanitizada
 */
function cleanText(value, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * Validador e sanitizador dos payloads de recebimentos operacionais.
 * 
 * @param {object} input - Objeto de entrada enviado pelo Front-End
 * @returns {object} Objeto sanitizado e pronto para gravação no banco
 */
function validateRecord(input) {
  const record = {
    id: `R-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    data: cleanText(input.data, 40),
    origem: cleanText(input.origem),
    doca: cleanText(input.doca, 12).replace(/\D/g, "") || "—",
    motorista: cleanText(input.motorista) || "—", // Opcional (preenche "—" se omitido)
    placa: cleanText(input.placa, 10).toUpperCase() || "—", // Opcional (preenche "—" se omitido)
    volumetria: Number(input.volumetria) || 0, // Opcional (padrão: 0)
    inicio: input.inicio ? cleanText(input.inicio, 40) : null,
    fim: null,
    sla: Number(input.sla) || 60, // Atribui SLA padrão de 60 minutos se omitido
    conferente: cleanText(input.conferente) || "—",
    status: cleanText(input.status, 30) || "Em Trânsito",
    source: "server"
  };

  // Validação de presença obrigatória apenas para a Data e a Origem
  if (!record.data || Number.isNaN(new Date(record.data).getTime())) {
    throw new Error("Data de previsão inválida");
  }

  if (!record.origem) {
    throw new Error("A origem do recebimento é obrigatória");
  }

  // Valida o formato da Placa APENAS se tiver sido informada (diferente do padrão "—")
  if (record.placa !== "—" && !/^[A-Z0-9-]{7,8}$/.test(record.placa)) {
    throw new Error("Placa inválida. Utilizar formato ABC-1234 ou ABC1D23");
  }

  // Validação de número válido para volumetria e status operacional
  if (!Number.isFinite(record.volumetria) || record.volumetria < 0) {
    throw new Error("Volumetria inválida");
  }

  if (!["Em Trânsito", "Aguardando", "Em descarga", "Concluído", "Em Atraso"].includes(record.status)) {
    throw new Error("Status operacional inválido");
  }

  return record;
}

module.exports = {
  cleanText,
  validateRecord
};