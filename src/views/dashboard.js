"use strict";

function getMetrics() {
  const today = allRecords().filter(r => sameDay(r.data));
  const active = today.filter(r => r.status === "Em descarga");
  const finished = today.filter(r => r.status === "Concluído" || r.status === "Em Atraso");
  const avg = finished.length ? Math.round(finished.reduce((sum, r) => sum + durationMinutes(r), 0) / finished.length) : 0;
  const onSla = finished.length ? Math.round(finished.filter(r => durationMinutes(r) <= Number(r.sla || 60)).length / finished.length * 100) : 100;
  return { today, active, finished, avg, onSla, docks: new Set(active.map(r => r.doca)).size };
}

function kpi(label, value, icon, trend, featured = false) {
  return `<article class="kpi-card ${featured ? "featured" : ""}"><div class="kpi-head"><span>${label}</span><span class="kpi-icon">${icons[icon]}</span></div><div class="kpi-value">${value}</div><div class="trend"><b>●</b>${trend}</div></article>`;
}

function renderVolumeChart(records) {
  const hours = ["06h", "08h", "10h", "12h", "14h", "16h", "18h"];
  const values = hours.map(h => {
    const start = Number(h.slice(0, 2));
    const rows = records.filter(r => {
      const hr = new Date(r.data).getHours();
      return hr >= start && hr < start + 2;
    });
    return [rows.length, rows.filter(r => r.status === "Concluído").length];
  });
  const max = Math.max(4, ...values.flat());
  return `<div class="volume-chart"><div class="axis-y"><span>${max}</span><span>${Math.round(max * 0.66)}</span><span>${Math.round(max * 0.33)}</span><span>0</span></div><div class="chart-field">${values.map((v, i) => `<div class="bar-group"><i class="bar" style="height:${Math.max(2, v[0] / max * 100)}%"></i><i class="bar secondary" style="height:${Math.max(2, v[1] / max * 100)}%"></i><span>${hours[i]}</span></div>`).join("")}</div></div>`;
}

function renderStatus(records) {
  const statuses = ["Concluído", "Em descarga", "Aguardando", "Em Trânsito", "Em Atraso"];
  const colors = ["var(--green)", "var(--brand)", "var(--orange)", "#dce5ed", "var(--red)"];
  const counts = statuses.map(s => records.filter(r => r.status === s).length);
  return `<div class="status-body"><div class="donut-wrap"><div class="donut"><div class="donut-center"><strong>${records.length}</strong><span>veículos</span></div></div></div><div class="status-list">${statuses.map((s, i) => `<div class="status-row"><i style="background:${colors[i]}"></i><span>${s}</span><strong>${counts[i]}</strong></div>`).join("")}</div></div>`;
}

function renderRecordsPanel(records, title, showAction = false) {
  return `<section class="panel records">
    <div class="panel-head"><div><h3>${title}</h3><p>Lista de recebimentos operacionais</p></div></div>
    <div class="table-wrap"><table>
      <thead>
        <tr><th>Veículo / Origem</th><th>Doca</th><th>Motorista</th><th>Volumetria</th><th>Início</th><th>SLA</th><th>Status</th><th>Conferente</th></tr>
      </thead>
      <tbody>
        ${records.length ? records.map(r => `<tr>
          <td><div class="vehicle"><span class="truck-icon">${icons.truck}</span><div><strong>${esc(r.placa)}</strong><span>${esc(r.origem)}</span></div></div></td>
          <td><strong>${dockLabel(r.doca)}</strong></td>
          <td>${esc(r.motorista)}</td>
          <td>${hasVolumetry(r) && Number(r.volumetria) > 0 ? Number(r.volumetria).toLocaleString("pt-BR") : "-"}</td>
          <td>${fmtTime(r.inicio)}</td>
          <td><span class="sla ${r.inicio ? slaClass(r) : ""}">${durationMinutes(r)}/${r.sla || 60} min</span></td>
          <td><span class="status-badge status-${slug(r.status)}">${esc(r.status)}</span></td>
          <td>${esc(r.conferente)}</td>
        </tr>`).join("") : `<tr><td colspan="8" class="empty">Nenhum registro encontrado.</td></tr>`}
      </tbody>
    </table></div>
  </section>`;
}

function renderDashboard() {
  const m = getMetrics();
  return `<section class="section-page active">
    <div class="kpi-grid">
      ${kpi("Veículos previstos", m.today.length, "truck", `${m.today.filter(r => r.status === "Em Trânsito").length} em trânsito`, true)}
      ${kpi("Em descarga", m.active.length, "dock", `${m.docks} docas ocupadas`)}
      ${kpi("Volumetria", m.today.filter(hasVolumetry).reduce((s, r) => s + Number(r.volumetria || 0), 0).toLocaleString("pt-BR"), "box", "volumes confirmados")}
      ${kpi("SLA Médio", `${m.avg}<small> min</small>`, "clock", `${m.onSla}% dentro do prazo`)}
      ${kpi("Finalizados", m.finished.length, "check", "operações concluídas")}
    </div>
    <div class="content-grid">
      <section class="panel"><div class="panel-head"><div><h3>Fluxo de recebimento</h3><p>Em trânsito x concluídos por faixa horária</p></div><div class="chart-legend"><span><i></i>Em trânsito</span><span><i></i>Concluídos</span></div></div>${renderVolumeChart(m.today)}</section>
      <section class="panel"><div class="panel-head"><div><h3>Status da operação</h3><p>Distribuição de hoje</p></div><div class="segmented"><button class="active">Hoje</button></div></div>${renderStatus(m.today)}</section>
    </div>
    ${renderRecordsPanel(m.today.slice(0, 6), "Recebimentos de hoje", true)}
  </section>`;
}