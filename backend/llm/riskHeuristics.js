function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function heuristicLiquidityScore(tvl) {
  if (typeof tvl !== "number" || !isFinite(tvl) || tvl <= 0) return null;
  if (tvl >= 1_000_000_000) return 1.0;
  if (tvl >= 100_000_000) return 0.85;
  if (tvl >= 10_000_000) return 0.7;
  if (tvl >= 1_000_000) return 0.55;
  if (tvl >= 100_000) return 0.4;
  return 0.25;
}

function heuristicRaisedScore(totalRaisedUsd) {
  if (typeof totalRaisedUsd !== "number" || !isFinite(totalRaisedUsd) || totalRaisedUsd <= 0) return null;
  // Higher raised => safer fundraising/reputation.
  if (totalRaisedUsd >= 100_000_000) return 0.95;
  if (totalRaisedUsd >= 50_000_000) return 0.9;
  if (totalRaisedUsd >= 10_000_000) return 0.8;
  if (totalRaisedUsd >= 1_000_000) return 0.65;
  return 0.4;
}

function heuristicLongevityScore(listedAt) {
  if (typeof listedAt !== "number" || !isFinite(listedAt) || listedAt <= 0) return null;
  const ageDays = (Date.now() / 1000 - listedAt) / 86400;
  if (!isFinite(ageDays) || ageDays <= 0) return null;
  return clamp01(ageDays / (365 * 4));
}

function heuristicAuditScore(auditCount) {
  if (!Number.isFinite(auditCount)) return null;
  if (auditCount >= 3) return 0.95;
  if (auditCount === 2) return 0.9;
  if (auditCount === 1) return 0.75;
  if (auditCount === 0) return 0.4;
  return null;
}

export function buildHeuristicRiskAssessment({ protocolName, url, analysis }) {
  const a = analysis || {};
  const tvl = a?.tvl?.valueUsd;
  const listedAt = a?.protocol?.listedAt;
  const audits = a?.protocol?.auditsVerified?.count ?? a?.protocol?.audits;
  const auditFirms = Array.isArray(a?.protocol?.auditsVerified?.firms) ? a.protocol.auditsVerified.firms : [];
  const auditLinks = Array.isArray(a?.protocol?.auditLinks) ? a.protocol.auditLinks : [];
  const totalRaisedUsd = typeof a?.protocol?.totalRaisedUsd === "number" ? a.protocol.totalRaisedUsd : null;

  const liquidityScore = heuristicLiquidityScore(tvl);
  const raisedScore = heuristicRaisedScore(totalRaisedUsd);
  const longevityScore = heuristicLongevityScore(listedAt);
  const auditCount =
    Number.isFinite(audits) ? audits : auditFirms.length ? auditFirms.length : (auditLinks.length ? auditLinks.length : null);
  const auditScore = heuristicAuditScore(auditCount);

  const scores = [liquidityScore, raisedScore, longevityScore, auditScore].filter(
    (x) => typeof x === "number"
  );
  const overallTotal = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0.5;

  return {
    protocol: { name: protocolName || null, url: url || null },
    criteria: [],
    sectionTotals: [
      { sectionId: "liquidity", score: liquidityScore ?? 0 },
      { sectionId: "investment_reputation", score: raisedScore ?? 0 },
      { sectionId: "longevity", score: longevityScore ?? 0 },
      { sectionId: "audits", score: auditScore ?? 0 },
    ],
    overallTotal,
    evidence: [
      "Heuristic risk scoring (full LLM rubric not used or did not return structured scores).",
      typeof tvl === "number" ? `Liquidity/TVL observed: ${tvl}` : "Liquidity/TVL not available.",
      typeof totalRaisedUsd === "number" ? `Total raised: ${totalRaisedUsd}` : "Total raised unknown.",
      typeof listedAt === "number" ? `Protocol listedAt (index): ${listedAt}` : "listedAt unknown.",
      auditFirms.length ? `Auditors (verification): ${auditFirms.join(", ")}` : "",
      auditCount != null ? `Audits detected: ${auditCount}` : "Audit info unknown.",
    ],
  };
}

