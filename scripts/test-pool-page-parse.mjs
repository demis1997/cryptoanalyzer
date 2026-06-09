#!/usr/bin/env node
import { parsePoolPageMetrics } from "../backend/services/poolPageParse.js";
import { buildPoolRiskAssessment } from "../backend/llm/poolScoring.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = 1;
  } else {
    console.log("OK:", msg);
  }
}

const morphoText = `
steakUSDC MetaMorpho vault
Total liquidity: $182.4M
Utilization rate: 78.5%
LLTV: 86%
Supply cap 92% filled
`;

const m = parsePoolPageMetrics(morphoText);
assert(m.poolTvlUsd === 182_400_000, `TVL parsed ${m.poolTvlUsd}`);
assert(Math.abs(m.utilization - 0.785) < 0.001, `util ${m.utilization}`);
assert(m.lltv === 86, `lltv ${m.lltv}`);

const pendleText = `PT-weETH market · Days to maturity: 62 · No active secondary market · Market TVL: $45.2M`;
const p = parsePoolPageMetrics(pendleText);
assert(p.pendleDaysToMaturity === 62, `maturity ${p.pendleDaysToMaturity}`);
assert(p.pendleSecondaryMarket === false, "no secondary");
assert(p.poolTvlUsd === 45_200_000, `pendle tvl ${p.poolTvlUsd}`);

const p4 = buildPoolRiskAssessment({
  label: "test vault",
  yieldsRows: [{ symbol: "USDC", apyBase: 5 }],
  integrators: [{ name: "Morpho", id: "morpho" }],
});
const p4c = p4.criteria.find((c) => c.key === "parameterSafety");
assert(p4c.unavailable === true, "P.4 unavailable without LLTV");

const p2 = buildPoolRiskAssessment({
  label: "PT-weETH",
  yieldsRows: [{ symbol: "PT-weETH", apyBase: 5, pendleDaysToMaturity: 62, pendleSecondaryMarket: false }],
});
const p2c = p2.criteria.find((c) => c.key === "liquidityExit");
assert(p2c.score === 0.5, `P.2 Pendle score ${p2c.score}`);
assert(Boolean(p2c.calcBreakdown), "P.2 calc breakdown");

const p7 = buildPoolRiskAssessment({
  yieldsRows: [{ symbol: "USDC", tvlUsd: 999_000_000, tvlUncertain: true }],
});
const p7c = p7.criteria.find((c) => c.key === "poolTvl");
assert(p7c.unavailable === true, "P.7 rejects uncertain DefiLlama TVL");

const p7ok = buildPoolRiskAssessment({
  yieldsRows: [{ symbol: "USDC", tvlUsd: 50_000_000, tvlSource: "pool_page", tvlEvidence: "parsed" }],
});
const p7okc = p7ok.criteria.find((c) => c.key === "poolTvl");
assert(p7okc.score === 0.8, `P.7 pool page TVL score ${p7okc.score}`);

process.exit(failed);
