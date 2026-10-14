"use strict";

// URL base do servidor na nuvem (Render). Em localhost a API é servida pela mesma origem.
const API_BASE_URL = location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? ""
    : "https://recebe-mais.onrender.com";

const API_TIMEOUT_MS = 60000; // o Render gratuito pode levar ~50 s para "acordar"

async function api(path, options = {}) {
    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            ...options,
            // "include" permite enviar o cookie de sessão entre GitHub Pages e Render
            credentials: "include",
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined,
            headers: {
                "Content-Type": "application/json",
                ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}),
                ...(options.headers || {})
            }
        });
    } catch {
        const error = new Error("Sem conexão com o servidor. Verifique a internet e tente novamente.");
        error.network = true;
        throw error;
    }

    // Lê como texto: respostas vazias ou HTML (502/504 do Render) não derrubam o parse
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

    if (!response.ok) {
        const fallback = response.status >= 500
            ? "Servidor indisponível no momento. Tente novamente em instantes."
            : "Falha na API";
        const error = new Error(payload.error || fallback);
        error.status = response.status;
        throw error;
    }
    return payload;
}

async function hydrateFromServer() {
    try {
        const payload = await api("/api/records");
        state.records = payload.records;
        state.apiOnline = true;
            state.user = null;
            state.role = null;
            state.csrf = null;
            if (typeof renderApp === "function") renderApp();
        }
    }
}

async function checkSession(attempt = 0) {
    try {
        const payload = await api("/api/me");
        state.user = payload.user;
        state.role = payload.user.role;
        state.csrf = payload.csrf;
        state.apiOnline = true;
    } catch (error) {
        // Só 401 significa "não logado". Falha de rede/servidor acordando: tenta de novo antes de desistir.
        if (error.status !== 401 && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 4000));
            return checkSession(attempt + 1);
        }
        state.user = null;
        state.role = null;
        state.csrf = null;
    }
    state.authChecked = true;
    if (typeof renderApp === "function") renderApp();
    if (state.user) hydrateFromServer();
}

// Atenção: isto só controla a interface. A autorização real é feita no servidor.
function can(permission) {
    if (state.role === "Supervisor") return true;
    if (permission === "create") return ["Conferente", "Assistente"].includes(state.role);
    if (permission === "transition") return state.role === "Conferente";
    if (permission === "sheet") return false;
    return Boolean(state.user);
}
