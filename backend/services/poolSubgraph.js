/**
 * Protocol subgraph queries for pool-specific TVL, utilization, LLTV (tier-1 with protocol API).
 */
import { normalizePoolChain } from "./poolAddress.js";
import { moralisTokenPriceUsd } from "./moralisClient.js";
import { subgraphEnabled, subgraphUrl, querySubgraph } from "./subgraphClient.js";
import { theGraphSubgraphUrl } from "./sourceUrls.js";

const RAY = 1e27;

const AAVE_V3_SUBGRAPHS = {
  ethereum: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
  polygon: "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211",
  arbitrum: "DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B",
  optimism: "DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb",
  base: "GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
};

/** Messari-schema Morpho Blue deployments (community; override via env). */
const MORPHO_SUBGRAPHS = {
  ethereum: process.env.MORPHO_SUBGRAPH_ID_ETHEREUM || "8Lz789DP5VKLXumTMTgygjU2xtuzx8AhbaacgN5PYCAs",
  base: process.env.MORPHO_SUBGRAPH_ID_BASE || "71ZTy1veF9twER9CLMnPWeLQ7GZcwKsjmygejrgKirqs",
  polygon: process.env.MORPHO_SUBGRAPH_ID_POLYGON || "EhFokmwryNs7qbvostceRqVdjc3petuD13mmdUiMBw8Y",
  arbitrum: process.env.MORPHO_SUBGRAPH_ID_ARBITRUM || "",
  optimism: process.env.MORPHO_SUBGRAPH_ID_OPTIMISM || "",
};

export function subgraphIdForPool(ctx = {}) {
  const kind = ctx?.protocolKind;
  const c = normalizePoolChain(ctx?.chain);
  if (kind === "aave_reserve") return AAVE_V3_SUBGRAPHS[c] || null;
  if (kind === "morpho_market") return MORPHO_SUBGRAPHS[c] || null;
  return null;
}

export function subgraphExplorerUrlForPool(ctx = {}) {
  const id = subgraphIdForPool(ctx);
  return id ? theGraphSubgraphUrl(id) : null;
}

function num(raw) {
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

function bigintUsd(amountRaw, decimals, priceUsd) {
  const amt = num(amountRaw);
  const dec = num(decimals) ?? 18;
  const px = num(priceUsd);
  if (amt == null || px == null || px <= 0) return null;
  return (amt / 10 ** dec) * px;
}

async function priceUsdForAsset(address, chain) {
  const moralis = await moralisTokenPriceUsd(address, chain).catch(() => null);
  if (moralis?.usdPrice) return moralis.usdPrice;
  const chainKey = normalizePoolChain(chain);
  const resp = await fetch(`https://coins.llama.fi/prices/current/${chainKey}:${address}`, {
    headers: { "User-Agent": "cryptoanalyzer/subgraph" },
  }).catch(() => null);
  const json = resp?.ok ? await resp.json().catch(() => null) : null;
  const key = `${chainKey}:${String(address).toLowerCase()}`;
  return num(json?.coins?.[key]?.price);
}

async function fetchAaveReserveSubgraph({ chain, underlyingAsset }) {
  const addr = String(underlyingAsset || "").toLowerCase();
  const c = normalizePoolChain(chain);
  const subgraphId = AAVE_V3_SUBGRAPHS[c];
  if (!subgraphId || !/^0x[a-f0-9]{40}$/.test(addr)) return null;

  const endpoint = subgraphUrl({ subgraphId });
  const q = `query($underlying: String!) {
    reserves(where: { underlyingAsset: $underlying }, first: 1) {
      symbol decimals underlyingAsset
      availableLiquidity totalLiquidity
      utilizationRate
      totalCurrentVariableDebt totalPrincipalStableDebt
      reserveLiquidationThreshold baseLTVasCollateral
      liquidityRate
    }
  }`;

  const r = await querySubgraph(endpoint, q, { underlying: addr });
  if (!r.ok) return { source: "subgraph", error: r.error || "aave_subgraph_query_failed" };
  const reserve = r.data?.reserves?.[0];
  if (!reserve) return null;

  const priceUsd = await priceUsdForAsset(addr, c);
  const liquidityUsd = bigintUsd(reserve.availableLiquidity, reserve.decimals, priceUsd);
  const supplyUsd = bigintUsd(reserve.totalLiquidity, reserve.decimals, priceUsd);
  const tvlUsd = liquidityUsd ?? supplyUsd;

  let util = num(reserve.utilizationRate);
  if (util != null && util > 1) util /= RAY;
  if (util == null && supplyUsd && liquidityUsd != null && supplyUsd > 0) {
    util = 1 - liquidityUsd / supplyUsd;
  }

  const lltv = num(reserve.reserveLiquidationThreshold);
  const lltvPct =
    lltv != null ? (lltv > 100 ? lltv / 100 : lltv <= 1 ? lltv * 100 : lltv / 100) : null;

  return {
    source: "subgraph",
    protocol: "aave-v3",
    symbol: reserve.symbol,
    subgraphId,
    subgraphUrl: theGraphSubgraphUrl(subgraphId),
    scoring: {
      totalAssetsUsd: tvlUsd,
      supplyAssetsUsd: supplyUsd,
      liquidityAssetsUsd: liquidityUsd,
      tvlEvidence:
        liquidityUsd != null
          ? `Aave subgraph availableLiquidity ~$${Math.round(liquidityUsd).toLocaleString()}`
          : supplyUsd != null
            ? `Aave subgraph totalLiquidity ~$${Math.round(supplyUsd).toLocaleString()}`
            : null,
      utilization: util != null && isFinite(util) ? util : null,
      utilizationEvidence:
        util != null ? `Aave subgraph utilization ${(util * 100).toFixed(1)}%` : null,
      lltvPct: lltvPct != null && lltvPct <= 100 ? lltvPct : null,
      lltvEvidence: lltvPct != null ? `Aave subgraph liquidation threshold ${lltvPct.toFixed(1)}%` : null,
      poolAgeSource: null,
    },
    subgraphId,
    subgraphUrl: theGraphSubgraphUrl(subgraphId),
  };
}

async function fetchMorphoMarketSubgraph({ marketId, chain }) {
  const id = String(marketId || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(id)) return null;
  const c = normalizePoolChain(chain);
  const subgraphId = MORPHO_SUBGRAPHS[c];
  if (!subgraphId) return null;

  const endpoint = subgraphUrl({ subgraphId });
  const q = `query($id: Bytes!) {
    market(id: $id) {
      id name
      totalDepositBalanceUSD totalBorrowBalanceUSD totalValueLockedUSD
      maximumLTV liquidationThreshold
      createdTimestamp lastUpdateTimestamp
      inputToken { symbol decimals }
      borrowedToken { symbol decimals }
      positions(first: 5, orderBy: balanceUSD, orderDirection: desc) {
        side balanceUSD account { id }
      }
    }
  }`;

  const r = await querySubgraph(endpoint, q, { id });
  if (!r.ok) return { source: "subgraph", error: r.error || "morpho_subgraph_query_failed" };
  const market = r.data?.market;
  if (!market) return null;

  const deposit = num(market.totalDepositBalanceUSD);
  const borrow = num(market.totalBorrowBalanceUSD);
  const liquidityUsd =
    deposit != null && borrow != null ? Math.max(0, deposit - borrow) : num(market.totalValueLockedUSD);
  const util = deposit != null && deposit > 0 && borrow != null ? borrow / deposit : null;
  const lltv = num(market.maximumLTV);
  const liqThresh = num(market.liquidationThreshold);
  const lltvPct =
    lltv != null
      ? lltv <= 1
        ? lltv * 100
        : lltv
      : liqThresh != null
        ? liqThresh <= 1
          ? liqThresh * 100
          : liqThresh
        : null;

  const positions = Array.isArray(market.positions) ? market.positions : [];
  const depositPositions = positions.filter((p) => String(p.side || "").toUpperCase() === "DEPOSITOR");
  const topDepositUsd = depositPositions.reduce((m, p) => Math.max(m, num(p.balanceUSD) || 0), 0);
  const totalDepositsUsd = num(market.totalDepositBalanceUSD);
  const top1Pct = totalDepositsUsd > 0 && topDepositUsd > 0 ? (topDepositUsd / totalDepositsUsd) * 100 : null;

  const createdMs =
    market.createdTimestamp != null && isFinite(Number(market.createdTimestamp))
      ? Number(market.createdTimestamp) * 1000
      : null;

  const sym = [market.inputToken?.symbol, market.borrowedToken?.symbol].filter(Boolean).join("/");

  return {
    source: "subgraph",
    protocol: "morpho-blue",
    symbol: sym || market.name,
    scoring: {
      totalAssetsUsd: liquidityUsd,
      supplyAssetsUsd: deposit,
      liquidityAssetsUsd: liquidityUsd,
      tvlEvidence:
        liquidityUsd != null
          ? `Morpho subgraph market liquidity ~$${Math.round(liquidityUsd).toLocaleString()} (supply − borrow)`
          : null,
      utilization: util,
      utilizationEvidence: util != null ? `Morpho subgraph utilization ${(util * 100).toFixed(1)}%` : null,
      lltvPct,
      lltvEvidence: lltvPct != null ? `Morpho subgraph LLTV ${lltvPct.toFixed(1)}%` : null,
      poolCreatedAt: createdMs,
      poolAgeSource: createdMs != null ? "subgraph" : null,
      poolAgeEvidence:
        createdMs != null
          ? `Morpho subgraph market created ${new Date(createdMs).toISOString().slice(0, 10)}`
          : null,
      top1DepositorPct: top1Pct,
      depositorConcentrationEvidence:
        top1Pct != null
          ? `Morpho subgraph top depositor ~${top1Pct.toFixed(1)}% of supply (sample)`
          : null,
    },
    subgraphId,
    subgraphUrl: theGraphSubgraphUrl(subgraphId),
  };
}

/**
 * Fetch pool metrics from The Graph subgraphs when configured.
 */
export async function fetchPoolSubgraphMetrics(ctx = {}) {
  if (!subgraphEnabled()) return null;

  const kind = ctx?.protocolKind;
  try {
    if (kind === "aave_reserve") {
      return await fetchAaveReserveSubgraph({
        chain: ctx.chain,
        underlyingAsset: ctx.underlyingAsset || ctx.vaultAddress,
      });
    }
    if (kind === "morpho_market") {
      return await fetchMorphoMarketSubgraph({ marketId: ctx.marketId, chain: ctx.chain });
    }
  } catch (e) {
    return { source: "subgraph", error: String(e?.message || e) };
  }
  return null;
}
