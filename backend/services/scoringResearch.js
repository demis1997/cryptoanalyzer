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

  const slugRoot = slug.split("-")[0] || slug;
  const isPendle = /pendle|pt-/i.test(`${label} ${sym} ${slug}`);
  const queries = [
    poolUrl ? `${poolUrl} APY net yield supply rate rewards emissions` : null,
    label ? `"${label}" ${slug || ""} pool APY net yield organic rewards emissions` : null,
    sym && slug ? `${slug} ${sym} ${ch} current APY yield rate pool dashboard` : null,
    sym && slug ? `site:dune.com ${slug} ${sym} pool TVL liquidity APY` : null,
    sym && slug ? `${slug} ${sym} ${ch} pool TVL total liquidity market size deposits` : null,
    poolUrl ? `${poolUrl} TVL total liquidity utilization LLTV oracle` : null,
    sym && slug ? `${slug} ${sym} ${ch} oracle Chainlink Pyth TWAP liquidation` : null,
    sym && slug ? `${slug} ${sym} LLTV LTV loan-to-value liquidation threshold` : null,
    label ? `"${label}" vault curator risk manager` : null,
    slug ? `${slug} ${sym || label} utilization supply cap borrow` : null,
    isPendle ? `${label || sym} Pendle days to maturity expiry PT liquidity` : null,
    label ? `${label} yield organic vs emissions sustainability APY stability` : null,
    slug ? `${slugRoot} vault launched deployed date pool age` : null,
    poolUrl ? `${poolUrl} risk parameters LLTV utilization` : null,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_SCORING_SEARCH_QUERIES || 7) || 7;
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
