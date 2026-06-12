/**
 * TVL source priority for pool scoring (P.7).
 * 1. Contract / protocol API / on-chain (highest confidence)
 * 2. Playwright pool page render
 * 3. DefiLlama, Dune, pool analytics sites
 * 4. Web search / LLM inference (lowest)
 */

export const TVL_SOURCE_RANK = {
  subgraph: 0,
  protocol_api: 0,
  on_chain: 0,
  protocol_url_match: 0,
  compound_on_chain: 0,
  pool_page: 1,
  dune: 2,
  defillama: 2,
  analytics: 2,
  moralis: 2,
  web_search: 3,
  llm: 3,
};

export const TVL_CONFIDENCE_BY_SOURCE = {
  subgraph: "high",
  protocol_api: "high",
  on_chain: "high",
  protocol_url_match: "high",
  compound_on_chain: "high",
  pool_page: "high",
  dune: "medium",
  defillama: "medium",
  analytics: "medium",
  moralis: "medium",
  web_search: "low",
  llm: "low",
};

export function tvlSourceRank(source) {
  const s = String(source || "").toLowerCase();
  if (s in TVL_SOURCE_RANK) return TVL_SOURCE_RANK[s];
  if (/subgraph|thegraph/i.test(s)) return 0;
  if (/protocol|api|on.?chain/i.test(s)) return 0;
  if (/pool_page|crawl|playwright/i.test(s)) return 1;
  if (/defillama|dune|analytics|inspector/i.test(s)) return 2;
  if (/web|search|llm|tavily/i.test(s)) return 3;
  return 99;
}

export function tvlConfidenceForSource(source) {
  const s = String(source || "").toLowerCase();
  return TVL_CONFIDENCE_BY_SOURCE[s] || (tvlSourceRank(s) <= 1 ? "high" : tvlSourceRank(s) === 2 ? "medium" : "low");
}

const TIER0_TIE_BREAK = {
  subgraph: 0,
  protocol_api: 1,
  on_chain: 2,
  protocol_url_match: 3,
  compound_on_chain: 4,
};

function tier0TieBreak(source) {
  const s = String(source || "").toLowerCase();
  return TIER0_TIE_BREAK[s] ?? 50;
}

/** @param {Array<{value:number, source:string, evidence?:string}>} candidates */
export function pickBestTvlCandidate(candidates, { allowDefillama = true } = {}) {
  const list = (candidates || []).filter(
    (c) => c?.value != null && isFinite(Number(c.value)) && Number(c.value) > 0
  );
  const filtered = allowDefillama ? list : list.filter((c) => c.source !== "defillama");
  if (!filtered.length) return null;

  const preferSubgraph = /^(1|true|yes|on)$/i.test(String(process.env.POOL_SUBGRAPH_PREFER || "1").trim());

  filtered.sort((a, b) => {
    const dr = tvlSourceRank(a.source) - tvlSourceRank(b.source);
    if (dr !== 0) return dr;
    if (tvlSourceRank(a.source) === 0 && preferSubgraph) {
      const tb = tier0TieBreak(a.source) - tier0TieBreak(b.source);
      if (tb !== 0) return tb;
    }
    return Number(a.value) - Number(b.value);
  });
  return filtered[0];
}

/** True if `incoming` should replace `existing` on the yields row. */
export function shouldReplaceTvl(existing, incoming) {
  if (!incoming?.value || !isFinite(Number(incoming.value))) return false;
  if (!existing?.value || !isFinite(Number(existing.value)) || existing.tvlUncertain) return true;
  return tvlSourceRank(incoming.source) < tvlSourceRank(existing.source);
}

export function mergeTvlIntoRow(row, candidate) {
  if (!candidate || !shouldReplaceTvl(
    { value: row?.tvlUsd, source: row?.tvlSource, tvlUncertain: row?.tvlUncertain },
    candidate
  )) {
    return row;
  }
  const next = { ...row };
  next.defillamaTvlUsd = next.defillamaTvlUsd ?? next.tvlUsd;
  next.tvlUsd = Number(candidate.value);
  next.tvlSource = candidate.source || "unknown";
  next.tvlEvidence = candidate.evidence || next.tvlEvidence;
  next.tvlUncertain = false;
  return next;
}
