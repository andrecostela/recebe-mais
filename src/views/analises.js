"use strict";

function renderAnalyticsPage() {
  const rows = recordsDoTurnoAtual();
  const finished = rows.filter(r => r.fim);
  const avg = finished.length ? Math.round(finished.reduce((s, r) => s + durationMinutes(r), 0) / finished.length) : 0;

  const origins = [...new Set(rows.map(r => r.origem))].map(name => ({
    name,
    count: rows.filter(r => r.origem === name).length,
    volume: rows.filter(r => r.origem === name && hasVolumetry(r)).reduce((s, r) => s + Number(r.volumetria || 0), 0)
  })).sort((a, b) => b.volume - a.volume);

  return `<section class="section-page active">
    <div class="hero-strip">
      <div>
        <h2>Análise operacional</h2>
        <p>Indicadores consolidados referentes <strong>apenas ao turno atual</strong>.</p>
      </div>
      <button class="secondary-btn" data-action="export">Exportar base</button>
    </div>

    <div class="kpi-grid">
      ${kpi("Recebimentos", rows.length, "truck", "neste turno", true)}
      ${kpi("Finalizados", finished.length, "check", "operações concluídas")}
      ${kpi("Tempo médio", `${avg}<small> min</small>`, "clock", "por descarga")}
      ${kpi("Volume total", rows.filter(hasVolumetry).reduce((s, r) => s + Number(r.volumetria || 0), 0).toLocaleString("pt-BR"), "box", "volumes movimentados")}
      ${kpi("Origens", origins.length, "dock", "CDs e hubs")}
    </div>

    <section class="panel records">
      <div class="panel-head">
        <div>
          <h3>Desempenho por origem</h3>
          <p>Ranking por volumetria cadastrada (Turno Atual)</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Origem</th><th>Recebimentos</th><th>Volumetria</th><th>Participação</th></tr>
          </thead>
          <tbody>
            ${origins.length ? origins.map(o => `<tr>
              <td><strong>${esc(o.name)}</strong></td>
              <td>${o.count}</td>
              <td>${o.volume.toLocaleString("pt-BR")}</td>
              <td>${Math.round(o.volume / Math.max(1, rows.filter(hasVolumetry).reduce((s, r) => s + Number(r.volumetria || 0), 0)) * 100)}%</td>
            </tr>`).join("") : `<tr><td colspan="4" class="empty">Nenhum dado registrado neste turno ainda.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  </section>`;
}