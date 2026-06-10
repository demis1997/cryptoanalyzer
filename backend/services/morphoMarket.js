/**
 * Morpho Blue market resolution by bytes32 marketId.
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";
import { parseMorphoLltv } from "./scoringAudit.js";

const CHAIN_IDS = { ethereum: 1, arbitrum: 42161, optimism: 10, base: 8453, polygon: 137 };

async function morphoGql(query, variables) {
  const resp = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/morpho-market" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.data) return null;
  return json.data;
}

export async function fetchMorphoMarketById(marketId, chain) {
  const id = String(marketId || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(id)) return null;
  const chainId = CHAIN_IDS[normalizePoolChain(chain)];
  if (!chainId) return null;

  const q = `
  query Market($marketId: String!, $chainId: Int!) {
    marketById(marketId: $marketId, chainId: $chainId) {
      lltv
      loanAsset { symbol address }
      collateralAsset { symbol address }
      oracle { address }
      state { supplyAssetsUsd borrowAssetsUsd utilization }
    }
  }`;

  try {
    const data = await morphoGql(q, { marketId: id, chainId });
    const m = data?.marketById;
    if (!m) return null;

    const loan = m.loanAsset?.symbol || "?";
    const coll = m.collateralAsset?.symbol || "?";
    const tvlUsd = Number(m.state?.supplyAssetsUsd);
    const util = Number(m.state?.utilization);
    const lltv = parseMorphoLltv(m.lltv);

    const scoring = {
      totalAssetsUsd: isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : null,
      tvlEvidence: isFinite(tvlUsd) ? `Morpho API supplyAssetsUsd $${Math.round(tvlUsd).toLocaleString()}` : null,
      utilization: isFinite(util) ? util : null,
      utilizationEvidence: isFinite(util) ? `Morpho API market utilization ${(util * 100).toFixed(1)}%` : null,
      lltvPct: lltv,
      lltvEvidence: lltv != null ? `Morpho API LLTV ${lltv.toFixed(1)}%` : null,
      oracleType: m.oracle?.address ? "Chainlink" : null,
      oracleEvidence: m.oracle?.address ? `Morpho oracle ${m.oracle.address}` : null,
    };

    return {
      marketId: id,
      symbol: `${coll}/${loan}`,
      name: `Morpho ${coll}/${loan}`,
      chain: normalizePoolChain(chain),
      project: "morpho-blue",
      source: "morpho_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
