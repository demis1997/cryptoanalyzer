import { runHostedLlmJson } from "../llm/provider.js";
import { parseScoringHintsFromText } from "./poolDataSources.js";
import { mergeTvlIntoRow } from "./tvlSourcePriority.js";

function llmEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_INTELLIGENCE_LLM || "1").trim());
}

function curatorFromLabel(label = "") {
  const hay = String(label).toLowerCase();
  if (/steakhouse|steakusdc|steaketh/i.test(hay)) return { curator: "Steakhouse Financial", evidence: "Vault name/symbol" };
  if (/gauntlet/i.test(hay)) return { curator: "Gauntlet", evidence: "Vault name" };
  if (/re7/i.test(hay)) return { curator: "Re7 Labs", evidence: "Vault name" };
  if (/mev capital|smokehouse/i.test(hay)) return { curator: "MEV Capital", evidence: "Vault name" };
  return null;
}

/**
 * LLM + heuristics: curator name, oracle type, LLTV/utilization from crawl/search text.
 */
export async function enrichPoolMetadataWithLlm({
  poolLabel,
  poolUrl,
  issuerSlug,
  yieldsRow,
  webResearch,
  poolIdentity = null,
  externalData = null,
  trace = null,
} = {}) {
  const out = { hints: {}, sources: [] };
  const fromLabel = curatorFromLabel(poolLabel);
  if (fromLabel) {
    out.hints.curator = fromLabel.curator;
    out.sources.push({ label: "Vault label", detail: fromLabel.evidence });
  }

  const blob = [
    webResearch?.formatted || "",
    webResearch?.crawl?.formatted || "",
    webResearch?.scoringResearch?.formatted || "",
    webResearch?.duneResearch?.formatted || "",
  ].join("\n");
  Object.assign(out.hints, parseScoringHintsFromText(blob));

  if (!llmEnabled()) return out;

  const rowSummary = yieldsRow
    ? {
        project: yieldsRow.project,
        symbol: yieldsRow.symbol,
        chain: yieldsRow.chain,
        tvlUsd: yieldsRow.tvlUsd,
        pool: yieldsRow.pool,
        apyBase: yieldsRow.apyBase,
        curator: yieldsRow.curator,
        oracleType: yieldsRow.oracleType,
        lltv: yieldsRow.lltv,
        utilization: yieldsRow.utilization,
      }
    : {};

  const missing = [];
  if (!yieldsRow?.oracleType) missing.push("oracleType");
  if (yieldsRow?.lltv == null) missing.push("lltvPct");
  if (yieldsRow?.utilization == null) missing.push("utilizationPct");
  if (!yieldsRow?.tvlUsd || yieldsRow?.tvlUncertain) missing.push("poolTvlUsd");
  if (/pendle|pt-/i.test(`${poolLabel} ${yieldsRow?.symbol || ""}`) && yieldsRow?.pendleDaysToMaturity == null) {
    missing.push("daysToMaturity");
  }
  if (!yieldsRow?.curator && /vault|curat|metamorpho|euler/i.test(`${poolLabel} ${issuerSlug}`)) {
    missing.push("curator");
  }
  if (yieldsRow?.apyBase == null && yieldsRow?.apy == null) missing.push("apyBasePct");

  trace?.step?.("LLM pool metadata (oracle / curator)", {
    kind: "llm",
    detail: poolLabel || poolUrl || issuerSlug || "",
  });

  const tvlCandidates = poolIdentity?.tvlCandidates || [];
  const cgSummary = (externalData?.coinGecko || [])
    .filter((c) => c.ok)
    .map((c) => `${c.token || c.symbol}: rank #${c.marketCapRank ?? "—"}, mcap $${c.marketCapUsd ? Math.round(c.marketCapUsd).toLocaleString() : "—"}`)
    .join("; ");
  const cmcSummary = externalData?.coinMarketCap?.ok
    ? Object.entries(externalData.coinMarketCap.quotes || {})
        .map(([s, q]) => `${s} rank #${q.rank ?? "—"}`)
        .join(", ")
    : "";

  const system = `You extract factual pool/vault metadata for DeFi risk scoring by comparing MULTIPLE sources.
Works for ANY protocol (Aave, Morpho, Pendle, Euler, Curve, Compound, etc.) — not Morpho-specific.
You cannot browse the web.

TVL SOURCE PRIORITY (for poolTvlUsd only — follow strictly):
1. Protocol/contract API or on-chain resolver (already in TVL CANDIDATES as protocol_api / on_chain) — NEVER override with a lower tier.
2. Playwright pool page crawl (pool_page).
3. DefiLlama / Dune / pool analytics dashboards (defillama / dune).
4. Web search snippets (lowest) — only if no higher tier exists.

CoinGecko and CoinMarketCap are for ASSET quality (token rank/market cap), NOT pool TVL.
Do NOT use token market cap as pool TVL.
Return JSON only — no markdown:
{
  "curator": string | null,
  "curatorEvidence": string,
  "oracleType": "chainlink" | "chainlink_derived" | "pyth" | "twap_long" | "twap_short" | "custom_multi" | "custom_single" | null,
  "oracleEvidence": string,
  "lltvPct": number | null,
  "utilizationPct": number | null,
  "poolTvlUsd": number | null,
  "poolTvlEvidence": string,
  "daysToMaturity": number | null,
  "pendleSecondaryMarket": boolean | null,
  "maturityEvidence": string,
  "apyTotalPct": number | null,
  "apyBasePct": number | null,
  "apyRewardPct": number | null,
  "apyStability": "stable" | "moderate" | "volatile" | null,
  "poolLaunchedDate": string | null,
  "confidence": "high" | "medium" | "low"
}
Rules:
- curator: named vault curator (Steakhouse, Gauntlet, Re7, MEV Capital, etc.) — null if permissionless market with no curator.
- oracleType: only if explicitly mentioned in research (Chainlink, Pyth, TWAP window, etc.).
- poolTvlUsd: THIS POOL's TVL/liquidity/total assets on the pool detail page — NOT protocol-wide or token market cap. Look for: "TVL", "Total liquidity", "Total value locked", "Market size", "Total deposits", "Assets under management", "$XM in pool".
- utilizationPct: supply/borrow utilization % from pool dashboard (not protocol aggregate).
- daysToMaturity: Pendle PT / fixed-term — days until maturity, expiry date, "time to maturity".
- pendleSecondaryMarket: true if PT trades on DEX/secondary market; false if explicitly no secondary liquidity.
- Do NOT invent addresses or firm names not supported by the text.
- Morpho MetaMorpho vaults usually have a named curator on morpho.org or docs.`;

  const user = `
Pool label: ${poolLabel || "unknown"}
Pool URL: ${poolUrl || "n/a"}
Issuer (DefiLlama): ${issuerSlug || "unknown"}

DefiLlama yields row (reference only — may be wrong pool or token-level TVL):
${JSON.stringify(rowSummary, null, 2)}

TVL CANDIDATES (ranked — prefer lowest source number / highest tier: protocol_api > pool_page > defillama > web_search):
${tvlCandidates.length ? JSON.stringify(tvlCandidates, null, 2) : "none yet"}

COIN GECKO (asset rank — NOT pool TVL):
${cgSummary || "not fetched"}

COINMARKETCAP (asset rank — NOT pool TVL):
${cmcSummary || externalData?.coinMarketCap?.skipped ? "CMC_API_KEY not set" : "not fetched"}

POOL IDENTITY (on-chain / resolver):
${poolIdentity ? JSON.stringify(poolIdentity, null, 2) : "unknown"}

FIELDS STILL MISSING (prioritize finding these in research):
${missing.length ? missing.join(", ") : "none — confirm or refine values above"}

WEB RESEARCH:
${blob.slice(0, 14000) || "(empty — set TAVILY_API_KEY or enable crawl)"}

Return JSON only.`.trim();

  try {
    const r = await runHostedLlmJson({ step: "poolMetadata", system, user, timeoutMs: 90_000, trace });
    const j = r?.json || {};
    if (j.curator && typeof j.curator === "string") {
      out.hints.curator = j.curator;
      out.hints.curatorEvidence = j.curatorEvidence || "LLM from web research";
      out.sources.push({ label: "LLM curator", detail: j.curatorEvidence || j.curator });
    }
    if (j.oracleType) {
      out.hints.oracleType = j.oracleType;
      out.hints.oracleEvidence = j.oracleEvidence || "";
      out.sources.push({ label: "LLM oracle", detail: j.oracleEvidence || j.oracleType });
    }
    if (typeof j.lltvPct === "number" && isFinite(j.lltvPct)) out.hints.lltv = j.lltvPct;
    if (typeof j.utilizationPct === "number" && isFinite(j.utilizationPct)) {
      out.hints.utilization = j.utilizationPct / 100;
      out.hints.utilizationEvidence = "LLM from web research";
    }
    if (typeof j.poolTvlUsd === "number" && isFinite(j.poolTvlUsd) && j.poolTvlUsd > 0) {
      out.hints.poolTvlUsd = j.poolTvlUsd;
      out.hints.tvlSource = "llm";
      out.hints.tvlEvidence = j.poolTvlEvidence || "LLM inferred from web research (lowest TVL tier)";
    }
    if (typeof j.daysToMaturity === "number" && isFinite(j.daysToMaturity)) {
      out.hints.pendleDaysToMaturity = Math.round(j.daysToMaturity);
      out.hints.daysToMaturity = out.hints.pendleDaysToMaturity;
      out.hints.maturityEvidence = j.maturityEvidence || "LLM from pool page";
    }
    if (typeof j.pendleSecondaryMarket === "boolean") {
      out.hints.pendleSecondaryMarket = j.pendleSecondaryMarket;
    }
    if (typeof j.apyBasePct === "number" && isFinite(j.apyBasePct)) {
      out.hints.apyBase = j.apyBasePct;
      out.hints.apySource = "pool_page";
      out.hints.apyEvidence = "LLM from web research";
    }
    if (typeof j.apyRewardPct === "number" && isFinite(j.apyRewardPct)) out.hints.apyReward = j.apyRewardPct;
    if (typeof j.apyTotalPct === "number" && isFinite(j.apyTotalPct)) out.hints.apy = j.apyTotalPct;
    if (j.apyStability === "stable") {
      out.hints.apyCv30d = 0.08;
      out.hints.apyStabilityEvidence = "LLM: stable APY from web research";
    } else if (j.apyStability === "volatile") {
      out.hints.apyCv30d = 0.55;
      out.hints.apyStabilityEvidence = "LLM: volatile APY from web research";
    } else if (j.apyStability === "moderate") {
      out.hints.apyCv30d = 0.22;
      out.hints.apyStabilityEvidence = "LLM: moderate APY volatility from web research";
    }
    if (j.poolLaunchedDate && /^\d{4}-\d{2}-\d{2}/.test(String(j.poolLaunchedDate))) {
      const ms = Date.parse(j.poolLaunchedDate);
      if (isFinite(ms)) {
        out.hints.poolCreatedAt = ms;
        out.hints.poolAgeEvidence = `LLM: launched ${j.poolLaunchedDate}`;
      }
    }
    out.llmConfidence = j.confidence || "medium";
    trace?.step?.("Pool metadata from LLM", {
      kind: "llm",
      detail: [
        j.curator ? `curator: ${j.curator}` : null,
        j.oracleType ? `oracle: ${j.oracleType}` : null,
        j.lltvPct != null ? `LLTV ${j.lltvPct}%` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "no curator/oracle in text",
    });
  } catch (e) {
    trace?.step?.("LLM pool metadata failed", { kind: "error", detail: String(e?.message || e) });
  }

  return out;
}

export function applyMetadataHintsToRow(row, meta) {
  if (!row || typeof row !== "object") return row;
  const hints = meta?.hints || {};
  const next = { ...row };
  if (hints.curator) {
    next.curator = hints.curator;
    next.curatorEvidence = hints.curatorEvidence || meta?.sources?.[0]?.detail || null;
  }
  if (hints.oracleType === "chainlink" || hints.oracleType === "chainlink_derived") {
    next.oracleType = hints.oracleType === "chainlink_derived" ? "Chainlink derived" : "Chainlink";
    next.oracleEvidence = hints.oracleEvidence || null;
  } else if (hints.oracleType === "pyth") {
    next.oracleType = "Pyth";
    next.oracleEvidence = hints.oracleEvidence || null;
  } else if (hints.oracleType === "twap_long") {
    next.oracleType = "TWAP 30min";
    next.oracleEvidence = hints.oracleEvidence || null;
  } else if (hints.oracleType === "twap_short") {
    next.oracleType = "TWAP";
    next.oracleEvidence = hints.oracleEvidence || null;
  } else if (hints.oracleType === "custom_multi") {
    next.oracleType = "Custom multi-source";
    next.oracleEvidence = hints.oracleEvidence || null;
  } else if (hints.oracleType === "custom_single") {
    next.oracleType = "Custom single-source";
    next.oracleEvidence = hints.oracleEvidence || null;
  }
  if (hints.lltv != null) {
    next.lltv = hints.lltv;
    if (hints.lltvEvidence) next.lltvEvidence = hints.lltvEvidence;
  }
  if (hints.utilization != null) {
    next.utilization = hints.utilization;
    if (hints.utilizationEvidence) next.utilizationEvidence = hints.utilizationEvidence;
  }
  if (hints.capUtilization != null) next.capUtilization = hints.capUtilization;
  if (hints.poolTvlUsd != null && isFinite(Number(hints.poolTvlUsd))) {
    Object.assign(
      next,
      mergeTvlIntoRow(next, {
        value: Number(hints.poolTvlUsd),
        source: hints.tvlSource || "llm",
        evidence: hints.tvlEvidence || null,
      })
    );
  }
  if (hints.pendleDaysToMaturity != null) {
    next.pendleDaysToMaturity = hints.pendleDaysToMaturity;
    next.daysToMaturity = hints.daysToMaturity;
    if (hints.maturityEvidence) next.maturityEvidence = hints.maturityEvidence;
  }
  if (hints.pendleSecondaryMarket != null) {
    next.pendleSecondaryMarket = hints.pendleSecondaryMarket;
    next.pendleSecondaryEvidence = hints.pendleSecondaryEvidence;
  }
  if (hints.apy != null && isFinite(Number(hints.apy))) {
    next.apy = Number(hints.apy);
    next.apySource = hints.apySource || "pool_page";
    next.apyEvidence = hints.apyEvidence || null;
  }
  if (hints.apyBase != null && isFinite(Number(hints.apyBase))) {
    next.apyBase = Number(hints.apyBase);
    next.apySource = hints.apySource || "pool_page";
    next.apyEvidence = hints.apyEvidence || next.apyEvidence;
  }
  if (hints.apyReward != null && isFinite(Number(hints.apyReward))) next.apyReward = Number(hints.apyReward);
  if (hints.apyCv30d != null) {
    next.apyCv30d = hints.apyCv30d;
    if (hints.apyStabilityEvidence) next.apyStabilityEvidence = hints.apyStabilityEvidence;
  }
  if (hints.poolCreatedAt != null) {
    next.poolCreatedAt = hints.poolCreatedAt;
    if (hints.poolAgeEvidence) next.poolAgeEvidence = hints.poolAgeEvidence;
  }
  return next;
}
