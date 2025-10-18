# XRPL DeepFlow — Render Deploy

Two ways to deploy on Render:

## A) One-click Blueprint (recommended)
1. Push this folder to a **GitHub** repo.
2. Ensure `render.yaml` is in the repo root.
3. In Render, click **New +** → **Blueprint** → connect repo.
4. Confirm settings; Render will provision a **Web Service** with Node runtime.
5. Visit the URL once live.

## B) Standard Web Service
1. Push to GitHub.
2. In Render: **New +** → **Web Service** → select repository.
3. Runtime: **Node**. Build Command: `npm install`. Start Command: `node server.js`.
4. Add env var `MIN_XRP` (optional). Render auto-sets `PORT`.
5. Save. Deploy complete when healthy (health check at `/healthz`).

### Local Run
```bash
npm install
npm start    # http://localhost:8080
```

### Env Vars
- `MIN_XRP` (default `1000000`)
- `XRPSCAN_SEARCH_URL` (XRPSCAN Advanced Search)
- `XRPSCAN_WELL_KNOWN`
- `PRICE_API`

> This app is stateless; for persistence/alerts use a DB/queue later.
