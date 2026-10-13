"use strict";

const { usePg, pool } = require("../db");
const { json, authenticateSession } = require("../middlewares/security");

async function handleInsumosRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/insumos") {
    const session = authenticateSession(req, res);
    if (!session) return true;

    if (usePg) {
      try {
        const dataInicio = url.searchParams.get("data_inicio");
        const dataFim = url.searchParams.get("data_fim");
        const origem = url.searchParams.get("origem");
        const conferente = url.searchParams.get("conferente");

        let querySQL = `
          SELECT 
            i.id,
            i.tipo_insumo,
            i.quantidade,
            i.condicao,
            i.observacao,
            i.foto_url,
            i.criado_em,
            r.origem,
            r.placa,
            r.conferente
          FROM insumos_recebimento i
          JOIN recebimentos r ON r.id = i.recebimento_id
          WHERE 1=1
        `;
        const params = [];
        let idx = 1;

        if (dataInicio) {
          querySQL += ` AND i.criado_em >= $${idx++}`;
          params.push(dataInicio);
        }
        if (dataFim) {
          querySQL += ` AND i.criado_em <= $${idx++}`;
          params.push(dataFim);
        }
        if (origem) {
          querySQL += ` AND LOWER(r.origem) LIKE $${idx++}`;
          params.push(`%${origem.toLowerCase().trim()}%`);
        }
        if (conferente) {
          querySQL += ` AND LOWER(r.conferente) LIKE $${idx++}`;
          params.push(`%${conferente.toLowerCase().trim()}%`);
        }

        querySQL += ` ORDER BY i.criado_em DESC`;

        const resInsumos = await pool.query(querySQL, params);
        json(res, 200, { insumos: resInsumos.rows });
      } catch (err) {
        console.error("Erro ao consultar insumos no PostgreSQL:", err);
        json(res, 500, { error: "Erro ao consultar relatório de insumos." });
      }
      return true;
    }

    json(res, 200, { insumos: [] });
    return true;
  }

  return false;
}

module.exports = handleInsumosRoutes;