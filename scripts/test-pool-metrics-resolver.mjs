#!/usr/bin/env node
/**
 * Unit tests for poolMetricsResolver (no network when web search disabled).
 */
import { resolvePoolMetrics } from "../backend/services/poolMetricsResolver.js";

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
      Days to maturity: 45
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
    yieldsRow: { symbol: "USDC", project: "morpho", tvlUsd: 500_000_000 },
  }
);

assert(r.scoringHints.poolTvlUsd === 175_200_000, `TVL from crawl ${r.scoringHints.poolTvlUsd}`);
assert(r.scoringHints.tvlSource === "pool_page", `source ${r.scoringHints.tvlSource}`);
assert(r.scoringHints.utilization != null, "utilization parsed");
assert(r.scoringHints.lltv === 86, `lltv ${r.scoringHints.lltv}`);
assert(r.poolIdentity.tvlUsd === 175_200_000, "identity TVL");

const vaultMeta = {
  totalAssetsUsd: 180_000_000,
  tvlEvidence: "Morpho API",
};
const r2 = await resolvePoolMetrics(
  { label: "steakUSDC", issuerSlug: "morpho", vaultMeta: { scoring: vaultMeta } },
  { webResearch: { formatted: "Market TVL $12M" }, yieldsRow: { tvlUsd: 999e6 } }
);
assert(r2.scoringHints.poolTvlUsd === 12_000_000, "pool page beats protocol when higher priority");
assert(r2.scoringHints.tvlSource === "pool_page", "pool_page wins over defillama");

process.exit(failed);
