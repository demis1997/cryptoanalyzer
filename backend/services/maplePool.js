/**
 * Maple Finance syrup pool metrics via official GraphQL API.
 */
import fetch from "node-fetch";
const MAPLE_GQL = "https://api.maple.finance/v2/graphql";

const POOL_IDS = {
  syrupusdc: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
  syrupusdt: "0xccbc525ed6b4a4a4e6fb6a9d5566dea3b5566dea3b",
};

async function mapleGql(query, variables = {}) {
  const resp = await fetch(MAPLE_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/maple-pool" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.errors?.length) return null;
  return json?.data || null;
}

function poolIdFromHint(nameHint) {
  const n = String(nameHint || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.includes("syrupusdt")) return POOL_IDS.syrupusdt;
  if (n.includes("syrupusdc") || n.includes("syrup")) return POOL_IDS.syrupusdc;
  return POOL_IDS.syrupusdc;
}

function parseUsd6(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  return n / 1e6;
}

function parseApy30(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  return n / 1e30 * 100;
}

export async function fetchMaplePool({ nameHint, poolId } = {}) {
  const id = (poolId || poolIdFromHint(nameHint)).toLowerCase();

  const query = `
    query Pool($id: ID!) {
      poolV2(id: $id) {
        id name assets depositedAssets totalAssets principalOut weeklyApy monthlyApy
      }
      syrupGlobals {
        collateralRatio loansValue collateralValue
      }
    }`;

  try {
    const data = await mapleGql(query, { id });
    const pool = data?.poolV2;
    if (!pool) return null;

    const totalAssetsUsd = parseUsd6(pool.totalAssets);
    const principalOutUsd = parseUsd6(pool.principalOut);
    const cashUsd = parseUsd6(pool.assets);
    const util =
      totalAssetsUsd != null && principalOutUsd != null && totalAssetsUsd > 0
        ? principalOutUsd / totalAssetsUsd
        : null;

    const globals = data?.syrupGlobals || {};
    const collateralRatioPct = Number(globals.collateralRatio) / 1e8;
    const loansUsd = parseUsd6(globals.loansValue);
    const collateralUsd = parseUsd6(globals.collateralValue);
    const loanToCollateralPct =
      loansUsd != null && collateralUsd != null && collateralUsd > 0
        ? (loansUsd / collateralUsd) * 100
        : null;
    const apyPct = parseApy30(pool.weeklyApy) ?? parseApy30(pool.monthlyApy);

    const sym = /usdt/i.test(pool.name || nameHint || "") ? "syrupUSDT" : "syrupUSDC";

    const scoring = {
      totalAssetsUsd: totalAssetsUsd,
      tvlEvidence: totalAssetsUsd != null ? `Maple API totalAssets $${Math.round(totalAssetsUsd).toLocaleString()}` : null,
      utilization: util,
      utilizationEvidence:
        util != null
          ? `Maple principalOut / totalAssets ${(util * 100).toFixed(1)}% (cash $${Math.round(cashUsd || 0).toLocaleString()})`
          : null,
      lltvPct: loanToCollateralPct,
      lltvEvidence:
        loanToCollateralPct != null
          ? `Maple loans/collateral ${loanToCollateralPct.toFixed(1)}% (protocol CR ${collateralRatioPct.toFixed(1)}%)`
          : null,
      apyPct,
      apyEvidence: apyPct != null ? `Maple API weekly APY ${apyPct.toFixed(2)}%` : null,
      capUtilization: util,
      oracleType: "Chainlink",
      oracleEvidence: "Maple institutional loan oracles / collateral valuation",
    };

    return {
      symbol: sym,
      name: pool.name || `Maple ${sym}`,
      chain: "ethereum",
      vaultAddress: id,
      project: "maple-finance",
      source: "maple_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
