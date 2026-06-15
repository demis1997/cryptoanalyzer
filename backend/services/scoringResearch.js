import { searchWeb } from "./webResearch.js";
import { webResearchSession } from "./webResearchSession.js";
import { shouldSkipScoringWebResearch } from "./researchSkip.js";

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_SCORING_SEARCH || "1").trim());
}

/**
 * Protocol-agnostic web searches aimed at P.3–P.4, P.9 scoring fields (oracle, LLTV, curator, utilization).
 */
export async function gatherScoringWebResearch({
  poolLabel,
  poolUrl,
  issuerSlug,
  symbol,
  chain,
  trace = null,
  session = null,
  vaultMeta = null,
  subgraphScoring = null,
  ctx = null,
} = {}) {
  if (!enabled()) return { enabled: false, searches: [], formatted: "", skipped: true };

  if (shouldSkipScoringWebResearch({ ctx, vaultMeta, subgraphScoring })) {
    return {
      enabled: false,
      searches: [],
      formatted: "",
      skipped: true,
      skipReason: "protocol_api_and_subgraph_resolved",
      traceLogged: Boolean(trace),
    };
  }

  const label = String(poolLabel || "").trim();
  const slug = String(issuerSlug || "").trim();
  const sym = String(symbol || "").trim();
  const ch = String(chain || "").trim();
  const searchSession = session || webResearchSession(trace);

  const slugRoot = slug.split("-")[0] || slug;
  const isPendle = /pendle|pt-/i.test(`${label} ${sym} ${slug}`);
  const queries = [
    poolUrl ? `${poolUrl} APY net yield supply rate` : null,
    sym && slug ? `${slug} ${sym} ${ch} utilization LLTV oracle` : null,
    sym && slug ? `${slug} ${sym} ${ch} pool TVL deposits` : null,
    isPendle ? `${label || sym} Pendle days to maturity AMM liquidity` : null,
    label ? `"${label}" vault curator risk manager` : null,
    poolUrl ? `${poolUrl} risk parameters utilization` : null,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_SCORING_SEARCH_QUERIES || 4) || 4;
  const searches = await searchSession.runQueries(queries, { maxResults: 5, maxCount: maxQ });

  const lines = [];
  for (const s of searches) {
    lines.push(`\n### Scoring search (${s.provider}): ${s.query}`);
    if (s.answer) lines.push(`Summary: ${s.answer}`);
    for (const h of (s.hits || []).slice(0, 4)) {
      lines.push(`- ${h.title} | ${h.url}`);
      if (h.snippet) lines.push(`  ${String(h.snippet).slice(0, 240)}`);
    }
  }

  return {
    enabled: true,
    searches,
    formatted: lines.join("\n").trim(),
    providers: [...new Set(searches.map((s) => s.provider))],
    traceLogged: Boolean(trace),
  };
}

export function mergeResearchBlobs(...parts) {
  return parts
    .map((p) => (typeof p === "string" ? p : p?.formatted || ""))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}
