#!/usr/bin/env node
/**
 * Smoke test for POOL_SCORING_METHODOLOGY.md (Morpho steakUSDC-style vault).
 * Run: node scripts/test-pool-scoring.mjs
 */
import { buildPoolRiskAssessment } from "../backend/llm/poolScoring.js";

const eighteenMonthsAgoSec = Math.floor(Date.now() / 1000) - 18 * 30 * 86400;

const result = buildPoolRiskAssessment(
  {
    label: "steakUSDC",
    issuerSlug: "morpho",
    yieldsRows: [
      {
        symbol: "USDC",
        tvlUsd: 180_000_000,
        apyBase: 7,
        apyReward: 3,
        utilization: 0.72,
        poolMeta: "MetaMorpho",
      },
    ],
    underlyingTokens: [{ symbol: "USDC" }],
    integrators: [{ name: "Morpho", tier: "issuer", id: "defillama:morpho" }],
  },
  { protocolListedAt: eighteenMonthsAgoSec }
);

console.log("poolType:", result.poolType);
console.log("poolScore:", result.poolScore, "/ 100");
console.log("weight applied:", Math.round(result.weightApplied * 100) + "%");

const scored = result.criteria.filter((c) => !c.na && !c.unavailable);
console.log("criteria scored:", scored.length);

if (result.poolScore < 70 || result.poolScore > 96) {
  console.warn("WARN: score outside expected band for rich USDC vault fixture");
  process.exitCode = 1;
}

if (result.poolType !== "curated_vault") {
  console.warn("WARN: expected curated_vault pool type");
  process.exitCode = 1;
}

console.log("OK");
