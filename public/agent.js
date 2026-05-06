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

clear();

