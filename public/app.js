import {
  escapeHtml,
  formatUsd,
  severityFromScore,
  severityLabel,
  MetricCard,
  RiskScoreCard,
  RiskBreakdownBar,
  EvidenceCard,
  SkeletonGrid,
  SkeletonLines,
  ContractTableRow,
} from "./js/ui-components.js";
import { GraphPanel } from "./js/risk-graph.js";
import { initShell, setPlatformStatus, setAnalyzing, showToast, revealResults } from "./js/shell.js";

const form = document.getElementById("protocol-form");
const graphSearchForm = document.getElementById("graph-search-form");
const graphSearchQ = document.getElementById("graph-search-q");
const graphSearchResults = document.getElementById("graph-search-results");
const poolProtocolsPanel = document.getElementById("pool-protocols-panel");
const poolProtocolsMeta = document.getElementById("pool-protocols-meta");
const poolProtocolsList = document.getElementById("pool-protocols-list");
const poolUnderlyingEl = document.getElementById("pool-underlying-tokens");
const poolRiskSummaryEl = document.getElementById("pool-risk-summary");
const poolIntelBtn = document.getElementById("pool-intel-btn");
const searchModeBtns = document.querySelectorAll("[data-search-mode]");
const urlInput = document.getElementById("protocol-url");
const walletInput = document.getElementById("wallet-address");
const debankLinkWrap = document.getElementById("debank-link-wrap");
const debankLink = document.getElementById("debank-link");

const protocolNameEl = document.getElementById("protocol-name");
const protocolUrlEl = document.getElementById("protocol-url-display");
const protocolChainsEl = document.getElementById("protocol-chains");
const protocolCategoryEl = document.getElementById("protocol-category");
const protocolAuditsEl = document.getElementById("protocol-audits");
const protocolMethodologyEl = document.getElementById("protocol-methodology");
const protocolInformationEl = document.getElementById("protocol-information");

const contractTableBody = document.getElementById("contract-table-body");
const contractList = document.getElementById("contract-list");
const contractsEmpty = document.getElementById("contracts-empty");

const connectionsList = document.getElementById("connections-list");
const connectionsEmpty = document.getElementById("connections-empty");

const investorList = document.getElementById("investor-list");
const investorsEmpty = document.getElementById("investors-empty");

const tokenLiquidityList = document.getElementById("token-liquidity-list");
const tokenLiquidityEmpty = document.getElementById("token-liquidity-empty");

const riskOverall = document.getElementById("risk-overall");
const riskStatus = document.getElementById("risk-status");
const riskSections = document.getElementById("risk-sections");
const riskNotes = document.getElementById("risk-notes");

const allocationList = document.getElementById("allocation-list");
const allocationsEmpty = document.getElementById("allocations-empty");

const evidenceList = document.getElementById("evidence-list");
const evidenceEmpty = document.getElementById("evidence-empty");
const evidenceGrid = document.getElementById("evidence-grid");

const reportPdfBtn = document.getElementById("report-pdf-btn");
const reportJsonBtn = document.getElementById("report-json-btn");
const chatgptResearchBtn = document.getElementById("chatgpt-research-btn");
const exportPdfCta = document.getElementById("export-pdf-cta");
const exportJsonCta = document.getElementById("export-json-cta");
const exportChatgptCta = document.getElementById("export-chatgpt-cta");

const overallScoreEl = document.getElementById("overall-score");
const overallNotesEl = document.getElementById("overall-notes");
const heroRiskScoreEl = document.getElementById("hero-risk-score");
const overviewMetricsEl = document.getElementById("overview-metrics");
const liquidityMetricsEl = document.getElementById("liquidity-metrics");
const fundingMetricsEl = document.getElementById("funding-metrics");
const riskBreakdownEl = document.getElementById("risk-breakdown");

const landingState = document.getElementById("landing-state");
const resultsHero = document.getElementById("results-hero");
const analysisLoading = document.getElementById("analysis-loading");
const loadingMetrics = document.getElementById("loading-metrics");
const loadingLines = document.getElementById("loading-lines");

const graphDepthEl = document.getElementById("graph-depth");
const graphNodeDetail = document.getElementById("graph-node-detail");
const graphExpandBtn = document.getElementById("graph-expand-btn");

let lastAnalysis = null;
let lastRubric = null;
let shellApi = null;
let searchMode = "protocol";
let lastGraphRef = null;

const heroGraph = new GraphPanel(document.getElementById("hero-graph-panel"), {
  onSelect: (node) => {
    if (graphNodeDetail) {
      graphNodeDetail.innerHTML = `<b>${escapeHtml(node.label)}</b> · ${escapeHtml(node.kind)} · <span class="mono">${escapeHtml(node.ref || "")}</span>`;
    }
  },
});
const tabGraph = new GraphPanel(document.getElementById("tab-graph-panel"), {
  onSelect: (node) => {
    if (graphNodeDetail) {
      graphNodeDetail.innerHTML = `<b>${escapeHtml(node.label)}</b> · ${escapeHtml(node.kind)}`;
    }
  },
});
const landingGraph = new GraphPanel(document.getElementById("landing-graph"), { onSelect: () => {} });

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

function updateDebankLink() {
  const v = walletInput?.value?.trim() || "";
  if (debankLinkWrap && debankLink && isValidWalletAddress(v)) {
    debankLink.href = `https://debank.com/profile/${encodeURIComponent(v)}`;
    debankLinkWrap.style.display = "block";
    return;
  }
  if (debankLinkWrap) debankLinkWrap.style.display = "none";
}

walletInput?.addEventListener("input", updateDebankLink);
updateDebankLink();

function setSearchMode(mode) {
  searchMode = mode === "graph" ? "graph" : "protocol";
  searchModeBtns.forEach((btn) => {
    btn.classList.toggle("search-mode__btn--active", btn.dataset.searchMode === searchMode);
  });
  if (form) form.hidden = searchMode !== "protocol";
  if (graphSearchForm) graphSearchForm.hidden = searchMode !== "graph";
  if (graphSearchResults) graphSearchResults.hidden = searchMode !== "graph";
  const u = new URL(window.location.href);
  if (searchMode === "graph") u.searchParams.set("mode", "graph");
  else u.searchParams.delete("mode");
  history.replaceState(null, "", u.toString());
}

searchModeBtns.forEach((btn) => {
  btn.addEventListener("click", () => setSearchMode(btn.dataset.searchMode || "protocol"));
});

async function apiGetJson(url) {
  const resp = await fetch(url);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json?.ok === false) throw new Error(json?.error || `Request failed (${resp.status})`);
  return json;
}

function renderGraphSearchResults(rows, meta) {
  if (!graphSearchResults) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    graphSearchResults.hidden = false;
    graphSearchResults.innerHTML = `<div class="graph-search-drop__meta">${escapeHtml(meta || "No matches.")}</div>`;
    return;
  }
  graphSearchResults.hidden = false;
  graphSearchResults.innerHTML = `
    <div class="graph-search-drop__meta">${escapeHtml(meta || "")}</div>
    ${list
      .slice(0, 25)
      .map(
        (r) => `
      <div class="graph-search-drop__item">
        <div>
          <div>${escapeHtml(String(r.label || r.ref || "").slice(0, 90))}</div>
          <div class="metric metric--muted mono-inline" style="font-size:11px;">${escapeHtml(String(r.kind || ""))} · ${escapeHtml(String(r.ref || ""))}</div>
        </div>
        <button type="button" class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-graph-ref="${escapeHtml(r.ref)}">Open</button>
      </div>`
      )
      .join("")}
  `;
}

function parsePoolInput(q) {
  const s = String(q || "").trim();
  const key = s.match(/^([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/i);
  if (key) return { chain: key[1].toLowerCase(), address: key[2].toLowerCase() };
  const bare = s.match(/^(0x[a-fA-F0-9]{40})$/i);
  if (bare) return { chain: "ethereum", address: bare[1].toLowerCase() };
  const cref = s.match(/^contract:([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/i);
  if (cref) return { chain: cref[1].toLowerCase(), address: cref[2].toLowerCase() };
  return null;
}

function buildGraphFromPoolNeighborhood(r, chain, address) {
  const ref = `contract:${chain}:${address}`;
  const rootLabel = r?.root?.label || `Pool ${address.slice(0, 10)}…`;
  const nodes = [{ ref, kind: "contract", label: rootLabel }];
  const edges = [];
  const seen = new Set([ref]);

  for (const p of Array.isArray(r?.protocols) ? r.protocols : []) {
    const pid = String(p?.id || "").trim();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    nodes.push({ ref: pid, kind: "protocol", label: p.name || pid });
    edges.push({ from: ref, to: pid, relation: p.link === "yields" ? "yields_listing" : "ecosystem" });
  }
  for (const c of Array.isArray(r?.pools) ? r.pools : []) {
    const pk = `contract:${c.chain || chain}:${c.address}`;
    if (!c?.address || seen.has(pk) || pk === ref) continue;
    seen.add(pk);
    nodes.push({ ref: pk, kind: "contract", label: c.label || "Related pool" });
    edges.push({ from: ref, to: pk, relation: "related_pool" });
  }
  return { ref, nodes, edges };
}

function formatPoolSaveStatus(persisted) {
  if (!persisted) return "";
  const saved = [];
  if (persisted.local) saved.push("SQLite");
  if (persisted.neo4j) saved.push("Neo4j");
  if (!saved.length && !(persisted.errors || []).length) return "";
  let text = saved.length ? `Saved: ${saved.join(" + ")}` : "Saved locally (SQLite)";
  const err = (persisted.errors || [])[0];
  if (err && !persisted.neo4j) {
    text += ` · ${err}`;
  }
  return text;
}

function renderPoolProtocolsPanel(r, contextLabel) {
  if (!poolProtocolsPanel || !poolProtocolsList) return;
  const issuer = Array.isArray(r?.issuer)
    ? r.issuer
    : (r?.protocols || r?.integrators || []).filter((p) => p.tier === "issuer" || p.tier === "primary");
  const using = Array.isArray(r?.usingProtocols)
    ? r.usingProtocols
    : (r?.protocols || r?.integrators || []).filter((p) => p.tier === "integrator");
  const related = Array.isArray(r?.related) ? r.related : [];
  const total = issuer.length + using.length + related.length;
  if (!total) {
    poolProtocolsPanel.hidden = true;
    poolProtocolsList.innerHTML = "";
    return;
  }
  poolProtocolsPanel.hidden = false;
  if (poolProtocolsMeta) {
    const webSrc = r?.webResearch?.enabled
      ? ` · ${(r.webResearch.providers || []).join(" + ") || "web"}${r.webResearch.crawl?.pages?.length ? ` · ${r.webResearch.crawl.pages.length} page(s) crawled` : ""}`
      : "";
    poolProtocolsMeta.textContent = `${contextLabel} — ${issuer.length} issuer · ${using.length} integrator(s) (DefiLlama + web search + LLM)${webSrc}.`;
  }
  if (poolUnderlyingEl && Array.isArray(r?.underlyingTokens) && r.underlyingTokens.length) {
    poolUnderlyingEl.innerHTML = `<b>Underlying tokens:</b> ${r.underlyingTokens
      .map((t) => `<span class="mono">${escapeHtml(t.symbol || "")}</span> ${escapeHtml(t.chain)}:${escapeHtml(String(t.address).slice(0, 10))}…`)
      .join(" · ")}`;
  } else if (poolUnderlyingEl) {
    poolUnderlyingEl.innerHTML = "";
  }
  if (poolRiskSummaryEl && r?.risk?.pool) {
    const sc = Math.round((r.risk.pool.overallTotal || 0) * 100);
    poolRiskSummaryEl.style.display = "block";
    poolRiskSummaryEl.innerHTML = `
      <div><b>Pool risk score (heuristic):</b> ${sc}/100</div>
      <div class="metric metric--muted" style="margin-top:6px;font-size:12px;">${escapeHtml((r.risk.pool.notes || []).join(" "))}</div>
      <div class="metric metric--muted" style="margin-top:4px;font-size:12px;">${formatPoolSaveStatus(r.persisted)}</div>
    `;
  } else if (poolRiskSummaryEl) {
    poolRiskSummaryEl.style.display = "none";
  }
  const row = (p, extra = "") => `
    <li class="pool-protocols-panel__item">
      <div>
        <div>${escapeHtml(String(p.name || p.id).slice(0, 80))}${extra}</div>
        <div class="metric metric--muted mono-inline" style="font-size:11px;">${escapeHtml(p.id)} · ${escapeHtml(p.link || "yields")}${p.relationship ? ` · ${escapeHtml(p.relationship)}` : ""}${p.confidence ? ` · ${escapeHtml(p.confidence)}` : ""}${typeof p.overallTotal === "number" ? ` · risk ${Math.round(p.overallTotal * 100)}` : p.totalTvlUsd ? ` · TVL $${Math.round(p.totalTvlUsd).toLocaleString()}` : ""}</div>
      </div>
      <button type="button" class="btn btn--ghost" style="padding:6px 12px;font-size:12px;" data-open-protocol="${escapeHtml(p.id)}">Open graph</button>
    </li>`;
  const perRisk = Object.fromEntries((r?.risk?.perProtocol || []).map((x) => [x.id, x.overallTotal]));
  const withRisk = (p) => ({ ...p, overallTotal: perRisk[p.id] });
  poolProtocolsList.innerHTML =
    (issuer.length
      ? `<li class="metric metric--muted" style="list-style:none;padding:4px 0 8px;font-size:12px;">Pool issuer</li>${issuer.map((p) => row(withRisk(p))).join("")}`
      : "") +
    (using.length
      ? `<li class="metric metric--muted" style="list-style:none;padding:12px 0 8px;font-size:12px;">Protocols using same underlying / exposure (DefiLlama)</li>${using.slice(0, 40).map((p) => row(withRisk(p))).join("")}`
      : "") +
    (related.length
      ? `<li class="metric metric--muted" style="list-style:none;padding:12px 0 8px;font-size:12px;">Extended token-linked</li>${related.map((p) => row(p)).join("")}`
      : "");
}

async function runPoolIntelligenceFromQuery() {
  const q = String(graphSearchQ?.value || "").trim();
  if (!q) return;
  setSearchMode("graph");
  setPlatformStatus("Running pool intelligence (DefiLlama discovery + risk + graph save)…");
  shellApi?.setTab("graph");
  setViewMode("landing");
  if (resultsHero) resultsHero.hidden = true;
  if (graphSearchResults) graphSearchResults.hidden = true;
  if (poolIntelBtn) poolIntelBtn.disabled = true;
  try {
    const body = /^https?:\/\//i.test(q) ? { url: q, query: q } : { query: q };
    const r = await fetch("/api/pool/intelligence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, persist: true }),
    });
    const data = await r.json();
    if (!r.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${r.status})`);
    const label = data.label || q;
    renderPoolProtocolsPanel(
      {
        issuer: data.issuer,
        usingProtocols: data.usingProtocols,
        integrators: data.integrators,
        underlyingTokens: data.underlyingTokens,
        risk: data.risk,
        persisted: data.persisted,
        webResearch: data.webResearch,
      },
      label
    );
    const graph = data.graph || { ref: data.poolRef, nodes: [], edges: [] };
    const displayGraph = {
      ref: graph.ref,
      nodes: (graph.nodes || []).slice(0, 32),
      edges: (graph.edges || []).filter(
        (e) =>
          (graph.nodes || []).slice(0, 32).some((n) => n.ref === e.from) &&
          (graph.nodes || []).slice(0, 32).some((n) => n.ref === e.to)
      ),
    };
    tabGraph.setDepth(3);
    tabGraph.render(displayGraph.nodes.length ? displayGraph : { ref: "pool", nodes: [{ ref: "pool", kind: "yield_pool", label }], edges: [] });
    landingGraph.render(displayGraph.nodes.length ? displayGraph : { ref: "pool", nodes: [{ ref: "pool", kind: "yield_pool", label }], edges: [] });
    setPlatformStatus(
      `Pool intelligence complete — ${(data.usingProtocols || []).length} integrator protocol(s), ${(data.underlyingTokens || []).length} underlying token(s).`,
      "success"
    );
  } catch (e) {
    setPlatformStatus(String(e?.message || e), "error");
    showToast(String(e?.message || e), "error");
  } finally {
    if (poolIntelBtn) poolIntelBtn.disabled = false;
  }
}

poolIntelBtn?.addEventListener("click", () => runPoolIntelligenceFromQuery());

function buildGraphFromYieldsMarket(r, label) {
  const ref = `market:${String(label || "pool").slice(0, 48)}`;
  const nodes = [{ ref, kind: "yield_pool", label: String(label || "Pool market").slice(0, 28) }];
  const edges = [];
  const seen = new Set([ref]);
  const issuer = Array.isArray(r?.issuer)
    ? r.issuer
    : (r?.integrators || r?.protocols || []).filter((p) => p.tier === "issuer");
  const using = Array.isArray(r?.usingProtocols)
    ? r.usingProtocols
    : (r?.integrators || []).filter((p) => p.tier === "integrator");
  const primary = Array.isArray(r?.primary)
    ? r.primary
    : (r?.protocols || []).filter((p) => p.tier !== "related" && p.link !== "underlying_token");
  const addProtocol = (p, relation, limit = 20) => {
    const pid = String(p?.id || "").trim();
    if (!pid || seen.has(pid) || nodes.length >= limit) return;
    seen.add(pid);
    nodes.push({ ref: pid, kind: "protocol", label: String(p.name || pid).replace(/^defillama:/i, "").slice(0, 22) });
    edges.push({ from: ref, to: pid, relation: p.link || relation });
  };
  for (const p of issuer.slice(0, 4)) addProtocol(p, "pool_issuer", 24);
  for (const p of using.slice(0, 16)) addProtocol(p, "integrator", 24);
  if (nodes.length <= 1) {
    for (const p of primary.slice(0, 12)) addProtocol(p, "pool_issuer", 24);
  }
  for (const t of (r?.underlyingTokens || []).slice(0, 6)) {
    const addr = String(t?.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr) || seen.has(addr)) continue;
    const ch = String(t?.chain || "ethereum").toLowerCase();
    const tk = `token:${ch}:${addr}`;
    seen.add(tk);
    nodes.push({ ref: tk, kind: "token", label: t.symbol || addr.slice(0, 10) });
    edges.push({ from: ref, to: tk, relation: "underlying" });
  }
  return { ref, nodes, edges };
}

async function openPoolDiscoverResult(r, label) {
  const hasIntegrators = (r?.usingProtocols || []).length || (r?.integrators || []).length;
  if (!r?.hit && !(r?.protocols || []).length && !hasIntegrators) {
    setPlatformStatus("No pool market found on DefiLlama for this URL. Try a vault link with 0x… or Run pool intelligence.", "error");
    renderPoolProtocolsPanel({ protocols: [] }, label);
    tabGraph.renderDemo();
    return;
  }
  const graph = buildGraphFromYieldsMarket(r, label);
  tabGraph.setDepth(Number(graphDepthEl?.value || 3) || 3);
  tabGraph.render(graph);
  landingGraph.render(graph);
  renderPoolProtocolsPanel(
    {
      issuer: r.issuer,
      usingProtocols: r.usingProtocols,
      integrators: r.integrators,
      underlyingTokens: r.underlyingTokens,
      risk: r.risk,
      protocols: r.protocols,
      webResearch: r.webResearch,
    },
    label
  );
  const usingN = (r.usingProtocols || []).length;
  const issuerN = (r.issuer || []).length;
  if (graphNodeDetail) {
    graphNodeDetail.innerHTML = `<b>${escapeHtml(label)}</b> · ${escapeHtml(r.source || "DefiLlama")} · <b>${issuerN}</b> issuer · <b>${usingN}</b> integrator(s)`;
  }
  setPlatformStatus(
    `Pool search — ${issuerN} issuer, ${usingN} protocol(s) using this pool${usingN < 2 ? " (try Run pool intelligence for LLM + DB save)" : ""}.`,
    "success"
  );
}

async function openPoolByWebsiteUrl(url) {
  setSearchMode("graph");
  setPlatformStatus("Discovering pool from website (DefiLlama live)…");
  shellApi?.setTab("graph");
  setViewMode("landing");
  if (resultsHero) resultsHero.hidden = true;
  if (graphSearchResults) graphSearchResults.hidden = true;
  try {
    const r = await apiGetJson(`/api/pool/discover-url?url=${encodeURIComponent(url)}`);
    const label = r.marketLabel || url;
    await openPoolDiscoverResult(r, label);
  } catch (e) {
    setPlatformStatus(String(e?.message || e), "error");
    showToast(String(e?.message || e), "error");
  }
}

async function openPoolByYieldsMarket(project, symbolHint) {
  setSearchMode("graph");
  shellApi?.setTab("graph");
  setViewMode("landing");
  if (resultsHero) resultsHero.hidden = true;
  if (graphSearchResults) graphSearchResults.hidden = true;
  try {
    const r = await apiGetJson(
      `/api/pool/yields-market?project=${encodeURIComponent(project)}&symbol=${encodeURIComponent(symbolHint || "")}`
    );
    await openPoolDiscoverResult(r, r.marketLabel || `${project} ${symbolHint}`.trim());
  } catch (e) {
    setPlatformStatus(String(e?.message || e), "error");
    showToast(String(e?.message || e), "error");
  }
}

async function openPoolByAddress(chain, address) {
  const ch = String(chain || "ethereum").toLowerCase();
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    showToast("Invalid pool address", "error");
    return;
  }
  setSearchMode("graph");
  setPlatformStatus("Loading protocols that use this pool…");
  shellApi?.setTab("graph");
  setViewMode("landing");
  if (resultsHero) resultsHero.hidden = true;
  if (graphSearchResults) graphSearchResults.hidden = true;

  try {
    const r = await apiGetJson(
      `/api/db/pool/neighborhood?chain=${encodeURIComponent(ch)}&address=${encodeURIComponent(addr)}&hops=4`
    );
    if (!r.hit && !(Array.isArray(r.protocols) && r.protocols.length)) {
      setPlatformStatus("No protocols found for this pool. Try Run intelligence on the vault protocol site first.", "error");
      renderPoolProtocolsPanel({ protocols: [] }, `${ch}:${addr.slice(0, 10)}…`);
      tabGraph.renderDemo();
      return;
    }
    const hops = Number(graphDepthEl?.value || 4) || 4;
    const graph = buildGraphFromPoolNeighborhood(r, ch, addr);
    tabGraph.setDepth(hops);
    tabGraph.render(graph);
    landingGraph.render(graph);
    renderPoolProtocolsPanel(r, `${ch}:${addr.slice(0, 10)}…`);
    if (graphNodeDetail) {
      graphNodeDetail.innerHTML = `<b>${escapeHtml(r.root?.label || "Pool")}</b> · contract · <span class="mono">${escapeHtml(ch)}:${escapeHtml(addr)}</span> — <b>${(r.protocols || []).length}</b> protocol(s)`;
    }
    const sec = r.security || {};
    const secNote =
      sec?.hacked && sec.incidents?.length
        ? ` Security: ${sec.incidents.length} hack(s) in related protocols.`
        : "";
    setPlatformStatus(`Pool loaded — ${(r.protocols || []).length} protocol(s), ${(r.pools || []).length} related pool(s).${secNote}`, "success");
  } catch (e) {
    setPlatformStatus(String(e?.message || e), "error");
    showToast(String(e?.message || e), "error");
  }
}

poolProtocolsList?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-open-protocol]");
  const id = btn?.getAttribute?.("data-open-protocol");
  if (id) openGraphRef(id);
});

function graphFromRelatedApi(related, rootRef) {
  const rawNodes = Array.isArray(related?.graph?.nodes) ? related.graph.nodes : [];
  const nodes = rawNodes.map((n) => ({
    ref: n.id || n.ref,
    kind: "protocol",
    label: n.name || n.id || rootRef,
  }));
  if (rootRef && !nodes.some((n) => n.ref === rootRef)) {
    nodes.unshift({
      ref: rootRef,
      kind: "protocol",
      label: rootRef.replace(/^defillama:/i, "").replace(/^protocol:/i, ""),
    });
  }
  const edges = (Array.isArray(related?.graph?.edges) ? related.graph.edges : [])
    .filter((e) => e?.from && e?.to)
    .map((e) => ({ from: e.from, to: e.to, relation: e.relation || "linked" }));
  return { ref: rootRef, nodes, edges };
}

async function openGraphRef(ref) {
  const hops = Number(graphDepthEl?.value || 3) || 3;
  lastGraphRef = ref;
  setPlatformStatus("Loading protocol graph…");
  shellApi?.setTab("graph");
  setViewMode("landing");
  if (resultsHero) resultsHero.hidden = true;
  if (graphSearchResults) graphSearchResults.hidden = true;

  const renderGraph = (graph, statusMsg) => {
    tabGraph.setDepth(hops);
    tabGraph.render(graph);
    landingGraph.render(graph);
    if (graphNodeDetail) {
      const root = graph.nodes.find((n) => n.ref === ref) || graph.nodes[0];
      graphNodeDetail.innerHTML = `<b>${escapeHtml(root?.label || ref)}</b> · ${escapeHtml(root?.kind || "protocol")} · <span class="mono">${escapeHtml(ref)}</span>`;
    }
    setPlatformStatus(statusMsg, "success");
  };

  try {
    const r = await apiGetJson(`/api/graph/neighborhood?ref=${encodeURIComponent(ref)}&hops=${encodeURIComponent(String(hops))}`);
    const graph = {
      ref,
      nodes: Array.isArray(r?.graph?.nodes) ? r.graph.nodes : [],
      edges: Array.isArray(r?.graph?.edges) ? r.graph.edges : [],
    };
    if (graph.nodes.length) {
      renderGraph(graph, `Graph loaded (${graph.nodes.length} nodes, ${graph.edges.length} edges).`);
      return;
    }
  } catch {
    // fall through to related-protocol API
  }

  if (ref.startsWith("defillama:") || ref.startsWith("protocol:") || ref.startsWith("url:")) {
    try {
      const related = await apiGetJson(`/api/db/related?id=${encodeURIComponent(ref)}&hops=${encodeURIComponent(String(hops))}`);
      const graph = graphFromRelatedApi(related, ref);
      if (graph.nodes.length > 1 || graph.edges.length) {
        const note = related.neo4jError ? " (Neo4j DB name may be wrong in .env)" : "";
        renderGraph(graph, `Related protocols graph — ${graph.nodes.length} nodes${note}.`);
        if (related.neo4jError) showToast(related.neo4jError, "error");
        return;
      }
    } catch (e) {
      showToast(String(e?.message || e), "error");
    }
  }

  const label = ref.replace(/^defillama:/i, "").replace(/^protocol:/i, "");
  renderGraph(
    { ref, nodes: [{ ref, kind: "protocol", label }], edges: [] },
    "Graph preview only — Neo4j save unavailable. Pool data is still in SQLite."
  );
  showToast("Neo4j graph unavailable. Check NEO4J_USER=neo4j and your Aura password in .env.", "error");
}

async function runGraphSearch() {
  const q = String(graphSearchQ?.value || "").trim();
  if (!q) return;
  setSearchMode("graph");
  setPlatformStatus("Searching graph database…");
  try {
    const directPool = parsePoolInput(q);
    if (directPool) {
      await openPoolByAddress(directPool.chain, directPool.address);
      return;
    }

    if (/^https?:\/\//i.test(q)) {
      const rr = await apiGetJson(`/api/resolve?url=${encodeURIComponent(q)}`).catch(() => ({ hit: false }));
      if (rr?.kind === "pool_website" && rr.url) {
        await openPoolByWebsiteUrl(rr.url);
        return;
      }
      if (rr?.hit) {
        if (rr.kind === "yields_market" && rr.project) {
          await openPoolByYieldsMarket(rr.project, rr.symbolHint || "");
          return;
        }
        if (rr.kind === "pool" && rr.poolKey) {
          const [ch, addr] = String(rr.poolKey).split(":");
          if (ch && addr) {
            await openPoolByAddress(ch, addr);
            return;
          }
        }
        if (rr.ref?.startsWith("contract:")) {
          const m = rr.ref.match(/^contract:([^:]+):(0x[a-f0-9]{40})$/i);
          if (m) {
            await openPoolByAddress(m[1].toLowerCase(), m[2].toLowerCase());
            return;
          }
        }
        if (rr.kind === "protocol" && rr.protocolHint) {
          const slug = String(rr.protocolHint).replace(/^defillama:/i, "");
          await openPoolByYieldsMarket(slug, "");
          return;
        }
        if (rr.ref) {
          await openGraphRef(rr.ref);
          return;
        }
      }
      await openPoolByWebsiteUrl(q);
      return;
    }
    const r = await apiGetJson(`/api/graph/search?q=${encodeURIComponent(q)}&limit=25`);
    const rows = Array.isArray(r.results) ? r.results : [];
    if (rows.length === 1 && rows[0]?.ref) {
      const only = rows[0];
      if (only.ref?.startsWith("contract:") || only.kind === "contract") {
        const m = String(only.ref).match(/^contract:([^:]+):(0x[a-f0-9]{40})$/i);
        if (m) {
          await openPoolByAddress(m[1].toLowerCase(), m[2].toLowerCase());
          return;
        }
      }
      await openGraphRef(only.ref);
      return;
    }
    renderGraphSearchResults(rows, `Source: ${r.source || "neo4j"} · ${rows.length} result(s)`);
    setPlatformStatus(rows.length ? "Select a result to open its neighborhood graph." : "No graph matches. Try Protocol database or run ingest jobs.", "error");
  } catch (e) {
    renderGraphSearchResults([], `Search failed: ${String(e?.message || e)}`);
    setPlatformStatus(String(e?.message || e), "error");
  }
}

graphSearchForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  runGraphSearch();
});

graphSearchResults?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-graph-ref]");
  const ref = btn?.getAttribute?.("data-graph-ref");
  if (!ref) return;
  const m = ref.match(/^contract:([^:]+):(0x[a-f0-9]{40})$/i);
  if (m) openPoolByAddress(m[1].toLowerCase(), m[2].toLowerCase());
  else openGraphRef(ref);
});

function setViewMode(mode) {
  if (landingState) landingState.hidden = mode !== "landing";
  if (analysisLoading) analysisLoading.hidden = mode !== "loading";
  if (resultsHero) resultsHero.hidden = mode !== "results";
}

function setExportEnabled(on) {
  [reportPdfBtn, reportJsonBtn, chatgptResearchBtn, exportPdfCta, exportJsonCta, exportChatgptCta].forEach((el) => {
    if (el) el.disabled = !on;
  });
}

function inferCategory(data) {
  const chains = data?.chainsSupported || data?.protocol?.chains || [];
  const name = String(data?.protocol?.name || "").toLowerCase();
  if (/bridge|portal/i.test(name)) return "Bridge";
  if (/lend|borrow|aave|compound/i.test(name)) return "Lending";
  if (/dex|swap|amm|uniswap/i.test(name)) return "DEX";
  if (/yield|vault|pendle|morpho/i.test(name)) return "Yield";
  if (Array.isArray(chains) && chains.length > 3) return "Multi-chain";
  return "DeFi Protocol";
}

function buildRiskDimensions(analysis, rubric) {
  const a = analysis || {};
  const overall = typeof rubric?.overallTotal === "number" ? rubric.overallTotal : 0.52;
  const sections = Array.isArray(rubric?.sectionTotals) ? rubric.sectionTotals : [];
  const byId = Object.fromEntries(sections.map((s) => [s.sectionId, s.score]));

  const auditCount = a?.protocol?.auditsVerified?.count ?? a?.protocol?.audits;
  const auditScore =
    typeof byId.audits === "number"
      ? byId.audits
      : Number.isFinite(auditCount) && auditCount > 0
        ? Math.min(1, 0.55 + auditCount * 0.12)
        : 0.35;

  const tvl = a?.tvl?.valueUsd;
  const liqScore =
    typeof byId.liquidity === "number"
      ? byId.liquidity
      : typeof tvl === "number" && tvl > 10_000_000
        ? 0.78
        : typeof tvl === "number" && tvl > 0
          ? 0.55
          : 0.4;

  const edges = Array.isArray(a?.connections?.edges) ? a.connections.edges : [];
  const hasBridge = edges.some((e) => /bridge|wrap|custody/i.test(String(e.relation || "")));
  const hasOracle = edges.some((e) => /oracle|price|feed/i.test(String(e.relation || "")));

  return [
    { id: "smart_contract", label: "Smart contract security", score: auditScore, note: "Audit coverage & verification" },
    { id: "liquidity", label: "Liquidity & TVL depth", score: liqScore, note: "Market depth and exit liquidity" },
    { id: "governance", label: "Governance & admin keys", score: Math.max(0.35, overall - 0.08), note: "Upgradeability & timelock assumptions" },
    { id: "oracle", label: "Oracle dependency", score: hasOracle ? 0.48 : 0.62, note: hasOracle ? "External price feeds detected" : "Limited oracle exposure in graph" },
    { id: "bridge", label: "Bridge & custody path", score: hasBridge ? 0.42 : 0.68, note: hasBridge ? "Bridge/custody edges present" : "No bridge edges in current graph" },
    { id: "exploit", label: "Exploit history", score: 0.58, note: "Cross-referenced with DefiLlama incidents DB" },
    { id: "centralization", label: "Centralization risk", score: Math.max(0.38, 1 - overall * 0.35), note: "Issuer/custodian concentration heuristic" },
  ];
}

function renderRiskBreakdown(analysis, rubric) {
  if (!riskBreakdownEl) return;
  const dims = buildRiskDimensions(analysis, rubric);
  riskBreakdownEl.innerHTML = dims.map((d) => RiskBreakdownBar(d)).join("");
}

function renderHeroRiskScore(rubric) {
  if (!heroRiskScoreEl) return;
  const overall = typeof rubric?.overallTotal === "number" ? rubric.overallTotal : null;
  const level = severityFromScore(overall);
  heroRiskScoreEl.innerHTML = RiskScoreCard({
    title: "Composite risk score",
    score: overall,
    level,
    subtitle: overall != null ? "Higher score indicates stronger institutional risk posture (0–100)." : "Run intelligence to compute rubric.",
  });
}

function renderOverviewMetrics(data) {
  if (!overviewMetricsEl) return;
  const tvl = data?.tvl?.valueUsd;
  const vol = data?.tvl?.valueUsd != null ? data?.txsPerDay?.value : null;
  const raised = data?.protocol?.totalRaisedUsd;
  const contracts = Array.isArray(data?.contracts) ? data.contracts.length : 0;
  overviewMetricsEl.innerHTML = [
    MetricCard({ label: "Total value locked", value: formatUsd(tvl), delta: "DefiLlama / on-chain", tone: "accent" }),
    MetricCard({ label: "24h volume", value: formatUsd(vol), delta: "Native token volume proxy" }),
    MetricCard({ label: "Total raised", value: formatUsd(raised), delta: "Public funding data" }),
    MetricCard({ label: "Indexed contracts", value: contracts ? String(contracts) : "—", delta: "Verified deployments" }),
  ].join("");
}

function renderLiquidityMetrics(data) {
  if (!liquidityMetricsEl) return;
  const tvl = data?.tvl?.valueUsd;
  const vol = data?.txsPerDay?.value;
  liquidityMetricsEl.innerHTML = [
    MetricCard({ label: "TVL", value: formatUsd(tvl), tone: "accent" }),
    MetricCard({ label: "24h native volume", value: formatUsd(vol) }),
    MetricCard({
      label: "Liquidity tokens",
      value: String(Array.isArray(data?.tokenLiquidity) ? data.tokenLiquidity.length : 0),
      delta: "Tracked assets",
    }),
  ].join("");
}

function renderFundingMetrics(data) {
  if (!fundingMetricsEl) return;
  const raised = data?.protocol?.totalRaisedUsd;
  fundingMetricsEl.innerHTML = MetricCard({
    label: "Total capital raised",
    value: formatUsd(raised),
    delta: "DefiLlama raises index",
    tone: "accent",
  });
}

function renderGraphFromAnalysis(data) {
  const depth = Number(graphDepthEl?.value || 3);
  const graph = GraphPanel.fromConnections(data?.connections, data?.protocol?.name || "Protocol");
  if (graph && graph.nodes.length) {
    heroGraph.setDepth(depth);
    tabGraph.setDepth(depth);
    heroGraph.render(graph);
    tabGraph.render(graph);
    return graph;
  }
  heroGraph.renderDemo();
  tabGraph.renderDemo();
  return null;
}

function renderContracts(contracts) {
  const list = Array.isArray(contracts) ? contracts : [];
  const hasAudits = lastAnalysis?.protocol?.auditsVerified?.firms?.length > 0;

  if (contractTableBody) {
    contractTableBody.innerHTML = "";
    if (!list.length) {
      contractsEmpty.style.display = "block";
      return;
    }
    contractsEmpty.style.display = "none";
    contractTableBody.innerHTML = list
      .slice(0, 200)
      .map((c) =>
        ContractTableRow({
          label: c.label,
          network: c.network,
          address: c.address,
          auditStatus: hasAudits ? "verified" : "unknown",
          evidence: c.evidence,
        })
      )
      .join("");
  }

  if (contractList) {
    contractList.innerHTML = "";
    list.slice(0, 50).forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML = `<div>${escapeHtml(c.label)} <span class="muted">• ${escapeHtml(c.network)}</span></div>
        <div class="tag"><span class="tag__label">Address</span><span class="tag__value">${escapeHtml(c.address)}</span></div>`;
      contractList.appendChild(li);
    });
  }
}

function renderConnections(connections) {
  if (!connectionsList || !connectionsEmpty) return;
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
  const fmt = (raw, n) => {
    const a = n?.address || raw;
    if (a && /^0x[a-f0-9]{40}$/i.test(String(a))) return `${String(a).slice(0, 10)}…${String(a).slice(-8)}`;
    return raw ? String(raw).slice(0, 42) : "—";
  };

  edges.slice(0, 80).forEach((e) => {
    const from = byKey.get(String(e.from || "").toLowerCase());
    const to = byKey.get(String(e.to || "").toLowerCase());
    const li = document.createElement("li");
    li.innerHTML = `<div><strong>${escapeHtml(from?.label || "Node")}</strong> → ${escapeHtml(to?.label || "Node")}</div>
      <div class="muted">${escapeHtml(e.relation || "connected")} · ${escapeHtml(fmt(e.from, from))} → ${escapeHtml(fmt(e.to, to))}</div>`;
    connectionsList.appendChild(li);
  });
}

function renderTotalRaised(data) {
  investorList.innerHTML = "";
  const raised = data?.protocol?.totalRaisedUsd;
  if (!Number.isFinite(raised) || raised <= 0) {
    investorsEmpty.style.display = "block";
    return;
  }
  investorsEmpty.style.display = "none";
  const li = document.createElement("li");
  li.innerHTML = `<div>Disclosed capital raised</div><div class="tag"><span class="tag__label">Amount</span><span class="tag__value">${formatUsd(raised)}</span></div>`;
  investorList.appendChild(li);
}

function renderProtocolMeta(data) {
  const protocol = data?.protocol || {};
  protocolNameEl.textContent = protocol.name || "Unknown protocol";
  protocolUrlEl.innerHTML = protocol.url
    ? `<a href="${escapeHtml(protocol.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(protocol.url)}</a>`
    : escapeHtml(data?.origin || "—");

  const chains = data?.chainsSupported || protocol?.chains || [];
  if (protocolChainsEl) {
    protocolChainsEl.textContent = Array.isArray(chains) && chains.length ? chains.join(" · ") : "Multi-chain";
  }
  if (protocolCategoryEl) protocolCategoryEl.textContent = inferCategory(data);

  if (protocolAuditsEl) {
    const firms = Array.isArray(protocol?.auditsVerified?.firms) ? protocol.auditsVerified.firms : [];
    protocolAuditsEl.textContent = firms.length
      ? `Audit firms: ${firms.join(", ")}`
      : Number.isFinite(protocol?.audits)
        ? `Index audit count: ${protocol.audits}`
        : "";
  }

  const llmMeta = document.getElementById("llm-enrich-meta");
  if (llmMeta) {
    const g = data?.localGraph;
    const le = data?.llmEnrich;
    const parts = [];
    if (g?.persisted) parts.push(`Graph persisted (${g.protocolId || "ok"}).`);
    if (le?.enabled && le.hostedPipelineRan) {
      parts.push(`AI enrichment: ${le.auditors ?? 0} auditors, ${le.graphEdges ?? 0} graph edges.`);
    } else if (le?.enabled === false && le?.source === "local_graph") {
      parts.push("Served from cache — enable full refresh for live crawl.");
    }
    llmMeta.textContent = parts.join(" ");
  }

  if (protocolMethodologyEl) {
    const text = protocol?.methodology || "";
    protocolMethodologyEl.textContent = text ? `Methodology: ${text.slice(0, 140)}…` : "";
  }

  if (protocolInformationEl) {
    const text = protocol?.description || "";
    protocolInformationEl.textContent = text ? text.slice(0, 320) + (text.length > 320 ? "…" : "") : "No protocol description indexed.";
  }
}

function renderTokenLiquidity(items) {
  tokenLiquidityList.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    tokenLiquidityEmpty.style.display = "block";
    return;
  }
  tokenLiquidityEmpty.style.display = "none";
  items.forEach((t) => {
    const li = document.createElement("li");
    const liq = typeof t.liquidityUsd === "number" ? formatUsd(t.liquidityUsd) : t.liquidityLabel || "—";
    li.innerHTML = `<div>${escapeHtml(t.token || t.asset || "Token")}</div>
      <div class="tag"><span class="tag__label">Liquidity</span><span class="tag__value">${escapeHtml(liq)}</span></div>`;
    tokenLiquidityList.appendChild(li);
  });
}

function renderLlmRisk(data) {
  const risk = data?.risk;
  if (!risk) {
    riskOverall.textContent = "—";
    riskStatus.textContent = "Qualitative web risk not returned.";
    return;
  }
  riskOverall.textContent = (risk.level || "unknown").toUpperCase();
  riskStatus.textContent = risk.summary || "";
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function scoreToLevel(score) {
  return severityFromScore(score);
}

function renderRubricAssessment(assessment) {
  const overall = typeof assessment?.overallTotal === "number" ? clamp01(assessment.overallTotal) : null;
  if (overall == null) {
    riskOverall.textContent = "—";
    riskStatus.textContent = "Rubric pending.";
    overallScoreEl.textContent = "—";
    overallNotesEl.textContent = "Complete intelligence run to score.";
    renderHeroRiskScore(null);
    renderRiskBreakdown(lastAnalysis, null);
    return;
  }

  const level = scoreToLevel(overall);
  riskOverall.textContent = severityLabel(level).toUpperCase();
  riskStatus.textContent = `Composite rubric: ${(overall * 100).toFixed(0)} / 100`;
  overallScoreEl.textContent = `${(overall * 100).toFixed(0)}`;
  overallNotesEl.textContent = "WWDA-style heuristic rubric (enable ENABLE_LLM_RISK for full LLM scoring).";

  riskSections.innerHTML = "";
  const totals = Array.isArray(assessment?.sectionTotals) ? assessment.sectionTotals : [];
  totals.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<div>${escapeHtml(s.sectionId || "Section")}</div>
      <div class="tag"><span class="tag__label">Score</span><span class="tag__value">${Number.isFinite(s.score) ? Number(s.score).toFixed(2) : "—"}</span></div>`;
    riskSections.appendChild(li);
  });

  if (riskNotes) {
    const evidence = Array.isArray(assessment?.evidence) ? assessment.evidence : [];
    riskNotes.innerHTML = evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
  }

  renderHeroRiskScore(assessment);
  renderRiskBreakdown(lastAnalysis, assessment);
}

function renderAllocations(allocations) {
  allocationList.innerHTML = "";
  if (!Array.isArray(allocations) || allocations.length === 0) {
    allocationsEmpty.style.display = "block";
    return;
  }
  allocationsEmpty.style.display = "none";
  allocations.forEach((a) => {
    const li = document.createElement("li");
    li.innerHTML = `<div>${escapeHtml(a.target || a.protocol || a.name || "Exposure")}</div>
      <div class="tag"><span class="tag__label">Share</span><span class="tag__value">${typeof a.sharePercent === "number" ? a.sharePercent.toFixed(1) + "%" : "—"}</span></div>
      <div class="tag"><span class="tag__label">TVL</span><span class="tag__value">${typeof a.tvlUsd === "number" ? formatUsd(a.tvlUsd) : "—"}</span></div>`;
    allocationList.appendChild(li);
  });
}

function renderEvidence(data) {
  const structured = Array.isArray(data?.evidenceNotes) ? data.evidenceNotes.filter((n) => n && (n.label || n.source)) : [];
  const lines = [];

  if (!structured.length) {
    if (Array.isArray(data?.tvl?.evidence)) data.tvl.evidence.forEach((e) => lines.push({ label: "TVL", source: e }));
    if (Array.isArray(data?.protocol?.totalRaisedEvidence)) {
      data.protocol.totalRaisedEvidence.forEach((e) => lines.push({ label: "Funding", source: e }));
    }
  }

  if (evidenceGrid) {
    evidenceGrid.innerHTML = "";
    const cards = structured.length
      ? structured.map((n) =>
          EvidenceCard({
            label: n.label || "Metric",
            source: n.source || "—",
            detail: n.detail || "",
            href: String(n.source || "").startsWith("http") ? n.source : "",
          })
        )
      : lines.map((l) => EvidenceCard({ label: l.label, source: l.source }));

    if (!cards.length) {
      evidenceEmpty.style.display = "block";
      return;
    }
    evidenceEmpty.style.display = "none";
    evidenceGrid.innerHTML = cards.join("");
  }

  if (evidenceList) evidenceList.innerHTML = "";
}

async function runRiskScore(url) {
  riskStatus.textContent = "Computing institutional rubric…";
  const resp = await fetch("/api/risk-assessment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, protocolName: lastAnalysis?.protocol?.name || null }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${resp.status})`);
  }
  const assessment = await resp.json();
  lastRubric = assessment;
  renderRubricAssessment(assessment);
}

async function expandGraphFromNeo4j() {
  const pid =
    lastAnalysis?.neo4j?.protocolId ||
    lastAnalysis?.localGraph?.protocolId ||
    lastAnalysis?.cache?.protocolKey;
  if (!pid) {
    showToast("No protocol id — run intelligence first.", "error");
    return;
  }
  setPlatformStatus("Expanding graph from database…");
  try {
    const r = await fetch(`/api/db/related?id=${encodeURIComponent(pid)}&hops=4`);
    const json = await r.json();
    if (json?.graph?.nodes?.length) {
      lastAnalysis = { ...lastAnalysis, connections: json.graph };
      renderGraphFromAnalysis(lastAnalysis);
      renderConnections(json.graph);
    } else if (json.neo4jError) {
      showToast(`Graph DB: ${json.neo4jError}`, "error");
    }
  } catch (e) {
    showToast(String(e.message || e), "error");
  } finally {
    setPlatformStatus("");
  }
}

function safeFilenamePart(value) {
  return String(value || "report")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildChatGptResearchPrompt({ url, protocolName } = {}) {
  return `
You are an institutional DeFi risk analyst preparing an investment committee memo.

Protocol URL: ${url || "—"}
Protocol name: ${protocolName || "—"}

Deliver:
1) All security audits — firm, date, scope, report URL
2) Audit coverage estimate (% of core contracts)
3) Dependency graph: subject → tokens → issuers → integrated protocols (2 hops)
4) Bullet summary with citations + Mermaid graph TD

Use primary sources only. Mark unknowns explicitly.
`.trim();
}

function openChatGptWithPrompt(prompt) {
  try {
    window.postMessage({ type: "PROTOCOL_INSPECTOR_CHATGPT_AUTOSEND", prompt }, "*");
  } catch {
    /* ignore */
  }
  const w = window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer");
  navigator.clipboard?.writeText(prompt).catch(() => {});
  if (!w) showToast("Popup blocked — prompt copied to clipboard.", "error");
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPdf(filename, body) {
  const resp = await fetch("/api/report/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const htmlResp = await fetch("/api/report/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (htmlResp.ok) {
      const blob = await htmlResp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.replace(/\.pdf$/i, "") + ".html";
      a.click();
      URL.revokeObjectURL(url);
      showToast("PDF unavailable — downloaded HTML report.", "error");
      return;
    }
    throw new Error([err.error, err.detail].filter(Boolean).join(" — ") || "PDF failed");
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleExportPdf() {
  if (!lastAnalysis) {
    showToast("Run intelligence first.", "error");
    return;
  }
  const name = lastAnalysis?.protocol?.name || safeFilenamePart(lastAnalysis?.protocol?.url) || "protocol";
  setPlatformStatus("Generating investor PDF…");
  try {
    await downloadPdf(`${safeFilenamePart(name)}-investor-report.pdf`, {
      generatedAt: new Date().toISOString(),
      protocolKey: lastAnalysis?.cache?.protocolKey || null,
      url: lastAnalysis?.protocol?.url || lastAnalysis?.origin || null,
      riskAssessment: lastRubric,
    });
    setPlatformStatus("Report ready.", "success");
  } catch (e) {
    showToast(String(e.message || e), "error");
    setPlatformStatus("");
  }
}

function handleExportJson() {
  if (!lastAnalysis) {
    showToast("Run intelligence first.", "error");
    return;
  }
  const name = lastAnalysis?.protocol?.name || "protocol";
  downloadJson(`${safeFilenamePart(name)}-intelligence.json`, {
    generatedAt: new Date().toISOString(),
    analysis: lastAnalysis,
    riskAssessment: lastRubric,
  });
}

function bindExportButtons() {
  const pdfHandlers = [reportPdfBtn, exportPdfCta];
  const jsonHandlers = [reportJsonBtn, exportJsonCta];
  const gptHandlers = [chatgptResearchBtn, exportChatgptCta];
  pdfHandlers.forEach((el) => el?.addEventListener("click", handleExportPdf));
  jsonHandlers.forEach((el) => el?.addEventListener("click", handleExportJson));
  gptHandlers.forEach((el) =>
    el?.addEventListener("click", () => {
      const url = lastAnalysis?.protocol?.url || urlInput?.value || "";
      openChatGptWithPrompt(
        buildChatGptResearchPrompt({ url, protocolName: lastAnalysis?.protocol?.name })
      );
    })
  );
}

graphDepthEl?.addEventListener("change", () => {
  if (lastAnalysis) renderGraphFromAnalysis(lastAnalysis);
});
graphExpandBtn?.addEventListener("click", expandGraphFromNeo4j);

if (form && urlInput) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    const walletAddress = walletInput?.value?.trim() || "";

    setAnalyzing(true);
    setViewMode("loading");
    if (loadingMetrics) loadingMetrics.innerHTML = SkeletonGrid(4);
    if (loadingLines) loadingLines.innerHTML = SkeletonLines(6);
    setPlatformStatus("Running protocol intelligence pipeline…");

    try {
      const resp = await fetch("/api/llm-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          walletAddress,
          forceRefresh: document.getElementById("force-refresh")?.checked === true,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${resp.status})`);
      }
      const data = await resp.json();
      lastAnalysis = data;
      lastRubric = null;

      setViewMode("results");
      setExportEnabled(true);
      const tabParam = new URL(window.location.href).searchParams.get("tab");
      shellApi?.setTab(tabParam && tabParam !== "landing" ? tabParam : "overview");

      renderProtocolMeta(data);
      renderOverviewMetrics(data);
      renderLiquidityMetrics(data);
      renderFundingMetrics(data);
      renderContracts(data.contracts || []);
      renderConnections(data.connections || null);
      renderGraphFromAnalysis(data);
      renderTotalRaised(data);
      renderTokenLiquidity(data.tokenLiquidity || data.tokens || []);
      renderLlmRisk(data);
      renderAllocations(data.allocations || data.exposures || []);
      renderEvidence(data);

      setPlatformStatus("Intelligence complete.", "success");
      await revealResults();

      runRiskScore(url).catch((e) => {
        console.error(e);
        riskStatus.textContent = "Rubric scoring failed.";
        showToast("Rubric scoring failed — overview metrics still available.", "error");
      });
    } catch (err) {
      console.error(err);
      setViewMode("landing");
      showToast(err.message || "Analysis failed. Check server logs.", "error");
      setPlatformStatus(String(err.message || "Analysis failed"), "error");
    } finally {
      setAnalyzing(false);
    }
  });
}

bindExportButtons();

document.addEventListener("platform-tab", (e) => {
  const tabId = e.detail?.tabId;
  if (tabId === "graph" && !lastAnalysis) {
    tabGraph.renderDemo();
  } else if (tabId === "graph" && lastAnalysis) {
    renderGraphFromAnalysis(lastAnalysis);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  shellApi = initShell();
  setViewMode("landing");
  landingGraph.renderDemo();
  tabGraph.renderDemo();
  setExportEnabled(false);

  const u = new URL(window.location.href);
  const prefill = u.searchParams.get("url") || u.searchParams.get("protocol");
  if (prefill && urlInput) {
    urlInput.value = /^https?:\/\//i.test(prefill) ? prefill : `https://${prefill}`;
  }
  const tab = u.searchParams.get("tab");
  if (tab === "graph") {
    shellApi?.setTab("graph");
  }
  if (u.searchParams.get("mode") === "graph" || u.searchParams.get("q")) {
    setSearchMode("graph");
    if (u.searchParams.get("q") && graphSearchQ) {
      graphSearchQ.value = u.searchParams.get("q");
      runGraphSearch();
    }
  } else {
    setSearchMode("protocol");
  }
});
