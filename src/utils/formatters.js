"use strict";

function fmtDate(iso, withTime = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", withTime ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" }).format(d);
}

function fmtTime(iso) {
  return iso ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";
}

function slug(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-");
}

function durationMinutes(record) {
  if (!record.inicio) return 0;
  return Math.max(0, Math.round(((record.fim ? new Date(record.fim) : new Date()) - new Date(record.inicio)) / 60000));
}

function slaClass(record) {
  const d = durationMinutes(record);
  return d <= record.sla * 0.85 ? "good" : d <= record.sla ? "warn" : "bad";
}

function dockLabel(value) {
  const number = String(value ?? "").replace(/\D/g, "");
  return number ? String(Number(number)).padStart(2, "0") : "—";
}

function hasVolumetry(record) {
  return ["Em descarga", "Concluído", "Em Atraso"].includes(normalizeRecord(record).status);
}

function sameDay(iso, date = new Date()) {
  const d = new Date(iso);
  return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function normalizeRecord(record) {
  const status = record.status === "Previsto" ? "Em Trânsito" : record.status === "Divergência" ? "Em Atraso" : record.status;
  const dock = String(record.doca ?? "").replace(/^D/i, "").replace(/^0+(?=\d)/, "");
  return { ...record, status, doca: dock || "—" };
}

function allRecords() {
  const seen = new Set();
  return [...state.records, ...state.sheetRecords].map(normalizeRecord).filter(r => {
    const key = `${String(r.placa).toUpperCase()}-${String(r.data).slice(0, 16)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.data) - new Date(a.data));
}

function recordsDoTurnoAtual() {
  const agora = new Date();
  const hora = agora.getHours();

  let inicioTurno, fimTurno;

  if (hora >= 6 && hora < 14) {
    inicioTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 6, 0, 0);
    fimTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 13, 59, 59);
  } else if (hora >= 14 && hora < 22) {
    inicioTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 14, 0, 0);
    fimTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 21, 59, 59);
  } else {
    if (hora >= 22) {
      inicioTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 22, 0, 0);
      fimTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1, 5, 59, 59);
    } else {
      inicioTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 1, 22, 0, 0);
      fimTurno = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 5, 59, 59);
    }
  }

  return allRecords().filter(r => {
    const dataComparacao = new Date(r.inicio || r.data);
    return dataComparacao >= inicioTurno && dataComparacao <= fimTurno;
  });
}