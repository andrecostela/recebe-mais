"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "recebimentos.json");
const usePg = Boolean(process.env.DATABASE_URL);

const pool = usePg
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

function cleanText(value, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function nowAt(hour, minute = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function seed() {
  return [
    { id: "D-101", data: nowAt(7, 20), origem: "CD Guarulhos", doca: "3", motorista: "Carlos Mendes", placa: "RFG-8J21", volumetria: 1860, inicio: nowAt(7, 42), fim: nowAt(8, 31), sla: 60, conferente: "Ana Souza", status: "Concluído", source: "server" },
    { id: "D-102", data: nowAt(8, 10), origem: "Hub Campinas", doca: "5", motorista: "João Ribeiro", placa: "GHT-4C07", volumetria: 2430, inicio: nowAt(8, 28), fim: null, sla: 75, conferente: "Marcos Lima", status: "Em descarga", source: "server" },
    { id: "D-103", data: nowAt(9, 0), origem: "CD Extrema", doca: "2", motorista: "Paulo Nunes", placa: "BXR-1D94", volumetria: 0, inicio: null, fim: null, sla: 45, conferente: "—", status: "Aguardando", source: "server" },
    { id: "D-104", data: nowAt(9, 35), origem: "Hub Sorocaba", doca: "8", motorista: "Rafael Alves", placa: "TJK-6F13", volumetria: 0, inicio: null, fim: null, sla: 90, conferente: "Beatriz Reis", status: "Em Trânsito", source: "server" },
    { id: "D-105", data: nowAt(10, 20), origem: "CD Louveira", doca: "1", motorista: "Diego Martins", placa: "KLM-9A42", volumetria: 0, inicio: null, fim: null, sla: 55, conferente: "—", status: "Em Trânsito", source: "server" }
  ];
}

async function initDb() {
  if (!usePg) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(60) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        hash VARCHAR(128) NOT NULL,
        salt VARCHAR(32) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS recebimentos (
        id VARCHAR(36) PRIMARY KEY,
        data TIMESTAMP WITH TIME ZONE NOT NULL,
        origem VARCHAR(120) NOT NULL,
        placa VARCHAR(10) NOT NULL,
        motorista VARCHAR(120) NOT NULL,
        doca VARCHAR(10) DEFAULT '—',
        volumetria INT DEFAULT 0,
        sla INT DEFAULT 60,
        status VARCHAR(30) DEFAULT 'Em Trânsito',
        inicio TIMESTAMP WITH TIME ZONE,
        fim TIMESTAMP WITH TIME ZONE,
        conferente VARCHAR(100) DEFAULT '—',
        insumo_tipo TEXT,
        insumo_qtd INT,
        insumo_status TEXT,
        insumo_obs TEXT,
        insumos_lista JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS insumos_recebimento (
        id VARCHAR(36) PRIMARY KEY,
        recebimento_id VARCHAR(36) NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,
        tipo_insumo VARCHAR(50) NOT NULL,
        quantidade INT NOT NULL CHECK (quantidade > 0),
        condicao VARCHAR(30) DEFAULT '',
        observacao TEXT,
        foto_url TEXT,
        criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS auditoria (
        id VARCHAR(36) PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        action VARCHAR(120) NOT NULL,
        record_id VARCHAR(36),
        placa VARCHAR(20),
        role VARCHAR(60)
      );
    `);

    const resUsers = await client.query("SELECT COUNT(*) FROM usuarios");
    if (parseInt(resUsers.rows[0].count, 10) === 0) {
      const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD || "admin12345678";
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(initialAdminPassword, salt, 64).toString("hex");
      await client.query(
        "INSERT INTO usuarios (id, username, name, role, hash, salt) VALUES ($1, $2, $3, $4, $5, $6)",
        [crypto.randomUUID(), "admin", "Administrador do Sistema", "Supervisor", hash, salt]
      );
      console.log(`✅ [PostgreSQL] Administrador inicial criado com sucesso.`);
    }
  } catch (err) {
    console.error("❌ Erro ao inicializar tabelas no PostgreSQL:", err);
  } finally {
    client.release();
  }
}
initDb();

function writeDb(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

async function readDb() {
  if (usePg) {
    try {
      const recRes = await pool.query("SELECT * FROM recebimentos ORDER BY data DESC");
      const auditRes = await pool.query("SELECT * FROM auditoria ORDER BY timestamp DESC LIMIT 100");

      const records = recRes.rows.map(r => ({
        id: r.id,
        data: r.data ? new Date(r.data).toISOString() : new Date().toISOString(),
        origem: r.origem,
        placa: r.placa,
        motorista: r.motorista,
        doca: r.doca || "—",
        volumetria: r.volumetria || 0,
        sla: r.sla || 60,
        status: r.status,
        inicio: r.inicio ? new Date(r.inicio).toISOString() : null,
        fim: r.fim ? new Date(r.fim).toISOString() : null,
        conferente: r.conferente || "—",
        insumo_tipo: r.insumo_tipo,
        insumo_qtd: r.insumo_qtd,
        insumo_status: r.insumo_status,
        insumo_obs: r.insumo_obs,
        insumos: r.insumos_lista ? (typeof r.insumos_lista === "string" ? JSON.parse(r.insumos_lista) : r.insumos_lista) : null,
        source: "server"
      }));

      const audit = auditRes.rows.map(a => ({
        id: a.id,
        timestamp: a.timestamp ? new Date(a.timestamp).toISOString() : new Date().toISOString(),
        action: a.action,
        recordId: a.record_id,
        placa: a.placa,
        role: a.role
      }));

      return { records, audit };
    } catch (err) {
      console.error("❌ Erro ao ler banco de dados no PostgreSQL:", err);
      return { records: [], audit: [] };
    }
  }

  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(db.records)) db.records = [];
    if (!Array.isArray(db.audit)) db.audit = [];
    if (!db.records.length) {
      db.records = seed();
      writeDb(db);
    } else {
      let changed = false;
      db.records = db.records.map(record => {
        const status = record.status === "Previsto" ? "Em Trânsito" : record.status === "Divergência" ? "Em Atraso" : record.status;
        const doca = String(record.doca ?? "").replace(/^D/i, "").replace(/^0+(?=\d)/, "") || "—";
        if (status !== record.status || doca !== record.doca) changed = true;
        return { ...record, status, doca };
      });
      if (changed) writeDb(db);
    }
    return db;
  } catch {
    const db = { records: seed(), audit: [] };
    writeDb(db);
    return db;
  }
}

function audit(db, action, record, role) {
  db.audit.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    recordId: record.id,
    placa: record.placa,
    role: cleanText(role, 30) || "Conferente"
  });
  db.audit = db.audit.slice(0, 1000);
}

async function auditDb(action, record, role) {
  if (usePg) {
    await pool.query(
      "INSERT INTO auditoria (id, timestamp, action, record_id, placa, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [crypto.randomUUID(), new Date().toISOString(), action, record.id, record.placa, cleanText(role, 30) || "Conferente"]
    );
    return;
  }
}

function auditUserManagement(db, action, targetUsername, targetRole, actorUsername) {
  if (!Array.isArray(db.audit)) db.audit = [];
  db.audit.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action: `[SEGURANÇA] ${action}`,
    recordId: targetUsername,
    placa: targetRole,
    role: actorUsername
  });
  db.audit = db.audit.slice(0, 1000);
}

async function createRecordDb(record, role) {
  if (usePg) {
    await pool.query(
      "INSERT INTO recebimentos (id, data, origem, placa, motorista, doca, volumetria, sla, status, inicio, fim, conferente) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [record.id, record.data, record.origem, record.placa, record.motorista, record.doca, record.volumetria, record.sla, record.status, record.inicio, record.fim, record.conferente]
    );
    await auditDb("Recebimento criado", record, role);
    return;
  }

  const db = await readDb();
  db.records.unshift(record);
  audit(db, "Recebimento criado", record, role);
  writeDb(db);
}

async function transitionRecordDb(id, action, input, role) {
  const allowed = { start: "Em descarga", finish: "Concluído", issue: "Em Atraso" };
  const targetStatus = allowed[action];
  if (!targetStatus) throw new Error("Transição inválida");

  if (usePg) {
    const checkRes = await pool.query("SELECT * FROM recebimentos WHERE id = $1", [id]);
    if (checkRes.rows.length === 0) throw new Error("Registro não encontrado");
    const record = checkRes.rows[0];

    let updateQuery = "UPDATE recebimentos SET status = $1";
    const queryParams = [targetStatus];
    let paramIdx = 2;

    if (action === "start") {
      if (!["Em Trânsito", "Aguardando"].includes(record.status)) throw new Error("A descarga não pode ser iniciada neste status");
      const volume = Number(input.volumetria);
      if (!Number.isFinite(volume) || volume < 1) throw new Error("Informe a volumetria para iniciar a descarga");

      updateQuery += `, volumetria = $${paramIdx++}, inicio = $${paramIdx++}`;
      queryParams.push(volume, new Date().toISOString());

      if (input.conferente) {
        updateQuery += `, conferente = $${paramIdx++}`;
        queryParams.push(input.conferente);
      }
    }

    if (action === "finish" || action === "issue") {
      if (record.status !== "Em descarga") throw new Error("A descarga não está em andamento");

      updateQuery += `, fim = $${paramIdx++}`;
      queryParams.push(new Date().toISOString());

      if (input.insumo_tipo) {
        updateQuery += `, insumo_tipo = $${paramIdx++}, insumo_qtd = $${paramIdx++}, insumo_status = $${paramIdx++}, insumo_obs = $${paramIdx++}, insumos_lista = $${paramIdx++}`;
        queryParams.push(
          input.insumo_tipo,
          input.insumo_qtd || 0,
          input.insumo_status || "",
          input.insumo_obs || "",
          input.insumos ? (typeof input.insumos === "string" ? input.insumos : JSON.stringify(input.insumos)) : null
        );

        try {
          let insumosArray = [];
          if (typeof input.insumos === "string") {
            insumosArray = JSON.parse(input.insumos);
          } else if (Array.isArray(input.insumos)) {
            insumosArray = input.insumos;
          }

          for (const item of insumosArray) {
            const qtd = Number(item.qtd || item.quantidade || 0);
            if (qtd > 0 && item.tipo) {
              await pool.query(`
                INSERT INTO insumos_recebimento (id, recebimento_id, tipo_insumo, quantidade, condicao, observacao, foto_url)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
              `, [
                crypto.randomUUID(),
                id,
                cleanText(item.tipo, 50),
                qtd,
                cleanText(item.status || item.condicao, 30),
                cleanText(item.obs || item.observacao, 255),
                cleanText(item.foto_url || input.foto_url || "", 500)
              ]);
            }
          }
        } catch (insumoErr) {
          console.error("Erro ao gravar insumos relacionais:", insumoErr);
        }
      }
    }

    updateQuery += ` WHERE id = $${paramIdx} RETURNING *`;
    queryParams.push(id);

    const updatedRes = await pool.query(updateQuery, queryParams);
    const updatedRecord = updatedRes.rows[0];

    await auditDb(`Status alterado para ${targetStatus}`, updatedRecord, role);
    return updatedRecord;
  }

  const db = await readDb();
  const record = db.records.find(r => r.id === id);
  if (!record) throw new Error("Registro não encontrado");

  if (action === "start") {
    if (!["Em Trânsito", "Aguardando"].includes(record.status)) throw new Error("A descarga não pode ser iniciada neste status");
    const volume = Number(input.volumetria);
    if (!Number.isFinite(volume) || volume < 1) throw new Error("Informe a volumetria para iniciar a descarga");
    record.volumetria = volume;
    record.inicio = new Date().toISOString();
    if (input.conferente) record.conferente = input.conferente;
  }

  if (action === "finish" || action === "issue") {
    if (record.status !== "Em descarga") throw new Error("A descarga não está em andamento");
    record.fim = new Date().toISOString();
    if (input.insumo_tipo) {
      record.insumo_tipo = input.insumo_tipo;
      record.insumo_qtd = input.insumo_qtd;
      record.insumo_status = input.insumo_status;
      record.insumo_obs = input.insumo_obs;
      record.insumos_lista = input.insumos;
    }
  }

  record.status = targetStatus;
  audit(db, `Status alterado para ${record.status}`, record, role);
  writeDb(db);
  return record;
}

module.exports = {
  usePg,
  pool,
  readDb,
  writeDb,
  createRecordDb,
  transitionRecordDb,
  auditDb,
  auditUserManagement
};