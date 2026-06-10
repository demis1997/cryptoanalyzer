#!/usr/bin/env node
import { parsePoolPageMetrics } from "../backend/services/poolPageParse.js";
import { applyExternalDataToYieldsRows } from "../backend/services/poolDataSources.js";
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
Net APY: 7.2%
Base APY: 5.1%
Reward APY: 2.1%
Launched: 2024-03-15
`;

const m = parsePoolPageMetrics(morphoText);
assert(m.poolTvlUsd === 182_400_000, `TVL parsed ${m.poolTvlUsd}`);
assert(Math.abs(m.utilization - 0.785) < 0.001, `util ${m.utilization}`);
assert(m.lltv === 86, `lltv ${m.lltv}`);
assert(m.apyBase === 5.1, `apyBase ${m.apyBase}`);
assert(m.apyReward === 2.1, `apyReward ${m.apyReward}`);
assert(m.poolCreatedAt != null, "launch date parsed");

const pendleText = `PT-weETH market · Days to maturity: 62 · No active secondary market · Market TVL: $45.2M`;
const pendleAmmText = `sUSDai market\nAMM Liquidity\n$8.21M`;
const p = parsePoolPageMetrics(pendleText);
assert(p.pendleDaysToMaturity === 62, `maturity ${p.pendleDaysToMaturity}`);
assert(p.pendleSecondaryMarket === false, "no secondary");
assert(p.poolTvlUsd === 45_200_000, `pendle tvl ${p.poolTvlUsd}`);
const pa = parsePoolPageMetrics(pendleAmmText);
assert(Math.round(pa.poolTvlUsd) === 8_210_000, `AMM liquidity tvl ${pa.poolTvlUsd}`);
assert(Math.round(pa.pendleAmmLiquidityUsd) === 8_210_000, `AMM liq field ${pa.pendleAmmLiquidityUsd}`);

const stakingText = `weETH staking vault · Withdrawal queue: 5 days · Trade on Uniswap for instant exit`;
const st = parsePoolPageMetrics(stakingText);
assert(st.withdrawalQueueDays === 5, `staking queue ${st.withdrawalQueueDays}`);
assert(st.stakingSecondaryMarket === true, "staking secondary");

const cooldownText = `Ethena USDe vault · Cooldown period: 3 days before withdrawal`;
const cd = parsePoolPageMetrics(cooldownText);
assert(cd.vaultCooldownDays === 3, `cooldown ${cd.vaultCooldownDays}`);

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

const pendleAmm = buildPoolRiskAssessment({
  label: "sUSDai",
  issuerSlug: "pendle",
  yieldsRows: [
    {
      symbol: "sUSDai",
      project: "pendle",
      pendleAmmLiquidityUsd: 8_210_000,
      tvlUsd: 24_000_000,
      tvlSource: "protocol_api",
      tvlEvidence: "Pendle API",
    },
  ],
});
assert(pendleAmm.poolType === "pendle_pt", `pendle pool type ${pendleAmm.poolType}`);
const p2amm = pendleAmm.criteria.find((c) => c.key === "liquidityExit");
assert(p2amm.unavailable === true, `P.2 excludes AMM-only Pendle ${p2amm.score}`);
const p4na = pendleAmm.criteria.find((c) => c.key === "parameterSafety");
assert(p4na.na === true, "P.4 N/A for Pendle");
const p7pendle = pendleAmm.criteria.find((c) => c.key === "poolTvl");
assert(p7pendle.score === 0.6, `P.7 Pendle AMM TVL score ${p7pendle.score}`);
assert(p7pendle.input.includes("8,210,000"), `P.7 uses AMM not totalTvl: ${p7pendle.input}`);

const [dlPendleRow] = applyExternalDataToYieldsRows(
  [
    {
      symbol: "sUSDai",
      project: "pendle",
      pool: "fake-pool-id",
      tvlUsd: 20_000_000_000,
      tvlSource: "defillama",
    },
  ],
  {
    scoringHints: {
      pendleAmmLiquidityUsd: 8_210_000,
      ammLiquidityUsd: 8_210_000,
    },
  }
);
assert(Math.round(dlPendleRow.tvlUsd) === 8_210_000, `strip DL TVL for Pendle AMM ${dlPendleRow.tvlUsd}`);
assert(dlPendleRow.tvlSource === "protocol_api", `Pendle TVL source ${dlPendleRow.tvlSource}`);

const pendleMaturity = buildPoolRiskAssessment({
  label: "PT-weETH",
  issuerSlug: "pendle",
  yieldsRows: [
    {
      symbol: "PT-weETH",
      project: "pendle",
      pendleDaysToMaturity: 120,
      pendleAmmLiquidityUsd: 8_210_000,
      pendleSecondaryMarket: true,
    },
  ],
});
const p2mat = pendleMaturity.criteria.find((c) => c.key === "liquidityExit");
assert(p2mat.score === 0.9, `P.2 Pendle maturity+secondary ${p2mat.score}`);

const stakingRisk = buildPoolRiskAssessment({
  label: "weETH",
  yieldsRows: [{ symbol: "weETH", withdrawalQueueDays: 5, stakingSecondaryMarket: true }],
});
assert(stakingRisk.poolType === "staking", `staking type ${stakingRisk.poolType}`);
const p2st = stakingRisk.criteria.find((c) => c.key === "liquidityExit");
assert(p2st.score === 0.8, `P.2 staking queue+secondary ${p2st.score}`);

const vaultRisk = buildPoolRiskAssessment({
  label: "USDe vault",
  yieldsRows: [{ symbol: "USDe", poolMeta: "earn vault", vaultCooldownDays: 3 }],
});
const p2cd = vaultRisk.criteria.find((c) => c.key === "liquidityExit");
assert(p2cd.score === 0.7, `P.2 vault cooldown ${p2cd.score}`);

const ammRisk = buildPoolRiskAssessment({
  label: "USDC/WETH",
  yieldsRows: [{ symbol: "USDC-WETH", poolMeta: "uniswap v3", tvlUsd: 15_000_000, tvlSource: "pool_page" }],
});
assert(ammRisk.poolType === "amm_lp", `amm type ${ammRisk.poolType}`);
const p2ammLiq = ammRisk.criteria.find((c) => c.key === "liquidityExit");
assert(p2ammLiq.score === 0.9, `P.2 deep AMM ${p2ammLiq.score}`);

const morphoP2 = buildPoolRiskAssessment({
  label: "steakUSDC",
  yieldsRows: [
    {
      symbol: "USDC",
      utilization: 0.72,
      utilizationEvidence: "Morpho API market utilization 72.0%",
      poolMeta: "MetaMorpho",
    },
  ],
  integrators: [{ name: "Morpho", id: "morpho" }],
});
const p2util = morphoP2.criteria.find((c) => c.key === "liquidityExit");
assert(p2util.score === 0.85, `P.2 lending util ${p2util.score}`);
assert(/Morpho API/i.test(p2util.confidenceReason), `P.2 audit text ${p2util.confidenceReason}`);

process.exit(failed);
