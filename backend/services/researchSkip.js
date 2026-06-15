/**
 * Skip redundant web research when protocol API + subgraph already resolved key fields.
 */

function skipWhenResolvedEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_RESEARCH_SKIP_WHEN_RESOLVED || "1").trim());
}

function mergedMeta({ vaultMeta, subgraphScoring, scoringHints } = {}) {
  return {
    ...(vaultMeta?.scoring || vaultMeta || {}),
    ...(subgraphScoring || {}),
    ...(scoringHints || {}),
  };
}

function isLendingPool({ ctx, meta } = {}) {
  const hay = `${ctx?.protocolKind || ""} ${ctx?.issuerSlug || ""} ${meta?.tvlEvidence || ""}`.toLowerCase();
  return /aave|morpho|compound|spark|lend|reserve|market/.test(hay);
}

function isPendlePool({ ctx } = {}) {
  return /pendle/i.test(`${ctx?.protocolKind || ""} ${ctx?.issuerSlug || ""} ${ctx?.url || ""}`);
}

/** Enough on-chain/API data to skip scoring-focused web searches. */
export function shouldSkipScoringWebResearch({ ctx, vaultMeta, subgraphScoring } = {}) {
  if (!skipWhenResolvedEnabled()) return false;
  const meta = mergedMeta({ vaultMeta, subgraphScoring });
  const hasTvl = meta.totalAssetsUsd != null && Number(meta.totalAssetsUsd) > 0;
  if (!hasTvl) return false;

  if (isPendlePool({ ctx })) {
    return meta.pendleAmmLiquidityUsd != null || meta.pendleDaysToMaturity != null;
  }
  if (isLendingPool({ ctx, meta })) {
    const hasUtil = meta.utilization != null && isFinite(Number(meta.utilization));
    const hasLltv = meta.lltvPct != null && isFinite(Number(meta.lltvPct));
    const hasDepositors =
      meta.top1DepositorPct != null ||
      (Array.isArray(meta.depositorSharePercents) && meta.depositorSharePercents.length >= 2);
    return hasUtil && hasLltv && hasDepositors;
  }
  return hasTvl;
}

/** Skip Dune TVL search when tier-1 TVL already resolved. */
export function shouldSkipDuneResearch({ vaultMeta, subgraphScoring, scoringHints } = {}) {
  if (!skipWhenResolvedEnabled()) return false;
  if (/^(0|false|no|off)$/i.test(String(process.env.POOL_DUNE_SEARCH || "1").trim())) return true;
  const meta = mergedMeta({ vaultMeta, subgraphScoring, scoringHints });
  return meta.totalAssetsUsd != null && Number(meta.totalAssetsUsd) > 0;
}
