/**
 * Pool-level scoring per POOL_SCORING_METHODOLOGY.md v2.0
 * Each criterion: score 0–1 or N/A. Weights renormalize when N/A.
 */

import { selectPrimaryYieldsRow } from "../services/poolAddress.js";

const METHODOLOGY_VERSION = "2.0";

const HHI_CRITICAL = 0.3;
const WSC_LOG_BOUND = 31;

const CRITERIA = [
  { id: "P.1", key: "assetQuality", name: "Asset Quality", weight: 0.2 },
  { id: "P.2", key: "liquidityExit", name: "Liquidity & Exit Risk", weight: 0.15 },
  { id: "P.3", key: "oracleQuality", name: "Oracle Quality", weight: 0.15 },
  { id: "P.4", key: "parameterSafety", name: "Parameter Safety", weight: 0.1 },
  { id: "P.5", key: "depositorConcentration", name: "Depositor Concentration Risk", weight: 0.08 },
  { id: "P.6", key: "poolAge", name: "Pool Age", weight: 0.05 },
  { id: "P.7", key: "poolTvl", name: "Pool TVL", weight: 0.07 },
  { id: "P.8", key: "yieldQuality", name: "Yield Quality & Sustainability", weight: 0.05 },
  { id: "P.9", key: "curatorQuality", name: "Curator / Risk Manager", weight: 0.05 },
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

export function primaryYieldsRow(rows, opts = {}) {
  return selectPrimaryYieldsRow(rows, opts);
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
      return t === "staking" || t === "amm_lp" || t === "pendle_pt";
    default:
      return false;
  }
}

function scoreAssetQuality(row, underlyingTokens) {
  const sym = String(row?.symbol || "").trim();
  const s = sym.toLowerCase();
  const under = (underlyingTokens || [])
    .map((t) => String(t?.symbol || t?.label || "").toLowerCase())
    .filter((t) => t && !/^0x[a-f0-9]{40}$/.test(t));
  const tokens = [s, ...under].filter((t) => t && !/^0x[a-f0-9]{40}$/.test(t));

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
    else sc = 0.1;
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
      let band = "≥95%";
      if (u < 70) {
        sc = 1.0;
        band = "<70%";
      } else if (u < 80) {
        sc = 0.85;
        band = "70–80%";
      } else if (u < 90) {
        sc = 0.6;
        band = "80–90%";
      } else if (u < 95) {
        sc = 0.3;
        band = "90–95%";
      }
      return {
        score: sc,
        input: `utilization ${u.toFixed(1)}%`,
        evidence: row?.utilizationEvidence || `Lending utilization band ${band} → ${sc} (P.2).`,
        calcBreakdown: `util=${u.toFixed(1)}% → band ${band} → score ${sc}`,
      };
    }
    return {
      unavailable: true,
      input: "utilization not found",
      evidence:
        "Utilization not in protocol API or pool page — criterion excluded (parse pool dashboard: utilization rate, supply/borrow utilization %).",
    };
  }
  if (t === "staking") {
    return {
      unavailable: true,
      input: "withdrawal queue unknown",
      evidence: "Staking/LRT exit queue not parsed from pool page — criterion excluded (P.2).",
    };
  }
  if (t === "amm_lp") {
    return { score: 0.9, input: "AMM/LP", evidence: "Exit anytime with slippage risk (P.2).", calcBreakdown: "AMM/LP default 0.90" };
  }
  if (t === "pendle_pt") {
    const days = row?.pendleDaysToMaturity ?? row?.daysToMaturity;
    if (typeof days === "number" && isFinite(days)) {
      let baseSc = 0.9;
      let band = ">90d";
      if (days <= 0) {
        baseSc = 1.0;
        band = "matured";
      } else if (days <= 30) {
        baseSc = 0.7;
        band = "≤30d";
      } else if (days <= 90) {
        baseSc = 0.8;
        band = "31–90d";
      }
      const hasSecondary = row?.pendleSecondaryMarket;
      const secondaryAdj = hasSecondary === false ? 0.3 : 0;
      const sc = Math.max(0, baseSc - secondaryAdj);
      const calcParts = [`daysToMaturity=${days} → band ${band} → base ${baseSc}`];
      if (secondaryAdj) calcParts.push(`no secondary market −0.30 → ${sc}`);
      return {
        score: sc,
        input: `${days}d to maturity${hasSecondary === false ? ", no secondary market" : hasSecondary ? ", secondary market" : ""}`,
        evidence: row?.maturityEvidence || `Pendle PT maturity table (P.2).`,
        calcBreakdown: calcParts.join("; "),
      };
    }
    return {
      unavailable: true,
      input: "maturity not found",
      evidence:
        "Days to maturity not parsed from Pendle pool page — criterion excluded (look for: days to maturity, expiry date, time to maturity).",
    };
  }
  return {
    unavailable: true,
    input: "exit terms unknown",
    evidence: "Structured vault cooldown/exit not found on pool page — criterion excluded (P.2).",
  };
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
  if (poolType === "structured_vault" || poolType === "lending" || poolType === "curated_vault") {
    return {
      unavailable: true,
      input: "oracle not identified",
      evidence: "Oracle not found in DefiLlama, Morpho API, or web research — check protocol docs (P.3).",
    };
  }
  return {
    unavailable: true,
    input: "oracle unknown",
    evidence: "Oracle type not in available sources (P.3).",
  };
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
    const final = clamp01(lltvSc * capMult);
    const capNote =
      typeof capFill === "number"
        ? `cap fill ${(capFill > 1 ? capFill : capFill * 100).toFixed(1)}% → mult ${capMult}`
        : "no cap data → mult 1.0";
    return {
      score: final,
      input: `LLTV ${pct.toFixed(1)}%${typeof capFill === "number" ? `, cap ${(capFill > 1 ? capFill : capFill * 100).toFixed(1)}%` : ""}`,
      evidence: row?.lltvEvidence || `P.4 LLTV band → ${lltvSc}; ${capNote}; final ${final.toFixed(3)}`,
      calcBreakdown: `LLTV ${pct.toFixed(1)}% → ${lltvSc} × capMult ${capMult} = ${final.toFixed(3)}`,
    };
  }
  return {
    unavailable: true,
    input: "LLTV/caps not found",
    evidence:
      "LLTV or collateral parameters not in protocol API or pool page — criterion excluded (parse: LLTV, LTV, loan-to-value, liquidation threshold).",
  };
}

function computeHhi(shareFractions) {
  return shareFractions.reduce((sum, s) => sum + s * s, 0);
}

function scoreHhiNormalized(hhi) {
  if (hhi >= HHI_CRITICAL) return 0;
  return clamp01(1 - Math.sqrt(hhi / HHI_CRITICAL));
}

function computeWsc50(shareFractions) {
  const sorted = [...shareFractions].sort((a, b) => b - a);
  let cumulative = 0;
  let count = 0;
  for (const share of sorted) {
    cumulative += share;
    count += 1;
    if (cumulative >= 0.5) return count;
  }
  return Math.max(1, sorted.length);
}

function scoreWscNormalized(wsc50) {
  return clamp01(Math.log(1 + wsc50) / Math.log(WSC_LOG_BOUND));
}

function harmonicMean(a, b) {
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

function normalizeShareInputs(raw) {
  const nums = (Array.isArray(raw) ? raw : [])
    .map((x) => Number(x))
    .filter((x) => isFinite(x) && x > 0);
  if (!nums.length) return [];
  const asFrac = nums.map((x) => (x > 1 ? x / 100 : x));
  const sum = asFrac.reduce((a, b) => a + b, 0);
  return sum > 0 && sum <= 1.05 ? asFrac : asFrac.map((x) => x / sum);
}

function scoreDepositorConcentrationFromShares(shareFractions, { partial = false } = {}) {
  const fracs = shareFractions.filter((x) => x > 0);
  if (!fracs.length) return null;
  const hhi = computeHhi(fracs);
  const scoreHhi = scoreHhiNormalized(hhi);
  const wsc50 = computeWsc50(fracs);
  const scoreWsc = scoreWscNormalized(wsc50);
  const final = harmonicMean(scoreHhi, scoreWsc);
  return {
    score: clamp01(partial ? final * 0.9 : final),
    input: `HHI=${hhi.toFixed(3)} · WSC₅₀=${wsc50}`,
    evidence: partial
      ? "HHI/WSC from partial depositor shares (P.5)."
      : "HHI × WSC harmonic mean (methodology P.5 v2.0).",
    hhi,
    wsc50,
  };
}

function scoreDepositorConcentration(row) {
  const fullShares = normalizeShareInputs(row?.depositorShares ?? row?.depositShares);
  if (fullShares.length >= 2) {
    const r = scoreDepositorConcentrationFromShares(fullShares);
    if (r) return r;
  }

  const topShares = normalizeShareInputs(
    row?.depositorSharePercents ?? row?.topDepositorShares ?? row?.topDepositorPctList
  );
  if (topShares.length >= 5) {
    const r = scoreDepositorConcentrationFromShares(topShares, { partial: false });
    if (r) return r;
  }
  if (topShares.length >= 2) {
    const r = scoreDepositorConcentrationFromShares(topShares, { partial: true });
    if (r) return r;
  }

  const top1 = row?.top1DepositorPct ?? row?.concentrationTop1;
  if (typeof top1 === "number") {
    const t1 = top1 > 1 ? top1 / 100 : top1;
    const top3 = row?.top3DepositorPct ?? row?.concentrationTop3;
    const t3 = typeof top3 === "number" ? (top3 > 1 ? top3 / 100 : top3) : Math.min(1, t1 * 3);
    const remainder = Math.max(0, t3 - t1);
    const fracs = [t1, remainder / 2, remainder / 2].filter((x) => x > 0.001);
    const r = scoreDepositorConcentrationFromShares(fracs, { partial: true });
    if (r) {
      return {
        ...r,
        input: `${r.input} (proxy top1/top3)`,
        evidence: "HHI/WSC approximated from top1/top3 — full depositor set not on-chain (P.5).",
      };
    }
  }

  return {
    unavailable: true,
    input: "on-chain not fetched",
    evidence: "Depositor share list required for HHI/WSC (P.5).",
  };
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
    else if (count > 0) ageMs = 30 * 86400000;
  }
  if (ageMs == null) {
    return { unavailable: true, input: "unknown", evidence: "Pool deployment date not available." };
  }
  const months = ageMs / (30 * 86400000);
  const count = Number(row?.count);
  let sc = 0.1;
  if (months >= 24) sc = 1.0;
  else if (months >= 12) sc = 0.85;
  else if (months >= 6) sc = 0.7;
  else if (months >= 3) sc = 0.5;
  else if (months >= 1) sc = 0.3;
  return {
    score: sc,
    input: `~${Math.round(months)} months`,
    evidence: count > 0
      ? `Pool age proxied from DefiLlama APY history (${count} samples ≈ ${Math.round(months)} mo, P.6).`
      : "Pool age from deployment timestamp or protocol listedAt (P.6).",
  };
}

function scorePoolTvl(row) {
  if (row?.tvlUncertain) {
    return {
      unavailable: true,
      input: "symbol-only DefiLlama match",
      evidence:
        row?.tvlEvidence ||
        "DefiLlama TVL is token/protocol aggregate, not this pool — parse pool page TVL or resolve vault address (P.7).",
    };
  }
  const tvl = Number(row?.tvlUsd);
  if (!isFinite(tvl) || tvl <= 0) {
    return {
      unavailable: true,
      input: "pool TVL not found",
      evidence:
        "Pool-specific TVL not parsed from pool page or protocol API — criterion excluded (P.7). Do not use token-level DefiLlama TVL.",
    };
  }
  let sc = 0.2;
  let band = "<$500K";
  if (tvl > 100_000_000) {
    sc = 1.0;
    band = ">$100M";
  } else if (tvl >= 10_000_000) {
    sc = 0.8;
    band = "$10M–$100M";
  } else if (tvl >= 1_000_000) {
    sc = 0.6;
    band = "$1M–$10M";
  } else if (tvl >= 500_000) {
    sc = 0.4;
    band = "$500K–$1M";
  }
  const source = row?.tvlSource || "unknown";
  return {
    score: sc,
    input: `$${Math.round(tvl).toLocaleString()}`,
    evidence: row?.tvlEvidence || `Pool TVL band ${band} → ${sc} (source: ${source}, P.7).`,
    calcBreakdown: `tvl=$${Math.round(tvl).toLocaleString()} (${source}) → band ${band} → score ${sc}`,
  };
}

function scoreYieldQuality(row) {
  const apy = Number(row?.apy);
  const apyBase = Number(row?.apyBase);
  const apyReward = Number(row?.apyReward);
  if (!isFinite(apy) && !isFinite(apyBase)) {
    return { unavailable: true, input: "no APY", evidence: "Yield breakdown missing (P.8)." };
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
  let stabilityLabel = "default 0.90 (no CV)";
  if (typeof cv === "number") {
    if (cv < 0.1) {
      mult = 1.0;
      stabilityLabel = `CV ${cv.toFixed(3)} < 0.10 → mult 1.00`;
    } else if (cv < 0.25) {
      mult = 0.9;
      stabilityLabel = `CV ${cv.toFixed(3)} < 0.25 → mult 0.90`;
    } else if (cv < 0.5) {
      mult = 0.75;
      stabilityLabel = `CV ${cv.toFixed(3)} < 0.50 → mult 0.75`;
    } else {
      mult = 0.6;
      stabilityLabel = `CV ${cv.toFixed(3)} ≥ 0.50 → mult 0.60`;
    }
  } else {
    const sigma = Number(row?.sigma);
    if (isFinite(sigma) && sigma < 0.5) {
      mult = 0.95;
      stabilityLabel = `sigma ${sigma.toFixed(3)} < 0.50 → mult 0.95`;
    } else if (isFinite(sigma) && sigma < 1.2) {
      mult = 0.85;
      stabilityLabel = `sigma ${sigma.toFixed(3)} < 1.20 → mult 0.85`;
    } else {
      mult = 0.75;
      stabilityLabel = isFinite(sigma) ? `sigma ${sigma.toFixed(3)} → mult 0.75` : "no CV/sigma → mult 0.75";
    }
  }

  const final = clamp01(sourceSc * mult);
  let sourceBand = "emissions-heavy";
  if (baseShare >= 0.8) sourceBand = "≥80% organic";
  else if (baseShare >= 0.6) sourceBand = "60–80% organic";
  else if (baseShare >= 0.4) sourceBand = "40–60% organic";
  else if (baseShare >= 0.2) sourceBand = "20–40% organic";
  else if (baseShare > 0) sourceBand = "<20% organic";

  return {
    score: final,
    input: `${Math.round(baseShare * 100)}% organic APY${isFinite(apy) ? `, ${apy.toFixed(2)}% total` : ""}`,
    evidence: `P.8: sourceScore ${sourceSc} × stabilityMult ${mult} = ${final.toFixed(3)}`,
    calcBreakdown: [
      `apyBase=${isFinite(apyBase) ? apyBase.toFixed(2) : "—"}%`,
      `apyReward=${isFinite(apyReward) ? apyReward.toFixed(2) : "—"}%`,
      `baseShare=${Math.round(baseShare * 100)}% (${sourceBand} → sourceScore ${sourceSc})`,
      stabilityLabel,
      `final = ${sourceSc} × ${mult} = ${final.toFixed(3)}`,
    ].join(" · "),
  };
}

const CURATOR_SCORES = [
  {
    re: /gauntlet|b\.?protocol|steakhouse|steakusdc|chaos labs/i,
    score: 1.0,
    label: "Institutional curator",
  },
  { re: /re7|mev capital|smokehouse|hyperithm/i, score: 0.8, label: "Known curator" },
  {
    re: /kpk|telos|galaxy|tulipa|anthias|gami labs|alphaping|yearn/i,
    score: 0.6,
    label: "Known team, limited public methodology",
  },
  {
    re: /ultrayield|vault bridge|alterscope|apostro|muscadine|9summits|tanken|yfarmer|relend|hakutora|clearstar/i,
    score: 0.3,
    label: "Anonymous or unverifiable curator",
  },
];

function scoreCurator(poolType, integrators, issuerSlug, label = "", row = null) {
  if (isCriterionNA("curatorQuality", poolType)) {
    return { na: true, evidence: "Non-curated pool type (P.9 N/A)." };
  }
  const curatorField = String(row?.curator || "").trim();
  const hay = `${label} ${curatorField} ${row?.curatorEvidence || ""} ${(integrators || []).map((p) => `${p.name} ${p.id}`).join(" ")}`;
  if (curatorField) {
    for (const c of CURATOR_SCORES) {
      if (c.re.test(curatorField) || c.re.test(hay)) {
        return {
          score: c.score,
          input: curatorField,
          evidence: row?.curatorEvidence || "Curator from Morpho API or web research (P.9).",
        };
      }
    }
    return {
      score: 0.6,
      input: curatorField,
      evidence: row?.curatorEvidence || "Named curator from API; not in rubric tier table (P.9).",
    };
  }
  for (const c of CURATOR_SCORES) {
    if (c.re.test(hay)) {
      return { score: c.score, input: c.label, evidence: "Curator detected from vault label/integrators (P.9)." };
    }
  }
  if (/morpho|euler|metamorpho|evault/i.test(hay) && (poolType === "curated_vault" || poolType === "lending")) {
    return {
      unavailable: true,
      input: "curator not named",
      evidence: "Curated vault but curator not resolved — Morpho API or docs needed (P.9).",
    };
  }
  return { na: true, evidence: "No named curator in available data (P.9 N/A)." };
}

const CRITERION_GUIDE = {
  "P.1": {
    summary: "Risk tier of the core deposited asset (lowest-quality asset in the pool).",
    dataSources: "DefiLlama symbol, underlying tokens, CoinGecko/CoinMarketCap rank.",
  },
  "P.2": {
    summary: "How easily you can exit at full value (utilization, queues, maturity).",
    dataSources: "DefiLlama utilization; pool type heuristics; crawl text for withdrawal terms.",
  },
  "P.3": {
    summary: "Oracle quality for liquidations and pricing (N/A for pure staking).",
    dataSources: "Protocol docs, crawl/search text, yields metadata.",
  },
  "P.4": {
    summary: "LLTV and supply/borrow cap utilization (N/A for staking/LP).",
    dataSources: "On-chain parameters, crawl text, curator vault defaults.",
  },
  "P.5": {
    summary: "Depositor concentration via HHI and withdrawal shock capacity (WSC₅₀), harmonic mean.",
    dataSources: "On-chain deposit/Mint events, subgraphs, Dune; top-N shares as proxy when full set unavailable.",
  },
  "P.6": {
    summary: "How long this specific pool has been live.",
    dataSources: "Pool created timestamp, DefiLlama history, protocol listedAt fallback.",
  },
  "P.7": {
    summary: "Absolute pool TVL from DefiLlama yields.",
    dataSources: "DefiLlama yields API.",
  },
  "P.8": {
    summary: "Organic vs emission yield and APY stability over 30 days.",
    dataSources: "DefiLlama apyBase/apyReward; yields chart for CV.",
  },
  "P.9": {
    summary: "Curator quality for MetaMorpho-style vaults (N/A for vanilla staking/LP/PT).",
    dataSources: "Vault name, integrator list, web research.",
  },
};

const CONFIDENCE_HELP = {
  high: "Direct measurement or explicit field from a primary API (DefiLlama, on-chain parameter, named oracle in docs).",
  medium: "Strong heuristic from asset symbol, pool type, or partial API fields — verify in docs before relying on score.",
  low: "Default or inferred value where key fields are missing; treat as directional only.",
};

function defillamaPoolUrl(row) {
  const proj = String(row?.project || "").trim();
  if (!proj) return "https://defillama.com/yields";
  return `https://defillama.com/protocol/${encodeURIComponent(proj)}`;
}

function enrichCriterionMeta(key, result, row, ctx, opts = {}) {
  if (result.na) {
    return {
      confidence: "n/a",
      confidenceReason: "Not applicable for this pool type per methodology.",
      sources: [{ label: "POOL_SCORING_METHODOLOGY.md", url: null }],
    };
  }
  if (result.unavailable) {
    return {
      confidence: "low",
      confidenceReason: "Required data was not available; weight renormalized without this criterion.",
      sources: [{ label: "Data gap", url: null }],
    };
  }

  const ext = opts.externalData || ctx.externalData || {};
  const chartUrl = ext.defillamaChart?.url || null;
  const sources = [{ label: "DefiLlama yields", url: defillamaPoolUrl(row) }];

  const pickFromNotes = (idPrefix) => {
    for (const s of ext.sources || []) {
      if (String(s.id || "").startsWith(idPrefix)) {
        sources.push({ label: s.label || s.provider, url: s.url || null });
      }
    }
  };

  let confidence = "medium";
  let confidenceReason = result.evidence || "";

  switch (key) {
    case "assetQuality": {
      pickFromNotes("coingecko");
      pickFromNotes("coinmarketcap");
      if (row?.assetRankHint) {
        confidence = "high";
        confidenceReason = "Asset symbol plus CoinGecko/CMC market-cap rank for the token.";
      } else if (/^(eth|weth|btc|wbtc|usdc|usdt|dai)$/i.test(String(row?.symbol || ""))) {
        confidence = "high";
        confidenceReason = "Major asset tier from well-known symbol (methodology P.1 table).";
      } else {
        confidence = "medium";
        confidenceReason = "Asset tier inferred from symbol/heuristics; confirm exact wrapper (e.g. weETH vs ETH).";
      }
      break;
    }
    case "liquidityExit": {
      if (typeof (row?.utilization ?? row?.utilizationRate) === "number") {
        confidence = "high";
        confidenceReason = "Utilization rate from DefiLlama yields row.";
      } else {
        confidence = "medium";
        confidenceReason = "No utilization in API; score uses pool-type default (vault/LST/AMM).";
      }
      pickFromNotes("inspector");
      break;
    }
    case "oracleQuality": {
      const hint = String(row?.oracleType || row?.oracle || "").toLowerCase();
      const ev = row?.oracleEvidence || "";
      if (/chainlink|pyth|twap/i.test(hint)) {
        confidence = "high";
        confidenceReason = ev || "Oracle type from web research or crawl text.";
      } else if (result.unavailable) {
        confidence = "low";
        confidenceReason = "Oracle not identified in DefiLlama, Morpho, or web research — criterion excluded.";
      } else if (hint && hint !== "unknown" && hint !== "not specified") {
        confidence = "medium";
        confidenceReason = ev || "Oracle hint from parsed text — verify on-chain feed addresses.";
      } else {
        confidence = "low";
        confidenceReason = "Oracle not confirmed — check protocol docs and Morpho market page.";
      }
      pickFromNotes("inspector");
      if (ctx.url) sources.push({ label: "Pool URL", url: ctx.url });
      break;
    }
    case "parameterSafety": {
      if (typeof (row?.lltv ?? row?.ltv) === "number") {
        confidence = "high";
        confidenceReason = "LLTV/LTV from enriched on-chain or crawl-parsed parameters.";
      } else {
        confidence = "low";
        confidenceReason = "LLTV/caps unknown; neutral default applied.";
      }
      break;
    }
    case "poolAge": {
      if (row?.poolCreatedAt || row?.createdAt) {
        confidence = "high";
        confidenceReason = row?.poolCreatedAt
          ? "Pool age from DefiLlama APY history first sample or deployment timestamp."
          : "Pool age from deployment or listed timestamp.";
      } else if (opts.protocolListedAt) {
        confidence = "medium";
        confidenceReason = "Pool age proxied from protocol listedAt on DefiLlama.";
      } else {
        confidence = "low";
        confidenceReason = "Age estimated from DefiLlama sample count or unknown.";
      }
      if (chartUrl) sources.push({ label: "DefiLlama protocol", url: defillamaPoolUrl(row) });
      break;
    }
    case "depositorConcentration": {
      if (row?.depositorShares?.length || row?.depositorSharePercents?.length) {
        confidence = "high";
        confidenceReason = "HHI/WSC computed from depositor share inputs.";
      } else if (row?.top1DepositorPct != null) {
        confidence = "medium";
        confidenceReason = "HHI/WSC approximated from top1/top3 — prefer full depositor share list.";
      } else {
        confidence = "low";
        confidenceReason = "Depositor shares not available; criterion excluded from score.";
      }
      break;
    }
    case "poolTvl":
      confidence = "high";
      confidenceReason = "TVL taken directly from DefiLlama yields row.";
      break;
    case "yieldQuality": {
      pickFromNotes("defillama_chart");
      if (chartUrl) sources.push({ label: "DefiLlama APY chart", url: chartUrl });
      if (isFinite(Number(row?.apyBase))) {
        confidence = "high";
        confidenceReason = "Organic vs reward split from DefiLlama apyBase/apyReward.";
      } else {
        confidence = "medium";
        confidenceReason = "APY breakdown estimated from total APY when base/reward split missing.";
      }
      break;
    }
    case "curatorQuality": {
      pickFromNotes("inspector");
      if (row?.curator && row?.curatorEvidence) {
        confidence = "high";
        confidenceReason = `${row.curatorEvidence}`;
        sources.push({ label: "Morpho API / LLM", url: ctx.url || null });
      } else if (/steakhouse|gauntlet|re7|mev capital/i.test(String(ctx.label || "") + row?.curator)) {
        confidence = "high";
        confidenceReason = "Named curator matched from vault label or Morpho API.";
      } else if (result.unavailable) {
        confidence = "low";
        confidenceReason = "Curated vault without resolved curator — score excluded from total.";
      } else if (result.score != null) {
        confidence = "medium";
        confidenceReason = "Curator inferred from label/heuristics; confirm on vault page.";
      }
      break;
    }
    default:
      break;
  }

  return { confidence, confidenceReason, sources };
}

function buildQualitativeFlags(ctx, poolType) {
  const flags = [];
  const depth = Number(ctx?.dependencyDepth);
  if (depth > 2) flags.push({ id: "cross_protocol_depth", message: `Dependency depth ${depth} > 2 — manual review.` });
  const row = primaryYieldsRow(ctx.yieldsRows, {
    vaultAddress: ctx.vaultAddress,
    chain: ctx.chain,
    nameHint: ctx.nameHint,
  });
  if (row?.ilRisk === "yes") flags.push({ id: "il_risk", message: "DefiLlama marks IL risk on this pool." });
  if (poolType === "pendle_pt") flags.push({ id: "maturity", message: "PT position — confirm days to maturity and secondary liquidity." });
  return flags;
}

/**
 * @param {object} ctx — pool intelligence context
 * @param {object} [opts] — protocolDetail for issuer listedAt
 */
export function buildPoolRiskAssessment(ctx, opts = {}) {
  const rowOpts = {
    vaultAddress: ctx.vaultAddress,
    chain: ctx.chain,
    nameHint: ctx.nameHint,
  };
  const row = primaryYieldsRow(ctx.yieldsRows, rowOpts);
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
    depositorConcentration: () => scoreDepositorConcentration(row),
    poolAge: () => scorePoolAge(row, protocolListedAt),
    poolTvl: () => scorePoolTvl(row),
    yieldQuality: () => scoreYieldQuality(row),
    curatorQuality: () => scoreCurator(poolType, ctx.integrators, ctx.issuerSlug, ctx.label, row),
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

    const meta = enrichCriterionMeta(def.key, result, row, ctx, opts);
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
      calcBreakdown: result.calcBreakdown || null,
      confidence: meta.confidence,
      confidenceReason: meta.confidenceReason,
      sources: meta.sources,
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

  const primaryPool = row
    ? {
        project: row.project,
        symbol: row.symbol,
        chain: row.chain,
        tvlUsd: row.tvlUsd,
        poolId: row.pool,
      }
    : null;

  return {
    methodologyVersion: METHODOLOGY_VERSION,
    poolType,
    primaryPool,
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
      "See POOL_SCORING_METHODOLOGY.md v2.0.",
    ],
  };
}

export function getPoolScoringSchema() {
  return {
    version: METHODOLOGY_VERSION,
    formula: "pool_score = sum(score_i × weight_i) / sum(weight_i) × 100",
    confidenceLevels: CONFIDENCE_HELP,
    criteria: CRITERIA.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      weightPct: Math.round(c.weight * 100),
      guide: CRITERION_GUIDE[c.id] || null,
    })),
  };
}
