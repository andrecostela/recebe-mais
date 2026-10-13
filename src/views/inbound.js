"use strict";

"use strict";

function renderDockCard(dock, records) {
    const record = records.find(r => r.doca === dock && r.status === "Em descarga") || records.find(r => r.doca === dock && ["Aguardando", "Em Trânsito"].includes(r.status));
    const status = record?.status || "Disponível";
    const isEmDescarga = record?.status === "Em descarga";
    const canCreate = can("create");

    const isOwner = (record?.conferente === state.user?.username) || (record?.conferente === state.user?.name);
    const isSupervisor = state.role === "Supervisor";
    const canFinish = isEmDescarga && (isOwner || isSupervisor);

    let btnAction = "new-record";
    let btnText = "Iniciar recebimento";
    let btnClass = "primary-btn inbound-start";

    if (record) {
        if (isEmDescarga) {
            btnAction = "prompt-insumos";
            btnText = "Finalizar Descarga";
            if (!canFinish) btnClass += " disabled";
        } else if (["Aguardando", "Em Trânsito"].includes(status)) {
            btnAction = "prepare-unload";
            btnText = "Iniciar descarga agendada";
        }
    } else if (!canCreate) {
        btnClass += " disabled";
    }

    return `<article class="inbound-card ${isEmDescarga ? "is-active" : ""}">
    <div class="inbound-card-head"><span>DOCA</span><strong>${dockLabel(dock)}</strong></div>
    <div class="inbound-card-data">
      <div><span>Origem</span><strong>${record ? esc(record.origem) : "-"}</strong></div>
      <div><span>Motorista</span><strong>${record && record.motorista && record.motorista !== "—" ? esc(record.motorista) : "-"}</strong></div>
      <div><span>Placa</span><strong>${record && record.placa && record.placa !== "—" ? esc(record.placa) : "-"}</strong></div>
      <div><span>Volumetria</span><strong>${record && hasVolumetry(record) && Number(record.volumetria) > 0 ? Number(record.volumetria).toLocaleString("pt-BR") : "-"}</strong></div>
      <div><span>Status</span><strong><span class="status-badge status-${slug(status)}">${esc(status)}</span></strong></div>
    </div>
    <button class="${btnClass}" ${btnClass.includes("disabled") ? "disabled" : ""} data-action="${btnAction}" data-id="${record ? esc(record.id) : ""}" data-dock="${dock}">${btnText}</button>
    ${isEmDescarga && !canFinish ? `<p style="font-size: 9px; color: var(--red); text-align: center; margin-top: 5px;">Apenas ${record.conferente} ou Gestor</p>` : ""}
  </article>`;
}

// ... (Mantenha a renderDocksPage como está)

function renderDocksPage() {
  const today = allRecords().filter(r => sameDay(r.data));
  const docks = Array.from({ length: 18 }, (_, i) => String(i + 1));
  const activeCount = today.filter(r => r.status === "Em descarga").length;
  return `<section class="section-page active">
    <div class="hero-strip"><div><h2>Operação Inbound</h2><p>Selecione uma doca para iniciar o recebimento.</p></div><span class="date-chip">${activeCount} de 18 docas em operação</span></div>
    <div class="inbound-grid">${docks.map(d => renderDockCard(d, today)).join("")}</div>
  </section>`;
}
