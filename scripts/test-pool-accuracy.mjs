#!/usr/bin/env node
/**
 * Accuracy validation for pool URLs — compares protocol API vs crawl vs final scoring row.
 * Run: POOL_INTELLIGENCE_LLM=0 POOL_WEB_SEARCH=0 node scripts/test-pool-accuracy.mjs
 */
import { parseProtocolPoolUrl } from "../backend/services/protocolUrlParse.js";
import { resolvePoolFromProtocolTarget } from "../backend/services/poolProtocolResolver.js";
import { enrichYieldsForScoring } from "../backend/services/poolScoringEnrich.js";
import { selectPrimaryYieldsRow } from "../backend/services/poolAddress.js";
import { buildPoolRiskAssessment } from "../backend/llm/poolScoring.js";
import { crawlPoolWebsite } from "../backend/services/poolCrawl.js";

const POOLS = [
  { id: 1, protocol: "Aave V3", symbol: "DAI", chain: "ethereum", url: "https://app.aave.com/reserve-overview/?underlyingAsset=0x6b175474e89094c44da98b954eedeac495271d0f&marketName=proto_mainnet_v3" },
  { id: 2, protocol: "SparkLend", symbol: "wstETH", chain: "ethereum", url: "https://app.spark.fi/markets/1/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { id: 3, protocol: "Compound", symbol: "USDC", chain: "optimism", url: "https://app.compound.finance/markets/usdc-op" },
  { id: 4, protocol: "Pendle", chain: "arbitrum", url: "https://app.pendle.finance/trade/pools/0x299674f6da858f903d77486fba50bc9f2e0db24d/zap/in?chain=arbitrum&page=1" },
  { id: 5, protocol: "Hyperliquid", url: "https://app.hyperliquid.xyz/vaults/0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" },
  { id: 6, protocol: "Pendle", chain: "arbitrum", url: "https://app.pendle.finance/trade/pools/0x46d62a8dede1bf2d0de04f2ed863245cbba5e538/zap/in?chain=arbitrum" },
  { id: 7, protocol: "Morpho", chain: "base", url: "https://app.morpho.org/base/market/0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836/cbbtc-usdc" },
  { id: 8, protocol: "Morpho", chain: "ethereum", url: "https://app.morpho.org/ethereum/market/0x15bb2a6af0c909eed19fb1f2ceeead34ecbdcba626de752c6b09389ee14eec32/kbtc-rlusd" },
  { id: 9, protocol: "Maple", symbol: "syrupUSDC", url: "https://app.maple.finance/earn" },
  { id: 10, protocol: "Aave v3", symbol: "DAI", chain: "polygon", url: "https://app.aave.com/reserve-overview/?underlyingAsset=0x8f3cf7ad23cd3cadbd9735aff958023239c6a063&marketName=proto_polygon_v3" },
  { id: 11, protocol: "Kamino", symbol: "Steakhouse USDC", chain: "solana", url: "https://kamino.com/earn/lend/steakhouse-usdc/vault-overview" },
  { id: 12, protocol: "Fluid", symbol: "wstETH", chain: "ethereum", url: "https://fluid.io/lending/1" },
];

process.env.POOL_INTELLIGENCE_LLM = "0";
process.env.POOL_WEB_SEARCH = "0";
process.env.POOL_SCORING_SEARCH = "0";
process.env.POOL_DUNE_SEARCH = "0";

const MAX_POOL_TVL = 5_000_000_000;
const WARN_DRIFT_PCT = 15;

function fmtUsd(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function driftPct(a, b) {
  if (!a || !b) return null;
  return (Math.abs(a - b) / Math.max(a, b)) * 100;
}

const results = [];
let issues = 0;

for (const pool of POOLS) {
  const parsed = parseProtocolPoolUrl(pool.url);
  const ctx = { ...parsed, url: pool.url, label: pool.protocol };
  const line = { id: pool.id, protocol: pool.protocol, url: pool.url, flags: [] };

  if (pool.chain && parsed.chain !== pool.chain) {
    line.flags.push(`chain: expected ${pool.chain}, got ${parsed.chain}`);
  }

  const apiResolved = await resolvePoolFromProtocolTarget(ctx, [], null).catch(() => null);
  const apiRow = apiResolved?.yieldsRows?.[0];
  const apiTvl = apiRow?.tvlUsd;
  const apiMeta = apiResolved?.vaultMeta?.scoring || apiResolved?.vaultMeta;

  line.parsed = {
    protocolKind: parsed.protocolKind,
    chain: parsed.chain,
    vault: parsed.vaultAddress || parsed.underlyingAsset,
    marketId: parsed.marketId?.slice(0, 14),
  };
  line.api = {
    symbol: apiRow?.symbol,
    tvl: apiTvl,
    tvlSource: apiRow?.tvlSource,
    tvlEvidence: apiRow?.tvlEvidence?.slice(0, 80),
    utilization: apiRow?.utilization,
    lltv: apiRow?.lltv,
    poolCreatedAt: apiRow?.poolCreatedAt,
  };

  let crawlTvl = null;
  let crawlEvidence = null;
  const doCrawl = /^(1|true|yes)$/i.test(String(process.env.POOL_ACCURACY_CRAWL || "").trim());
  try {
    if (!doCrawl) throw new Error("crawl skipped");
    const crawl = await crawlPoolWebsite(pool.url, { maxPages: 1, timeBudgetMs: 45_000 });
    const m = crawl.pages?.[0]?.metrics;
    crawlTvl = m?.poolTvlUsd;
    crawlEvidence = m?.tvlEvidence?.slice(0, 80);
    line.crawl = { ok: crawl.ok, tvl: crawlTvl, evidence: crawlEvidence, rendered: crawl.pages?.[0]?.rendered };
  } catch (e) {
    line.crawl = { skipped: !doCrawl, error: doCrawl ? String(e?.message || e) : null };
  }

  const enriched = await enrichYieldsForScoring(ctx).catch((e) => ({ error: String(e?.message || e) }));
  const finalRow = enriched?.yieldsRows ? selectPrimaryYieldsRow(enriched.yieldsRows, ctx) : null;
  line.final = {
    symbol: finalRow?.symbol,
    tvl: finalRow?.tvlUsd,
    tvlSource: finalRow?.tvlSource,
    tvlEvidence: finalRow?.tvlEvidence?.slice(0, 80),
    utilization: finalRow?.utilization,
    lltv: finalRow?.lltv,
    poolCreatedAt: finalRow?.poolCreatedAt,
    vaultAddress: finalRow?.vaultAddress,
    marketId: finalRow?.marketId?.slice(0, 14),
  };

  const risk = finalRow
    ? buildPoolRiskAssessment({ label: pool.protocol, url: pool.url, yieldsRows: enriched.yieldsRows })
    : null;
  line.scoring = {
    poolType: risk?.poolType,
    score: risk?.poolScore,
    p7: risk?.criteria?.find((c) => c.key === "poolTvl"),
    p6: risk?.criteria?.find((c) => c.key === "poolAge"),
  };

  if (!finalRow?.tvlUsd || finalRow.tvlUncertain) line.flags.push("missing or uncertain final TVL");
  if (finalRow?.tvlUsd > MAX_POOL_TVL) line.flags.push(`TVL looks like protocol aggregate: ${fmtUsd(finalRow.tvlUsd)}`);
  if (pool.symbol && finalRow?.symbol && !String(finalRow.symbol).toLowerCase().includes(pool.symbol.toLowerCase().split(" ")[0].slice(0, 4))) {
    if (pool.id !== 9) line.flags.push(`symbol mismatch: expected ~${pool.symbol}, got ${finalRow.symbol}`);
  }
  if (apiTvl && finalRow?.tvlUsd && finalRow.tvlSource !== "protocol_api" && finalRow.tvlSource !== "on_chain") {
    line.flags.push(`final TVL source ${finalRow.tvlSource} overrides API ${fmtUsd(apiTvl)}`);
  }
  if (apiTvl && crawlTvl) {
    const d = driftPct(apiTvl, crawlTvl);
    if (d != null && d > WARN_DRIFT_PCT) line.flags.push(`API vs crawl drift ${d.toFixed(1)}% (API ${fmtUsd(apiTvl)} vs crawl ${fmtUsd(crawlTvl)})`);
  }
  if (apiTvl && finalRow?.tvlUsd) {
    const d = driftPct(apiTvl, finalRow.tvlUsd);
    if (d != null && d > 5 && finalRow.tvlSource === "protocol_api") {
      line.flags.push(`final vs API drift ${d.toFixed(1)}%`);
    }
  }
  if (parsed.vaultAddress && finalRow?.vaultAddress && parsed.vaultAddress !== finalRow.vaultAddress) {
    line.flags.push(`vault address mismatch`);
  }
  if (parsed.marketId && finalRow?.marketId && parsed.marketId !== finalRow.marketId) {
    line.flags.push(`marketId mismatch`);
  }

  if (line.flags.length) issues += line.flags.length;
  results.push(line);

  console.log(`\n#${pool.id} ${pool.protocol}`);
  console.log(`  URL parse: ${parsed.protocolKind} · ${parsed.chain} · ${parsed.vaultAddress?.slice(0, 10) || parsed.marketId?.slice(0, 14) || "?"}`);
  console.log(`  API:       ${line.api.symbol || "?"} · TVL ${fmtUsd(apiTvl)} (${apiRow?.tvlSource || "?"}) · util ${apiRow?.utilization != null ? (apiRow.utilization * 100).toFixed(1) + "%" : "—"} · LLTV ${apiRow?.lltv ?? "—"}`);
  console.log(`  Crawl:     TVL ${fmtUsd(crawlTvl)} ${crawlEvidence ? `· ${crawlEvidence}` : ""}`);
  console.log(`  Final:     ${line.final.symbol || "?"} · TVL ${fmtUsd(line.final.tvl)} (${line.final.tvlSource}) · P.7 ${line.scoring.p7?.unavailable ? "N/A" : line.scoring.p7?.score}`);
  if (line.flags.length) console.log(`  ⚠ ${line.flags.join(" · ")}`);
  else console.log(`  ✓ OK`);
}

console.log(`\n=== Summary: ${results.length} pools, ${issues} issue(s) ===`);
const failed = results.filter((r) => r.flags.length);
if (failed.length) {
  for (const r of failed) console.log(`  #${r.id} ${r.protocol}: ${r.flags.join("; ")}`);
}
process.exit(issues > 0 ? 1 : 0);
