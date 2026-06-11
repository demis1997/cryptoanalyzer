#!/usr/bin/env node
import { parsePoolPageMetrics } from "../backend/services/poolPageParse.js";
import { parseStructuredPoolMetrics } from "../backend/services/poolPageStructuredParse.js";
import { applyExternalDataToYieldsRows } from "../backend/services/poolDataSources.js";
import { applyVaultScoringMetaToRow } from "../backend/services/scoringAudit.js";
import { fetchMorphoMarketById } from "../backend/services/morphoMarket.js";
import { fetchAaveReserve } from "../backend/services/aaveReserve.js";
import { fetchCompoundMarket } from "../backend/services/compoundMarket.js";
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

const morphoSpaText = `WBTC / USDC
Market
Total Liquidity
$16.55M
Utilization
89.17%
LLTV
86%
Net APY
4.2%`;
const morphoSpa = parseStructuredPoolMetrics(morphoSpaText, {
  url: "https://app.morpho.org/ethereum/market/0xabc/wbtc-usdc",
});
assert(Math.round(morphoSpa.poolTvlUsd) === 16_550_000, `Morpho SPA TVL ${morphoSpa.poolTvlUsd}`);
assert(Math.abs(morphoSpa.utilization - 0.8917) < 0.001, `Morpho SPA util ${morphoSpa.utilization}`);
assert(morphoSpa.lltv === 86, `Morpho SPA lltv ${morphoSpa.lltv}`);

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

const morphoMkt = await fetchMorphoMarketById(
  "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49",
  "ethereum"
);
assert(morphoMkt?.scoring?.liquidityAssetsUsd > 0, "morpho market liquidity");
assert(
  morphoMkt.scoring.totalAssetsUsd === morphoMkt.scoring.liquidityAssetsUsd,
  "P.7 uses liquidity not supply"
);
assert(morphoMkt.scoring.totalAssetsUsd < morphoMkt.scoring.supplyAssetsUsd / 2, "liquidity << supply");
const morphoRow = applyVaultScoringMetaToRow(
  { symbol: "WBTC/USDC", project: "morpho-blue", tvlSource: "protocol_api" },
  morphoMkt.scoring
);
const morphoRisk = buildPoolRiskAssessment({
  label: "WBTC/USDC",
  issuerSlug: "morpho",
  yieldsRows: [morphoRow],
});
const p7m = morphoRisk.criteria.find((c) => c.key === "poolTvl");
const p6m = morphoRisk.criteria.find((c) => c.key === "poolAge");
assert(p7m.score === 0.8, `Morpho market P.7 ~$15M liquidity: ${p7m.input} score ${p7m.score}`);
assert(p7m.input.replace(/,/g, "").includes("15194") || p7m.input.includes("14"), `P.7 ~$15M not supply ${p7m.input}`);
assert(/liquidityAssetsUsd/i.test(p7m.evidence), `P.7 evidence ${p7m.evidence}`);
assert(!p6m.unavailable, `P.6 from creationTimestamp ${p6m.input}`);
assert(p6m.score >= 0.7, `P.6 ~16mo market age ${p6m.score}`);

const aaveDai = await fetchAaveReserve({
  chain: "ethereum",
  underlyingAsset: "0x6b175474e89094c44da98b954eedeac495271d0f",
});
assert(aaveDai?.liquidityAssetsUsd > 0, "aave liquidity");
assert(aaveDai.totalAssetsUsd === aaveDai.liquidityAssetsUsd, "aave P.7 uses available liquidity");
assert(aaveDai.totalAssetsUsd < aaveDai.supplyAssetsUsd / 2, "aave liquidity << supply");
assert(aaveDai.poolCreatedAt > 0, `aave pool age ${aaveDai.poolCreatedAt}`);
const aaveRow = applyVaultScoringMetaToRow(
  { symbol: "DAI", project: "aave-v3", tvlSource: "protocol_api" },
  aaveDai.scoring
);
const aaveRisk = buildPoolRiskAssessment({ label: "DAI", issuerSlug: "aave", yieldsRows: [aaveRow] });
const p7a = aaveRisk.criteria.find((c) => c.key === "poolTvl");
const p6a = aaveRisk.criteria.find((c) => c.key === "poolAge");
assert(!p6a.unavailable, `Aave P.6 ${p6a.input}`);
assert(/availableLiquidity/i.test(p7a.evidence), `Aave P.7 ${p7a.evidence}`);

const comp = await fetchCompoundMarket({ marketSlug: "usdc-op", chain: "optimism" });
assert(comp?.liquidityAssetsUsd > 0, "compound cash liquidity");
assert(comp.totalAssetsUsd < (comp.supplyAssetsUsd || Infinity), "compound cash < supply");
assert(comp.poolCreatedAt > 0, `compound pool age ${comp.poolCreatedAt}`);
const compRow = applyVaultScoringMetaToRow(
  { symbol: "USDC", project: "compound", tvlSource: "protocol_api" },
  comp.scoring
);
const compRisk = buildPoolRiskAssessment({ label: "USDC", issuerSlug: "compound", yieldsRows: [compRow] });
const p7comp = compRisk.criteria.find((c) => c.key === "poolTvl");
const p6comp = compRisk.criteria.find((c) => c.key === "poolAge");
assert(!p6comp.unavailable, `Compound P.6 ${p6comp.input}`);
assert(/cash liquidity/i.test(p7comp.evidence), `Compound P.7 ${p7comp.evidence}`);

process.exit(failed);
