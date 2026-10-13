"use strict";

function pad(n) { return String(n).padStart(2, "0"); }

function openNewRecord(preselectedDock = "") {
  const localValue = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal"><form class="modal" id="record-form" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>Iniciar recebimento</h2><p>Registre o veículo e os dados da descarga na doca ${dockLabel(preselectedDock)}.</p></div><button type="button" class="close-btn" data-action="close-modal">×</button></div><div class="modal-body"><div class="form-grid">
    <div class="field"><label>Data e hora previstas *</label><input required name="data" type="datetime-local" value="${localValue}"></div>
    <div class="field"><label>CD / Hub de origem *</label><input required name="origem" placeholder="Ex.: CD Guarulhos"></div>
    <div class="field"><label>Motorista *</label><input required name="motorista" placeholder="Nome completo"></div>
    <div class="field"><label>Placa do veículo *</label><input required maxlength="8" name="placa" placeholder="ABC-1D23" style="text-transform:uppercase"></div>
    <div class="field"><label>Volumetria *</label><input required min="1" name="volumetria" type="number" placeholder="Quantidade de volumes"><p class="helper">Obrigatória para iniciar o recebimento.</p></div>
    <div class="field"><label>Doca *</label><select required name="doca"><option value="">Selecione</option>${Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}" ${String(i + 1) === String(preselectedDock) ? "selected" : ""}>${pad(i + 1)}</option>`).join("")}</select></div>
    <div class="field"><label>SLA de descarga (min) *</label><input required min="1" name="sla" type="number" value="60"></div>
    <div class="field"><label>Conferente / Responsável</label><input name="conferente" value="${esc(state.user?.name || state.user?.username)}" readonly style="background:#f3f6fa;color:#8396a7;"></div>
    <div class="field full"><label>Status inicial</label><select name="status"><option selected>Em descarga</option><option>Aguardando</option><option>Em Trânsito</option></select><p class="helper">O horário de início será registrado automaticamente.</p></div>
  </div></div><div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancelar</button><button class="primary-btn" type="submit">Salvar e iniciar</button></div></form></div>`;
}

function openStartUnload(id) {
  const r = allRecords().find(item => item.id === id);
  if (!r) return;
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal"><form class="modal small" id="start-unload-form" data-id="${esc(r.id)}">
    <div class="modal-head"><div><h2>Iniciar Recebimento</h2><p>${esc(r.placa)} • Doca ${dockLabel(r.doca)}</p></div><button type="button" class="close-btn" data-action="close-modal">×</button></div>
    <div class="modal-body">
      <div class="field"><label>Volumetria confirmada *</label><input required min="1" name="volumetria" type="number" placeholder="Quantidade de volumes"></div>
    </div>
    <div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancelar</button><button class="primary-btn" type="submit">Confirmar e Iniciar</button></div>
  </form></div>`;
}

function getInsumoTemplate(index) {
  return `<div class="insumo-item" style="border: 1px solid #e0e6ed; padding: 12px; border-radius: 8px; margin-bottom: 12px; background: #fdfdfd;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <strong style="font-size: 11px; color: var(--ink);">Insumo #${index + 1}</strong>
      ${index > 0 ? `<button type="button" onclick="this.closest('.insumo-item').remove()" style="background:none; border:none; color:var(--red); font-size:16px; cursor:pointer;" title="Remover">×</button>` : ''}
    </div>
    <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 8px;">
      <div class="field">
        <label>Tipo *</label>
        <select name="tipo_insumo" required>
          <option value="">Selecione</option>
          <option value="Gaylords">Gaylords</option>
          <option value="Pallets">Pallets</option>
          <option value="Bags">Bags</option>
          <option value="Strech">Strech</option>
          <option value="Outros">Outros</option>
        </select>
      </div>
      <div class="field">
        <label>Quantidade *</label>
        <input type="number" min="1" name="qtd_insumo" required placeholder="Qtd">
      </div>
      <div class="field full status-insumo-wrap">
        <label>Condição</label>
        <select name="status_insumo">
          <option value="Completas">Completas / Íntegras</option>
          <option value="Incompletas">Incompletas / Danificadas</option>
        </select>
      </div>
      <div class="field full">
        <label>Observação</label>
        <input type="text" name="obs_insumo" placeholder="Detalhes (opcional)" maxlength="120">
      </div>
    </div>
  </div>`;
}

function openPromptInsumos(id) {
  const r = allRecords().find(item => item.id === id);
  if (!r) return;
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal"><form class="modal" id="finish-unload-form" data-id="${esc(r.id)}">
    <div class="modal-head"><div><h2>Finalizar Recebimento</h2><p>Doca ${dockLabel(r.doca)} • Deseja registrar devolução de insumos?</p></div><button type="button" class="close-btn" data-action="close-modal">×</button></div>
    <div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
      <div style="display:flex; gap:10px; margin-bottom: 15px;">
        <label style="display:flex; align-items:center; gap:5px;"><input type="radio" name="tem_insumo" value="sim" checked> Sim, carregar insumos</label>
        <label style="display:flex; align-items:center; gap:5px;"><input type="radio" name="tem_insumo" value="nao"> Não há insumos</label>
      </div>
      <div id="insumos-fields">
        <div id="insumos-list">${getInsumoTemplate(0)}</div>
        <button type="button" class="secondary-btn" data-action="add-insumo" style="width:100%; margin-bottom: 15px; border-style: dashed; color: var(--brand);">+ Adicionar outro insumo</button>
        <div class="field full">
          <label>Link da Evidência / Foto (Google Drive) *</label>
          <input type="url" name="foto_url" placeholder="https://drive.google.com/file/d/..." style="width:100%;">
          <p class="helper">Cole o link da foto salva no Google Drive da empresa.</p>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancelar</button>
      <button class="primary-btn" type="submit" style="background:var(--green)">Concluir Descarga</button>
    </div>
  </form></div>`;

  const form = document.getElementById("finish-unload-form");
  const fieldsWrap = document.getElementById("insumos-fields");
  form.addEventListener("change", (e) => {
    if (e.target.name === "tem_insumo") {
      fieldsWrap.style.display = e.target.value === "sim" ? "block" : "none";
      const firstQtd = form.querySelector('[name="qtd_insumo"]');
      if (firstQtd) firstQtd.required = (e.target.value === "sim");
    }
  });
}

function openSheetConfig() {
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal"><form class="modal small" id="sheet-form" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>Conectar Google Sheets</h2><p>Integração somente leitura com a torre de controle.</p></div><button type="button" class="close-btn" data-action="close-modal">×</button></div><div class="modal-body">
    <div class="field"><label>URL pública de exportação CSV</label><input name="sheetUrl" type="url" value="${esc(state.config.sheetUrl)}" placeholder="https://docs.google.com/spreadsheets/.../export?format=csv"><p class="helper">A planilha precisa estar publicada para leitura.</p></div>
    <div class="field" style="margin-top:15px"><label>Intervalo de atualização</label><select name="refreshMinutes"><option value="1" ${state.config.refreshMinutes == 1 ? "selected" : ""}>A cada 1 minuto</option><option value="5" ${state.config.refreshMinutes == 5 ? "selected" : ""}>A cada 5 minutos</option><option value="15" ${state.config.refreshMinutes == 15 ? "selected" : ""}>A cada 15 minutos</option></select></div>
  </div><div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancelar</button>${state.config.sheetUrl ? `<button type="button" class="secondary-btn" data-action="disconnect-sheet" style="color:var(--red)">Desconectar</button>` : ""}<button class="primary-btn" type="submit">Salvar conexão</button></div></form></div>`;
}

async function openManageUsers() {
  document.querySelector("#modal-root").innerHTML = `<div class="overlay"><div class="modal small"><div class="modal-body" style="text-align:center;padding:40px;">Carregando equipe...</div></div></div>`;
  try {
    const res = await api("/api/users");
    const listHtml = res.users.map(u => `
      <div class="settings-row" style="margin-bottom: 8px;">
        <div>
          <strong style="display:block;color:var(--ink);font-size:12px;">${esc(u.name || u.username)}</strong>
          <span style="font-size:10px;">Login: ${esc(u.username)} • Perfil: ${esc(u.role)}</span>
        </div>
        <button class="secondary-btn" style="padding: 6px 10px; font-size: 10px;" data-action="edit-user" data-username="${esc(u.username)}" data-name="${esc(u.name || "")}" data-role="${esc(u.role)}">Editar</button>
      </div>
    `).join("");

    document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal">
      <div class="modal small" onclick="event.stopPropagation()">
        <div class="modal-head"><div><h2>Gerenciar Equipe</h2><p>Usuários cadastrados no sistema.</p></div><button class="close-btn" data-action="close-modal">×</button></div>
        <div class="modal-body">
          <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px; padding-right: 5px;">
            ${listHtml}
          </div>
          <button class="primary-btn" style="width: 100%;" data-action="new-user">Adicionar Novo Usuário</button>
        </div>
      </div>
    </div>`;
  } catch (e) {
    document.querySelector("#modal-root").innerHTML = "";
    toast("Erro", "Não foi possível carregar a equipe.");
  }
}

function openUserForm(username = "", name = "", role = "Conferente") {
  const isEdit = !!username;
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal">
    <form class="modal small" id="register-user-form" data-action-type="${isEdit ? 'update' : 'create'}" onclick="event.stopPropagation()">
      <div class="modal-head">
        <div>
          <h2>${isEdit ? 'Editar Usuário' : 'Novo Usuário'}</h2>
          <p>${isEdit ? 'Altere as informações do membro da equipe.' : 'Preencha os dados do novo membro.'}</p>
        </div>
        <button type="button" class="close-btn" data-action="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>Nome Completo *</label><input required name="new_name" type="text" placeholder="Ex: André Costa" value="${esc(name)}"></div>
        <div class="field"><label>Nome de Usuário (Login) *</label><input required name="new_username" type="text" placeholder="Ex: andre.costa" value="${esc(username)}" ${isEdit ? 'readonly style="background:#f3f6fa;color:#8396a7;cursor:not-allowed;"' : ''}></div>
        <div class="field"><label>${isEdit ? 'Nova Senha (deixe em branco para manter)' : 'Senha Inicial *'}</label><input ${isEdit ? '' : 'required'} name="new_password" type="password" placeholder="${isEdit ? 'Digite se for redefinir a senha' : 'Mínimo de 12 caracteres'}"></div>
        <div class="field" style="margin-top:10px"><label>Função no Sistema *</label>
          <select required name="new_role">
            <option value="Conferente" ${role === 'Conferente' ? 'selected' : ''}>Conferente (Apenas opera docas)</option>
            <option value="Assistente" ${role === 'Assistente' ? 'selected' : ''}>Assistente (Cadastra e monitora)</option>
            <option value="Supervisor" ${role === 'Supervisor' ? 'selected' : ''}>Supervisor (Acesso total)</option>
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="manage-users">Voltar para lista</button>
        <button class="primary-btn" type="submit">${isEdit ? 'Salvar Alterações' : 'Cadastrar Usuário'}</button>
      </div>
    </form>
  </div>`;
}

function openChangePasswordModal() {
  document.querySelector("#modal-root").innerHTML = `<div class="overlay" data-action="close-modal">
    <form class="modal small" id="change-password-form" onclick="event.stopPropagation()">
      <div class="modal-head">
        <div><h2>Alterar Minha Senha</h2><p>Digite sua senha atual e a nova frase-senha.</p></div>
        <button type="button" class="close-btn" data-action="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>Senha Atual *</label><input required name="current_password" type="password" placeholder="Digite sua senha atual"></div>
        <div class="field"><label>Nova Senha *</label><input required name="new_password" type="password" placeholder="Mínimo de 12 caracteres"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancelar</button>
        <button class="primary-btn" type="submit">Alterar Senha</button>
      </div>
    </form>
  </div>`;
}
