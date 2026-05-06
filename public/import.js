const fileEl = document.getElementById("import-file");
const importBtn = document.getElementById("import-btn");
const importStatus = document.getElementById("import-status");

const docxFileEl = document.getElementById("docx-file");
const docxBtn = document.getElementById("docx-btn");
const viewDocxBtn = document.getElementById("view-docx-btn");
const docxModal = document.getElementById("docx-modal");
const docxCloseBtn = document.getElementById("docx-close-btn");
const docxRenderEl = document.getElementById("docx-render");
const docxModalMeta = document.getElementById("docx-modal-meta");

const qEl = document.getElementById("search-q");
const searchBtn = document.getElementById("search-btn");
const resultsEl = document.getElementById("search-results");

const protocolNameEl = document.getElementById("protocol-name");
const protocolUrlEl = document.getElementById("protocol-url-display");
const protocolAuditsEl = document.getElementById("protocol-audits");

const riskScoreEl = document.getElementById("risk-score");
const riskScoreNoteEl = document.getElementById("risk-score-note");
const summaryEl = document.getElementById("summary-text");
const sourcesEl = document.getElementById("sources-text");
const riskListEl = document.getElementById("risk-list");
const riskEmptyEl = document.getElementById("risk-empty");

const connectionsList = document.getElementById("connections-list");
const connectionsEmpty = document.getElementById("connections-empty");

const auditorList = document.getElementById("auditor-list");
const auditorEmpty = document.getElementById("auditor-empty");

const tokenList = document.getElementById("token-list");
const tokenEmpty = document.getElementById("token-empty");

const contractList = document.getElementById("contract-list");
const contractEmpty = document.getElementById("contract-empty");

const evidenceList = document.getElementById("evidence-list");
const evidenceEmpty = document.getElementById("evidence-empty");

function renderEvidence(notes) {
  evidenceList.innerHTML = "";
  const items = Array.isArray(notes) ? notes : [];
  if (!items.length) {
    evidenceEmpty.style.display = "block";
    return;
  }
  evidenceEmpty.style.display = "none";
  for (const n of items.slice(0, 80)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${n.label || ""}</div>
      <div class="tag">
        <span class="tag__label">Source</span>
        <span class="tag__value">${n.source || "—"}</span>
      </div>
      ${n.detail ? `<div style="margin-top:0.35rem;opacity:0.92;font-size:0.9em">${String(n.detail)}</div>` : ""}
    `;
    evidenceList.appendChild(li);
  }
}

function renderAuditors(protocol) {
  auditorList.innerHTML = "";
  const firms = Array.isArray(protocol?.auditsVerified?.firms) ? protocol.auditsVerified.firms : [];
  if (!firms.length) {
    auditorEmpty.style.display = "block";
    return;
  }
  auditorEmpty.style.display = "none";
  for (const f of firms) {
    const li = document.createElement("li");
    li.textContent = String(f);
    auditorList.appendChild(li);
  }
}

function renderTokens(items) {
  if (!tokenList || !tokenEmpty) return;
  tokenList.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    tokenEmpty.style.display = "block";
    return;
  }
  tokenEmpty.style.display = "none";
  for (const t of rows.slice(0, 120)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${t.token || t.symbol || "Token"} <span style="color:#9ca3af;">• ${t.chain || "unknown"}</span></div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">Address</span>
        <span class="tag__value">${t.tokenAddress || t.address || "—"}</span>
      </div>
    `;
    tokenList.appendChild(li);
  }
}

function renderContracts(items) {
  if (!contractList || !contractEmpty) return;
  contractList.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    contractEmpty.style.display = "block";
    return;
  }
  contractEmpty.style.display = "none";
  for (const c of rows.slice(0, 140)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${c.label || "Contract"} <span style="color:#9ca3af;">• ${c.network || c.chain || "unknown"}</span></div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">Address</span>
        <span class="tag__value">${c.address || "—"}</span>
      </div>
    `;
    contractList.appendChild(li);
  }
}

function renderConnections(connections) {
  connectionsList.innerHTML = "";
  const edges = Array.isArray(connections?.edges) ? connections.edges : [];
  const nodes = Array.isArray(connections?.nodes) ? connections.nodes : [];
  if (!edges.length || !nodes.length) {
    connectionsEmpty.style.display = "block";
    return;
  }
  connectionsEmpty.style.display = "none";

  const byKey = new Map();
  for (const n of nodes) {
    const id = String(n.id || "").toLowerCase();
    const addr = String(n.address || "").toLowerCase();
    if (id) byKey.set(id, n);
    if (addr) byKey.set(addr, n);
  }

  edges.slice(0, 180).forEach((e) => {
    const from = byKey.get(String(e.from || "").toLowerCase());
    const to = byKey.get(String(e.to || "").toLowerCase());
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${(from?.label || from?.name || e.from || "Node")} <span style="color:#9ca3af;">→</span> ${(to?.label || to?.name || e.to || "Node")}</div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">Relation</span>
        <span class="tag__value">${e.relation || "connected_to"}</span>
      </div>
      ${e.evidence ? `<div class="metric metric--muted" style="margin-top:6px;">${String(e.evidence).slice(0, 260)}</div>` : ""}
    `;
    connectionsList.appendChild(li);
  });
}

function renderProtocolMeta(data) {
  const protocol = data?.protocol || {};
  protocolNameEl.textContent = protocol.name || "Unknown protocol";
  protocolUrlEl.textContent = protocol.url || data?.origin || "—";
  const firms = Array.isArray(protocol?.auditsVerified?.firms) ? protocol.auditsVerified.firms : [];
  if (firms.length) protocolAuditsEl.textContent = `Audited by: ${firms.join(", ")}.`;
  else protocolAuditsEl.textContent = "";
}

function renderDocxExtras(data) {
  // Reset
  if (riskScoreEl) riskScoreEl.textContent = "–";
  if (riskScoreNoteEl) riskScoreNoteEl.textContent = "";
  if (summaryEl) summaryEl.textContent = "—";
  if (sourcesEl) sourcesEl.textContent = "";
  if (riskListEl) riskListEl.innerHTML = "";
  if (riskEmptyEl) riskEmptyEl.style.display = "block";

  const imported = data?.imported;
  const fields = imported?.extractedFields;
  if (!fields || typeof fields !== "object") return;

  if (riskScoreEl) riskScoreEl.textContent = fields.riskScore || "–";
  if (riskScoreNoteEl) {
    riskScoreNoteEl.textContent = imported?.filename ? `Source: ${imported.filename}` : "Source: imported DOCX";
  }

  if (summaryEl) {
    summaryEl.textContent = fields.description ? String(fields.description) : "—";
  }
  if (sourcesEl) {
    sourcesEl.textContent = fields.sources ? `Sources: ${String(fields.sources)}` : "";
  }

  const rows = Array.isArray(fields.riskOverview) ? fields.riskOverview : [];
  if (!rows.length) return;
  if (riskEmptyEl) riskEmptyEl.style.display = "none";
  for (const r of rows.slice(0, 18)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${r.area || "Risk area"}</div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">Assessment</span>
        <span class="tag__value">${r.assessment || "—"}</span>
      </div>
      <div class="metric metric--muted" style="margin-top:6px;">${r.rationale || ""}</div>
    `;
    riskListEl.appendChild(li);
  }
}

let lastDocxUrl = null;
let lastDocxFilename = null;

async function importFile() {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;
  importBtn.disabled = true;
  importStatus.textContent = "Importing…";
  try {
    const text = await f.text();
    const ext = (f.name || "").toLowerCase().endsWith(".csv") ? "csv" : "json";
    const resp = await fetch("/api/import/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: ext, text }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) throw new Error(json.error || `Import failed (${resp.status})`);
    importStatus.textContent = `Imported: ${json.imported?.map((x) => x.rootProtocol).join(", ") || "ok"}`;
  } catch (e) {
    importStatus.textContent = `Import failed: ${String(e?.message || e)}`;
  } finally {
    importBtn.disabled = false;
  }
}

async function importDocx() {
  const f = docxFileEl?.files && docxFileEl.files[0];
  if (!f) return;
  if (docxBtn) docxBtn.disabled = true;
  importStatus.textContent = "Importing DOCX…";
  try {
    const fd = new FormData();
    fd.append("file", f, f.name);
    const resp = await fetch("/api/import/docx", { method: "POST", body: fd });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) throw new Error(json.error || `DOCX import failed (${resp.status})`);
    importStatus.textContent = `Imported DOCX: ${json.name || json.id}`;
    // Auto-open after import
    if (json.id) await openProtocol(json.id);
  } catch (e) {
    importStatus.textContent = `DOCX import failed: ${String(e?.message || e)}`;
  } finally {
    if (docxBtn) docxBtn.disabled = false;
  }
}

async function viewFullDocx() {
  const url = lastDocxUrl;
  if (!url) return;
  if (!docxModal || !docxRenderEl) return;
  docxModal.style.display = "block";
  docxRenderEl.innerHTML = "";
  if (docxModalMeta) docxModalMeta.textContent = lastDocxFilename ? `Source: ${lastDocxFilename}` : url;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`DOCX fetch failed (${resp.status})`);
    const buf = await resp.arrayBuffer();
    // docx-preview exposes a global `docx` object.
    if (!window.docx || typeof window.docx.renderAsync !== "function") {
      throw new Error("docx-preview not loaded");
    }
    await window.docx.renderAsync(buf, docxRenderEl, null, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
    });
  } catch (e) {
    docxRenderEl.innerHTML = `<div style="color:#111827;">Failed to render DOCX: ${String(e?.message || e)}</div>`;
  }
}

async function doSearch() {
  const q = String(qEl.value || "").trim();
  resultsEl.innerHTML = "";
  if (!q) return;
  searchBtn.disabled = true;
  try {
    const resp = await fetch(`/api/import/search?q=${encodeURIComponent(q)}`);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) throw new Error(json.error || `Search failed (${resp.status})`);
    const results = Array.isArray(json.results) ? json.results : [];
    if (!results.length) {
      const li = document.createElement("li");
      li.textContent = "No results.";
      resultsEl.appendChild(li);
      return;
    }
    // If there’s an obvious single hit, auto-open and fill the page.
    if (results.length === 1) {
      await openProtocol(results[0].id);
      return;
    }
    for (const r of results.slice(0, 25)) {
      const li = document.createElement("li");
      const name = r.name || r.id;
      li.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
          <div>${String(name || "").slice(0, 80)}</div>
          <button class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-id="${r.id}">View</button>
        </div>
        <div class="metric metric--muted">${r.id}</div>
      `;
      resultsEl.appendChild(li);
    }
  } catch (e) {
    const li = document.createElement("li");
    li.textContent = `Search failed: ${String(e?.message || e)}`;
    resultsEl.appendChild(li);
  } finally {
    searchBtn.disabled = false;
  }
}

async function openProtocol(id) {
  if (!id) return;
  // Clear panels
  renderProtocolMeta(null);
  renderConnections(null);
  renderAuditors(null);
  renderTokens(null);
  renderContracts(null);
  renderEvidence(null);
  renderDocxExtras(null);
  importStatus.textContent = "Loading…";

  const resp = await fetch(`/api/import/protocol?id=${encodeURIComponent(id)}`);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.ok) {
    importStatus.textContent = json.error || `Load failed (${resp.status})`;
    return;
  }
  const data = json.data;
  renderProtocolMeta(data);
  renderAuditors(data.protocol);
  renderConnections(data.connections);
  renderTokens(data.tokenLiquidity);
  renderContracts(data.contracts);
  renderEvidence(data.evidenceNotes);
  renderDocxExtras(data);
  importStatus.textContent = `Loaded: ${data?.protocol?.name || id}`;

  // Enable full DOCX viewer when this protocol came from DOCX import.
  const imported = data?.imported;
  lastDocxUrl = typeof imported?.docxUrl === "string" ? imported.docxUrl : null;
  lastDocxFilename = typeof imported?.filename === "string" ? imported.filename : null;
  if (viewDocxBtn) viewDocxBtn.disabled = !lastDocxUrl;
}

importBtn?.addEventListener("click", importFile);
docxBtn?.addEventListener("click", importDocx);
viewDocxBtn?.addEventListener("click", viewFullDocx);
docxCloseBtn?.addEventListener("click", () => {
  if (docxModal) docxModal.style.display = "none";
});
docxModal?.addEventListener("click", (e) => {
  // Click outside card closes modal
  if (e.target === docxModal) docxModal.style.display = "none";
});
searchBtn?.addEventListener("click", doSearch);
qEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
resultsEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-id]");
  const id = btn?.getAttribute?.("data-id");
  if (id) openProtocol(id);
});

