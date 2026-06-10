/**
 * Build a DefiLlama-shaped yields row from protocol API metadata when DL has no match.
 */
import { normalizePoolChain } from "./poolAddress.js";

export function buildSyntheticYieldsRow({
  symbol,
  name = null,
  project,
  chain,
  vaultAddress = null,
  marketId = null,
  poolMeta = null,
  meta = {},
} = {}) {
  const chainNorm = normalizePoolChain(chain || "ethereum");
  const scoring = meta?.scoring || meta;
  return {
    symbol: symbol || name || project || "POOL",
    project: project || "unknown",
    chain: chainNorm,
    vaultAddress: vaultAddress || null,
    marketId: marketId || null,
    poolMeta: poolMeta || `${project || "protocol"} market`,
    tvlUncertain: false,
    tvlSource: scoring?.tvlSource || meta?.tvlSource || "protocol_api",
    tvlEvidence: scoring?.tvlEvidence || meta?.tvlEvidence || null,
    tvlUsd: scoring?.totalAssetsUsd ?? scoring?.tvlUsd ?? null,
    apyBase: scoring?.apyPct ?? scoring?.apyBase ?? null,
    apySource: scoring?.apyPct != null ? "protocol_api" : null,
    apyEvidence: scoring?.apyEvidence || null,
    utilization: scoring?.utilization ?? null,
    utilizationEvidence: scoring?.utilizationEvidence || null,
    lltv: scoring?.lltvPct ?? scoring?.lltv ?? null,
    lltvEvidence: scoring?.lltvEvidence || null,
    oracleType: scoring?.oracleType || null,
    oracleEvidence: scoring?.oracleEvidence || null,
    capUtilization: scoring?.capUtilization ?? null,
    curator: scoring?.curator || meta?.curator || null,
    curatorEvidence: scoring?.curatorEvidence || null,
    pendleDaysToMaturity: scoring?.pendleDaysToMaturity ?? null,
    pendleAmmLiquidityUsd: scoring?.pendleAmmLiquidityUsd ?? null,
    ammLiquidityUsd: scoring?.ammLiquidityUsd ?? null,
    pendleTradingVolumeUsd: scoring?.pendleTradingVolumeUsd ?? null,
    pendleSecondaryMarket: scoring?.pendleSecondaryMarket ?? null,
    withdrawalQueueDays: scoring?.withdrawalQueueDays ?? null,
    vaultCooldownDays: scoring?.vaultCooldownDays ?? null,
    stakingSecondaryMarket: scoring?.stakingSecondaryMarket ?? null,
    underlyingTokens: meta?.underlyingTokens || scoring?.underlyingTokens || [],
    synthetic: true,
  };
}
