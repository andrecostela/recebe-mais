  });
}

// ---------------------------------------------------------------------
// 8. Servidor HTTP
// ---------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      applyCors(req, res);
      if (req.method === "OPTIONS") { // preflight: responde ANTES de qualquer autenticação
        res.writeHead(204);
        return res.end();
      }
      await dbReady;
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return json(res, 500, { error: "Falha interna" });
    res.end();
  }
});
