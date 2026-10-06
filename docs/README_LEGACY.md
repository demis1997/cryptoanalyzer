## Protocol Inspector – Simple Frontend

This is a **very simple frontend** where you paste a DeFi protocol website and it shows, below, some key (currently mocked) information:

- **Contract addresses**
- **Total value locked (TVL)**
- **Investors of the protocol**
- **Transactions per day**

Right now, all values are **mock/demo data generated in the browser** so you can focus on the UI and wiring. To make it production‑ready, you would connect the form submit action to a backend and/or third‑party APIs.

### Files

- **`index.html`**: Main HTML page and layout.
- **`style.css`**: Styling for a clean, modern, simple dashboard UI.
- **`app.js`**: Frontend logic (handles URL input and populates mock data).
- **`package.json`**: Minimal project metadata and a convenience `start` script.

### Running locally

From the project root:

```bash
npm install
npm run start
```

This uses `npx serve .` to start a simple static file server. Open the URL it prints (usually `http://localhost:3000` or `http://localhost:5000`) and you’ll see the app.

### Making it real (hooking to data)

To replace mock data with real values:

- **Contract addresses**: From your own registry, subgraph, or a scraping backend.
- **TVL**: From analytics APIs like DefiLlama or your own TVL service.
- **Investors**: From your internal datasets, token distribution APIs, or curated lists.
- **Transactions per day**: From chain indexers / explorers (e.g. Covalent, Alchemy, custom indexer).

Update `app.js` to call your backend (e.g. `fetch("/api/analyze?url=" + encodeURIComponent(url))`) instead of `generateMockData`, then render the real response into the same DOM elements.

