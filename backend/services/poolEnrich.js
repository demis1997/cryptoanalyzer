import { runHostedLlmJson } from "../llm/provider.js";
import { parseScoringHintsFromText } from "./poolDataSources.js";

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
  if (!yieldsRow?.curator && /vault|curat|metamorpho|euler/i.test(`${poolLabel} ${issuerSlug}`)) {
    missing.push("curator");
  }

  trace?.step?.("LLM pool metadata (oracle / curator)", {
    kind: "llm",
    detail: poolLabel || poolUrl || issuerSlug || "",
  });

  const system = `You extract factual pool/vault metadata for DeFi risk scoring from web research and DefiLlama data.
Works for ANY protocol (Aave, Morpho, Pendle, Euler, Curve, Compound, etc.) — not Morpho-specific.
You cannot browse the web. Only use WEB RESEARCH and DEFILLAMA sections.
Return JSON only — no markdown:
{
  "curator": string | null,
  "curatorEvidence": string,
  "oracleType": "chainlink" | "chainlink_derived" | "pyth" | "twap_long" | "twap_short" | "custom_multi" | "custom_single" | null,
  "oracleEvidence": string,
  "lltvPct": number | null,
  "utilizationPct": number | null,
  "confidence": "high" | "medium" | "low"
}
Rules:
- curator: named vault curator (Steakhouse, Gauntlet, Re7, MEV Capital, etc.) — null if permissionless market with no curator.
- oracleType: only if explicitly mentioned in research (Chainlink, Pyth, TWAP window, etc.).
- Do NOT invent addresses or firm names not supported by the text.
- Morpho MetaMorpho vaults usually have a named curator on morpho.org or docs.`;

  const user = `
Pool label: ${poolLabel || "unknown"}
Pool URL: ${poolUrl || "n/a"}
Issuer (DefiLlama): ${issuerSlug || "unknown"}

DefiLlama yields row:
${JSON.stringify(rowSummary, null, 2)}

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
  if (hints.lltv != null) next.lltv = hints.lltv;
  if (hints.utilization != null) next.utilization = hints.utilization;
  if (hints.capUtilization != null) next.capUtilization = hints.capUtilization;
  return next;
}
