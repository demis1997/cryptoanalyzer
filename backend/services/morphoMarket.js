/**
 * Morpho Blue market resolution by bytes32 marketId.
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";
import { parseMorphoLltv } from "./scoringAudit.js";
import { morphoGraphqlUrl, morphoMarketPageUrl } from "./sourceUrls.js";
import { resolvePoolCreatedAtMs } from "./poolContractAge.js";

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
      creationTimestamp
      state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
    }
  }`;

  try {
    const data = await morphoGql(q, { marketId: id, chainId });
    const m = data?.marketById;
    if (!m) return null;

    const loan = m.loanAsset?.symbol || "?";
    const coll = m.collateralAsset?.symbol || "?";
    const supplyUsd = Number(m.state?.supplyAssetsUsd);
    const liquidityUsd = Number(m.state?.liquidityAssetsUsd);
    // Morpho market UI TVL = available loan-side liquidity, not total supply.
    const tvlUsd =
      isFinite(liquidityUsd) && liquidityUsd > 0
        ? liquidityUsd
        : isFinite(supplyUsd) && supplyUsd > 0
          ? supplyUsd
          : null;
    const util = Number(m.state?.utilization);
    const lltv = parseMorphoLltv(m.lltv);
    const ageMeta = await resolvePoolCreatedAtMs({
      marketId: id,
      chain: normalizePoolChain(chain),
      protocolKind: "morpho_market",
    });

    const scoring = {
      totalAssetsUsd: tvlUsd,
      supplyAssetsUsd: isFinite(supplyUsd) && supplyUsd > 0 ? supplyUsd : null,
      liquidityAssetsUsd: isFinite(liquidityUsd) && liquidityUsd > 0 ? liquidityUsd : null,
      tvlEvidence:
        tvlUsd != null
          ? isFinite(liquidityUsd) && liquidityUsd > 0
            ? `Morpho API liquidityAssetsUsd $${Math.round(liquidityUsd).toLocaleString()} (market liquidity)`
            : `Morpho API supplyAssetsUsd $${Math.round(supplyUsd).toLocaleString()}`
          : null,
      utilization: isFinite(util) ? util : null,
      utilizationEvidence: isFinite(util) ? `Morpho API market utilization ${(util * 100).toFixed(1)}%` : null,
      lltvPct: lltv,
      lltvEvidence: lltv != null ? `Morpho API LLTV ${lltv.toFixed(1)}%` : null,
      oracleType: m.oracle?.address ? "Chainlink" : null,
      oracleEvidence: m.oracle?.address ? `Morpho oracle ${m.oracle.address}` : null,
      poolCreatedAt: ageMeta?.poolCreatedAt ?? null,
      poolAgeEvidence: ageMeta?.poolAgeEvidence ?? null,
      poolAgeSource: ageMeta?.poolAgeSource ?? null,
      poolAgeExplorerUrl: ageMeta?.poolAgeExplorerUrl ?? null,
    };

    return {
      marketId: id,
      symbol: `${coll}/${loan}`,
      name: `Morpho ${coll}/${loan}`,
      chain: normalizePoolChain(chain),
      project: "morpho-blue",
      source: "morpho_api",
      sourceUrl: morphoGraphqlUrl(),
      marketPageUrl: morphoMarketPageUrl(chain, id, `${coll}-${loan}`.toLowerCase()),
      tvlSource: "protocol_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
