/**
 * Structured extraction from rendered pool pages (innerText / HTML).
 * Complements regex parsing in poolPageParse.js for SPA dashboards (Morpho, Aave, Pendle).
 */

function parseMoneyAmount(raw, suffix = "") {
  const num = Number(String(raw || "").replace(/,/g, ""));
  if (!isFinite(num) || num <= 0) return null;
  const s = String(suffix || "").toLowerCase();
  if (s === "k") return num * 1_000;
  if (s === "m" || s === "mm") return num * 1_000_000;
  if (s === "b" || s === "bn") return num * 1_000_000_000;
  if (s === "t") return num * 1_000_000_000_000;
  return num;
}

export function parseMoneyToUsd(raw, suffix) {
  return parseMoneyAmount(raw, suffix);
}

const MONEY_RE = /\$?\s*([\d,.]+)\s*([kmbt]|bn|mm)?\b/i;
const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/;

function isPlausibleMoneyMatch(m) {
  if (!m) return false;
  const matched = String(m[0] || "");
  const hasDollar = matched.includes("$");
  const hasSuffix = Boolean(m[2]);
  const hasComma = String(m[1] || "").includes(",");
  const digitsOnly = String(m[1] || "").replace(/[.,]/g, "");
  return hasDollar || hasSuffix || hasComma || digitsOnly.length >= 4;
}

function moneyFromLine(line) {
  const m = MONEY_RE.exec(String(line || ""));
  if (!isPlausibleMoneyMatch(m)) return null;
  const usd = parseMoneyAmount(m[1], m[2]);
  if (usd == null || usd < 1_000) return null;
  return { usd, label: m[0].trim() };
}

function pctFromLine(line) {
  const m = PCT_RE.exec(String(line || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n)) return null;
  return { value: n, label: m[0].trim() };
}

function normalizeLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function lineMatchesLabel(line, labels) {
  const lower = String(line || "").toLowerCase();
  return labels.some((lab) => {
    const l = lab.toLowerCase();
    if (lower === l) return true;
    if (lower.startsWith(`${l} `) || lower.startsWith(`${l}:`)) return true;
    if (lower.endsWith(` ${l}`) || lower.includes(`${l}:`)) return true;
    return false;
  });
}

function findNear(lines, idx, { money = false, pct = false, window = 3 } = {}) {
  const slice = lines.slice(idx, Math.min(lines.length, idx + window + 1));
  for (const line of slice) {
    if (money) {
      const hit = moneyFromLine(line);
      if (hit) return hit;
    }
    if (pct) {
      const hit = pctFromLine(line);
      if (hit) return hit;
    }
  }
  return null;
}

const TVL_LABEL_GROUPS = [
  { key: "availableLiquidity", labels: ["available liquidity", "liquidity available", "borrowable liquidity", "cash liquidity"], priority: 0 },
  { key: "totalLiquidity", labels: ["total liquidity", "market liquidity", "pool liquidity", "liquidity in pool"], priority: 1 },
  { key: "ammLiquidity", labels: ["amm liquidity", "sy liquidity", "pt liquidity", "yt liquidity", "lp liquidity"], priority: 1 },
  { key: "tvl", labels: ["tvl", "total value locked", "total assets", "net assets", "assets under management", "total deposits", "market size"], priority: 2 },
  { key: "supply", labels: ["total supply", "supply assets", "supplied"], priority: 8, skipIfLending: true },
];

function isLendingPage(text, url) {
  const hay = `${url || ""} ${text || ""}`.toLowerCase();
  return /morpho|aave|compound|spark|borrow|lend|lltv|utilization|collateral/i.test(hay);
}

/**
 * Label-adjacent extraction from rendered innerText (SPA dashboards).
 */
export function parseStructuredPoolMetrics(innerText, { url = "", poolLabel = "" } = {}) {
  const hints = {};
  const lines = normalizeLines(innerText);
  if (!lines.length) return hints;

  const lending = isLendingPage(innerText, url);
  const tvlHits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const group of TVL_LABEL_GROUPS) {
      if (group.skipIfLending && lending) continue;
      if (!lineMatchesLabel(line, group.labels)) continue;
      const near = moneyFromLine(line) || findNear(lines, i, { money: true, window: 4 });
      if (near) {
        tvlHits.push({
          usd: near.usd,
          priority: group.priority,
          evidence: `"${line}" → ${near.label}`,
          group: group.key,
        });
      }
    }

    if (lineMatchesLabel(line, ["utilization", "utilization rate", "supply utilization", "market utilization"])) {
      const hit = pctFromLine(line) || findNear(lines, i, { pct: true, window: 3 });
      if (hit) {
        hints.utilization = hit.value / 100;
        hints.utilizationEvidence = `Structured: ${line} → ${hit.label || hit.value + "%"}`;
      }
    }

    if (lineMatchesLabel(line, ["lltv", "ltv", "loan-to-value", "liquidation ltv", "liquidation threshold", "max ltv"])) {
      const hit = pctFromLine(line) || findNear(lines, i, { pct: true, window: 3 });
      if (hit) {
        hints.lltv = hit.value;
        hints.lltvEvidence = `Structured: ${line} → ${hit.label || hit.value + "%"}`;
      }
    }

    if (lineMatchesLabel(line, ["net apy", "supply apy", "net yield", "apy", "current apy"])) {
      const hit = pctFromLine(line) || findNear(lines, i, { pct: true, window: 3 });
      if (hit && hints.apy == null && hints.apyBase == null) {
        hints.apy = hit.value;
        hints.apySource = "pool_page";
        hints.apyEvidence = `Structured: ${line} → ${hit.label || hit.value + "%"}`;
      }
    }

    if (lineMatchesLabel(line, ["base apy", "organic apy", "supply rate"])) {
      const hit = pctFromLine(line) || findNear(lines, i, { pct: true, window: 3 });
      if (hit) {
        hints.apyBase = hit.value;
        hints.apySource = "pool_page";
        hints.apyEvidence = `Structured: ${line} → ${hit.label || hit.value + "%"}`;
      }
    }

    if (lineMatchesLabel(line, ["reward apy", "incentive apy", "emissions apy"])) {
      const hit = pctFromLine(line) || findNear(lines, i, { pct: true, window: 3 });
      if (hit) {
        hints.apyReward = hit.value;
        hints.apySource = "pool_page";
      }
    }

    if (lineMatchesLabel(line, ["days to maturity", "time to maturity", "maturity"])) {
      const days = line.match(/(\d{1,4})\s*days?/i) || lines[i + 1]?.match(/(\d{1,4})\s*days?/i);
      if (days) {
        hints.pendleDaysToMaturity = Number(days[1]);
        hints.daysToMaturity = hints.pendleDaysToMaturity;
        hints.maturityEvidence = `Structured: ${line}`;
      }
    }

    if (/chainlink/i.test(line)) {
      hints.oracleType = /derived|composite/i.test(line) ? "chainlink_derived" : "chainlink";
    }
  }

  if (tvlHits.length) {
    tvlHits.sort((a, b) => a.priority - b.priority);
    const best = tvlHits[0];
    hints.poolTvlUsd = best.usd;
    hints.tvlSource = "pool_page";
    hints.tvlEvidence = `Structured page parse: ${best.evidence}`;
    if (best.group === "ammLiquidity") {
      hints.pendleAmmLiquidityUsd = best.usd;
      hints.ammLiquidityUsd = best.usd;
    }
    if (best.group === "availableLiquidity") {
      hints.availableLiquidityUsd = best.usd;
    }
  }

  return hints;
}

/** Shallow JSON field extraction from embedded SPA payloads. */
export function extractEmbeddedJsonMetrics(html) {
  const hints = {};
  const h = String(html || "");
  if (!h.trim()) return hints;

  const jsonFieldPatterns = [
    { re: /"liquidityAssetsUsd"\s*:\s*([\d.]+)/i, field: "poolTvlUsd", evidence: "liquidityAssetsUsd in page JSON" },
    { re: /"availableLiquidityUsd"\s*:\s*([\d.]+)/i, field: "poolTvlUsd", evidence: "availableLiquidityUsd in page JSON" },
    { re: /"totalLiquidityUsd"\s*:\s*([\d.]+)/i, field: "poolTvlUsd", evidence: "totalLiquidityUsd in page JSON" },
    { re: /"supplyAssetsUsd"\s*:\s*([\d.]+)/i, field: "supplyAssetsUsd", evidence: "supplyAssetsUsd in page JSON", deprioritize: true },
    { re: /"utilization"\s*:\s*([\d.]+)/i, field: "utilization", evidence: "utilization in page JSON", asPct: true },
    { re: /"lltv"\s*:\s*([\d.]+)/i, field: "lltv", evidence: "lltv in page JSON", asPct: true },
    { re: /"netApy"\s*:\s*([\d.]+)/i, field: "apy", evidence: "netApy in page JSON", asPct: true },
  ];

  for (const { re, field, evidence, asPct, deprioritize } of jsonFieldPatterns) {
    const m = h.match(re);
    if (!m) continue;
    let val = Number(m[1]);
    if (!isFinite(val)) continue;
    if (asPct && val > 0 && val <= 1) val *= 100;
    if (field === "utilization" && val > 1) val /= 100;
    if (deprioritize) continue;
    if (field === "poolTvlUsd" && hints.poolTvlUsd == null) {
      hints.poolTvlUsd = val;
      hints.tvlSource = "pool_page";
      hints.tvlEvidence = evidence;
    } else if (field === "utilization" && hints.utilization == null) {
      hints.utilization = val > 1 ? val / 100 : val;
      hints.utilizationEvidence = evidence;
    } else if (field === "lltv" && hints.lltv == null) {
      hints.lltv = val;
      hints.lltvEvidence = evidence;
    } else if (field === "apy" && hints.apy == null) {
      hints.apy = val;
      hints.apySource = "pool_page";
      hints.apyEvidence = evidence;
    }
  }

  return hints;
}

/**
 * Full pool page parse: structured innerText + embedded JSON + fallback regex text.
 */
export function parsePoolPageContent({ innerText = "", html = "", url = "", poolLabel = "" } = {}) {
  const structured = parseStructuredPoolMetrics(innerText, { url, poolLabel });
  const embedded = extractEmbeddedJsonMetrics(html);
  const combined = { ...embedded, ...structured };

  if (innerText && !combined.poolTvlUsd) {
    const blob = String(innerText).slice(0, 12000);
    const morphoLiquidity = blob.match(/\bTotal\s+Liquidity\b[\s\n]*\$?\s*([\d,.]+)\s*([kmb])?/i);
    if (morphoLiquidity) {
      const usd = parseMoneyAmount(morphoLiquidity[1], morphoLiquidity[2]);
      if (usd != null) {
        combined.poolTvlUsd = usd;
        combined.tvlSource = "pool_page";
        combined.tvlEvidence = `Morpho-style Total Liquidity $${morphoLiquidity[0].trim().slice(0, 40)}`;
      }
    }
  }

  return combined;
}
