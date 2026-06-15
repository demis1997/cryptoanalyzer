/**
 * Pendle markets API — pool-specific TVL, maturity, APY, AMM liquidity for scoring.
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";

const CHAIN_IDS = { ethereum: 1, arbitrum: 42161, optimism: 10, base: 8453, polygon: 137 };

function toApyPercent(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  return n <= 1 ? n * 100 : n;
}

function stripChainPrefix(raw) {
  const s = String(raw || "").trim().toLowerCase();
  const m = s.match(/^(?:\d+-)?(0x[a-f0-9]{40})$/);
  return m ? m[1] : null;
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Higher = better name match; 0 = no match. */
function scoreNameMatch(nameNorm, marketName) {
  const n = normName(marketName);
  if (!nameNorm || !n) return 0;
  if (n === nameNorm) return 100;
  if (nameNorm.length < 5) return 0;
  if (n.startsWith(nameNorm) || nameNorm.startsWith(n)) return 60;
  if (n.includes(nameNorm)) return 50;
  if (nameNorm.includes(n) && n.length >= 4) return 35;
  return 0;
}

function pickBetterMarket(a, b) {
  if (!a) return b;
  if (!b) return a;
  const liqA = Number(a.details?.liquidity ?? 0);
  const liqB = Number(b.details?.liquidity ?? 0);
  return liqB > liqA ? b : a;
}

async function fetchMarketsForChain(chainId, maxPages = 8) {
  const markets = [];
  for (let page = 0; page < maxPages; page++) {
    const resp = await fetch(
      `https://api-v2.pendle.finance/core/v2/markets/all?skip=${page * 100}&limit=100`,
      { headers: { "User-Agent": "cryptoanalyzer/pendle-market" } }
    );
    if (!resp.ok) break;
    const json = await resp.json().catch(() => ({}));
    const batch = Array.isArray(json?.results) ? json.results : [];
    markets.push(...batch.filter((m) => Number(m?.chainId) === chainId));
    if (batch.length < 100) break;
  }
  return markets;
}

function marketAddresses(m) {
  return [m?.address, m?.pt, m?.yt, m?.sy, m?.underlyingAsset]
    .map(stripChainPrefix)
    .filter(Boolean);
}

export function extractPendleScoringMeta(market) {
  if (!market) return null;
  const details = market.details || {};
  const totalTvl = Number(details.totalTvl ?? 0);
  const ammLiq = Number(details.liquidity ?? 0);
  // P.7 matches Pendle UI "AMM Liquidity", not protocol-wide totalTvl.
  const tvlUsd =
    isFinite(ammLiq) && ammLiq > 0
      ? ammLiq
      : isFinite(totalTvl) && totalTvl > 0
        ? totalTvl
        : null;

  let daysToMaturity = null;
  if (market.expiry) {
    const expMs = Date.parse(market.expiry);
    if (isFinite(expMs)) daysToMaturity = Math.ceil((expMs - Date.now()) / 86400000);
  }

  const implied = Number(details.impliedApy ?? 0);
  const underlying = Number(details.underlyingApy ?? 0);
  const swapFee = Number(details.swapFeeApy ?? 0);
  const pendleReward = Number(details.pendleApy ?? 0);
  const aggregated = Number(details.aggregatedApy ?? 0);
  const maxBoosted = Number(details.maxBoostedApy ?? 0);

  // Pendle LP pool APY (trade/pools) = aggregated LP yield, not PT implied APY.
  const apyTotal =
    toApyPercent(aggregated) ?? toApyPercent(maxBoosted) ?? toApyPercent(implied);
  const apyBase = toApyPercent(underlying);
  const apyRewardPct =
    apyBase != null && apyTotal != null
      ? Math.max(0, apyTotal - apyBase)
      : toApyPercent(swapFee) != null || toApyPercent(pendleReward) != null
        ? (toApyPercent(swapFee) || 0) + (toApyPercent(pendleReward) || 0)
        : null;
  const impliedApyPct = toApyPercent(implied);

  const tradingVol = Number(details.tradingVolume ?? 0);
  const hasSecondary = ammLiq >= 50_000 || tradingVol > 0;

  return {
    symbol: market.name || null,
    name: market.name || null,
    marketAddress: stripChainPrefix(market.address),
    expiry: market.expiry || null,
    pendleDaysToMaturity: daysToMaturity,
    daysToMaturity,
    maturityEvidence: market.expiry ? `Pendle API expiry ${market.expiry}` : null,
    totalAssetsUsd: tvlUsd,
    tvlUsd,
    tvlSource: "protocol_api",
    tvlEvidence:
      tvlUsd != null
        ? ammLiq > 0
          ? `Pendle API AMM liquidity $${Math.round(ammLiq).toLocaleString()}`
          : `Pendle API totalTvl $${Math.round(totalTvl).toLocaleString()}`
        : null,
    pendleTotalTvlUsd: isFinite(totalTvl) && totalTvl > 0 ? totalTvl : null,
    pendleAmmLiquidityUsd: isFinite(ammLiq) && ammLiq > 0 ? ammLiq : null,
    ammLiquidityUsd: isFinite(ammLiq) && ammLiq > 0 ? ammLiq : null,
    pendleTradingVolumeUsd: isFinite(tradingVol) && tradingVol > 0 ? tradingVol : null,
    pendleSecondaryMarket: hasSecondary,
    pendleSecondaryEvidence: hasSecondary ? "Pendle API: AMM liquidity / trading volume" : "Low AMM liquidity on Pendle API",
    apyPct: apyTotal,
    apyBasePct: apyBase,
    apyRewardPct,
    impliedApyPct,
    apyEvidence:
      apyTotal != null
        ? `Pendle API LP APY ${apyTotal.toFixed(2)}% (aggregated${apyBase != null ? `, ${apyBase.toFixed(2)}% underlying` : ""})`
        : null,
    source: "pendle_api",
    scoring: null,
  };
}

/** Attach nested scoring object for applyVaultScoringMetaToRow. */
export function pendleMetaForVault(market) {
  const base = extractPendleScoringMeta(market);
  if (!base) return null;
  const scoring = {
    totalAssetsUsd: base.tvlUsd,
    tvlEvidence: base.tvlEvidence,
    apyPct: base.apyPct,
    apyBasePct: base.apyBasePct,
    apyRewardPct: base.apyRewardPct,
    apyEvidence: base.apyEvidence,
    pendleDaysToMaturity: base.pendleDaysToMaturity,
    daysToMaturity: base.daysToMaturity,
    maturityEvidence: base.maturityEvidence,
    pendleAmmLiquidityUsd: base.pendleAmmLiquidityUsd,
    ammLiquidityUsd: base.ammLiquidityUsd,
    pendleTradingVolumeUsd: base.pendleTradingVolumeUsd,
    pendleSecondaryMarket: base.pendleSecondaryMarket,
    pendleSecondaryEvidence: base.pendleSecondaryEvidence,
  };
  return { ...base, scoring };
}

/**
 * Find Pendle market by contract address, market address in URL, or name hint.
 */
export async function findPendleMarket({ address, chain, nameHint, poolUrl } = {}) {
  const chainsToTry = [];
  const primary = CHAIN_IDS[normalizePoolChain(chain)] || 1;
  chainsToTry.push(primary);
  if (poolUrl && /arbitrum/i.test(poolUrl)) chainsToTry.push(CHAIN_IDS.arbitrum);
  if (poolUrl && /base/i.test(poolUrl)) chainsToTry.push(CHAIN_IDS.base);

  const addr = stripChainPrefix(address);
  const urlAddr = poolUrl ? stripChainPrefix(poolUrl.match(/0x[a-fA-F0-9]{40}/)?.[0]) : null;
  const wantAddr = addr || urlAddr;
  const nameNorm = normName(nameHint);

  const searchChains = wantAddr
    ? [...new Set(chainsToTry)]
    : [...new Set([primary, CHAIN_IDS.arbitrum, CHAIN_IDS.ethereum, CHAIN_IDS.base])];

  let bestByName = null;
  let bestScore = 0;

  for (const chainId of searchChains) {
    const markets = await fetchMarketsForChain(chainId);
    if (wantAddr) {
      const hit = markets.find((m) => marketAddresses(m).includes(wantAddr));
      if (hit) return { market: hit, chainId };
    }
    if (nameNorm) {
      for (const m of markets) {
        const score = scoreNameMatch(nameNorm, m?.name);
        if (score <= 0) continue;
        const minScore = nameNorm.length < 5 ? 100 : 50;
        if (score < minScore) continue;
        if (score > bestScore) {
          bestScore = score;
          bestByName = m;
        } else if (score === bestScore) {
          bestByName = pickBetterMarket(bestByName, m);
        }
      }
    }
  }

  if (bestByName) return { market: bestByName, chainId: Number(bestByName.chainId) };
  return null;
}

export function syntheticYieldsRowFromPendle(market, chain, vaultAddress) {
  const meta = extractPendleScoringMeta(market);
  const chainName = Object.entries(CHAIN_IDS).find(([, id]) => id === Number(market.chainId))?.[0] || chain || "ethereum";
  return {
    symbol: meta?.symbol || "Pendle",
    project: "pendle",
    chain: normalizePoolChain(chainName),
    vaultAddress: vaultAddress || meta?.marketAddress,
    poolMeta: "Pendle market",
    tvlUncertain: false,
    ...meta,
  };
}
