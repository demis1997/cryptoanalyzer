import { fetchDefillamaProtocolsCached } from "./yieldsDiscover.js";

/** Common DeFi names → DefiLlama slug hints (first match wins). */
const SLUG_ALIASES = {
  morpho: ["morpho-blue", "morpho-aave", "morpho"],
  pendle: ["pendle"],
  maple: ["maple-finance", "maple"],
  ethena: ["ethena"],
  aerodrome: ["aerodrome-slipstream", "aerodrome-finance", "aerodrome-v1"],
  uniswap: ["uniswap-v4", "uniswap-v3", "uniswap"],
  synthetix: ["synthetix"],
  aevo: ["aevo"],
  gains: ["gains-network"],
  curve: ["curve-dex", "curve"],
  aave: ["aave-v3", "aave"],
  compound: ["compound-v3", "compound"],
  euler: ["euler", "euler-v2"],
  balancer: ["balancer-v2", "balancer"],
  "gmx": ["gmx", "gmx-v2"],
  dydx: ["dydx", "dydx-v4"],
  hyperliquid: ["hyperliquid"],
  yearn: ["yearn-finance", "yearn"],
  convex: ["convex-finance"],
  frax: ["frax", "frax-ether"],
  lido: ["lido"],
  rocket: ["rocket-pool"],
};

let slugIndexCache = null;
let slugIndexAt = 0;
const INDEX_TTL_MS = 10 * 60 * 1000;

async function buildSlugIndex() {
  if (slugIndexCache && Date.now() - slugIndexAt < INDEX_TTL_MS) return slugIndexCache;
  const list = await fetchDefillamaProtocolsCached();
  const bySlug = new Map();
  const byToken = new Map();

  for (const [key, slugs] of Object.entries(SLUG_ALIASES)) {
    for (const s of slugs) {
      if (list.some((p) => String(p?.slug || "").toLowerCase() === s)) {
        byToken.set(key, s);
      }
    }
  }

  for (const p of list) {
    const slug = String(p?.slug || "").trim().toLowerCase();
    if (!slug) continue;
    bySlug.set(slug, p);
    const name = String(p?.name || "").trim().toLowerCase();
    if (name.length >= 5 && !byToken.has(name)) byToken.set(name, slug);
  }

  slugIndexCache = { bySlug, byToken, list };
  slugIndexAt = Date.now();
  return slugIndexCache;
}

function resolveSlug(token, index) {
  const t = String(token || "").trim().toLowerCase();
  if (!t || t.length < 3) return null;
  if (index.bySlug.has(t)) return t;
  if (index.byToken.has(t)) return index.byToken.get(t);
  if (SLUG_ALIASES[t]) {
    for (const s of SLUG_ALIASES[t]) {
      if (index.bySlug.has(s)) return s;
      return s;
    }
  }
  if (index.byToken.has(t)) return index.byToken.get(t);
  return null;
}

function contextAround(text, idx, radius = 120) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end);
}

function inferRelationship(snippet) {
  const s = String(snippet || "").toLowerCase();
  if (/integrat|composab|deposit|borrow|deploy|curat|allocator|partner|powered by|built with|uses?\s+avusdc|avusdc|has partnered|partnership/i.test(s)) {
    if (/future|roadmap|planned|will\b|expected|could\b|may\b|imagine|example/i.test(s)) {
      return { relationship: "planned_integration", confidence: "low" };
    }
    return { relationship: "integrator", confidence: "high" };
  }
  if (/liquidity|tvl|defillama|dex|pool on/i.test(s)) return { relationship: "liquidity_venue", confidence: "medium" };
  if (/similar to|comparable|like\s+/i.test(s)) return { relationship: "analog", confidence: "low" };
  return { relationship: "mentioned", confidence: "medium" };
}

/**
 * Find protocol names mentioned in web research / crawl text without LLM.
 */
export async function extractProtocolsMentionedInText(text, { issuerSlug, max = 24 } = {}) {
  const hay = String(text || "");
  if (hay.length < 20) return [];
  const issuer = String(issuerSlug || "").toLowerCase();
  const index = await buildSlugIndex();
  const lower = hay.toLowerCase();
  const found = new Map();

  const tryAdd = (token, idx) => {
    const slug = resolveSlug(token, index);
    if (!slug || slug === issuer) return;
    const ctx = contextAround(lower, idx);
    const rel = inferRelationship(ctx);
    const id = `defillama:${slug}`;
    const ent = index.bySlug.get(slug);
    const name = ent?.name || slug;
    if (!found.has(id)) {
      found.set(id, {
        id,
        name,
        url: `https://defillama.com/protocol/${slug}`,
        link: "web_mention",
        tier: "integrator",
        relationship: rel.relationship,
        confidence: rel.confidence,
        note: ctx.replace(/\s+/g, " ").trim().slice(0, 160),
        totalTvlUsd: 0,
        yieldsPools: [],
      });
    } else {
      const cur = found.get(id);
      if (rel.confidence === "high" && cur.confidence !== "high") {
        cur.confidence = "high";
        cur.relationship = rel.relationship;
        cur.note = ctx.replace(/\s+/g, " ").trim().slice(0, 160);
      }
    }
  };

  const aliasKeys = Object.keys(SLUG_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    let m;
    while ((m = re.exec(hay)) !== null) {
      tryAdd(key, m.index);
    }
  }

  const phrases = [
    ["maple finance", "maple"],
    ["gains network", "gains"],
    ["aerodrome finance", "aerodrome"],
    ["morpho blue", "morpho"],
  ];
  for (const [phrase, aliasKey] of phrases) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    let m;
    while ((m = re.exec(hay)) !== null) {
      tryAdd(aliasKey, m.index);
    }
  }

  return [...found.values()]
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.confidence] || 2) - (rank[b.confidence] || 2);
    })
    .slice(0, max);
}

/**
 * Parse integrators from gatherPoolWebResearch output (searches + crawl + Tavily answer).
 */
/** Pull protocol names from Tavily "Summary:" lines and integration phrasing. */
export async function extractFromSearchSummaries(searches, { issuerSlug } = {}) {
  const chunks = [];
  for (const s of searches || []) {
    if (s.answer) chunks.push(String(s.answer));
    for (const h of s.hits || []) {
      chunks.push(`${h.title}. ${h.snippet || ""}`);
    }
  }
  return extractProtocolsMentionedInText(chunks.join("\n"), { issuerSlug, max: 32 });
}

export async function discoverIntegratorsFromWebResearch(webResearch, { issuerSlug, poolLabel } = {}) {
  if (!webResearch?.enabled) return [];
  const chunks = [webResearch.formatted || ""];
  for (const s of webResearch.searches || []) {
    if (s.answer) chunks.push(String(s.answer));
    for (const h of s.hits || []) {
      chunks.push(`${h.title} ${h.snippet}`);
    }
  }
  const fromText = await extractProtocolsMentionedInText(chunks.join("\n"), { issuerSlug, max: 32 });
  const fromSummaries = await extractFromSearchSummaries(webResearch.searches, { issuerSlug });
  const seen = new Set();
  const out = [];
  for (const p of [...fromSummaries, ...fromText]) {
    if (!p?.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
