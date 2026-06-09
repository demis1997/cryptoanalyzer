/**
 * Parse pool-specific metrics from crawled protocol UI / docs text.
 * Used for P.2 (exit liquidity), P.4 (LLTV), P.7 (pool TVL) — not token-level aggregates.
 */

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

/**
 * @returns {Record<string, unknown>}
 */
export function parsePoolPageMetrics(text) {
  const t = String(text || "");
  const hints = {};
  if (!t.trim()) return hints;

  const tvlHit = firstMatchAmount(t, TVL_PATTERNS);
  if (tvlHit) {
    hints.poolTvlUsd = tvlHit.amount;
    hints.tvlSource = "pool_page";
    hints.tvlEvidence = `Parsed from page text: "${tvlHit.match}"`;
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

  const cap = t.match(/\b(?:supply|borrow)\s+cap[:\s]*(\d{2,3}(?:\.\d+)?)\s*%\s*(?:filled|util)/i);
  if (cap) hints.capUtilization = Number(cap[1]) / 100;

  if (/chainlink/i.test(t)) {
    hints.oracleType = /derived|composite|wsteth\/eth/i.test(t) ? "chainlink_derived" : "chainlink";
  } else if (/pyth/i.test(t)) hints.oracleType = "pyth";
  else if (/twap/i.test(t)) hints.oracleType = /30\s*min|1800/i.test(t) ? "twap_long" : "twap_short";

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
  if (m.capUtilization != null && out.capUtilization == null) out.capUtilization = m.capUtilization;
  if (m.oracleType && !out.oracleType) out.oracleType = m.oracleType;
  return out;
}
