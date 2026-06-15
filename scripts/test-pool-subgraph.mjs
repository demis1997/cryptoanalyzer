#!/usr/bin/env node
/**
 * Live subgraph smoke test (requires THE_GRAPH_API_KEY).
 * Run: node scripts/test-pool-subgraph.mjs
 */
import "dotenv/config";
import { fetchPoolSubgraphMetrics } from "../backend/services/poolSubgraph.js";
import { subgraphEnabled } from "../backend/services/subgraphClient.js";

if (!subgraphEnabled()) {
  console.log("SKIP: set THE_GRAPH_API_KEY and POOL_SUBGRAPH=1 to run live subgraph tests");
  process.exit(0);
}

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = 1;
  } else {
    console.log("OK:", msg);
  }
}

const aave = await fetchPoolSubgraphMetrics({
  protocolKind: "aave_reserve",
  chain: "ethereum",
  underlyingAsset: "0x6b175474e89094c44da98b954eedeac495271d0f",
});
ok(aave?.scoring?.totalAssetsUsd > 0, `Aave DAI TVL $${Math.round(aave?.scoring?.totalAssetsUsd || 0).toLocaleString()}`);
ok(aave?.scoring?.top1DepositorPct > 0, `Aave DAI P.5 top1 ~${aave?.scoring?.top1DepositorPct?.toFixed(1)}%`);
ok(
  Array.isArray(aave?.scoring?.depositorSharePercents) && aave.scoring.depositorSharePercents.length >= 5,
  `Aave DAI depositor shares n=${aave?.scoring?.depositorSharePercents?.length}`
);

const morpho = await fetchPoolSubgraphMetrics({
  protocolKind: "morpho_market",
  chain: "base",
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
});
ok(morpho?.scoring?.totalAssetsUsd > 0, `Morpho cbBTC/USDC TVL $${Math.round(morpho?.scoring?.totalAssetsUsd || 0).toLocaleString()}`);

process.exit(failed);
