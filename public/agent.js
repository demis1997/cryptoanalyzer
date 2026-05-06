const form = document.getElementById("agent-form");
const urlEl = document.getElementById("agent-url");
const runBtn = document.getElementById("agent-run");
const downloadBtn = document.getElementById("agent-download");
const forceEl = document.getElementById("agent-force");
const metaEl = document.getElementById("agent-meta");

const nameEl = document.getElementById("a-name");
const outUrlEl = document.getElementById("a-url");
const auditorsEl = document.getElementById("a-auditors");
const descEl = document.getElementById("a-desc");

const riskEl = document.getElementById("a-risk");
const riskNoteEl = document.getElementById("a-risk-note");

const relatedEl = document.getElementById("a-related");
const relatedEmpty = document.getElementById("a-related-empty");
const relatedGraphEl = document.getElementById("a-related-graph");
const rawEl = document.getElementById("a-raw");

// Pool search
const poolQEl = document.getElementById("agent-pool-q");
const poolSearchBtn = document.getElementById("agent-pool-search-btn");
const poolMetaEl = document.getElementById("agent-pool-meta");
const poolResultsEl = document.getElementById("agent-pool-results");
const poolGraphEl = document.getElementById("agent-pool-graph");
const poolRelatedEl = document.getElementById("agent-pool-related");
const poolRelatedEmpty = document.getElementById("agent-pool-related-empty");

let lastProtocolKey = null;
let lastRiskAssessment = null;

function safeText(v, max = 1200) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function apiPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error || `Request failed (${resp.status})`);
  return json;
}

async function apiGet(url) {
  const resp = await fetch(url);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json?.ok === false) throw new Error(json?.error || `Request failed (${resp.status})`);
  return json;
}

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

function clearPoolUi() {
  if (poolResultsEl) poolResultsEl.innerHTML = "";
  if (poolMetaEl) poolMetaEl.textContent = "";
  if (poolGraphEl) {
    poolGraphEl.style.display = "none";
    poolGraphEl.innerHTML = "";
  }
  if (poolRelatedEl) poolRelatedEl.innerHTML = "";
  if (poolRelatedEmpty) poolRelatedEmpty.style.display = "block";
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
  if (poolRelatedEl) poolRelatedEl.innerHTML = "";
  if (poolRelatedEmpty) poolRelatedEmpty.style.display = "block";
  if (poolMetaEl) poolMetaEl.textContent = "Loading pool neighborhood…";

  try {
    const r = await apiGet(
      `/api/db/pool/neighborhood?chain=${encodeURIComponent(parsed.chain)}&address=${encodeURIComponent(parsed.address)}&hops=4`
    );
    if (!r.hit) {
      if (poolMetaEl) poolMetaEl.textContent = "No neighborhood found.";
      return;
    }
    const protos = Array.isArray(r.protocols) ? r.protocols : [];
    const pools = Array.isArray(r.pools) ? r.pools : [];
    renderPoolGraphSvg({
      rootLabel: r.root?.label || poolKey,
      protocols: protos,
      pools: pools.filter(
        (x) => !(String(x.address || "").toLowerCase() === parsed.address && String(x.chain || "").toLowerCase() === parsed.chain)
      ),
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
              ? `<a class="btn btn--ghost" style="padding:6px 12px;font-size:12px;text-decoration:none;" href="/db.html#${encodeURIComponent(
                  it.id
                )}">Open protocol</a>`
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
  } catch (e) {
    if (poolMetaEl) poolMetaEl.textContent = `Pool neighborhood failed: ${String(e?.message || e)}`;
  }
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
    const key = isYield ? null : keyForPool(r.chain, r.address);
    const right =
      isYield
        ? `<a class="btn btn--ghost" style="padding:6px 12px;font-size:12px;text-decoration:none;" href="/db.html#${encodeURIComponent(
            r.protocolId
          )}">Open protocol</a>`
        : `<button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-pool="${escapeHtml(key)}">Open</button>`;

    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(label, 90)} <span style="color:#9ca3af;">• ${escapeHtml(type)}</span></div>
          <div class="metric metric--muted mono-inline">${
            isYield ? `${safeText(r.protocolName || "", 60)}` : `${escapeHtml(key)}`
          }</div>
        </div>
        ${right}
      </div>
    `;
    poolResultsEl.appendChild(li);
  }
}

async function doPoolSearch() {
  const q = String(poolQEl?.value || "").trim();
  if (!poolSearchBtn || !poolResultsEl) return;
  if (!q) return;
  poolSearchBtn.disabled = true;
  clearPoolUi();
  if (poolMetaEl) poolMetaEl.textContent = "Searching pools…";
  try {
    // If a pool/reserve URL is pasted, resolve it first.
    if (/^https?:\/\//i.test(q)) {
      if (poolMetaEl) poolMetaEl.textContent = "Recognizing link…";
      const rr = await apiGet(`/api/resolve?url=${encodeURIComponent(q)}`);
      if (rr?.hit) {
        if (rr.kind === "pool" && rr.poolKey) {
          if (poolMetaEl) poolMetaEl.textContent = "Opening pool neighborhood…";
          await openPool(rr.poolKey);
          return;
        }
        if (rr.kind === "token" && rr.protocolHint) {
          if (poolMetaEl) poolMetaEl.textContent = "Opening related protocol…";
          window.location.href = `/db.html#${encodeURIComponent(rr.protocolHint)}`;
          return;
        }
      }
      // fall through to text search if not resolved
    }

    const r = await apiGet(`/api/db/pool/search?q=${encodeURIComponent(q)}&limit=25`);
    const rows = Array.isArray(r.results) ? r.results : [];
    if (rows.length === 1) {
      const only = rows[0];
      if (only?.kind === "yield_pool" && only?.protocolId) {
        if (poolMetaEl) poolMetaEl.textContent = `Found 1 pool • opening protocol…`;
        window.location.href = `/db.html#${encodeURIComponent(only.protocolId)}`;
        return;
      }
      if (only?.chain && only?.address) {
        if (poolMetaEl) poolMetaEl.textContent = `Found 1 pool • opening neighborhood…`;
        await openPool(keyForPool(only.chain, only.address));
        return;
      }
    }
    renderPoolResults(rows);
    if (poolMetaEl) poolMetaEl.textContent = `Pool search source: ${r.source || "db"}`;
  } catch (e) {
    if (poolMetaEl) poolMetaEl.textContent = `Pool search failed: ${String(e?.message || e)}`;
  } finally {
    poolSearchBtn.disabled = false;
  }
}

function renderRelatedGraphSvg({ rootName, relatedNodes }) {
  if (!relatedGraphEl) return;
  const nodes = Array.isArray(relatedNodes) ? relatedNodes.slice(0, 36) : [];
  if (!nodes.length) {
    relatedGraphEl.style.display = "none";
    relatedGraphEl.innerHTML = "";
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

  relatedGraphEl.style.display = "block";
  relatedGraphEl.innerHTML = `
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
  relatedEl.innerHTML = "";
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) {
    if (relatedEmpty) relatedEmpty.style.display = "block";
    if (relatedGraphEl) {
      relatedGraphEl.style.display = "none";
      relatedGraphEl.innerHTML = "";
    }
    return;
  }
  if (relatedEmpty) relatedEmpty.style.display = "none";

  for (const n of nodes.slice(0, 220)) {
    if (!n?.id || n.id === rootId) continue;
    const li = document.createElement("li");
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(n.name || n.id, 90)}</div>
          <div class="metric metric--muted mono-inline">${safeText(prettyId(n.id), 140)}</div>
        </div>
        <a class="btn btn--ghost" style="padding:6px 12px;font-size:12px;text-decoration:none;" href="/db.html#${encodeURIComponent(
          n.id
        )}">Open</a>
      </div>
    `;
    relatedEl.appendChild(li);
  }
}

function clear() {
  nameEl.textContent = "–";
  outUrlEl.textContent = "";
  auditorsEl.textContent = "";
  descEl.textContent = "";
  riskEl.textContent = "–";
  riskNoteEl.textContent = "";
  relatedEl.innerHTML = "";
  if (relatedEmpty) relatedEmpty.style.display = "block";
  if (relatedGraphEl) {
    relatedGraphEl.style.display = "none";
    relatedGraphEl.innerHTML = "";
  }
  rawEl.textContent = "";
  metaEl.textContent = "";
  lastProtocolKey = null;
  lastRiskAssessment = null;
  if (downloadBtn) downloadBtn.disabled = true;
  clearPoolUi();
}

async function downloadAgentReport({ url, protocolKey, riskAssessment } = {}) {
  const resp = await fetch("/api/agent/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, protocolKey, riskAssessment }),
  });
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}));
    throw new Error(json?.error || `Download failed (${resp.status})`);
  }
  const blob = await resp.blob();
  const cd = resp.headers.get("content-disposition") || "";
  const m = /filename="([^"]+)"/i.exec(cd);
  const filename = m && m[1] ? m[1] : "agent-report.html";
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dlUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(dlUrl), 1500);
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = String(urlEl.value || "").trim();
  if (!url) return;

  clear();
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  metaEl.textContent = "Analyzing protocol…";

  try {
    const analysis = await apiPost("/api/llm-analyze", {
      url,
      forceRefresh: forceEl?.checked === true,
    });

    const p = analysis?.protocol || {};
    nameEl.textContent = p.name || "Unknown";
    outUrlEl.textContent = p.url ? `URL: ${p.url}` : "";

    const firms = Array.isArray(p?.auditsVerified?.firms) ? p.auditsVerified.firms : [];
    auditorsEl.textContent = firms.length ? `Auditors: ${firms.join(", ")}` : "";
    descEl.textContent = p.description ? safeText(p.description, 700) : "";

    metaEl.textContent = `Saved to graph DB: ${analysis?.neo4j?.persisted ? "yes" : "no"} (${analysis?.neo4j?.protocolId || "—"})`;

    // Risk rubric (server-side)
    try {
      metaEl.textContent += " • Scoring risk…";
      const rubric = await apiPost("/api/risk-assessment", {
        url,
        protocolName: p.name || null,
      });
      lastRiskAssessment = rubric;
      const overall = rubric?.overallTotal;
      if (typeof overall === "number") {
        riskEl.textContent = overall.toFixed(2);
        riskNoteEl.textContent = "Rubric total (0–1, higher is safer).";
      } else {
        riskEl.textContent = "–";
        riskNoteEl.textContent = "Rubric score missing.";
      }
    } catch (err) {
      riskEl.textContent = "–";
      riskNoteEl.textContent = `Risk scoring failed: ${String(err?.message || err)}`;
    }

    // Related protocols up to 4 hops (Neo4j)
    const pid = analysis?.neo4j?.protocolId || analysis?.localGraph?.protocolId || analysis?.cache?.protocolKey || null;
    lastProtocolKey = pid;
    if (pid) {
      metaEl.textContent += " • Loading related protocols…";
      const related = await apiGet(`/api/db/related?id=${encodeURIComponent(pid)}&hops=4`);
      const relNodes = Array.isArray(related?.graph?.nodes) ? related.graph.nodes : [];
      renderRelatedGraphSvg({
        rootName: p.name || prettyId(pid),
        relatedNodes: relNodes.filter((n) => n?.id && n.id !== pid),
      });
      renderRelated(related.graph, { rootId: pid });
    }

    rawEl.textContent = JSON.stringify(analysis, null, 2);
    metaEl.textContent = "Done.";
    if (downloadBtn) downloadBtn.disabled = false;
  } catch (err) {
    metaEl.textContent = `Failed: ${String(err?.message || err)}`;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run";
  }
});

downloadBtn?.addEventListener("click", async () => {
  const url = String(urlEl.value || "").trim();
  if (!url) return;
  downloadBtn.disabled = true;
  try {
    await downloadAgentReport({ url, protocolKey: lastProtocolKey, riskAssessment: lastRiskAssessment });
  } catch (e) {
    metaEl.textContent = `Download failed: ${String(e?.message || e)}`;
  } finally {
    downloadBtn.disabled = false;
  }
});

poolSearchBtn?.addEventListener("click", doPoolSearch);
poolQEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doPoolSearch();
});

poolResultsEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-pool]");
  const key = btn?.getAttribute?.("data-pool");
  if (key) openPool(key);
});

poolRelatedEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-pool]");
  const key = btn?.getAttribute?.("data-pool");
  if (key) openPool(key);
});

clear();

