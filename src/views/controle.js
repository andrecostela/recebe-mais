"use strict";

function renderReceiptsPage() {
  const transitoRecords = state.sheetRecords.map(r => {
    const diffMins = Number(r.previsao) || 0;
    let calcStatus = "Em Trânsito";
    if (diffMins <= 4.9833 && diffMins > 0) calcStatus = "Aguardando";
    if (diffMins <= 0) calcStatus = "Em Atraso";
    return { ...r, calcStatus, diffMins };
  });

  const produtividadeRecords = recordsDoTurnoAtual()
    .filter(r => r.status === "Concluído" || r.status === "Em descarga");

  const canDownloadReport = state.role === "Assistente" || state.role === "Supervisor";

  return `<section class="section-page active">
    ${canDownloadReport ? `
    <div style="display: flex; justify-content: flex-end; margin-bottom: 15px;">
        <button class="primary-btn" data-action="download-turno" style="background: var(--green); box-shadow: 0 4px 10px rgba(10,166,111,.2);">📥 Fechar Turno (Excel)</button>
    </div>` : ""}

    <section class="panel records" style="margin-bottom: 24px;">
        <div class="panel-head"><div><h3>Veículos em Trânsito</h3><p>Rastreio da planilha conectada</p></div></div>
        <div class="table-wrap"><table>
            <thead>
                <tr><th>Hub / CD</th><th>Previsão de Chegada</th><th>Status</th></tr>
            </thead>
            <tbody>
                ${transitoRecords.length ? transitoRecords.map(r => `<tr>
                    <td><strong>${esc(r.origem)}</strong></td>
                    <td>${r.previsao ? `${r.previsao} min` : "—"}</td>
                    <td><span class="status-badge status-${slug(r.calcStatus)}">${esc(r.calcStatus)}</span></td>
                </tr>`).join("") : `<tr><td colspan="3" class="empty">Nenhum veículo a caminho na planilha conectada.</td></tr>`}
            </tbody>
        </table></div>
    </section>

    <section class="panel records">
        <div class="panel-head"><div><h3>Produtividade</h3><p>Operações de descarga e finalizadas</p></div></div>
        <div class="table-wrap"><table>
            <thead>
                <tr><th>Origem</th><th>Volumetria</th><th>Início</th><th>Finalizado em</th><th>SLA</th><th>Status</th><th>Responsável</th></tr>
            </thead>
            <tbody>
                ${produtividadeRecords.length ? produtividadeRecords.map(r => `<tr>
                    <td><strong>${esc(r.origem)}</strong></td>
                    <td>${hasVolumetry(r) && Number(r.volumetria) > 0 ? Number(r.volumetria).toLocaleString("pt-BR") : "-"}</td>
                    <td>${fmtTime(r.inicio)}</td>
                    <td>${fmtTime(r.fim)}</td>
                    <td><span class="sla ${r.inicio ? slaClass(r) : ""}">${durationMinutes(r)}/${r.sla || 60} min</span></td>
                    <td><span class="status-badge status-${slug(r.status)}">${esc(r.status)}</span></td>
                    <td>${esc(r.conferente)}</td>
                </tr>`).join("") : `<tr><td colspan="7" class="empty">Nenhuma operação produtiva no momento.</td></tr>`}
            </tbody>
        </table></div>
    </section>
  </section>`;
}