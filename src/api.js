"use strict";

/**
 * Define a URL base da API REST no backend (Render/Produção vs. Localhost).
 */
const API_BASE_URL = location.hostname === "localhost" || location.hostname === "127.0.0.1" 
  ? "" 
  : "https://recebe-mais.onrender.com";

/**
 * Cliente HTTP unificado da aplicação Recebe+.
 * Transmite os cookies de sessão HTTP-Only e o token Anti-CSRF.
 * 
 * @param {string} path - Caminho do endpoint (ex: '/api/records')
 * @param {object} options - Opções da requisição Fetch
 * @returns {Promise<object>} Retorna a resposta JSON em caso de sucesso
 */
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    // Permite o envio/recebimento de cookies de sessão em requisições cross-origin (Render + GitHub Pages)
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}),
      ...(options.headers || {})
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Falha na comunicação com a API");
  }
  return payload;
}

/**
 * Hidrata o estado global com a lista de recebimentos atualizada do servidor.
 */
async function hydrateFromServer() {
  try {
    const payload = await api("/api/records");
    state.records = payload.records;
    state.apiOnline = true;
    saveRecords();
    if (typeof renderApp === "function") renderApp();
  } catch {
    state.apiOnline = false;
  }
}

/**
 * Verifica a sessão do usuário autenticado e resgata as permissões/CSRF.
 */
async function checkSession() {
  try {
    const payload = await api("/api/me");
    state.user = payload.user;
    state.role = payload.user.role;
    state.csrf = payload.csrf;
    state.apiOnline = true;
  } catch {
    state.user = null;
    state.role = null;
    state.csrf = null;
  }
  state.authChecked = true;
  if (typeof renderApp === "function") renderApp();
  if (state.user) hydrateFromServer();
}

/**
 * Matriz de Controle de Acesso Baseado em Perfis (RBAC).
 * 
 * @param {string} permission - Ação desejada ('create', 'transition', 'sheet')
 * @returns {boolean} Retorna true se a ação for permitida para a função ativa
 */
function can(permission) {
  if (state.role === "Supervisor") return true;
  if (permission === "create") return ["Conferente", "Assistente"].includes(state.role);
  if (permission === "transition") return state.role === "Conferente";
  if (permission === "sheet") return false;
  return Boolean(state.user);
}
