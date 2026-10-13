Sistema de controle de recebimento em docas, acompanhamento de volumetria, integração com Google Sheets e gestão de evidências de insumos.

## Estrutura do Projeto

- `public/`: Shell estático servido ao navegador (`index.html`, `styles.css`, `manifest.json`, `service-worker.js`, `icon.svg`).
- `src/`: Front-End modularizado em JavaScript puro (SPA com renderização reativa).
  - `app.js`: Ponto de entrada, rotas e inicialização.
  - `state.js`: Gerenciamento de estado global.
  - `api.js`: Cliente HTTP, autenticação e CSRF.
  - `utils/`: Utilidades para formatação e exportação.
  - `views/`: Views principais (Dashboard, Torre de Controle, Inbound, Insumos, Análises, Configurações).
  - `components/`: Componentes reutilizáveis.
- `server/`: REST API em Node.js com suporte a PostgreSQL e fallback JSON.
- `data/`: Armazenamento local de contingência/desenvolvimento.

## Como Executar

```bash
npm install
npm start
```

Acesse no navegador: `http://localhost:3000`
