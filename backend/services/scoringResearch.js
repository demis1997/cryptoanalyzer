import { searchWeb } from "./webResearch.js";

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
} = {}) {
  if (!enabled()) return { enabled: false, searches: [], formatted: "" };

  const label = String(poolLabel || "").trim();
  const slug = String(issuerSlug || "").trim();
  const sym = String(symbol || "").trim();
  const ch = String(chain || "").trim();

  const queries = [
    sym && slug ? `${slug} ${sym} ${ch} oracle Chainlink Pyth TWAP liquidation` : null,
    sym && slug ? `${slug} ${sym} LLTV LTV collateral liquidation threshold` : null,
    label ? `"${label}" vault curator risk manager` : null,
    slug ? `${slug} ${sym || label} utilization rate supply cap` : null,
    label ? `${label} DeFi pool APY yield source emissions` : null,
    slug ? `site:docs.${slug.split("-")[0]}.org OR site:github.com/${slug.split("-")[0]} oracle LLTV` : null,
    poolUrl ? `${poolUrl} oracle parameters risk` : null,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_SCORING_SEARCH_QUERIES || 4) || 4;
  const searches = [];
  for (const q of [...new Set(queries)].slice(0, maxQ)) {
    searches.push(await searchWeb(q, { maxResults: 5 }));
  }

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
  };
}

export function mergeResearchBlobs(...parts) {
  return parts
    .map((p) => (typeof p === "string" ? p : p?.formatted || ""))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}
