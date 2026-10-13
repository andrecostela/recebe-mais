"use strict";

const STORAGE_KEY = "recebe-plus-records-v1";
const CONFIG_KEY = "recebe-plus-config-v1";

function loadJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

const isoAt = (hour, minute = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const seedRecords = [
  { id: "D-101", data: isoAt(7, 20), origem: "CD Guarulhos", doca: "3", motorista: "Carlos Mendes", placa: "RFG-8J21", volumetria: 1860, inicio: isoAt(7, 42), fim: isoAt(8, 31), sla: 60, conferente: "Ana Souza", status: "Concluído" },
  { id: "D-102", data: isoAt(8, 10), origem: "Hub Campinas", doca: "5", motorista: "João Ribeiro", placa: "GHT-4C07", volumetria: 2430, inicio: isoAt(8, 28), fim: null, sla: 75, conferente: "Marcos Lima", status: "Em descarga" },
  { id: "D-103", data: isoAt(9, 0), origem: "CD Extrema", doca: "2", motorista: "Paulo Nunes", placa: "BXR-1D94", volumetria: 0, inicio: null, fim: null, sla: 45, conferente: "—", status: "Aguardando" },
  { id: "D-104", data: isoAt(9, 35), origem: "Hub Sorocaba", doca: "8", motorista: "Rafael Alves", placa: "TJK-6F13", volumetria: 0, inicio: null, fim: null, sla: 90, conferente: "Beatriz Reis", status: "Em Trânsito" },
  { id: "D-105", data: isoAt(10, 20), origem: "CD Louveira", doca: "1", motorista: "Diego Martins", placa: "KLM-9A42", volumetria: 0, inicio: null, fim: null, sla: 55, conferente: "—", status: "Em Trânsito" }
].map(r => ({ ...r, source: "local" }));

const state = {
  page: "dashboard",
  role: null,
  user: null,
  csrf: null,
  authChecked: false,
  records: loadJSON(STORAGE_KEY, seedRecords),
  sheetRecords: [],
  insumosRecords: [],
  config: loadJSON(CONFIG_KEY, { sheetUrl: "", refreshMinutes: 5 }),
  query: "",
  statusFilter: "todos",
  insumoFiltros: { dataInicio: "", dataFim: "", origem: "", conferente: "" },
  lastSync: null,
  apiOnline: false
};

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
}