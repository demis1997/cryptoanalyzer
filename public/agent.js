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

function renderRelated(graph, { rootId }) {
  relatedEl.innerHTML = "";
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) {
    if (relatedEmpty) relatedEmpty.style.display = "block";
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
          <div class="metric metric--muted mono-inline">${safeText(n.id, 140)}</div>
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
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dlUrl;
  a.download = "agent-report.html";
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

