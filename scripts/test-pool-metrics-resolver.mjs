#!/usr/bin/env node
import { resolvePoolMetrics } from "../backend/services/poolMetricsResolver.js";
import { pickBestTvlCandidate } from "../backend/services/tvlSourcePriority.js";

process.env.POOL_WEB_SEARCH = "0";
process.env.POOL_DUNE_SEARCH = "0";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = 1;
  } else {
    console.log("OK:", msg);
  }
}

const webResearch = {
  crawl: {
    formatted: `
      steakUSDC vault on Morpho
      Total Value Locked: $175.2M
      Utilization: 72.3%
      LLTV 86%
    `,
  },
  formatted: "",
};

const r = await resolvePoolMetrics(
  {
    label: "steakUSDC",
    issuerSlug: "morpho",
    vaultAddress: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
    chain: "ethereum",
  },
  {
    webResearch,
    yieldsRow: { symbol: "USDC", project: "morpho", tvlUsd: 500_000_000, pool: "abc-123" },
  }
);

assert(r.scoringHints.poolTvlUsd === 175_200_000, `TVL from crawl when no API ${r.scoringHints.poolTvlUsd}`);
assert(r.scoringHints.tvlSource === "pool_page", `source ${r.scoringHints.tvlSource}`);

const vaultMeta = {
  totalAssetsUsd: 15_194_000,
  tvlEvidence: "Morpho API liquidityAssetsUsd",
};
const r2 = await resolvePoolMetrics(
  {
    label: "WBTC/USDC",
    issuerSlug: "morpho",
    vaultMeta: { scoring: vaultMeta, source: "morpho_api" },
  },
  {
    webResearch: {
      crawl: { formatted: "Total Liquidity $16.55M" },
      formatted: "Market TVL $12M from search",
    },
    yieldsRow: { tvlUsd: 999e6, pool: "dl-pool-id" },
  }
);
assert(r2.scoringHints.tvlSource === "protocol_api", `protocol beats crawl: ${r2.scoringHints.tvlSource}`);
assert(r2.scoringHints.poolTvlUsd === 15_194_000, `API TVL ${r2.scoringHints.poolTvlUsd}`);
assert(
  r2.scoringHints.tvlCandidates?.some((c) => c.source === "web_search"),
  "web_search kept as candidate"
);

const sgPick = pickBestTvlCandidate([
  { value: 15_194_000, source: "protocol_api", evidence: "API" },
  { value: 15_200_000, source: "subgraph", evidence: "Subgraph" },
]);
assert(sgPick?.source === "subgraph", `POOL_SUBGRAPH_PREFER picks subgraph: ${sgPick?.source}`);

process.exit(failed);
