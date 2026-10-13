"use strict";

function renderSettingsPage() {
  return `<section class="section-page active">
    <div class="hero-strip">
      <div><h2>Configurações</h2><p>Integrações, perfil e comportamento do sistema.</p></div>
    </div>
    <div class="management-grid">
      <article class="panel info-card">
        <p class="eyebrow">INTEGRAÇÃO</p>
        <h3>Google Sheets</h3>
        <p>Importação somente leitura da planilha usada como torre de controle. Os dados cadastrados no Recebe+ não alteram a planilha.</p>
        <div class="settings-list">
          <div class="settings-row"><span>Status</span><strong>${state.config.sheetUrl ? "Conectado" : "Aguardando acesso"}</strong></div>
          <div class="settings-row"><span>Atualização</span><strong>A cada ${state.config.refreshMinutes} min</strong></div>
          <div class="settings-row"><span>Última leitura</span><strong>${state.lastSync ? fmtDate(state.lastSync) : "—"}</strong></div>
        </div>
        ${can("sheet") ? `<button class="primary-btn" data-action="sheet-config" style="margin-top:15px;">Configurar conexão</button>` : `<p class="helper">Somente supervisores podem configurar esta integração.</p>`}
      </article>

      <article class="panel info-card">
        <p class="eyebrow">PERFIL ATIVO</p>
        <h3>${state.role}</h3>
        <p>As permissões são definidas automaticamente pelo usuário autenticado.</p>
        <div class="settings-list">
          <div class="settings-row"><span>Usuário</span><strong>${esc(state.user.username)}</strong></div>
          <div class="settings-row"><span>Permissão</span><strong>${state.role === "Supervisor" ? "Gestão completa" : state.role === "Conferente" ? "Operação de descarga" : "Cadastro e monitoramento"}</strong></div>
          <div class="settings-row"><span>Armazenamento</span><strong>${state.apiOnline ? "Base compartilhada" : "Contingência local"}</strong></div>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px;">
          <button class="secondary-btn" data-action="open-change-password">Alterar Minha Senha</button>
          <button class="secondary-btn" data-action="logout">Encerrar sessão</button>
          ${state.role === "Supervisor" ? `<button class="primary-btn" data-action="manage-users">Gerenciar Equipe</button>` : ""}
        </div>
      </article>
    </div>
  </section>`;
}
