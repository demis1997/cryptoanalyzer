const qEl = document.getElementById("g-q");
const searchBtn = document.getElementById("g-search-btn");
const metaEl = document.getElementById("g-meta");
const resultsEl = document.getElementById("g-results");
const canvasEl = document.getElementById("g-canvas");
const emptyEl = document.getElementById("g-empty");
const detailsEl = document.getElementById("g-details");
const securityEl = document.getElementById("g-security");

const depthEl = document.getElementById("g-depth");
const chainEl = document.getElementById("g-chain");
const typeEl = document.getElementById("g-type");

const fProtocol = document.getElementById("f-protocol");
const fYield = document.getElementById("f-yield");
const fAsset = document.getElementById("f-asset");
const fContract = document.getElementById("f-contract");
const fToken = document.getElementById("f-token");

let lastGraph = null;
let lastRef = null;
let currentDepth = 2;

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeText(v, max = 120) {
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

function kindVisible(kind) {
  const k = String(kind || "");
  if (k === "protocol") return fProtocol?.checked !== false;
  if (k === "yield_pool") return fYield?.checked !== false;
  if (k === "asset") return fAsset?.checked !== false;
  if (k === "contract") return fContract?.checked !== false;
  if (k === "token") return fToken?.checked !== false;
  // other asset kinds (e.g. exposed tokens) count as asset
  if (k.startsWith("asset")) return fAsset?.checked !== false;
  return true;
}

function renderStarGraph({ ref, nodes, edges }) {
  if (!canvasEl) return;
  const nAll = Array.isArray(nodes) ? nodes : [];
  const eAll = Array.isArray(edges) ? edges : [];

  const nodesFiltered = nAll.filter((n) => kindVisible(n.kind));
  const allowed = new Set(nodesFiltered.map((n) => n.ref));
  const edgesFiltered = eAll.filter((e) => allowed.has(e.from) && allowed.has(e.to));

  const root = nodesFiltered.find((n) => n.ref === ref) || nodesFiltered[0] || null;
  if (!root) {
    canvasEl.style.display = "none";
    canvasEl.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }

  const others = nodesFiltered.filter((n) => n.ref !== root.ref).slice(0, 120);
  const width = 1800;
  const height = 860;
  const cx = Math.floor(width / 2);
  const cy = 88;

  const cols = 10;
  const colW = Math.floor(width / cols);
  const padX = 16;
  const padY = 220;

  const pts = others.map((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      ref: n.ref,
      kind: n.kind,
      label: String(n.label || n.ref).slice(0, 20),
      x: padX + c * colW + Math.floor(colW / 2),
      y: padY + r * 66,
    };
  });

  const color = (kind) => {
    if (kind === "protocol") return "#38bdf8";
    if (kind === "yield_pool") return "#a78bfa";
    if (kind === "token") return "#34d399";
    if (kind === "contract") return "#fbbf24";
    return "#94a3b8";
  };

  const lines = pts
    .map((p) => `<line x1="${cx}" y1="${cy + 18}" x2="${p.x}" y2="${p.y - 12}" stroke="#334155" stroke-width="1" />`)
    .join("");

  const bubble = (x, y, label, kind, ref) => `
    <g data-ref="${escapeHtml(ref)}" style="cursor:pointer;">
      <rect x="${x - 82}" y="${y - 20}" width="164" height="34" rx="12" fill="#0b1220" stroke="${color(kind)}" stroke-width="1.2" />
      <text x="${x}" y="${y + 2}" text-anchor="middle" font-size="11" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(
        label
      )}</text>
    </g>`;

  canvasEl.style.display = "block";
  if (emptyEl) emptyEl.style.display = "none";
  canvasEl.innerHTML = `
    <svg width="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Risk graph">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#020617" rx="18" />
      ${bubble(cx, cy, String(root.label || root.ref).slice(0, 26), root.kind, root.ref)}
      ${lines}
      ${pts.map((p) => bubble(p.x, p.y, p.label, p.kind, p.ref)).join("")}
      <text x="${width - 16}" y="${height - 14}" text-anchor="end" font-size="10" fill="#64748b" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
        Nodes: ${nodesFiltered.length} • Edges: ${edgesFiltered.length} • Depth: ${currentDepth}
      </text>
    </svg>
  `;
}

function setQueryParam(k, v) {
  const u = new URL(window.location.href);
  if (v == null || v === "") u.searchParams.delete(k);
  else u.searchParams.set(k, String(v));
  history.replaceState(null, "", u.toString());
}

function applyFiltersFromUrl() {
  const u = new URL(window.location.href);
  const depth = Number(u.searchParams.get("depth") || u.searchParams.get("hops") || 2);
  currentDepth = Math.min(5, Math.max(1, depth || 2));
  if (depthEl) depthEl.value = String(currentDepth);
  if (chainEl) chainEl.value = String(u.searchParams.get("chain") || "");
  if (typeEl) typeEl.value = String(u.searchParams.get("type") || "");

  const protocol = u.searchParams.get("protocol");
  if (protocol && qEl) {
    qEl.value = protocol;
    // auto-run search
    setTimeout(() => doSearch(), 0);
  }
}

async function openRef(ref) {
  lastRef = ref;
  metaEl.textContent = "Loading neighborhood…";
  setQueryParam("protocol", ref);
  setQueryParam("depth", currentDepth);
  const r = await apiGet(`/api/graph/neighborhood?ref=${encodeURIComponent(ref)}&hops=${encodeURIComponent(String(currentDepth))}`);
  lastGraph = r;
  const nodes = Array.isArray(r?.graph?.nodes) ? r.graph.nodes : [];
  const edges = Array.isArray(r?.graph?.edges) ? r.graph.edges : [];

  const root = nodes.find((n) => n.ref === ref) || nodes[0];
  detailsEl.innerHTML = root
    ? `<div><b>${escapeHtml(root.label || root.ref)}</b><br/><span style="color:#94a3b8;">${escapeHtml(root.kind)} • ${escapeHtml(
        root.ref
      )}</span></div>`
    : "–";

  if (securityEl) {
    const sec = r.security || {};
    if (sec?.hacked && Array.isArray(sec.incidents) && sec.incidents.length) {
      const items = sec.incidents
        .slice(0, 5)
        .map((x) => `${escapeHtml(x.name)} <span style="color:#94a3b8;">(${escapeHtml(String(x.classification || "incident"))})</span>`)
        .join("<br/>");
      securityEl.innerHTML = `<div><b>Hacks</b>: Found ${sec.incidents.length} incident(s). Weakest link: <b>${escapeHtml(
        sec.weakestLink?.name || "unknown"
      )}</b><br/>${items}</div>`;
    } else {
      securityEl.innerHTML = `<div><b>Hacks</b>: No known incidents found in this neighborhood (DefiLlama hacks DB).</div>`;
    }
  }

  renderStarGraph({ ref, nodes, edges });
  metaEl.textContent = `Loaded from ${r.source || "neo4j"} • nodes=${nodes.length} edges=${edges.length}`;
}

function renderSearchResults(rows) {
  resultsEl.innerHTML = "";
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "No results.";
    resultsEl.appendChild(li);
    return;
  }
  for (const r of list.slice(0, 25)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div>${safeText(r.label || r.ref, 90)}</div>
          <div class="metric metric--muted mono-inline">${escapeHtml(r.kind)} • ${escapeHtml(r.ref)}</div>
        </div>
        <button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-ref="${escapeHtml(r.ref)}">Open</button>
      </div>
    `;
    resultsEl.appendChild(li);
  }
}

async function doSearch() {
  const q = String(qEl.value || "").trim();
  if (!q) return;
  searchBtn.disabled = true;
  metaEl.textContent = "Searching…";
  try {
    if (/^https?:\/\//i.test(q)) {
      metaEl.textContent = "Recognizing link…";
      const rr = await apiGet(`/api/resolve?url=${encodeURIComponent(q)}`);
      if (rr?.hit && rr.ref) {
        await openRef(rr.ref);
        resultsEl.innerHTML = "";
        return;
      }
    }
    const r = await apiGet(`/api/graph/search?q=${encodeURIComponent(q)}&limit=25`);
    let rows = Array.isArray(r.results) ? r.results : [];

    // Client-side filtering by chain/type (best-effort).
    const chain = String(chainEl?.value || "").trim().toLowerCase();
    const type = String(typeEl?.value || "").trim().toLowerCase();
    if (type) rows = rows.filter((x) => String(x.kind || "").toLowerCase() === type);
    if (chain) {
      rows = rows.filter((x) => {
        const ref = String(x.ref || "").toLowerCase();
        return ref.includes(`:${chain}:`) || String(x.kind || "") === "protocol";
      });
    }

    if (rows.length === 1) {
      await openRef(rows[0].ref);
      resultsEl.innerHTML = "";
      return;
    }
    renderSearchResults(rows);
    metaEl.textContent = `Search source: ${r.source || "neo4j"}`;
  } catch (e) {
    metaEl.textContent = `Search failed: ${String(e?.message || e)}`;
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn?.addEventListener("click", doSearch);
qEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

resultsEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-ref]");
  const ref = btn?.getAttribute?.("data-ref");
  if (ref) openRef(ref);
});

canvasEl?.addEventListener("click", (e) => {
  const g = e.target?.closest?.("g[data-ref]");
  const ref = g?.getAttribute?.("data-ref");
  if (ref) openRef(ref);
});

for (const el of [fProtocol, fYield, fAsset, fContract, fToken]) {
  el?.addEventListener("change", () => {
    const nodes = Array.isArray(lastGraph?.graph?.nodes) ? lastGraph.graph.nodes : [];
    const edges = Array.isArray(lastGraph?.graph?.edges) ? lastGraph.graph.edges : [];
    if (lastRef && nodes.length) renderStarGraph({ ref: lastRef, nodes, edges });
  });
}

depthEl?.addEventListener("change", () => {
  currentDepth = Math.min(5, Math.max(1, Number(depthEl.value) || 2));
  setQueryParam("depth", currentDepth);
  if (lastRef) openRef(lastRef);
});
chainEl?.addEventListener("change", () => setQueryParam("chain", chainEl.value || ""));
typeEl?.addEventListener("change", () => setQueryParam("type", typeEl.value || ""));

applyFiltersFromUrl();

