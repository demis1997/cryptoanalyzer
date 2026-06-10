#!/usr/bin/env node
/**
 * Multi-protocol pool URL resolution smoke test.
 * Run: node scripts/test-pool-url-resolution.mjs
 */
import { extractPoolTargetFromUrl } from "../backend/services/poolAddress.js";
import { resolvePoolFromProtocolTarget } from "../backend/services/poolProtocolResolver.js";
import { fetchYieldsPoolsCached } from "../backend/services/yieldsDiscover.js";
import { selectPrimaryYieldsRow } from "../backend/services/poolAddress.js";
import { buildPoolRiskAssessment } from "../backend/llm/poolScoring.js";

const POOLS = [
  {
    id: 1,
    protocol: "Aave V3",
    url: "https://app.aave.com/reserve-overview/?underlyingAsset=0x6b175474e89094c44da98b954eedeac495271d0f&marketName=proto_mainnet_v3",
    expect: { protocolKind: "aave_reserve", chain: "ethereum", hasTvl: true, hasUtil: true },
  },
  {
    id: 2,
    protocol: "SparkLend",
    url: "https://app.spark.fi/markets/1/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    expect: { protocolKind: "spark_reserve", chain: "ethereum", hasTvl: true, hasUtil: true },
  },
  {
    id: 3,
    protocol: "Compound",
    url: "https://app.compound.finance/markets/usdc-op",
    expect: { protocolKind: "compound_market", chain: "optimism", hasTvl: true, hasUtil: true },
  },
  {
    id: 4,
    protocol: "Pendle",
    url: "https://app.pendle.finance/trade/pools/0x299674f6da858f903d77486fba50bc9f2e0db24d/zap/in?chain=arbitrum&page=1",
    expect: { protocolKind: "pendle_market", chain: "arbitrum", hasTvl: true },
  },
  {
    id: 5,
    protocol: "Hyperliquid",
    url: "https://app.hyperliquid.xyz/vaults/0xdfc24b077bc1425ad1dea75bcb6f8158e10df303",
    expect: { protocolKind: "hyperliquid_vault", hasTvl: true },
  },
  {
    id: 6,
    protocol: "Pendle",
    url: "https://app.pendle.finance/trade/pools/0x46d62a8dede1bf2d0de04f2ed863245cbba5e538/zap/in?chain=arbitrum",
    expect: { protocolKind: "pendle_market", chain: "arbitrum", hasTvl: true },
  },
  {
    id: 7,
    protocol: "Morpho",
    url: "https://app.morpho.org/base/market/0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836/cbbtc-usdc",
    expect: { protocolKind: "morpho_market", chain: "base", hasTvl: true, hasUtil: true, hasLltv: true },
  },
  {
    id: 8,
    protocol: "Morpho",
    url: "https://app.morpho.org/ethereum/market/0x15bb2a6af0c909eed19fb1f2ceeead34ecbdcba626de752c6b09389ee14eec32/kbtc-rlusd",
    expect: { protocolKind: "morpho_market", chain: "ethereum", hasTvl: true, hasUtil: true },
  },
  {
    id: 9,
    protocol: "Maple",
    url: "https://app.maple.finance/earn",
    expect: { protocolKind: "maple_pool", hasTvl: true, hasUtil: true, hasLltv: true },
  },
  {
    id: 10,
    protocol: "Aave v3",
    url: "https://app.aave.com/reserve-overview/?underlyingAsset=0x8f3cf7ad23cd3cadbd9735aff958023239c6a063&marketName=proto_polygon_v3",
    expect: { protocolKind: "aave_reserve", chain: "polygon", hasTvl: true },
  },
  {
    id: 11,
    protocol: "Kamino",
    url: "https://kamino.com/earn/lend/steakhouse-usdc/vault-overview",
    expect: { protocolKind: "kamino_vault", chain: "solana", hasTvl: true },
  },
  {
    id: 12,
    protocol: "Fluid",
    url: "https://fluid.io/lending/1",
    expect: { protocolKind: "fluid_lending", chain: "ethereum", hasTvl: true, hasUtil: true },
  },
];

let failed = 0;

function fail(msg) {
  console.error("FAIL:", msg);
  failed = 1;
}

function ok(msg) {
  console.log("OK:", msg);
}

console.log("Fetching DefiLlama yields cache…");
const allPools = await fetchYieldsPoolsCached();

for (const pool of POOLS) {
  console.log(`\n--- #${pool.id} ${pool.protocol} ---`);
  const target = extractPoolTargetFromUrl(pool.url);
  console.log("  parsed:", {
    protocolKind: target.protocolKind,
    chain: target.chain,
    issuerSlug: target.issuerSlug,
    vault: target.vaultAddress?.slice(0, 12),
    marketId: target.marketId?.slice(0, 12),
    nameHint: target.nameHint,
  });

  if (pool.expect.protocolKind && target.protocolKind !== pool.expect.protocolKind) {
    fail(`#${pool.id} protocolKind expected ${pool.expect.protocolKind}, got ${target.protocolKind}`);
  } else {
    ok(`#${pool.id} protocolKind ${target.protocolKind}`);
  }
  if (pool.expect.chain && target.chain !== pool.expect.chain) {
    fail(`#${pool.id} chain expected ${pool.expect.chain}, got ${target.chain}`);
  }

  const ctx = { ...target, url: pool.url };
  const resolved = await resolvePoolFromProtocolTarget(ctx, allPools, null).catch((e) => {
    fail(`#${pool.id} resolve error: ${e.message}`);
    return null;
  });

  if (!resolved?.yieldsRows?.length) {
    fail(`#${pool.id} no yields rows resolved`);
    continue;
  }

  const row = selectPrimaryYieldsRow(resolved.yieldsRows, ctx);
  ok(`#${pool.id} resolved ${row.symbol} · ${row.project} · ${row.chain}`);

  if (pool.expect.hasTvl && !(row.tvlUsd > 0)) fail(`#${pool.id} missing TVL`);
  else if (pool.expect.hasTvl) ok(`#${pool.id} TVL $${Math.round(row.tvlUsd).toLocaleString()}`);

  if (pool.expect.hasUtil && row.utilization == null) fail(`#${pool.id} missing utilization`);
  else if (pool.expect.hasUtil) ok(`#${pool.id} util ${(row.utilization * 100).toFixed(1)}%`);

  if (pool.expect.hasLltv && row.lltv == null) fail(`#${pool.id} missing LLTV/collateral metric`);
  else if (pool.expect.hasLltv) ok(`#${pool.id} LLTV/collateral ${Number(row.lltv).toFixed(1)}%`);

  const risk = buildPoolRiskAssessment({
    label: pool.protocol,
    url: pool.url,
    issuerSlug: target.issuerSlug,
    yieldsRows: resolved.yieldsRows,
  });
  const p2 = risk.criteria.find((c) => c.key === "liquidityExit");
  const p7 = risk.criteria.find((c) => c.key === "poolTvl");
  console.log(
    `  score: ${risk.poolScore}/100 · type=${risk.poolType} · P.2=${p2?.unavailable ? "gap" : p2?.score} · P.7=${p7?.unavailable ? "gap" : p7?.score}`
  );
}

console.log(failed ? "\nSome checks failed." : "\nAll URL resolution checks passed.");
process.exit(failed);
