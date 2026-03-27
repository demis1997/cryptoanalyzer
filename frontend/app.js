const form = document.getElementById("protocol-form");
const urlInput = document.getElementById("protocol-url");
const walletInput = document.getElementById("wallet-address");

const debankLinkWrap = document.getElementById("debank-link-wrap");
const debankLink = document.getElementById("debank-link");

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

const protocolNameEl = document.getElementById("protocol-name");
const protocolUrlEl = document.getElementById("protocol-url-display");
const protocolChainsEl = document.getElementById("protocol-chains");
const protocolAuditsEl = document.getElementById("protocol-audits");
const protocolMethodologyEl = document.getElementById("protocol-methodology");
const protocolInformationEl = document.getElementById("protocol-information");

const contractList = document.getElementById("contract-list");
const contractsEmpty = document.getElementById("contracts-empty");

const connectionsList = document.getElementById("connections-list");
const connectionsEmpty = document.getElementById("connections-empty");

const tvlValue = document.getElementById("tvl-value");
const tvlChange = document.getElementById("tvl-change");

const investorList = document.getElementById("investor-list");
const investorsEmpty = document.getElementById("investors-empty");

const txPerDay = document.getElementById("tx-per-day");
const txTrend = document.getElementById("tx-trend");

const tokenLiquidityList = document.getElementById("token-liquidity-list");
const tokenLiquidityEmpty = document.getElementById("token-liquidity-empty");

const riskBtn = document.getElementById("risk-btn");
const reportPdfBtn = document.getElementById("report-pdf-btn");
const reportJsonBtn = document.getElementById("report-json-btn");
const riskOverall = document.getElementById("risk-overall");
const riskStatus = document.getElementById("risk-status");
const riskSections = document.getElementById("risk-sections");
const riskNotes = document.getElementById("risk-notes");

const allocationList = document.getElementById("allocation-list");
const allocationsEmpty = document.getElementById("allocations-empty");

const evidenceList = document.getElementById("evidence-list");
const evidenceEmpty = document.getElementById("evidence-empty");

const overallScoreEl = document.getElementById("overall-score");
const overallNotesEl = document.getElementById("overall-notes");

let lastAnalysis = null;
let lastRubric = null;

function formatUsd(value) {
  if (!Number.isFinite(value)) return "–";
  if (value >= 1_000_000_000) {
    return "$" + (value / 1_000_000_000).toFixed(2) + "B";
  }
  if (value >= 1_000_000) {
    return "$" + (value / 1_000_000).toFixed(2) + "M";
  }
  if (value >= 1_000) {
    return "$" + (value / 1_000).toFixed(1) + "K";
  }
  return "$" + value.toLocaleString();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "–";
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(1) + "M";
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(1) + "K";
  }
  return value.toLocaleString();
}

function renderContracts(contracts) {
  contractList.innerHTML = "";
  if (!contracts || contracts.length === 0) {
    contractsEmpty.style.display = "block";
    return;
  }

  contractsEmpty.style.display = "none";

  contracts.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${c.label} <span style="color:#9ca3af;">• ${c.network}</span></div>
      <div class="tag">
        <span class="tag__label">Address</span>
        <span class="tag__value">${c.address}</span>
      </div>
    `;
    contractList.appendChild(li);
  });
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

  const byAddr = new Map(nodes.map((n) => [String(n.address || "").toLowerCase(), n]));
  const fmt = (a) => (a ? `${String(a).slice(0, 10)}…${String(a).slice(-8)}` : "—");

  edges.slice(0, 120).forEach((e) => {
    const from = byAddr.get(String(e.from || "").toLowerCase());
    const to = byAddr.get(String(e.to || "").toLowerCase());
    const rel = e.relation || "connected";
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${(from?.label || "Contract")} <span style="color:#9ca3af;">→</span> ${(to?.label || "Contract")}</div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">Relation</span>
        <span class="tag__value">${rel}</span>
      </div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">From</span>
        <span class="tag__value" title="${e.from || ""}">${fmt(e.from)}</span>
      </div>
      <div class="tag" style="margin-top:6px;">
        <span class="tag__label">To</span>
        <span class="tag__value" title="${e.to || ""}">${fmt(e.to)}</span>
      </div>
    `;
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
  li.innerHTML = `
    <div>Total raised</div>
    <div class="tag">
      <span class="tag__label">Amount</span>
      <span class="tag__value">${formatUsd(raised)}</span>
    </div>
  `;
  investorList.appendChild(li);
}

function renderProtocolMeta(data) {
  const protocol = data?.protocol || {};
  protocolNameEl.textContent = protocol.name || "Unknown protocol";
  protocolUrlEl.textContent = protocol.url || data?.origin || "—";
  const chains = data?.chainsSupported || protocol?.chains || [];
  if (protocolChainsEl) {
    protocolChainsEl.textContent =
      Array.isArray(chains) && chains.length ? `Chains: ${chains.join(", ")}` : "";
  }

  if (protocolAuditsEl) {
    const verifiedFirms = Array.isArray(protocol?.auditsVerified?.firms) ? protocol.auditsVerified.firms : [];
    if (verifiedFirms.length) {
      protocolAuditsEl.textContent = `Audited by: ${verifiedFirms.join(", ")}.`;
    } else if (Number.isFinite(protocol?.audits)) {
      protocolAuditsEl.textContent = `DefiLlama audits: ${protocol.audits}`;
    } else if (Array.isArray(protocol?.auditLinks) && protocol.auditLinks.length) {
      protocolAuditsEl.textContent = `DefiLlama audits: ${protocol.auditLinks.length}`;
    } else {
      protocolAuditsEl.textContent = "";
    }
  }

  if (protocolMethodologyEl) {
    const text = protocol?.methodology || "";
    protocolMethodologyEl.textContent = text ? `Methodology: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}` : "";
  }

  if (protocolInformationEl) {
    const text = protocol?.description || "";
    protocolInformationEl.textContent = text ? text.slice(0, 260) + (text.length > 260 ? "…" : "") : "—";
  }
}

function renderMetrics(data) {
  const tvlUsd = data?.tvl?.valueUsd ?? null;
  tvlValue.textContent = tvlUsd ? formatUsd(tvlUsd) : "–";

  tvlChange.className = "metric metric--muted";
  tvlChange.textContent = tvlUsd ? "Current TVL." : "No TVL data yet.";

  const vol = data?.txsPerDay?.value ?? null;
  txPerDay.textContent = vol ? formatUsd(vol) : "–";

  txTrend.className = "metric metric--muted";
  txTrend.textContent = vol ? "Native token volume (24h)." : "No native token volume data yet.";
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
    const liq =
      typeof t.liquidityUsd === "number"
        ? formatUsd(t.liquidityUsd)
        : t.liquidityLabel || "—";
    li.innerHTML = `
      <div>${t.token || t.asset || "Token"}</div>
      <div class="tag">
        <span class="tag__label">Liquidity</span>
        <span class="tag__value">${liq}</span>
      </div>
    `;
    tokenLiquidityList.appendChild(li);
  });
}

function renderRiskAssessment(data) {
  const risk = data?.risk;
  if (!risk) {
    riskOverall.textContent = "–";
    riskStatus.textContent = "No risk data returned.";
    riskSections.innerHTML = "";
    overallScoreEl.textContent = "–";
    overallNotesEl.textContent = "No rubric‑based rating yet.";
    if (riskNotes) riskNotes.innerHTML = "";
    return;
  }

  riskOverall.textContent = (risk.level || "unknown").toUpperCase();
  riskStatus.textContent = risk.summary || "No risk summary returned.";

  if (typeof risk.overallScore === "number") {
    overallScoreEl.textContent = risk.overallScore.toFixed(2);
    overallNotesEl.textContent =
      "Overall weighted score on 0‑1 scale (higher is better).";
  } else {
    overallScoreEl.textContent = "–";
    overallNotesEl.textContent =
      "Waiting for full rubric‑based score from backend.";
  }

  riskSections.innerHTML = "";
  if (Array.isArray(risk.sections)) {
    risk.sections.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>${s.label || s.id || "Section"}</div>
        <div class="tag">
          <span class="tag__label">Note</span>
          <span class="tag__value">${s.comment || ""}</span>
        </div>
      `;
      riskSections.appendChild(li);
    });
  }

  renderRiskNotesFromData(lastAnalysis, null);
}

function scoreToLevel(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 0.75) return "low";
  if (score >= 0.5) return "medium";
  return "high";
}

function renderRubricAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") {
    riskOverall.textContent = "–";
    riskStatus.textContent = "No rubric assessment returned.";
    riskSections.innerHTML = "";
    overallScoreEl.textContent = "–";
    overallNotesEl.textContent = "No rubric‑based rating yet.";
    return;
  }

  // Rubric scoring may include sections we couldn't verify (missing data).
  // To match the intent ("if data is missing, remove it from the equation"),
  // compute a display score only from the sub-scores derived from available data.
  const liq = computeLiquidityScore(lastAnalysis);
  const inv = computeRaisedScore(lastAnalysis);
  const age = computeAgeScore(lastAnalysis);
  const aud = computeAuditScore(lastAnalysis);

  const parts = [liq?.score, inv?.score, age?.score, aud?.score].filter((x) => typeof x === "number");
  const heuristicOverall =
    parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : assessment.overallTotal;

  const level = scoreToLevel(heuristicOverall);

  overallScoreEl.textContent = Number.isFinite(heuristicOverall)
    ? heuristicOverall.toFixed(2)
    : "–";
  overallNotesEl.textContent =
    "Overall computed from available facts (missing sections excluded).";

  riskOverall.textContent = level.toUpperCase();
  riskStatus.textContent = Number.isFinite(heuristicOverall)
    ? `Overall (available facts): ${heuristicOverall.toFixed(2)} (0–1).`
    : "Overall could not be computed.";

  riskSections.innerHTML = "";
  if (Array.isArray(assessment.sectionTotals) && assessment.sectionTotals.length) {
    assessment.sectionTotals.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>${s.sectionId || "Section"}</div>
        <div class="tag">
          <span class="tag__label">Score</span>
          <span class="tag__value">${Number.isFinite(s.score) ? s.score.toFixed(2) : "—"}</span>
        </div>
      `;
      riskSections.appendChild(li);
    });
  }

  renderRiskNotesFromData(lastAnalysis, assessment);
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeLiquidityScore(data) {
  const tvl = data?.tvl?.valueUsd;
  if (!Number.isFinite(tvl) || tvl <= 0) return { score: null, note: "No TVL/liquidity found." };
  // Simple tiering: higher liquidity => higher score.
  let score = 0.2;
  if (tvl >= 1_000_000_000) score = 1.0;
  else if (tvl >= 100_000_000) score = 0.85;
  else if (tvl >= 10_000_000) score = 0.7;
  else if (tvl >= 1_000_000) score = 0.55;
  else if (tvl >= 100_000) score = 0.4;
  return { score, note: `Liquidity/TVL: ${formatUsd(tvl)}` };
}

function computeRaisedScore(data) {
  const raised = data?.protocol?.totalRaisedUsd;
  if (!Number.isFinite(raised) || raised <= 0) {
    return { score: null, note: "Total raised unknown." };
  }
  // Tiered heuristic: more raised => safer (missing data excluded).
  let score = 0.3;
  if (raised >= 100_000_000) score = 0.95;
  else if (raised >= 50_000_000) score = 0.9;
  else if (raised >= 10_000_000) score = 0.8;
  else if (raised >= 1_000_000) score = 0.65;
  else score = 0.4;
  return { score, note: `Total raised: ${formatUsd(raised)}` };
}

function computeAgeScore(data) {
  const listedAt = data?.protocol?.listedAt;
  if (!Number.isFinite(listedAt)) return { score: null, note: "Protocol age unknown." };
  const ageDays = (Date.now() / 1000 - listedAt) / 86400;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return { score: null, note: "Protocol age unknown." };
  // 0 at 0 days, ~0.5 at 180d, ~0.8 at 2y, 1.0 at 4y+
  const score = clamp01(ageDays / (365 * 4));
  const years = (ageDays / 365).toFixed(1);
  return { score, note: `Listed ~${years} years ago (DefiLlama listedAt)` };
}

function computeAuditScore(data) {
  const audits = data?.protocol?.audits;
  const auditLinks = Array.isArray(data?.protocol?.auditLinks) ? data.protocol.auditLinks : [];
  const count = Number.isFinite(audits) ? audits : auditLinks.length ? auditLinks.length : null;
  if (!Number.isFinite(count)) return { score: null, note: "Audit info not available." };

  // Higher is better (this is a display-only heuristic; missing data is excluded).
  if (count >= 3) return { score: 0.95, note: `DefiLlama audits: ${count} (multiple audits)` };
  if (count === 2) return { score: 0.9, note: `DefiLlama audits: ${count} (reviewed)` };
  if (count === 1) return { score: 0.75, note: "DefiLlama audits: 1 (limited audit coverage)" };
  return { score: 0.4, note: "DefiLlama audits: 0 (audit info not found)" };
}

function renderRiskNotesFromData(data, rubricAssessment) {
  if (!riskNotes) return;
  riskNotes.innerHTML = "";
  if (!data) return;

  const liq = computeLiquidityScore(data);
  const inv = computeRaisedScore(data);
  const age = computeAgeScore(data);
  const aud = computeAuditScore(data);

  const items = [
    { label: "Liquidity score", ...liq },
    { label: "Fundraising score", ...inv },
    { label: "Longevity score", ...age },
    { label: "Audit score", ...aud },
  ];

  items.forEach((it) => {
    if (typeof it.score !== "number") {
      // Skip missing data to keep “missing sections excluded”.
      return;
    }
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${it.label}</div>
      <div class="tag">
        <span class="tag__label">Score</span>
        <span class="tag__value">${Number.isFinite(it.score) ? it.score.toFixed(2) : "—"}</span>
      </div>
      <div class="tag">
        <span class="tag__label">Note</span>
        <span class="tag__value">${it.note || "—"}</span>
      </div>
    `;
    riskNotes.appendChild(li);
  });
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
    const share =
      typeof a.sharePercent === "number"
        ? `${a.sharePercent.toFixed(1)}%`
        : a.share || "—";
    const tvlText =
      typeof a.tvlUsd === "number" ? formatUsd(a.tvlUsd) : a.tvlLabel || "";

    li.innerHTML = `
      <div>${a.target || a.protocol || a.name || "Destination"}</div>
      <div class="tag">
        <span class="tag__label">Share</span>
        <span class="tag__value">${share || "—"}</span>
      </div>
      <div class="tag">
        <span class="tag__label">TVL</span>
        <span class="tag__value">${tvlText || "—"}</span>
      </div>
      <div class="tag">
        <span class="tag__label">Risk</span>
        <span class="tag__value">${(a.riskLevel || "unknown").toUpperCase()}</span>
      </div>
    `;
    allocationList.appendChild(li);
  });
}

function renderEvidence(data) {
  evidenceList.innerHTML = "";

  const lines = [];

  if (Array.isArray(data?.tvl?.evidence)) {
    data.tvl.evidence.forEach((e) => lines.push({ label: "TVL", text: e || "" }));
  }

  if (Array.isArray(data?.txsPerDay?.evidence)) {
    data.txsPerDay.evidence.forEach((e) => lines.push({ label: "Tx/day", text: e || "" }));
  }

  if (Array.isArray(data?.protocol?.totalRaisedEvidence)) {
    data.protocol.totalRaisedEvidence.forEach((e) => lines.push({ label: "Total raised", text: e || "" }));
  }

  if (Array.isArray(data?.contracts)) {
    data.contracts.forEach((c) => {
      if (c.evidence) {
        lines.push({
          label: `Contract: ${c.address}`,
          text: c.evidence,
        });
      }
    });
  }

  if (!lines.length) {
    evidenceEmpty.style.display = "block";
    return;
  }

  evidenceEmpty.style.display = "none";

  lines.forEach((l) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${l.label}</div>
      <div class="tag">
        <span class="tag__label">Source</span>
        <span class="tag__value">${l.text}</span>
      </div>
    `;
    evidenceList.appendChild(li);
  });
}

async function runRiskScore(url) {
  const protocolName = lastAnalysis?.protocol?.name || null;
  if (riskBtn) riskBtn.disabled = true;
  riskStatus.textContent = "Computing rubric-based risk score…";

  try {
    const resp = await fetch("/api/risk-assessment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Keep payload small (analysis can be huge for large protocols).
      body: JSON.stringify({ url, protocolName }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Request failed with status ${resp.status}`);
    }
    const assessment = await resp.json();
    lastRubric = assessment;
    renderRubricAssessment(assessment);
  } catch (err) {
    console.error(err);
    riskStatus.textContent = "Failed to compute rubric score. Check server logs for details.";
  } finally {
    if (riskBtn) riskBtn.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  const walletAddress = walletInput?.value?.trim() || "";

  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Analyzing…";

  fetch("/api/llm-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, walletAddress }),
  })
    .then(async (resp) => {
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Request failed with status ${resp.status}`);
      }
      return resp.json();
    })
    .then((data) => {
      lastAnalysis = data;
      lastRubric = null;
      renderProtocolMeta(data);
      renderContracts(data.contracts || []);
      renderConnections(data.connections || null);
      renderTotalRaised(data);
      renderMetrics(data);
      renderTokenLiquidity(data.tokenLiquidity || data.tokens || []);
      renderRiskAssessment(data);
      renderAllocations(data.allocations || data.exposures || []);
      renderEvidence(data);
      // Auto-generate rubric risk right after analysis completes.
      runRiskScore(url);
    })
    .catch((err) => {
      console.error(err);
      alert("Failed to analyze protocol. Check the server logs for details.");
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = "Analyze";
    });
});

function safeFilenamePart(value) {
  return String(value || "report")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
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
    throw new Error(err.error || `PDF request failed with status ${resp.status}`);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

reportPdfBtn?.addEventListener("click", async () => {
  if (!lastAnalysis) {
    alert("Run Analyze first.");
    return;
  }
  const name = lastAnalysis?.protocol?.name || safeFilenamePart(lastAnalysis?.protocol?.url) || "protocol";
  reportPdfBtn.disabled = true;
  try {
    await downloadPdf(`${safeFilenamePart(name)}-report.pdf`, {
      generatedAt: new Date().toISOString(),
      // Avoid huge payloads: server loads latest analysis from DB cache when available.
      protocolKey: lastAnalysis?.cache?.protocolKey || null,
      url: lastAnalysis?.protocol?.url || lastAnalysis?.origin || null,
      riskAssessment: lastRubric,
    });
  } catch (e) {
    console.error(e);
    alert("Failed to generate PDF report. Check server logs.");
  } finally {
    reportPdfBtn.disabled = false;
  }
});

reportJsonBtn?.addEventListener("click", () => {
  if (!lastAnalysis) {
    alert("Run Analyze first.");
    return;
  }
  const name =
    lastAnalysis?.protocol?.name ||
    safeFilenamePart(lastAnalysis?.protocol?.url) ||
    "protocol";
  const payload = {
    generatedAt: new Date().toISOString(),
    analysis: lastAnalysis,
    riskAssessment: lastRubric,
  };
  downloadJson(`${safeFilenamePart(name)}-report.json`, payload);
});

