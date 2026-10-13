"use strict";

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      field += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normHeader(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseDateBR(value) {
  if (!value) return new Date().toISOString();
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const m = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return new Date().toISOString();
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(year, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0)).toISOString();
}

function parseTimeOnDate(value, base) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const m = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toISOString();
}

function parseSla(value) {
  const m = String(value || "").match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(String(value || 60).replace(/\D/g, "")) || 60;
}

function recordsFromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normHeader);
  const get = (row, name) => row[headers.indexOf(normHeader(name))] || "";

  return rows.slice(1).map((row, i) => {
    const data = parseDateBR(get(row, "Data"));
    return normalizeRecord({
      id: `GS-${i}-${String(get(row, "Placa do Veículo")).replace(/\W/g, "")}`,
      data,
      origem: get(row, "Origem") || "—",
      previsao: get(row, "Previsao") || get(row, "Previsão") || "",
      doca: get(row, "Doca") || "—",
      motorista: get(row, "Motorista") || "—",
      placa: get(row, "Placa do Veículo") || "—",
      volumetria: Number(String(get(row, "Volumetria")).replace(/\D/g, "")) || 0,
      inicio: parseTimeOnDate(get(row, "Início Descarga"), data),
      fim: parseTimeOnDate(get(row, "Fim Descarga"), data),
      sla: parseSla(get(row, "SLA")),
      conferente: get(row, "Conferente / Responsável") || "—",
      status: get(row, "Status do Recebimento") || "Em Trânsito",
      source: "sheet"
    });
  }).filter(r => r.placa !== "—");
}

async function syncSheet(manual = false) {
  if (!state.config.sheetUrl) {
    if (manual && typeof openSheetConfig === "function") openSheetConfig();
    return;
  }
  const label = document.querySelector("#sync-label");
  if (label) label.textContent = "Sincronizando…";
  try {
    const response = await fetch(state.config.sheetUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const csv = await response.text();
    const parsed = recordsFromCSV(csv);
    if (!parsed.length) throw new Error("Nenhuma linha reconhecida");
    state.sheetRecords = parsed;
    state.lastSync = new Date().toISOString();
    if (typeof renderApp === "function") renderApp();
    if (manual && typeof toast === "function") toast("Planilha sincronizada", `${parsed.length} registros importados em modo leitura.`);
  } catch (error) {
    if (label) label.textContent = "Falha na sincronização";
    if (manual && typeof toast === "function") toast("Não foi possível ler a planilha", "Verifique se a URL CSV está pública e se as colunas estão corretas.");
  }
}

let syncTimer;
function scheduleSync() {
  clearInterval(syncTimer);
  if (state.config.sheetUrl) syncTimer = setInterval(() => syncSheet(false), Math.max(1, state.config.refreshMinutes) * 60000);
}