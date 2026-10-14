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

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // armazenamento cheio ou bloqueado (modo privado): o app segue funcionando em memória
  }
}

const storedRecords = loadJSON(STORAGE_KEY, []);
const storedConfig = loadJSON(CONFIG_KEY, {});

const state = {
  page: "dashboard",
  role: null,
  user: null,
  csrf: null,
  authChecked: false,
  records: Array.isArray(storedRecords) ? storedRecords : [],
  sheetRecords: [],
  insumosRecords: [],
  config: { sheetUrl: "", refreshMinutes: 5, ...(storedConfig && typeof storedConfig === "object" ? storedConfig : {}) },
  query: "",
  statusFilter: "todos",
  insumoFiltros: { dataInicio: "", dataFim: "", origem: "", conferente: "" },
  lastSync: null,
  apiOnline: false
};

function saveRecords() {
  saveJSON(STORAGE_KEY, state.records);
}

function saveConfig() {
  saveJSON(CONFIG_KEY, state.config);
}
