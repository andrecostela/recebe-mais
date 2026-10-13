"use strict";

function toast(title, message = "") {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  root.innerHTML = `<div class="toast"><b>${esc(title)}</b>${esc(message)}</div>`;
  setTimeout(() => root.innerHTML = "", 3200);
}