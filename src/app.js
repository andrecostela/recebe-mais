"use strict";

function renderCurrentPage() {
    if (state.page === "dashboard") return renderDashboard();
    if (state.page === "recebimentos") return renderReceiptsPage();
    if (state.page === "docas") return renderDocksPage();
    if (state.page === "insumos") return renderInsumosPage();
    if (state.page === "analises") return renderAnalyticsPage();
    return renderSettingsPage();
}

function renderLogin() {
    document.querySelector("#app").innerHTML = `<main class="auth-page"><section class="auth-visual"><div class="auth-brand"><span class="brand-mark"><i></i><i></i><i></i></span><span class="brand-name">recebe+<small>controle logístico</small></span></div><div class="auth-copy"><span class="auth-kicker">OPERAÇÃO EM MOVIMENTO</span><h1>Cada doca.<br>Cada minuto.<br><em>Sob controle.</em></h1><p>Recebimento, volumetria e SLA em uma única visão operacional.</p></div><div class="auth-stats"><span><strong>18</strong>docas monitoradas</span><span><strong>24/7</strong>visão da operação</span><span><strong>1</strong>fonte de verdade</span></div></section><section class="auth-form-wrap"><form class="login-card" id="login-form"><p class="eyebrow">ACESSO RESTRITO</p><h2>Bem-vindo</h2><p class="login-intro">Entre com seu usuário e senha para acessar o recebimento.</p><div class="field"><label>Usuário</label><input name="username" required autocomplete="username" autofocus placeholder="Digite seu usuário"></div><div class="field"><label>Senha</label><div class="password-field"><input name="password" required type="password" autocomplete="current-password" placeholder="Digite sua senha"><button type="button" data-action="toggle-password" aria-label="Mostrar senha">Ver</button></div></div><button class="primary-btn login-submit" type="submit">Entrar no sistema</button><p class="security-note">Acesso monitorado · Sessão protegida · Ambiente de testes</p></form></section></main>`;
}

function renderApp() {
    if (!state.authChecked) {
        document.querySelector("#app").innerHTML = `<main class="auth-page"><div class="auth-loader"><span class="brand-mark"><i></i><i></i><i></i></span><strong>recebe+</strong><p>Carregando operação...</p></div></main>`;
        return;
    }
    if (!state.user) {
        renderLogin();
        return;
    }

    const agora = new Date();
    const dataHoraFormatada = agora.toLocaleDateString('pt-BR') + ' ' + agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const titles = {
        dashboard: ["", `HOSA - RESUMO DE VOLUMETRIA ${dataHoraFormatada}`],
        recebimentos: ["", "Torre de Controle"],
        docas: ["", "Gestão de Docas"],
        insumos: ["RRA / EVIDÊNCIAS", "Relatório de Insumos Devolvidos"],
        analises: ["DESEMPENHO", "Análises"],
        configuracoes: ["SISTEMA", "Configurações"]
    };

    const title = titles[state.page];
    const isAnalises = state.page === "analises";

    document.querySelector("#app").innerHTML = `<div class="app-shell">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><span class="brand-name">recebe+<small>controle logístico</small></span></div>
    <div class="nav-label">Operação</div><nav class="nav-list">${navItems.slice(0, 4).map(n => navButton(n)).join("").replace("Visão geral", "Visão Geral")}</nav>
    <div class="nav-label">Gestão</div><nav class="nav-list">${navItems.slice(4).map(n => navButton(n)).join("")}</nav>
    <div class="sidebar-bottom">
      <div class="sync-tile"><strong>Google Sheets</strong><p>${state.config.sheetUrl ? `Leitura automática a cada ${state.config.refreshMinutes} min.` : "Aguardando acesso à torre de controle."}</p>${can("sheet") ? `<button data-action="sheet-config">${state.config.sheetUrl ? "Gerenciar conexão" : "Configurar integração"}</button>` : ""}</div>
      <button class="profile" data-action="logout" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:transparent;text-align:left"><span class="avatar">${state.user.username.slice(0, 2).toUpperCase()}</span><span><strong>${esc(state.user.username)}</strong><span>${state.role} • sair</span></span></button>
    </div>
  </aside>
  <main class="main">
    <header class="topbar"><div><p class="eyebrow">${title[0]}</p><h1>${title[1]}</h1></div><div class="top-actions">
      <span class="live-pill"><i class="pulse"></i><span id="sync-label">${state.lastSync ? `Atualizado ${fmtTime(state.lastSync)}` : ""}</span></span>
      <button class="icon-btn" data-action="sync" title="Sincronizar">${icons.refresh}</button>
      ${isAnalises ? `<button class="secondary-btn" data-action="export">Exportar CSV</button>` : ""}
      <button class="logout-btn" data-action="logout">${icons.logout}<span>Sair</span></button>
    </div></header>
    <div class="page">${renderCurrentPage()}</div>
  </main>
  <nav class="mobile-nav">${navItems.slice(0, 4).map(n => navButton(n, true)).join("")}</nav></div>`;

    bindEvents();
}

function bindEvents() {
    document.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener("click", () => {
        state.page = btn.dataset.page;
        renderApp();
    }));

    const search = document.querySelector("#record-search");
    if (search) search.addEventListener("input", e => {
        state.query = e.target.value;
        const pos = e.target.selectionStart;
        renderApp();
        const next = document.querySelector("#record-search");
        if (next) {
            next.focus();
            next.setSelectionRange(pos, pos);
        }
    });

    const filter = document.querySelector("#status-filter");
    if (filter) filter.addEventListener("change", e => {
        state.statusFilter = e.target.value;
        renderApp();
    });
}

async function updateRecord(id, transition, changes, payload = {}) {
    const index = state.records.findIndex(r => r.id === id);
    if (index < 0) return false;
    if (state.apiOnline && state.records[index].source === "server") {
        try {
            const result = await api(`/api/records/${encodeURIComponent(id)}/transition`, {
                method: "PATCH",
                body: JSON.stringify({ action: transition, ...payload })
            });
            state.records[index] = result.record;
        } catch (error) {
            toast("Ação não concluída", error.message);
            return false;
        }
    } else state.records[index] = { ...state.records[index], ...changes };
    saveRecords();
    document.querySelector("#modal-root").innerHTML = "";
    renderApp();
    return true;
}

document.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "new-record" && can("create")) openNewRecord(button.dataset.dock || "");

    // CORREÇÃO: Remove a trava que impedia o fechamento dos modais
    if (action === "close-modal") {
        document.querySelector("#modal-root").innerHTML = "";
    }

    if (action === "manage-users" && state.role === "Supervisor") openManageUsers();
    if (action === "new-user") openUserForm();
    if (action === "edit-user") openUserForm(button.dataset.username, button.dataset.name, button.dataset.role);
    if (action === "sheet-config" && can("sheet")) openSheetConfig();
    if (action === "toggle-password") {
        const input = button.parentElement.querySelector("input");
        input.type = input.type === "password" ? "text" : "password";
        button.textContent = input.type === "password" ? "Ver" : "Ocultar";
    }
    if (action === "logout") {
        try {
            await api("/api/logout", { method: "POST", body: "{}" });
        } catch { }
        state.user = null;
        state.role = null;
        state.csrf = null;
        state.records = [];
        renderApp();
    }
    if (action === "sync") syncSheet(true);
    if (action === "open-change-password") openChangePasswordModal();
    if (action === "export") exportCSV();
    if (action === "download-turno") downloadTurnoExcel();
    if (action === "prepare-unload") openStartUnload(button.dataset.id);
    if (action === "prompt-insumos") openPromptInsumos(button.dataset.id);
    if (action === "disconnect-sheet") {
        state.config.sheetUrl = "";
        state.sheetRecords = [];
        saveConfig();
        document.querySelector("#modal-root").innerHTML = "";
        renderApp();
        toast("Planilha desconectada");
    }
    if (action === "add-insumo") {
        const list = document.getElementById("insumos-list");
        if (list) {
            const div = document.createElement("div");
            div.innerHTML = getInsumoTemplate(list.children.length);
            list.appendChild(div.firstElementChild);
            document.querySelector('.modal-body').scrollBy({ top: 150, behavior: 'smooth' });
        }
    }
    if (action === "filtrar-insumos") {
        state.insumoFiltros = {
            dataInicio: document.querySelector("#filtro-data-inicio")?.value || "",
            dataFim: document.querySelector("#filtro-data-fim")?.value || "",
            origem: document.querySelector("#filtro-origem")?.value || "",
            conferente: document.querySelector("#filtro-conferente")?.value || ""
        };
        fetchInsumos();
    }
    if (action === "limpar-filtros-insumos") {
        state.insumoFiltros = { dataInicio: "", dataFim: "", origem: "", conferente: "" };
        renderApp();
    }
});

document.addEventListener("submit", async event => {
    if (event.target.id === "login-form") {
        event.preventDefault();
        const submit = event.target.querySelector("button[type=submit]");
        submit.disabled = true;
        submit.textContent = "Validando…";
        const form = new FormData(event.target);
        try {
            const payload = await api("/api/login", {
                method: "POST",
                body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
            });
            state.user = payload.user;
            state.role = payload.user.role;
            state.csrf = payload.csrf;
            state.apiOnline = true;
            renderApp();
            await hydrateFromServer();
            toast("Acesso autorizado", `Sessão iniciada como ${state.role}.`);
        } catch (error) {
            submit.disabled = false;
            submit.textContent = "Entrar no sistema";
            toast("Acesso não autorizado", error.message);
        }
    }
    if (event.target.id === "record-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        const status = form.get("status");

        const record = {
            id: `R-${Date.now().toString().slice(-6)}`,
            data: new Date(form.get("data")).toISOString(),
            origem: String(form.get("origem")).trim(),
            doca: form.get("doca") || "—",
            motorista: String(form.get("motorista") || "—").trim(),
            placa: String(form.get("placa") || "—").trim().toUpperCase(),
            volumetria: Number(form.get("volumetria")) || 0,
            inicio: status === "Em descarga" ? new Date().toISOString() : null,
            fim: null,
            sla: Number(form.get("sla")) || 60,
            conferente: String(form.get("conferente") || "—").trim(),
            status,
            source: "local"
        };
        if (state.apiOnline) {
            try {
                const payload = await api("/api/records", {
                    method: "POST",
                    body: JSON.stringify(record)
                });
                state.records.unshift(payload.record);
            } catch (error) {
                toast("Cadastro não concluído", error.message);
                return;
            }
        } else state.records.unshift(record);
        saveRecords();
        document.querySelector("#modal-root").innerHTML = "";
        renderApp();
        toast("Recebimento cadastrado", `${record.placa} incluído na operação.`);
    }
    if (event.target.id === "start-unload-form") {
        event.preventDefault();
        const id = event.target.dataset.id;
        const volume = Number(new FormData(event.target).get("volumetria"));
        const conferenteNome = state.user.name || state.user.username;

        if (await updateRecord(id, "start", { status: "Em descarga", inicio: new Date().toISOString(), volumetria: volume, conferente: conferenteNome }, { volumetria: volume, conferente: conferenteNome })) {
            toast("Descarga iniciada", "Volumetria confirmada e SLA em andamento.");
        }
    }
    if (event.target.id === "finish-unload-form") {
        event.preventDefault();
        const id = event.target.dataset.id;
        const form = new FormData(event.target);

        const payload = {
            action: "finish",
            status: "Concluído",
            fim: new Date().toISOString(),
            foto_url: form.get("foto_url") || ""
        };

        if (form.get("tem_insumo") === "sim") {
            const items = [...event.target.querySelectorAll('.insumo-item')];
            const insumosList = items.map(item => ({
                tipo: item.querySelector('[name="tipo_insumo"]').value,
                qtd: Number(item.querySelector('[name="qtd_insumo"]').value || 0),
                status: item.querySelector('[name="status_insumo"]')?.value || "",
                obs: item.querySelector('[name="obs_insumo"]')?.value || "",
                foto_url: form.get("foto_url") || ""
            })).filter(i => i.tipo && i.qtd > 0);

            payload.insumos = insumosList;
            payload.insumo_tipo = insumosList.map(i => `${i.qtd}x ${i.tipo}`).join(", ");
            payload.insumo_qtd = insumosList.reduce((acc, curr) => acc + curr.qtd, 0);
        }

        if (await updateRecord(id, "finish", payload, payload)) {
            toast("Descarga finalizada", "Insumos registrados com sucesso.");
        }
    }
    if (event.target.id === "sheet-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        state.config.sheetUrl = String(form.get("sheetUrl") || "").trim();
        state.config.refreshMinutes = Number(form.get("refreshMinutes") || 5);
        saveConfig();
        document.querySelector("#modal-root").innerHTML = "";
        syncSheet(true);
        scheduleSync();
    }

    if (event.target.id === "register-user-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        const submit = event.target.querySelector("button[type=submit]");
        const actionType = event.target.dataset.actionType;

        const pass = String(form.get("new_password") || "").trim();
        const confirm = String(form.get("confirm_password") || "").trim();

        if (pass || confirm) {
            if (pass !== confirm) {
                toast("Erro", "As senhas digitadas não coincidem.");
                return;
            }
        }

        submit.disabled = true;
        submit.textContent = "Salvando...";

        // Concatena o nome e o sobrenome vindos do modal para salvar no banco
        const nomeCompleto = `${String(form.get("new_nome") || "").trim()} ${String(form.get("new_sobrenome") || "").trim()}`;

        api("/api/users", {
            method: "POST",
            body: JSON.stringify({
                action: actionType,
                name: nomeCompleto,
                username: String(form.get("new_username") || "").trim(),
                password: pass,
                role: form.get("new_role")
            })
        })
            .then(payload => {
                const msg = pass.length > 0 ? "Perfil e senha atualizados." : "Perfil atualizado com sucesso.";
                toast("Sucesso!", msg);
                openManageUsers();
            })
            .catch(error => {
                if (error.message && error.message.includes("Unexpected end of JSON")) {
                    toast("Sucesso!", "Alteração realizada com sucesso.");
                    openManageUsers();
                    return;
                }
                submit.disabled = false;
                submit.textContent = actionType === 'create' ? "Cadastrar Usuário" : "Salvar Alterações";
                toast("Falha ao salvar", error.message);
            });
    }

    if (event.target.id === "change-password-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        const submit = event.target.querySelector("button[type=submit]");

        submit.disabled = true;
        submit.textContent = "Atualizando...";

        api("/api/change-password", {
            method: "POST",
            body: JSON.stringify({
                currentPassword: form.get("current_password"),
                newPassword: form.get("new_password")
            })
        })
            .then(payload => {
                toast("Sucesso!", "Sua senha foi alterada com sucesso.");
                document.querySelector("#modal-root").innerHTML = "";
            })
            .catch(error => {
                submit.disabled = false;
                submit.textContent = "Alterar Senha";
                toast("Falha ao alterar senha", error.message);
            });
    }
});

// Inicialização
renderApp();
scheduleSync();
checkSession();
if (state.config.sheetUrl) syncSheet(false);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("service-worker.js").catch(() => { });
}