/**
 * Normalize DefiLlama yields API rows — keep all fields needed for P.1–P.9 scoring.
 */

export function fullYieldsPoolRow(r) {
  if (!r || typeof r !== "object") return null;
  return {
    project: r.project ?? null,
    symbol: r.symbol ?? null,
    chain: r.chain ?? null,
    tvlUsd: r.tvlUsd ?? null,
    apy: r.apy ?? null,
    apyBase: r.apyBase ?? null,
    apyReward: r.apyReward ?? null,
    apyMean30d: r.apyMean30d ?? null,
    apyPct30D: r.apyPct30D ?? null,
    poolMeta: r.poolMeta ?? null,
    pool: r.pool ?? null,
    underlyingTokens: Array.isArray(r.underlyingTokens) ? r.underlyingTokens : [],
    exposure: r.exposure ?? null,
    ilRisk: r.ilRisk ?? null,
    count: r.count ?? null,
    sigma: r.sigma ?? null,
    stablecoin: r.stablecoin ?? null,
    rewardTokens: r.rewardTokens ?? null,
  };
}

function rowLookupKey(r) {
  const pool = String(r?.pool || "").trim();
  if (pool) return `pool:${pool}`;
  const proj = String(r?.project || "").toLowerCase();
  const sym = String(r?.symbol || "").toLowerCase();
  const chain = String(r?.chain || "").toLowerCase();
  return `sym:${proj}:${sym}:${chain}`;
}

/** Re-attach full DefiLlama fields when rows were stripped to a subset. */
export function hydrateYieldsRows(rows, allPools) {
  const list = Array.isArray(rows) ? rows : [];
  const pools = Array.isArray(allPools) ? allPools : [];
  const index = new Map();
  for (const p of pools) {
    index.set(rowLookupKey(p), p);
    if (p.pool) index.set(`pool:${p.pool}`, p);
  }
  return list.map((r) => {
    const hit = index.get(rowLookupKey(r)) || (r?.pool ? index.get(`pool:${r.pool}`) : null);
    return fullYieldsPoolRow(hit || r);
  }).filter(Boolean);
}
