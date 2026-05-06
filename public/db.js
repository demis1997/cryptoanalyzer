const qEl = document.getElementById("db-q");
const searchBtn = document.getElementById("db-search-btn");
const resultsEl = document.getElementById("db-results");
const metaEl = document.getElementById("db-meta");

const nameEl = document.getElementById("p-name");
const idEl = document.getElementById("p-id");
const urlEl = document.getElementById("p-url");
const auditorsEl = document.getElementById("p-auditors");
const summaryEl = document.getElementById("p-summary");
const auditLinksEl = document.getElementById("p-audit-links");
const statsEl = document.getElementById("p-stats");
const docsEl = document.getElementById("p-docs");
const rawEl = document.getElementById("raw-json");

const relList = document.getElementById("rel-list");
const relEmpty = document.getElementById("rel-empty");
const relGraphEl = document.getElementById("rel-graph");

// Pool search
const poolQEl = document.getElementById("pool-q");
const poolSearchBtn = document.getElementById("pool-search-btn");
const poolResultsEl = document.getElementById("pool-results");
const poolMetaEl = document.getElementById("pool-meta");
const poolSelectedEl = document.getElementById("pool-selected");
const poolGraphEl = document.getElementById("pool-graph");
const poolRelatedEl = document.getElementById("pool-related");
const poolRelatedEmpty = document.getElementById("pool-related-empty");

function prettyId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.replace(/^defillama:/i, "").replace(/^protocol:/i, "").replace(/^url:/i, "");
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function clearProtocol() {
  nameEl.textContent = "–";
  idEl.textContent = "";
  urlEl.textContent = "";
  auditorsEl.textContent = "";
  summaryEl.textContent = "";
  if (auditLinksEl) auditLinksEl.innerHTML = "";
  statsEl.textContent = "–";
  docsEl.innerHTML = "";
  rawEl.textContent = "";
  relList.innerHTML = "";
  if (relGraphEl) {
    relGraphEl.style.display = "none";
    relGraphEl.innerHTML = "";
  }
  if (relEmpty) relEmpty.style.display = "block";
}

function clearPool() {
  if (poolSelectedEl) poolSelectedEl.textContent = "No pool selected.";
  if (poolGraphEl) {
    poolGraphEl.style.display = "none";
    poolGraphEl.innerHTML = "";
  }
  if (poolRelatedEl) poolRelatedEl.innerHTML = "";
  if (poolRelatedEmpty) poolRelatedEmpty.style.display = "block";
}

function safeText(v, max = 800) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function apiGet(url) {
  const resp = await fetch(url);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json?.ok === false) throw new Error(json?.error || `Request failed (${resp.status})`);
  return json;
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No results.";
    resultsEl.appendChild(li);
    return;
  }
  for (const r of rows.slice(0, 30)) {
    const li = document.createElement("li");
    const display = r.name || r.id;
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(display, 80)}</div>
          <div class="metric metric--muted mono-inline">${safeText(prettyId(r.id), 120)}</div>
        </div>
        <button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-id="${r.id}">Open</button>
      </div>
    `;
    resultsEl.appendChild(li);
  }
}

function keyForPool(chain, address) {
  const ch = String(chain || "ethereum").trim().toLowerCase() || "ethereum";
  const a = String(address || "").trim().toLowerCase();
  return `${ch}:${a}`;
}

function parsePoolKey(key) {
  const s = String(key || "").trim();
  const m = s.match(/^([a-z0-9_-]+):(0x[a-f0-9]{40})$/i);
  if (!m) return null;
  return { chain: m[1].toLowerCase(), address: m[2].toLowerCase() };
}

function renderPoolResults(results) {
  if (!poolResultsEl) return;
  poolResultsEl.innerHTML = "";
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No pools found.";
    poolResultsEl.appendChild(li);
    return;
  }
  for (const r of rows.slice(0, 30)) {
    const li = document.createElement("li");
    const label = r.label || "Pool/Market";
    const type = r.type ? String(r.type) : "pool";
    const key = keyForPool(r.chain, r.address);
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(label, 90)} <span style="color:#9ca3af;">• ${escapeHtml(type)}</span></div>
          <div class="metric metric--muted mono-inline">${escapeHtml(key)}</div>
        </div>
        <button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-pool="${escapeHtml(key)}">Open</button>
      </div>
    `;
    poolResultsEl.appendChild(li);
  }
}

function renderPoolGraphSvg({ rootLabel, protocols, pools }) {
  if (!poolGraphEl) return;
  const protos = Array.isArray(protocols) ? protocols.slice(0, 18) : [];
  const poolNodes = Array.isArray(pools) ? pools.slice(0, 18) : [];
  const items = [
    ...protos.map((p) => ({ label: String(p.name || prettyId(p.id) || "Protocol").slice(0, 18) })),
    ...poolNodes.map((c) => ({ label: String(c.label || "Pool").slice(0, 18) })),
  ].slice(0, 30);

  if (!items.length) {
    poolGraphEl.style.display = "none";
    poolGraphEl.innerHTML = "";
    return;
  }

  const width = 860;
  const height = 260;
  const root = { x: Math.floor(width / 2), y: 36, label: String(rootLabel || "Pool").slice(0, 26) };
  const cols = 6;
  const colW = Math.floor(width / cols);
  const padX = 18;
  const padY = 100;

  const pts = items.map((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      x: padX + c * colW + Math.floor(colW / 2),
      y: padY + r * 62,
      label: n.label,
    };
  });

  const lines = pts
    .map((p) => `<line x1="${root.x}" y1="${root.y + 14}" x2="${p.x}" y2="${p.y - 10}" stroke="#334155" stroke-width="1" />`)
    .join("");
  const bubbles = pts
    .map(
      (p) => `
      <g>
        <rect x="${p.x - 70}" y="${p.y - 18}" width="140" height="32" rx="12" fill="#0b1220" stroke="#334155" />
        <text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="11" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(p.label)}</text>
      </g>`
    )
    .join("");

  poolGraphEl.style.display = "block";
  poolGraphEl.innerHTML = `
    <svg width="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pool neighborhood graph">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#020617" rx="18" />
      <g>
        <rect x="${root.x - 140}" y="${root.y - 18}" width="280" height="38" rx="14" fill="#0b1220" stroke="#38bdf8" stroke-width="1.5" />
        <text x="${root.x}" y="${root.y + 6}" text-anchor="middle" font-size="12" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(root.label)}</text>
      </g>
      ${lines}
      ${bubbles}
      <text x="${width - 16}" y="${height - 14}" text-anchor="end" font-size="10" fill="#64748b" font-family="system-ui, -apple-system, Segoe UI, sans-serif">Protocols: ${protos.length} • Pools: ${poolNodes.length}</text>
    </svg>
  `;
}

async function openPool(poolKey) {
  const parsed = parsePoolKey(poolKey);
  if (!parsed) return;
  clearPool();
  if (poolMetaEl) poolMetaEl.textContent = "Loading pool neighborhood…";
  const r = await apiGet(
    `/api/db/pool/neighborhood?chain=${encodeURIComponent(parsed.chain)}&address=${encodeURIComponent(parsed.address)}&hops=4`
  );
  if (!r.hit) {
    if (poolMetaEl) poolMetaEl.textContent = "No neighborhood found.";
    return;
  }
  if (poolSelectedEl) {
    poolSelectedEl.textContent = `${r.root?.label || "Pool"} (${parsed.chain})`;
  }
  const protos = Array.isArray(r.protocols) ? r.protocols : [];
  const pools = Array.isArray(r.pools) ? r.pools : [];
  renderPoolGraphSvg({
    rootLabel: r.root?.label || poolKey,
    protocols: protos,
    pools: pools.filter((x) => !(String(x.address || "").toLowerCase() === parsed.address && String(x.chain || "").toLowerCase() === parsed.chain)),
  });

  if (poolRelatedEl) {
    poolRelatedEl.innerHTML = "";
    const list = [
      ...protos.map((p) => ({ kind: "protocol", id: p.id, name: p.name || prettyId(p.id) })),
      ...pools.map((c) => ({ kind: "pool", id: keyForPool(c.chain, c.address), name: c.label || "Pool" })),
    ]
      .filter((x) => x && x.id)
      .slice(0, 120);
    if (!list.length) {
      if (poolRelatedEmpty) poolRelatedEmpty.style.display = "block";
    } else {
      if (poolRelatedEmpty) poolRelatedEmpty.style.display = "none";
      for (const it of list) {
        const li = document.createElement("li");
        const btn =
          it.kind === "protocol"
            ? `<button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-id="${it.id}">Open protocol</button>`
            : `<button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-pool="${escapeHtml(it.id)}">Open pool</button>`;
        li.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <div>
              <div>${safeText(it.name, 90)} <span style="color:#9ca3af;">• ${escapeHtml(it.kind)}</span></div>
              <div class="metric metric--muted mono-inline">${escapeHtml(it.kind === "protocol" ? prettyId(it.id) : it.id)}</div>
            </div>
            ${btn}
          </div>
        `;
        poolRelatedEl.appendChild(li);
      }
    }
  }
  if (poolMetaEl) poolMetaEl.textContent = `Loaded pool neighborhood from ${r.source || "neo4j"}.`;
}

function renderRelatedGraphSvg({ rootName, relatedNodes }) {
  if (!relGraphEl) return;
  const nodes = Array.isArray(relatedNodes) ? relatedNodes.slice(0, 36) : [];
  if (!nodes.length) {
    relGraphEl.style.display = "none";
    relGraphEl.innerHTML = "";
    return;
  }

  const width = 860;
  const height = 260;
  const root = { x: Math.floor(width / 2), y: 36, label: String(rootName || "Protocol").slice(0, 26) };
  const cols = 6;
  const colW = Math.floor(width / cols);
  const padX = 18;
  const padY = 100;

  const pts = nodes.map((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      x: padX + c * colW + Math.floor(colW / 2),
      y: padY + r * 62,
      label: String(n.name || prettyId(n.id) || "Protocol").slice(0, 18),
    };
  });

  const lines = pts
    .map((p) => `<line x1="${root.x}" y1="${root.y + 14}" x2="${p.x}" y2="${p.y - 10}" stroke="#334155" stroke-width="1" />`)
    .join("");
  const bubbles = pts
    .map(
      (p) => `
      <g>
        <rect x="${p.x - 70}" y="${p.y - 18}" width="140" height="32" rx="12" fill="#0b1220" stroke="#334155" />
        <text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="11" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(p.label)}</text>
      </g>`
    )
    .join("");

  relGraphEl.style.display = "block";
  relGraphEl.innerHTML = `
    <svg width="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Related protocols graph">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#020617" rx="18" />
      <g>
        <rect x="${root.x - 120}" y="${root.y - 18}" width="240" height="38" rx="14" fill="#0b1220" stroke="#38bdf8" stroke-width="1.5" />
        <text x="${root.x}" y="${root.y + 6}" text-anchor="middle" font-size="12" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(root.label)}</text>
      </g>
      ${lines}
      ${bubbles}
      <text x="${width - 16}" y="${height - 14}" text-anchor="end" font-size="10" fill="#64748b" font-family="system-ui, -apple-system, Segoe UI, sans-serif">Showing ${nodes.length} related protocols</text>
    </svg>
  `;
}

function renderRelated(graph, { rootId }) {
  relList.innerHTML = "";
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) {
    if (relEmpty) relEmpty.style.display = "block";
    if (relGraphEl) {
      relGraphEl.style.display = "none";
      relGraphEl.innerHTML = "";
    }
    return;
  }
  if (relEmpty) relEmpty.style.display = "none";

  for (const n of nodes.slice(0, 220)) {
    if (!n?.id) continue;
    if (n.id === rootId) continue;
    const li = document.createElement("li");
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(n.name || n.id, 90)}</div>
          <div class="metric metric--muted mono-inline">${safeText(prettyId(n.id), 140)}</div>
        </div>
        <button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-open="${n.id}">View</button>
      </div>
    `;
    relList.appendChild(li);
  }
}

async function openProtocol(id) {
  clearProtocol();
  metaEl.textContent = "Loading protocol…";

  try {
    if (qEl) qEl.value = prettyId(id);
    // Keep URL shareable / back-button friendly.
    window.location.hash = encodeURIComponent(id);
  } catch {}

  const proto = await apiGet(`/api/db/protocol?id=${encodeURIComponent(id)}`);
  const p = proto.protocol || {};
  const extra = proto.extra || {};

  nameEl.textContent = p.name || "—";
  idEl.textContent = prettyId(p.id || id);
  urlEl.textContent = p.url ? `URL: ${p.url}` : "";

  const auditors =
    extra?.protocol?.auditsVerified?.firms ||
    (Array.isArray(p.auditors) ? p.auditors.map((a) => a?.name).filter(Boolean) : []);
  auditorsEl.textContent = Array.isArray(auditors) && auditors.length ? `Auditors: ${auditors.join(", ")}` : "";

  const desc = extra?.protocol?.description || extra?.protocol?.info || "";
  summaryEl.textContent = desc ? safeText(desc, 520) : "";

  if (auditLinksEl) {
    const links = Array.isArray(extra?.protocol?.auditLinks) ? extra.protocol.auditLinks : [];
    auditLinksEl.innerHTML = links.length
      ? `Audit links: ${links
          .slice(0, 8)
          .map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`)
          .join("<br/>")}`
      : "";
  }

  const tokenCount = Array.isArray(p.tokens) ? p.tokens.length : 0;
  const contractCount = Array.isArray(p.contracts) ? p.contracts.length : 0;
  const docCount = Array.isArray(p.docPages) ? p.docPages.length : 0;
  statsEl.textContent = `Tokens: ${tokenCount} • Contracts: ${contractCount} • Doc pages: ${docCount}`;

  docsEl.innerHTML = "";
  for (const d of (Array.isArray(p.docPages) ? p.docPages : []).slice(0, 25)) {
    const li = document.createElement("li");
    li.innerHTML = `<a class="mono-inline" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${safeText(d.url, 140)}</a>`;
    docsEl.appendChild(li);
  }

  rawEl.textContent = JSON.stringify(proto, null, 2);

  const related = await apiGet(`/api/db/related?id=${encodeURIComponent(p.id || id)}&hops=4`);
  renderRelatedGraphSvg({
    rootName: p.name || prettyId(p.id || id),
    relatedNodes: (Array.isArray(related?.graph?.nodes) ? related.graph.nodes : []).filter((n) => n?.id && n.id !== (p.id || id)),
  });
  renderRelated(related.graph, { rootId: p.id || id });
  metaEl.textContent = `Loaded from ${proto.source || "db"}; related from ${related.source || "neo4j"}.`;
}

async function doSearch() {
  const q = String(qEl.value || "").trim();
  resultsEl.innerHTML = "";
  if (!q) return;
  searchBtn.disabled = true;
  metaEl.textContent = "Searching…";
  try {
    const r = await apiGet(`/api/db/search?q=${encodeURIComponent(q)}&limit=25`);
    renderResults(r.results);
    metaEl.textContent = `Search source: ${r.source || "db"}`;
  } catch (e) {
    metaEl.textContent = `Search failed: ${String(e?.message || e)}`;
  } finally {
    searchBtn.disabled = false;
  }
}

async function doPoolSearch() {
  const q = String(poolQEl?.value || "").trim();
  if (!poolResultsEl || !poolSearchBtn) return;
  poolResultsEl.innerHTML = "";
  if (!q) return;
  poolSearchBtn.disabled = true;
  if (poolMetaEl) poolMetaEl.textContent = "Searching pools…";
  try {
    const r = await apiGet(`/api/db/pool/search?q=${encodeURIComponent(q)}&limit=25`);
    renderPoolResults(r.results);
    if (poolMetaEl) poolMetaEl.textContent = `Pool search source: ${r.source || "neo4j"}`;
  } catch (e) {
    if (poolMetaEl) poolMetaEl.textContent = `Pool search failed: ${String(e?.message || e)}`;
  } finally {
    poolSearchBtn.disabled = false;
  }
}

searchBtn?.addEventListener("click", doSearch);
qEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

poolSearchBtn?.addEventListener("click", doPoolSearch);
poolQEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doPoolSearch();
});

resultsEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-id]");
  const id = btn?.getAttribute?.("data-id");
  if (id) openProtocol(id);
});

relList?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-open]");
  const id = btn?.getAttribute?.("data-open");
  if (id) openProtocol(id);
});

poolResultsEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-pool]");
  const key = btn?.getAttribute?.("data-pool");
  if (key) openPool(key);
});

poolRelatedEl?.addEventListener("click", (e) => {
  const pbtn = e.target?.closest?.("button[data-id]");
  const pid = pbtn?.getAttribute?.("data-id");
  if (pid) {
    openProtocol(pid);
    return;
  }
  const btn = e.target?.closest?.("button[data-pool]");
  const key = btn?.getAttribute?.("data-pool");
  if (key) openPool(key);
});

clearProtocol();
clearPool();

// Support deep links: /db.html#defillama:lido
try {
  const h = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
  if (h) openProtocol(h);
} catch {}

