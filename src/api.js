"use strict";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Falha na API");
  return payload;
}

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

function can(permission) {
  if (state.role === "Supervisor") return true;
  if (permission === "create") return ["Conferente", "Assistente"].includes(state.role);
  if (permission === "transition") return state.role === "Conferente";
  if (permission === "sheet") return false;
  return Boolean(state.user);
}
