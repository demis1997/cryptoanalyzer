/**
 * Pool-level scoring per POOL_SCORING_METHODOLOGY.md v1.0
 * Each criterion: score 0–1 or N/A. Weights renormalize when N/A.
 */

const METHODOLOGY_VERSION = "1.0";

const CRITERIA = [
  { id: "P.1", key: "assetQuality", name: "Asset Quality", weight: 0.2 },
  { id: "P.2", key: "liquidityExit", name: "Liquidity & Exit Risk", weight: 0.15 },
  { id: "P.3", key: "oracleQuality", name: "Oracle Quality", weight: 0.15 },
  { id: "P.4", key: "parameterSafety", name: "Parameter Safety", weight: 0.1 },
  { id: "P.5", key: "depegVolatility", name: "Depeg / Volatility Risk", weight: 0.08 },
  { id: "P.6", key: "poolAge", name: "Pool Age", weight: 0.05 },
  { id: "P.7", key: "depositorConcentration", name: "Depositor Concentration", weight: 0.1 },
  { id: "P.8", key: "poolTvl", name: "Pool TVL", weight: 0.07 },
  { id: "P.9", key: "yieldQuality", name: "Yield Quality & Sustainability", weight: 0.05 },
  { id: "P.10", key: "curatorQuality", name: "Curator / Risk Manager", weight: 0.05 },
];

const STABLE_SYMBOLS = new Set([
  "usdc",
  "usdt",
  "dai",
  "usds",
  "usde",
  "susde",
  "frax",
  "lusd",
  "crvusd",
  "gho",
]);

const LST_SYMBOLS = /\b(wsteth|steth|reth|cbeth|sfrxeth|ethx)\b/i;
const LRT_SYMBOLS = /\b(weeth|rseth|ezeth|pufeth|rsteth)\b/i;
const PT_SYMBOLS = /\b(pt-|pt[a-z])/i;

function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function primaryYieldsRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))[0];
}

/** @returns {'lending'|'staking'|'amm_lp'|'pendle_pt'|'structured_vault'|'curated_vault'} */
export function inferPoolType({ yieldsRows = [], label = "", issuerSlug = "", integrators = [] } = {}) {
  const row = primaryYieldsRow(yieldsRows);
  const sym = String(row?.symbol || "").toLowerCase();
  const meta = String(row?.poolMeta || "").toLowerCase();
  const exposure = String(row?.exposure || "").toLowerCase();
  const hay = `${sym} ${meta} ${exposure} ${String(label).toLowerCase()} ${issuerSlug}`;
  const integHay = (integrators || []).map((p) => `${p.name} ${p.id}`).join(" ").toLowerCase();

  if (PT_SYMBOLS.test(sym) || /pendle/i.test(hay)) return "pendle_pt";
  if (/metamorpho|euler|evault|steakhouse|gauntlet|re7|mev capital|smokehouse|curator/i.test(integHay + hay)) {
    return "curated_vault";
  }
  if (/uniswap|curve|balancer|aerodrome|amm|lp\b/i.test(hay) && !/vault/i.test(meta)) return "amm_lp";
  if (LRT_SYMBOLS.test(sym) || LST_SYMBOLS.test(sym)) {
    if (!/lend|borrow|supply/i.test(hay)) return "staking";
  }
  if (/lend|borrow|supply|aave|compound|morpho-blue/i.test(hay)) return "lending";
  if (/vault|earn|perp|market.?making/i.test(meta + hay)) return "structured_vault";
  return "structured_vault";
}

export function isCriterionNA(criterionKey, poolType) {
  const t = poolType;
  switch (criterionKey) {
    case "oracleQuality":
      return t === "staking";
    case "parameterSafety":
      return t === "staking" || t === "amm_lp";
    case "curatorQuality":
      return t === "staking" || t === "amm_lp" || t === "pendle_pt" || t === "structured_vault";
    default:
      return false;
  }
}

function scoreAssetQuality(row, underlyingTokens) {
  const sym = String(row?.symbol || "").trim();
  const s = sym.toLowerCase();
  const under = (underlyingTokens || []).map((t) => String(t?.symbol || t?.label || "").toLowerCase());
  const tokens = [s, ...under].filter(Boolean);

  let min = 1;
  for (const tok of tokens) {
    let sc = 0.6;
    if (!tok || tok === "unknown") continue;
    if (/^(eth|weth|btc|wbtc)$/i.test(tok)) sc = 1.0;
    else if (STABLE_SYMBOLS.has(tok) || /^usdc|usdt|dai/i.test(tok)) sc = 0.95;
    else if (/^susd|susde|sdai|cusdc/i.test(tok)) sc = 0.85;
    else if (/^dai|usds|frax/i.test(tok)) sc = 0.8;
    else if (LST_SYMBOLS.test(tok)) sc = 0.8;
    else if (LRT_SYMBOLS.test(tok)) sc = 0.65;
    else if (PT_SYMBOLS.test(tok)) sc = 0.7;
    else if (/^(aave|crv|arb|op|uni|link)$/i.test(tok)) sc = 0.6;
    else if (row?.assetRankHint === "top100") sc = 0.6;
    else if (/lp|bpt|curve/i.test(tok)) sc = 0.5;
    else sc = 0.3;
    min = Math.min(min, sc);
  }
  return {
    score: clamp01(min),
    input: sym || tokens.join(", ") || "unknown",
    evidence: "Lowest-quality asset in pool (methodology P.1).",
  };
}

function scoreLiquidityExit(poolType, row) {
  const t = poolType;
  if (t === "lending" || t === "curated_vault") {
    const util = row?.utilization ?? row?.utilizationRate;
    if (typeof util === "number" && isFinite(util)) {
      const u = util > 1 ? util : util * 100;
      let sc = 0.1;
      if (u < 70) sc = 1.0;
      else if (u < 80) sc = 0.85;
      else if (u < 90) sc = 0.6;
      else if (u < 95) sc = 0.3;
      return { score: sc, input: `utilization ${u.toFixed(1)}%`, evidence: "Lending utilization (P.2)." };
    }
    return {
      score: 0.85,
      input: "vault/lending (utilization unknown)",
      evidence: "No utilization data — conservative default for supply-side vault.",
    };
  }
  if (t === "staking") {
    return { score: 0.85, input: "staking/LST", evidence: "Assumed ≤1d exit unless queue known (P.2)." };
  }
  if (t === "amm_lp") {
    return { score: 0.9, input: "AMM/LP", evidence: "Exit anytime with slippage risk (P.2)." };
  }
  if (t === "pendle_pt") {
    return { score: 0.8, input: "Pendle PT", evidence: "Fixed maturity; secondary market assumed (P.2)." };
  }
  return { score: 0.85, input: "structured vault", evidence: "Standard vault withdrawal (P.2)." };
}

function scoreOracle(poolType, row) {
  if (isCriterionNA("oracleQuality", poolType)) {
    return { na: true, evidence: "No liquidation oracle required (P.3 N/A)." };
  }
  const oracleHint = String(row?.oracle || row?.oracleType || "").toLowerCase();
  if (/chainlink.*deriv|derived/i.test(oracleHint)) {
    return { score: 0.9, input: "Chainlink derived", evidence: "P.3 oracle table." };
  }
  if (/chainlink/i.test(oracleHint)) {
    return { score: 1.0, input: "Chainlink", evidence: "P.3 oracle table." };
  }
  if (/pyth/i.test(oracleHint)) {
    return { score: 0.8, input: "Pyth", evidence: "P.3 oracle table." };
  }
  if (/twap/i.test(oracleHint)) {
    return { score: 0.7, input: "TWAP", evidence: "P.3 oracle table." };
  }
  if (poolType === "structured_vault" || poolType === "lending") {
    return {
      score: 0.75,
      input: "not specified",
      evidence: "Perp/vault likely uses external feeds — verify in docs (default 0.75).",
    };
  }
  return { score: 0.65, input: "unknown", evidence: "Oracle type not in yields data." };
}

function scoreParameterSafety(poolType, row) {
  if (isCriterionNA("parameterSafety", poolType)) {
    return { na: true, evidence: "No collateral parameters (P.4 N/A)." };
  }
  const lltv = row?.lltv ?? row?.ltv ?? row?.maxLtv;
  if (typeof lltv === "number" && isFinite(lltv)) {
    const pct = lltv > 1 ? lltv : lltv * 100;
    let lltvSc = 0.2;
    if (pct <= 70) lltvSc = 1.0;
    else if (pct <= 80) lltvSc = 0.85;
    else if (pct <= 86) lltvSc = 0.7;
    else if (pct <= 90) lltvSc = 0.5;
    else if (pct <= 91.5) lltvSc = 0.35;
    const capFill = row?.capUtilization ?? row?.supplyCapFill;
    let capMult = 1;
    if (typeof capFill === "number") {
      const c = capFill > 1 ? capFill : capFill * 100;
      if (c < 70) capMult = 1;
      else if (c < 85) capMult = 0.85;
      else if (c < 95) capMult = 0.65;
      else capMult = 0.4;
    }
    return {
      score: clamp01(lltvSc * capMult),
      input: `LLTV ${pct.toFixed(1)}%${typeof capFill === "number" ? `, cap ${capFill}%` : ""}`,
      evidence: "P.4 LLTV × cap multiplier.",
    };
  }
  if (poolType === "curated_vault") {
    return { score: 0.75, input: "curated vault", evidence: "Curator-managed caps — parameters not in API." };
  }
  return { score: 0.8, input: "defaults", evidence: "LLTV/caps unknown — neutral-lenient default." };
}

function scoreDepegVolatility(row) {
  const sym = String(row?.symbol || "").toLowerCase();
  if (/^(eth|weth|btc|wbtc)$/.test(sym)) {
    return { score: 1.0, input: sym, evidence: "No peg to lose (P.5)." };
  }
  if (STABLE_SYMBOLS.has(sym) || /^usdc|usdt/.test(sym)) {
    return { score: 0.95, input: sym, evidence: "Fiat-backed stable (P.5)." };
  }
  if (/^dai|usds/.test(sym)) return { score: 0.8, input: sym, evidence: "Over-coll stable (P.5)." };
  if (LST_SYMBOLS.test(sym)) return { score: 0.85, input: sym, evidence: "LST (P.5)." };
  if (LRT_SYMBOLS.test(sym)) return { score: 0.65, input: sym, evidence: "LRT layer (P.5)." };
  if (PT_SYMBOLS.test(sym)) return { score: 0.75, input: sym, evidence: "PT token (P.5)." };
  if (/usde|susd/i.test(sym)) return { score: 0.7, input: sym, evidence: "Synthetic stable (P.5)." };
  return { score: 0.6, input: sym || "mixed", evidence: "General asset peg risk (P.5)." };
}

function scorePoolAge(row, protocolListedAt) {
  const created = row?.poolCreatedAt ?? row?.createdAt ?? row?.listedAt;
  let ageMs = null;
  if (typeof created === "number" && created > 1e9) {
    ageMs = Date.now() - (created > 1e12 ? created : created * 1000);
  } else if (typeof protocolListedAt === "number" && protocolListedAt > 0) {
    const tsMs = protocolListedAt > 1e12 ? protocolListedAt : protocolListedAt * 1000;
    ageMs = Date.now() - tsMs;
  } else {
    const count = Number(row?.count);
    if (count > 300) ageMs = 400 * 86400000;
    else if (count > 100) ageMs = 200 * 86400000;
    else if (count > 30) ageMs = 90 * 86400000;
  }
  if (ageMs == null) {
    return { unavailable: true, input: "unknown", evidence: "Pool deployment date not available." };
  }
  const months = ageMs / (30 * 86400000);
  let sc = 0.1;
  if (months >= 24) sc = 1.0;
  else if (months >= 12) sc = 0.85;
  else if (months >= 6) sc = 0.7;
  else if (months >= 3) sc = 0.5;
  else if (months >= 1) sc = 0.3;
  return {
    score: sc,
    input: `~${Math.round(months)} months`,
    evidence: "Pool age from timestamps or DefiLlama sample count proxy (P.6).",
  };
}

function scoreDepositorConcentration(row) {
  const top1 = row?.top1DepositorPct ?? row?.concentrationTop1;
  const top3 = row?.top3DepositorPct ?? row?.concentrationTop3;
  if (typeof top1 !== "number") {
    return { unavailable: true, input: "on-chain not fetched", evidence: "Whale concentration requires on-chain analysis (P.7)." };
  }
  let sc = 0.1;
  if (top1 < 10) sc = 1.0;
  else if (top1 < 25 && (top3 == null || top3 < 40)) sc = 0.85;
  else if (top1 < 25 && top3 < 60) sc = 0.7;
  else if (top1 < 50) sc = 0.5;
  else if (top1 < 70) sc = 0.3;
  return { score: sc, input: `top1 ${top1}%`, evidence: "Depositor concentration (P.7)." };
}

function scorePoolTvl(row) {
  const tvl = Number(row?.tvlUsd);
  if (!isFinite(tvl) || tvl <= 0) {
    return { unavailable: true, input: "unknown", evidence: "TVL missing from yields row (P.8)." };
  }
  let sc = 0.2;
  if (tvl > 100_000_000) sc = 1.0;
  else if (tvl >= 10_000_000) sc = 0.8;
  else if (tvl >= 1_000_000) sc = 0.6;
  else if (tvl >= 500_000) sc = 0.4;
  return { score: sc, input: `$${Math.round(tvl).toLocaleString()}`, evidence: "Pool TVL (P.8)." };
}

function scoreYieldQuality(row) {
  const apy = Number(row?.apy);
  const apyBase = Number(row?.apyBase);
  const apyReward = Number(row?.apyReward);
  if (!isFinite(apy) && !isFinite(apyBase)) {
    return { unavailable: true, input: "no APY", evidence: "Yield breakdown missing (P.9)." };
  }
  const base = isFinite(apyBase) ? apyBase : isFinite(apy) ? apy * 0.7 : 0;
  const reward = isFinite(apyReward) ? apyReward : isFinite(apy) ? Math.max(0, apy - base) : 0;
  const total = base + reward || apy || 1;
  const baseShare = base / total;
  let sourceSc = 0.3;
  if (baseShare >= 0.8) sourceSc = 1.0;
  else if (baseShare >= 0.6) sourceSc = 0.85;
  else if (baseShare >= 0.4) sourceSc = 0.7;
  else if (baseShare >= 0.2) sourceSc = 0.5;
  else if (baseShare > 0) sourceSc = 0.3;
  else sourceSc = 0.15;

  const cv = row?.apyCv30d ?? row?.apyStabilityCv;
  let mult = 0.9;
  if (typeof cv === "number") {
    if (cv < 0.1) mult = 1.0;
    else if (cv < 0.25) mult = 0.9;
    else if (cv < 0.5) mult = 0.75;
    else mult = 0.6;
  } else {
    const sigma = Number(row?.sigma);
    if (isFinite(sigma) && sigma < 0.5) mult = 0.95;
    else if (isFinite(sigma) && sigma < 1.2) mult = 0.85;
    else mult = 0.75;
  }

  return {
    score: clamp01(sourceSc * mult),
    input: `${Math.round(baseShare * 100)}% organic APY${isFinite(apy) ? `, ${apy.toFixed(2)}% total` : ""}`,
    evidence: "Yield source × stability proxy (P.9).",
  };
}

const CURATOR_SCORES = [
  { re: /gauntlet|b\.?protocol|steakhouse|steakusdc|chaos labs/i, score: 1.0, label: "Institutional curator" },
  { re: /re7|mev capital|smokehouse|hyperithm/i, score: 0.8, label: "Known curator" },
];

function scoreCurator(poolType, integrators, issuerSlug, label = "") {
  if (isCriterionNA("curatorQuality", poolType)) {
    return { na: true, evidence: "Non-curated pool type (P.10 N/A)." };
  }
  const hay = `${label} ${(integrators || []).map((p) => `${p.name} ${p.id}`).join(" ")}`;
  for (const c of CURATOR_SCORES) {
    if (c.re.test(hay)) {
      return { score: c.score, input: c.label, evidence: "Curator detected from integrators (P.10)." };
    }
  }
  if (/morpho|euler/i.test(hay) && poolType === "curated_vault") {
    return { score: 0.6, input: "curated architecture", evidence: "Curator not named in data (P.10)." };
  }
  return { na: true, evidence: "No named curator in available data (P.10 N/A)." };
}

function buildQualitativeFlags(ctx, poolType) {
  const flags = [];
  const depth = Number(ctx?.dependencyDepth);
  if (depth > 2) flags.push({ id: "cross_protocol_depth", message: `Dependency depth ${depth} > 2 — manual review.` });
  const row = primaryYieldsRow(ctx.yieldsRows);
  if (row?.ilRisk === "yes") flags.push({ id: "il_risk", message: "DefiLlama marks IL risk on this pool." });
  if (poolType === "pendle_pt") flags.push({ id: "maturity", message: "PT position — confirm days to maturity and secondary liquidity." });
  return flags;
}

/**
 * @param {object} ctx — pool intelligence context
 * @param {object} [opts] — protocolDetail for issuer listedAt
 */
export function buildPoolRiskAssessment(ctx, opts = {}) {
  const row = primaryYieldsRow(ctx.yieldsRows);
  const poolType = inferPoolType({
    yieldsRows: ctx.yieldsRows,
    label: ctx.label,
    issuerSlug: ctx.issuerSlug,
    integrators: ctx.integrators,
  });
  const protocolListedAt = opts.protocolListedAt ?? opts.issuerListedAt ?? null;

  const scorers = {
    assetQuality: () => scoreAssetQuality(row, ctx.underlyingTokens),
    liquidityExit: () => scoreLiquidityExit(poolType, row),
    oracleQuality: () => scoreOracle(poolType, row),
    parameterSafety: () => scoreParameterSafety(poolType, row),
    depegVolatility: () => scoreDepegVolatility(row),
    poolAge: () => scorePoolAge(row, protocolListedAt),
    depositorConcentration: () => scoreDepositorConcentration(row),
    poolTvl: () => scorePoolTvl(row),
    yieldQuality: () => scoreYieldQuality(row),
    curatorQuality: () => scoreCurator(poolType, ctx.integrators, ctx.issuerSlug, ctx.label),
  };

  const criteria = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const def of CRITERIA) {
    const naByType = isCriterionNA(def.key, poolType);
    let result = { na: naByType };
    if (!naByType) {
      result = scorers[def.key]() || {};
    }

    const entry = {
      id: def.id,
      key: def.key,
      name: def.name,
      weight: def.weight,
      weightPct: Math.round(def.weight * 100),
      na: Boolean(result.na),
      unavailable: Boolean(result.unavailable),
      score: result.na || result.unavailable ? null : clamp01(result.score),
      input: result.input || null,
      evidence: result.evidence || null,
    };
    criteria.push(entry);

    if (!entry.na && !entry.unavailable && typeof entry.score === "number") {
      weightedSum += entry.score * def.weight;
      weightTotal += def.weight;
    }
  }

  const overallTotal = weightTotal > 0 ? weightedSum / weightTotal : 0.5;
  const poolScore = Math.round(overallTotal * 1000) / 10;
  const flags = buildQualitativeFlags(ctx, poolType);

  return {
    methodologyVersion: METHODOLOGY_VERSION,
    poolType,
    overallTotal: clamp01(overallTotal),
    poolScore,
    criteria,
    weightApplied: weightTotal,
    flags,
    sectionTotals: criteria
      .filter((c) => !c.na && !c.unavailable && c.score != null)
      .map((c) => ({ sectionId: c.key, label: c.name, score: c.score })),
    evidence: [
      `Pool type: ${poolType}.`,
      `Score from ${criteria.filter((c) => !c.na && !c.unavailable).length} criteria (${Math.round(weightTotal * 100)}% weight applied).`,
      "See POOL_SCORING_METHODOLOGY.md v1.0.",
    ],
  };
}

export function getPoolScoringSchema() {
  return {
    version: METHODOLOGY_VERSION,
    criteria: CRITERIA.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      weightPct: Math.round(c.weight * 100),
    })),
    formula: "pool_score = sum(score_i × weight_i) / sum(weight_i) × 100",
  };
}
