"use strict";

function exportCSV() {
  const headers = ["Data", "Origem", "Doca", "Motorista", "Placa do Veículo", "Volumetria", "Início Descarga", "Fim Descarga", "SLA", "Conferente / Responsável", "Status do Recebimento"];
  const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = allRecords().map(r => [fmtDate(r.data), r.origem, dockLabel(r.doca), r.motorista, r.placa, hasVolumetry(r) ? r.volumetria : "", fmtTime(r.inicio), fmtTime(r.fim), r.sla, r.conferente, r.status].map(quote).join(","));
  const blob = new Blob(["\ufeff" + [headers.map(quote).join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `recebimentos-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (typeof toast === "function") toast("Arquivo exportado", "A base CSV foi preparada para download.");
}

function downloadTurnoExcel() {
  if (typeof XLSX === "undefined") {
    if (typeof toast === "function") toast("Erro", "Biblioteca Excel não carregada. Verifique a tag no index.html.");
    return;
  }

  const agora = new Date();
  const hora = agora.getHours();

  let turno = "T3";
  if (hora >= 6 && hora < 14) turno = "T1";
  else if (hora >= 14 && hora < 22) turno = "T2";

  const produtividadeRecords = recordsDoTurnoAtual()
    .filter(r => r.status === "Concluído" || r.status === "Em descarga");

  if (produtividadeRecords.length === 0) {
    if (typeof toast === "function") toast("Aviso", "Nenhum dado de produtividade para exportar.");
    return;
  }

  const dadosExcel = produtividadeRecords.map(r => ({
    "Origem": r.origem,
    "Volumetria": hasVolumetry(r) && Number(r.volumetria) > 0 ? Number(r.volumetria) : "",
    "Início": fmtTime(r.inicio),
    "Finalizado em": fmtTime(r.fim),
    "SLA Previsto (min)": r.sla,
    "Tempo Decorrido (min)": durationMinutes(r),
    "Status": r.status,
    "Responsável": r.conferente
  }));

  const ws = XLSX.utils.json_to_sheet(dadosExcel);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Produtividade");

  const dia = String(agora.getDate()).padStart(2, '0');
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const nomeArquivo = `${turno}_${dia}-${mes}.xlsx`;

  XLSX.writeFile(wb, nomeArquivo);
  if (typeof toast === "function") toast("Download Concluído", `Planilha ${nomeArquivo} gerada com sucesso.`);
}