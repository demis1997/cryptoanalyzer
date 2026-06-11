/**
 * Parse pool-specific metrics from crawled protocol UI / docs text.
 * Used for P.2 (exit liquidity), P.4 (LLTV), P.7 (pool TVL) — not token-level aggregates.
 */
import { parsePoolPageContent, parseStructuredPoolMetrics } from "./poolPageStructuredParse.js";

function parseMoneyAmount(raw, suffix = "") {
  const num = Number(String(raw || "").replace(/,/g, ""));
  if (!isFinite(num) || num <= 0) return null;
  const s = String(suffix || "").toLowerCase();
  if (s === "k") return num * 1_000;
  if (s === "m") return num * 1_000_000;
  if (s === "b") return num * 1_000_000_000;
  if (s === "t") return num * 1_000_000_000_000;
  return num;
}

/** Extract first USD amount from a regex match [full, num, suffix?]. */
function moneyFromMatch(m) {
  if (!m) return null;
  return parseMoneyAmount(m[1], m[2]);
}

const TVL_PATTERNS = [
  /\bTotal\s+Liquidity[\s\n:]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\bAvailable\s+Liquidity[\s\n:]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\bAMM\s+Liquidity[\s\n:]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:SY|PT|YT|LP)\s+Liquidity[\s\n:]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:pool|market|vault)\s+tvl[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\btvl[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\btotal\s+(?:value\s+locked|liquidity|assets|deposits?|supply|size)[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:total\s+)?assets\s+under\s+management[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:deposited|supplied|liquidity|capital)\s*(?:in\s+pool)?[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\bmarket\s+(?:size|liquidity|cap)[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:net\s+)?assets[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\b(?:pool|vault)\s+balance[:\s]*\$?\s*([\d,.]+)\s*([kmbt])?\b/i,
  /\$\s*([\d,.]+)\s*([kmbt])?\s+(?:tvl|total\s+liquidity|in\s+(?:the\s+)?pool|deposited)\b/i,
  /\b([\d,.]+)\s*([kmbt])?\s+usd\s+(?:tvl|liquidity|deposited|in\s+pool)\b/i,
];

const UTIL_PATTERNS = [
  /\butilization(?:\s+rate)?[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\b(?:supply|borrow|lending)\s+utilization[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\b(\d{2,3}(?:\.\d+)?)\s*%\s+utilized\b/i,
  /\bcurrent\s+utilization[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\b(?:pool|market)\s+utilization[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\bcapacity\s+used[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
];

const LLTV_PATTERNS = [
  /\b(?:LLTV|LTV|loan[- ]to[- ]value|liquidation\s+(?:threshold|ltv))[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\b(?:max(?:imum)?\s+)?ltv[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i,
  /\bcollateral\s+factor[:\s]*(\d(?:\.\d+)?)/i,
];

const WITHDRAWAL_QUEUE_PATTERNS = [
  /\b(?:withdrawal|exit|unbonding|unstake|redemption)\s+queue[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(?:wait|delay|processing)\s+(?:time|period)[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(\d{1,4})\s*days?\s+(?:withdrawal|exit|unbonding|unstake|redemption)\s+queue\b/i,
  /\bqueue\s+(?:time|wait|delay)[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(?:estimated|average)\s+(?:wait|delay)[:\s]*(\d{1,4})\s*days?\b/i,
  /\bunbonding\s+period[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(\d{1,4})\s*days?\s+to\s+(?:withdraw|unstake|redeem|exit)\b/i,
  /\b(?:withdraw|unstake|redeem)\s+(?:in|after)[:\s]*(\d{1,4})\s*days?\b/i,
];

const COOLDOWN_PATTERNS = [
  /\b(?:cooldown|cool[- ]down|withdrawal)\s+period[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(\d{1,4})\s*days?\s+(?:cooldown|cool[- ]down|withdrawal\s+period)\b/i,
  /\block(?:ed)?\s+for[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(?:exit|withdrawal)\s+cooldown[:\s]*(\d{1,4})\s*days?\b/i,
];

const MATURITY_PATTERNS = [
  /\b(\d{1,4})\s*days?\s+(?:to\s+)?maturity\b/i,
  /\bdays?\s+to\s+maturity[:\s]*(\d{1,4})\b/i,
  /\bmaturity[:\s]*(\d{1,4})\s*days?\b/i,
  /\bmaturity[:\s]*(\d{1,4})\b(?!\s*[-/])/i,
  /\bexpires?\s+(?:in\s+)?(\d{1,4})\s*days?\b/i,
  /\bdays?\s+until\s+(?:maturity|expiry)[:\s]*(\d{1,4})\b/i,
  /\btime\s+to\s+maturity[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(?:pt|principal\s+token)\s+maturity[:\s]*(\d{1,4})\s*days?\b/i,
  /\bredemption\s+date[:\s]*(\d{1,4})\s*days?\b/i,
  /\b(?:fixed|term)\s+(?:end|expiry)[:\s]*(\d{1,4})\s*days?\b/i,
];

function firstMatchAmount(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    const amt = moneyFromMatch(m);
    if (amt != null && amt >= 1_000) return { amount: amt, match: m[0].trim().slice(0, 80) };
  }
  return null;
}

function firstMatchNumber(text, patterns, { asPct = false } = {}) {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let n = Number(m[1]);
    if (!isFinite(n)) continue;
    if (asPct && n > 0 && n <= 1) n *= 100;
    if (re.source.includes("collateral\\s+factor") && n > 0 && n <= 1) n *= 100;
    return { value: n, match: m[0].trim().slice(0, 80) };
  }
  return null;
}

function parseMaturityDate(text) {
  const iso = text.match(/\bmaturity(?:\s+date)?[:\s]*(\d{4}-\d{2}-\d{2})\b/i);
  if (!iso) return null;
  const ms = Date.parse(iso[1]);
  if (!isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86400000);
  return { value: days, match: iso[0].trim() };
}

function detectPendleSecondaryMarket(text) {
  const t = String(text || "");
  if (/\bno\s+(?:active\s+)?secondary\s+market\b/i.test(t)) return false;
  if (/\bsecondary\s+market\b/i.test(t)) return true;
  if (/\btrade\s+(?:this\s+)?pt\b/i.test(t)) return true;
  if (/\b(?:uniswap|curve|balancer|dex)\s+liquidity\b/i.test(t)) return true;
  return null;
}

function detectStakingSecondaryMarket(text) {
  const t = String(text || "");
  if (/\b(?:sell|trade|exit)\s+(?:on|via)\s+(?:dex|uniswap|curve|balancer)\b/i.test(t)) return true;
  if (/\bsecondary\s+(?:market|liquidity)\b/i.test(t)) return true;
  if (/\bliquid\s+(?:staking|derivative|token)\b/i.test(t) && /\b(?:uniswap|curve|dex)\b/i.test(t)) return true;
  return null;
}

function detectInstantWithdrawal(text) {
  const t = String(text || "");
  if (/\b(?:sell|trade|exit)\s+(?:on|via)\s+(?:dex|uniswap|curve|balancer)\b/i.test(t)) return false;
  return /\b(?:instant|immediate)\s+(?:withdraw|unstake|redemption)\b/i.test(t);
}

/**
 * @returns {Record<string, unknown>}
 */
export function parsePoolPageMetrics(text, opts = {}) {
  const t = String(text || "");
  const hints = {};
  if (!t.trim()) return hints;

  const structured =
    opts.innerText != null || opts.html
      ? parsePoolPageContent({
          innerText: opts.innerText ?? t,
          html: opts.html || "",
          url: opts.url || "",
          poolLabel: opts.poolLabel || "",
        })
      : parseStructuredPoolMetrics(t, { url: opts.url, poolLabel: opts.poolLabel });
  Object.assign(hints, structured);

  const tvlHit = hints.poolTvlUsd == null ? firstMatchAmount(t, TVL_PATTERNS) : null;
  if (tvlHit) {
    if (hints.poolTvlUsd == null || /total\s+supply|supply\s+assets/i.test(tvlHit.match)) {
      hints.poolTvlUsd = tvlHit.amount;
      hints.tvlSource = "pool_page";
      hints.tvlEvidence = `Parsed from page text: "${tvlHit.match}"`;
    }
    if (/AMM\s+Liquidity/i.test(tvlHit.match)) {
      hints.pendleAmmLiquidityUsd = tvlHit.amount;
      hints.ammLiquidityUsd = tvlHit.amount;
    }
  }

  const utilHit = firstMatchNumber(t, UTIL_PATTERNS);
  if (utilHit) {
    hints.utilization = utilHit.value / 100;
    hints.utilizationEvidence = `Parsed: "${utilHit.match}"`;
  }

  const lltvHit = firstMatchNumber(t, LLTV_PATTERNS);
  if (lltvHit) {
    hints.lltv = lltvHit.value;
    hints.lltvEvidence = `Parsed: "${lltvHit.match}"`;
  }

  let maturityHit = firstMatchNumber(t, MATURITY_PATTERNS);
  if (!maturityHit) maturityHit = parseMaturityDate(t);
  if (maturityHit) {
    hints.pendleDaysToMaturity = Math.round(maturityHit.value);
    hints.daysToMaturity = hints.pendleDaysToMaturity;
    hints.maturityEvidence = `Parsed: "${maturityHit.match}"`;
  }

  const secondary = detectPendleSecondaryMarket(t);
  if (secondary != null) {
    hints.pendleSecondaryMarket = secondary;
    hints.pendleSecondaryEvidence = secondary ? "Secondary market mentioned on page" : "No active secondary market noted";
  }

  if (detectInstantWithdrawal(t)) {
    hints.withdrawalQueueDays = 0;
    hints.withdrawalQueueEvidence = "Parsed: instant withdrawal noted on page";
  }
  const queueHit = firstMatchNumber(t, WITHDRAWAL_QUEUE_PATTERNS);
  if (queueHit) {
    hints.withdrawalQueueDays = Math.round(queueHit.value);
    hints.withdrawalQueueEvidence = `Parsed: "${queueHit.match}"`;
  }

  const cooldownHit = firstMatchNumber(t, COOLDOWN_PATTERNS);
  if (cooldownHit) {
    hints.vaultCooldownDays = Math.round(cooldownHit.value);
    hints.vaultCooldownEvidence = `Parsed: "${cooldownHit.match}"`;
  }

  const stakingSecondary = detectStakingSecondaryMarket(t);
  if (stakingSecondary != null) {
    hints.stakingSecondaryMarket = stakingSecondary;
    hints.stakingSecondaryEvidence = "Secondary DEX liquidity mentioned on page";
  }

  const cap = t.match(/\b(?:supply|borrow)\s+cap[:\s]*(\d{2,3}(?:\.\d+)?)\s*%\s*(?:filled|util)/i);
  if (cap) hints.capUtilization = Number(cap[1]) / 100;

  if (/chainlink/i.test(t)) {
    hints.oracleType = /derived|composite|wsteth\/eth/i.test(t) ? "chainlink_derived" : "chainlink";
  } else if (/pyth/i.test(t)) hints.oracleType = "pyth";
  else if (/twap/i.test(t)) hints.oracleType = /30\s*min|1800/i.test(t) ? "twap_long" : "twap_short";

  const apyBase = t.match(/\b(?:base|organic|supply)\s+apy[:\s]*(\d{1,2}(?:\.\d+)?)\s*%/i);
  const apyReward = t.match(/\b(?:reward|incentive|emission|boost)\s+apy[:\s]*(\d{1,2}(?:\.\d+)?)\s*%/i);
  const apyTotal =
    t.match(/\b(?:net\s+)?apy[:\s]*(\d{1,2}(?:\.\d+)?)\s*%/i) ||
    t.match(/\byield[:\s]*(\d{1,2}(?:\.\d+)?)\s*%/i) ||
    t.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\s+(?:apy|apr|yield)\b/i);
  if (apyBase) {
    hints.apyBase = Number(apyBase[1]);
    hints.apySource = "pool_page";
    hints.apyEvidence = `Parsed: "${apyBase[0].trim().slice(0, 60)}"`;
  }
  if (apyReward) {
    hints.apyReward = Number(apyReward[1]);
    hints.apySource = hints.apySource || "pool_page";
    hints.apyEvidence = hints.apyEvidence || `Parsed: "${apyReward[0].trim().slice(0, 60)}"`;
  }
  if (apyTotal && hints.apyBase == null) {
    hints.apy = Number(apyTotal[1]);
    hints.apySource = "pool_page";
    hints.apyEvidence = `Parsed: "${apyTotal[0].trim().slice(0, 60)}"`;
  } else if (apyTotal && hints.apyBase != null && hints.apyReward == null) {
    hints.apy = hints.apyBase + Number(apyTotal[1]) > hints.apyBase ? Number(apyTotal[1]) : hints.apyBase;
  }

  const volatile = /\b(?:apy|yield)\s+(?:volatile|unstable|highly variable)/i.test(t);
  const stable = /\b(?:apy|yield)\s+(?:stable|steady|consistent)/i.test(t);
  if (volatile) {
    hints.apyCv30d = 0.55;
    hints.apyStabilityEvidence = "Web text: APY described as volatile";
  } else if (stable) {
    hints.apyCv30d = 0.08;
    hints.apyStabilityEvidence = "Web text: APY described as stable";
  }

  const launched =
    t.match(/\b(?:launched|deployed|created|live since)[:\s]*(\d{4}-\d{2}-\d{2})\b/i) ||
    t.match(/\bcreated[:\s]*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i);
  if (launched) {
    const ms = Date.parse(launched[1]);
    if (isFinite(ms)) {
      hints.poolCreatedAt = ms;
      hints.poolAgeEvidence = `Parsed launch date: ${launched[1]}`;
      hints.poolCreatedAtSource = "pool_page";
    }
  }

  return hints;
}

/** Merge page metrics; pool-page TVL wins over weaker hints. */
export function mergePageMetricsIntoHints(hints, metrics) {
  const out = { ...hints };
  const m = metrics || {};
  if (m.poolTvlUsd != null) {
    out.poolTvlUsd = m.poolTvlUsd;
    out.tvlSource = m.tvlSource || "pool_page";
    out.tvlEvidence = m.tvlEvidence || null;
  }
  if (m.utilization != null && out.utilization == null) {
    out.utilization = m.utilization;
    out.utilizationEvidence = m.utilizationEvidence;
  }
  if (m.lltv != null && out.lltv == null) {
    out.lltv = m.lltv;
    out.lltvEvidence = m.lltvEvidence;
  }
  if (m.pendleDaysToMaturity != null) {
    out.pendleDaysToMaturity = m.pendleDaysToMaturity;
    out.daysToMaturity = m.daysToMaturity;
    out.maturityEvidence = m.maturityEvidence;
  }
  if (m.pendleSecondaryMarket != null) {
    out.pendleSecondaryMarket = m.pendleSecondaryMarket;
    out.pendleSecondaryEvidence = m.pendleSecondaryEvidence;
  }
  if (m.withdrawalQueueDays != null && out.withdrawalQueueDays == null) {
    out.withdrawalQueueDays = m.withdrawalQueueDays;
    out.withdrawalQueueEvidence = m.withdrawalQueueEvidence;
  }
  if (m.vaultCooldownDays != null && out.vaultCooldownDays == null) {
    out.vaultCooldownDays = m.vaultCooldownDays;
    out.vaultCooldownEvidence = m.vaultCooldownEvidence;
  }
  if (m.stakingSecondaryMarket != null && out.stakingSecondaryMarket == null) {
    out.stakingSecondaryMarket = m.stakingSecondaryMarket;
    out.stakingSecondaryEvidence = m.stakingSecondaryEvidence;
  }
  if (m.capUtilization != null && out.capUtilization == null) out.capUtilization = m.capUtilization;
  if (m.oracleType && !out.oracleType) out.oracleType = m.oracleType;
  if (m.apy != null && out.apy == null) {
    out.apy = m.apy;
    out.apySource = m.apySource || "pool_page";
    out.apyEvidence = m.apyEvidence;
  }
  if (m.apyBase != null && out.apyBase == null) {
    out.apyBase = m.apyBase;
    out.apySource = m.apySource || "pool_page";
    out.apyEvidence = m.apyEvidence;
  }
  if (m.apyReward != null && out.apyReward == null) out.apyReward = m.apyReward;
  if (m.apyCv30d != null && out.apyCv30d == null) {
    out.apyCv30d = m.apyCv30d;
    out.apyStabilityEvidence = m.apyStabilityEvidence;
  }
  if (m.poolCreatedAt != null && out.poolCreatedAt == null) {
    out.poolCreatedAt = m.poolCreatedAt;
    out.poolAgeEvidence = m.poolAgeEvidence;
  }
  if (m.pendleAmmLiquidityUsd != null) {
    out.pendleAmmLiquidityUsd = m.pendleAmmLiquidityUsd;
    out.ammLiquidityUsd = m.ammLiquidityUsd ?? m.pendleAmmLiquidityUsd;
    if (out.poolTvlUsd == null) {
      out.poolTvlUsd = m.pendleAmmLiquidityUsd;
      out.tvlSource = out.tvlSource || "protocol_api";
      out.tvlEvidence =
        out.tvlEvidence ||
        `Pendle AMM liquidity $${Math.round(m.pendleAmmLiquidityUsd).toLocaleString()}`;
    }
  }
  return out;
}
