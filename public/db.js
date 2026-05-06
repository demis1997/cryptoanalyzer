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
const poolSecurityEl = document.getElementById("pool-security");
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
  const secEl = document.getElementById("p-security");
  if (secEl) secEl.innerHTML = "";
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
  if (poolSecurityEl) poolSecurityEl.innerHTML = "";
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
    const isYield = r.kind === "yield_pool";
    const label = r.label || "Pool/Market";
    const type = isYield ? "yield_pool" : (r.type ? String(r.type) : "pool");
    const key = isYield ? (r.protocolName ? `${safeText(r.protocolName, 40)} • ${safeText(label, 60)}` : safeText(label, 80)) : keyForPool(r.chain, r.address);
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(label, 90)} <span style="color:#9ca3af;">• ${escapeHtml(type)}</span></div>
          <div class="metric metric--muted mono-inline">${escapeHtml(isYield ? prettyId(r.protocolId || "") : key)}</div>
        </div>
        ${
          isYield
            ? `<button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-id="${escapeHtml(r.protocolId)}">Open protocol</button>`
            : `<button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-pool="${escapeHtml(key)}">Open</button>`
        }
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

  if (poolSecurityEl) {
    const sec = r.security || {};
    if (sec?.hacked && Array.isArray(sec.incidents) && sec.incidents.length) {
      const items = sec.incidents
        .slice(0, 4)
        .map((x) => `${escapeHtml(x.name)} <span style="color:#94a3b8;">(${escapeHtml(String(x.classification || "incident"))})</span>`)
        .join("<br/>");
      poolSecurityEl.innerHTML = `<div><b>Hacks</b>: Found ${sec.incidents.length} related incident(s). Weakest link: <b>${escapeHtml(
        sec.weakestLink?.name || "unknown"
      )}</b><br/>${items}</div>`;
    } else {
      poolSecurityEl.innerHTML = `<div><b>Hacks</b>: No known incidents found in related protocols (DefiLlama hacks DB).</div>`;
    }
  }

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

function fmtUsd(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${Math.round(n).toLocaleString()}`;
  }
}

function renderKvs(kvs) {
  const rows = (Array.isArray(kvs) ? kvs : []).filter((x) => x && x.k && x.v);
  if (!rows.length) return "";
  return `
    <div class="summary" style="margin-top:12px;">
      ${rows
        .map(
          (r) => `
        <div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start; padding:6px 0; border-bottom: 1px solid rgba(148,163,184,0.12);">
          <div style="color:#cbd5e1; font-size:12px; min-width:140px;">${escapeHtml(r.k)}</div>
          <div style="color:#e5e7eb; font-size:12px; text-align:right;">${r.v}</div>
        </div>`
        )
        .join("")}
    </div>
  `;
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

  const secEl = document.getElementById("p-security");
  if (secEl) {
    const sec = proto.security || {};
    if (sec?.hacked && Array.isArray(sec.incidents) && sec.incidents.length) {
      const items = sec.incidents
        .slice(0, 4)
        .map((x) => `${escapeHtml(x.name)} <span style="color:#94a3b8;">(${escapeHtml(String(x.classification || "incident"))})</span>`)
        .join("<br/>");
      secEl.innerHTML = `<div><b>Hacks</b>: This protocol appears in the hacks DB. Weakest link: <b>${escapeHtml(
        sec.weakestLink?.name || "unknown"
      )}</b><br/>${items}</div>`;
    } else {
      secEl.innerHTML = `<div><b>Hacks</b>: No known incidents found for this protocol (DefiLlama hacks DB).</div>`;
    }
  }

  const tokenCount = Array.isArray(p.tokens) ? p.tokens.length : 0;
  const contractCount = Array.isArray(p.contracts) ? p.contracts.length : 0;
  const docCount = Array.isArray(p.docPages) ? p.docPages.length : 0;

  const tvlUsd = extra?.protocol?.tvlUsd;
  const category = extra?.protocol?.category;
  const chains = Array.isArray(extra?.protocol?.chains) ? extra.protocol.chains : [];
  const exposures = Array.isArray(extra?.protocol?.topTokenLiquidity) ? extra.protocol.topTokenLiquidity : [];
  const poolsFromYields = Array.isArray(extra?.protocol?.poolsFromYields) ? extra.protocol.poolsFromYields : [];
  const exposureList = exposures
    .slice(0, 10)
    .map((t) => {
      const sym = String(t?.token || "").trim();
      const usd = fmtUsd(t?.liquidityUsd);
      if (!sym || !usd) return null;
      return `${escapeHtml(sym)} <span style="color:#94a3b8;">(${escapeHtml(usd)})</span>`;
    })
    .filter(Boolean);

  const poolList = poolsFromYields
    .slice(0, 8)
    .map((pl) => {
      const nm = safeText(pl?.name || "Pool", 90);
      const tvl = fmtUsd(pl?.tvlUsd);
      const apy = typeof pl?.apy === "number" && isFinite(pl.apy) ? `${pl.apy.toFixed(2)}% APY` : "";
      const rhs = [tvl ? `TVL ${tvl}` : "", apy, pl?.exposure ? String(pl.exposure) : ""].filter(Boolean).join(" • ");
      return `${escapeHtml(nm)}${rhs ? ` <span style="color:#94a3b8;">— ${escapeHtml(rhs)}</span>` : ""}`;
    })
    .filter(Boolean);

  statsEl.innerHTML = renderKvs([
    { k: "TVL", v: tvlUsd ? escapeHtml(fmtUsd(tvlUsd)) : "" },
    { k: "Category", v: category ? escapeHtml(String(category)) : "" },
    { k: "Chains", v: chains.length ? escapeHtml(chains.slice(0, 10).join(", ")) : "" },
    {
      k: "Top exposures",
      v: exposureList.length ? `<div class="link-list">${exposureList.join("<br/>")}</div>` : "",
    },
    {
      k: "Top pools",
      v: poolList.length ? `<div class="link-list">${poolList.join("<br/>")}</div>` : "",
    },
    { k: "Stored objects", v: `Tokens: ${tokenCount} • Pools/Contracts: ${contractCount} • Docs: ${docCount}` },
  ]);

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
    const rows = Array.isArray(r.results) ? r.results : [];
    if (rows.length === 1 && rows[0]?.id) {
      metaEl.textContent = `Found 1 result • opening…`;
      await openProtocol(rows[0].id);
      return;
    }
    renderResults(rows);
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
    const rows = Array.isArray(r.results) ? r.results : [];
    if (rows.length === 1) {
      const only = rows[0];
      if (only?.kind === "yield_pool" && only?.protocolId) {
        if (poolMetaEl) poolMetaEl.textContent = `Found 1 pool (via ${r.source || "db"}) • opening protocol…`;
        await openProtocol(only.protocolId);
        return;
      }
      if (only?.chain && only?.address) {
        const key = keyForPool(only.chain, only.address);
        if (poolMetaEl) poolMetaEl.textContent = `Found 1 pool (via ${r.source || "db"}) • opening…`;
        await openPool(key);
        return;
      }
    }
    renderPoolResults(rows);
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

