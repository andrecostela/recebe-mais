"use strict";

// Troque o número da versão a cada deploy para descartar caches antigos.
const CACHE_NAME = "recebe-plus-v3";

// Caminhos relativos ao escopo do service worker (funcionam em "/" e em "/recebe-mais/")
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "manifest.json",
  "icon.svg",
  "src/state.js",
  "src/api.js",
  "src/utils/formatters.js",
  "src/utils/csv-parser.js",
  "src/utils/excel-exporter.js",
  "src/components/toasts.js",
  "src/components/navbar.js",
  "src/components/modals.js",
  "src/views/dashboard.js",
  "src/views/controle.js",
  "src/views/inbound.js",
  "src/views/insumos.js",
  "src/views/analises.js",
  "src/views/configuracoes.js",
  "src/app.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Tolerante: um arquivo ausente não impede a instalação do service worker
    await Promise.allSettled(ASSETS.map(asset => cache.add(new URL(asset, self.registration.scope))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Não intercepta outros domínios (Google Sheets, CDN, API no Render) nem rotas /api/
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  // Network-first: sempre tenta a versão mais nova; usa o cache só se a rede falhar
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      // Fallback para a página principal somente em navegação (nunca para JS/CSS/dados)
      if (request.mode === "navigate") {
        const page = await caches.match(new URL("index.html", self.registration.scope));
        if (page) return page;
      }
      return new Response("Sem conexão", { status: 503, statusText: "Offline" });
    }
  })());
});
