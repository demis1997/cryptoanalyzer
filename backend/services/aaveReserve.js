/**
 * Aave V3 reserve data via official GraphQL API.
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";
const CHAIN_IDS = { ethereum: 1, arbitrum: 42161, optimism: 10, base: 8453, polygon: 137 };

async function aaveGql(query) {
  const resp = await fetch("https://api.v3.aave.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/aave-reserve" },
    body: JSON.stringify({ query }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.data) return null;
  return json.data;
}

export async function fetchAaveReserve({ chain, underlyingAsset }) {
  const addr = String(underlyingAsset || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const chainId = CHAIN_IDS[normalizePoolChain(chain)];
  if (!chainId) return null;

  const query = `{
    markets(request: { chainIds: [${chainId}] }) {
      name
      reserves {
        underlyingToken { symbol address }
        supplyInfo { total { value } apy { value } }
        borrowInfo { utilizationRate { value } }
        size { usd }
      }
    }
  }`;

  try {
    const data = await aaveGql(query);
    const market = data?.markets?.[0];
    if (!market) return null;
    const reserve = (market.reserves || []).find(
      (r) => String(r?.underlyingToken?.address || "").toLowerCase() === addr
    );
    if (!reserve) return null;

    const tvlUsd = Number(reserve?.size?.usd);
    const util = Number(reserve?.borrowInfo?.utilizationRate?.value);
    const apy = Number(reserve?.supplyInfo?.apy?.value);
    const scoring = {
      totalAssetsUsd: isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : null,
      tvlEvidence: isFinite(tvlUsd) ? `Aave API reserve size $${Math.round(tvlUsd).toLocaleString()}` : null,
      utilization: isFinite(util) ? util : null,
      utilizationEvidence: isFinite(util) ? `Aave API utilization ${(util * 100).toFixed(1)}%` : null,
      apyPct: isFinite(apy) ? apy * 100 : null,
      apyEvidence: isFinite(apy) ? `Aave API supply APY ${(apy * 100).toFixed(2)}%` : null,
      oracleType: "Chainlink",
      oracleEvidence: "Aave V3 oracle infrastructure (Chainlink/Pyth)",
    };
    return {
      symbol: reserve.underlyingToken?.symbol || null,
      name: `${reserve.underlyingToken?.symbol || "Reserve"} (${market.name})`,
      chain: normalizePoolChain(chain),
      underlyingAsset: addr,
      project: "aave-v3",
      source: "aave_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
