import fetch from "node-fetch";
import { crawlPoolWebsite } from "./poolCrawl.js";

function webSearchEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_WEB_SEARCH || "1").trim());
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(s, max = 4000) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Tavily search API (recommended). Set TAVILY_API_KEY in .env.
 */
async function searchTavily(query, { maxResults = 8 } = {}) {
  const key = String(process.env.TAVILY_API_KEY || "").trim();
  if (!key) return null;
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: String(query).slice(0, 400),
      search_depth: "basic",
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
    }),
  });
  if (!resp.ok) throw new Error(`Tavily search failed: ${resp.status}`);
  const json = await resp.json().catch(() => ({}));
  const hits = (Array.isArray(json?.results) ? json.results : []).map((r) => ({
    title: r?.title || "",
    url: r?.url || "",
    snippet: r?.content || r?.snippet || "",
    source: "tavily",
  }));
  return {
    provider: "tavily",
    query,
    answer: json?.answer || null,
    hits,
  };
}

/**
 * No API key: DuckDuckGo HTML results (best-effort).
 */
async function searchDuckDuckGoHtml(query, { maxResults = 8 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "cryptoanalyzer/web-research",
      Accept: "text/html",
    },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`);
  const html = await resp.text();
  const hits = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && hits.length < maxResults) {
    hits.push({
      title: stripHtml(m[2]),
      url: m[1],
      snippet: stripHtml(m[3]),
      source: "duckduckgo",
    });
  }
  return { provider: "duckduckgo", query, answer: null, hits };
}

export async function searchWeb(query, { maxResults = 8 } = {}) {
  if (!webSearchEnabled()) return { provider: "disabled", query, answer: null, hits: [] };
  const q = String(query || "").trim();
  if (!q) return { provider: "none", query: q, answer: null, hits: [] };
  try {
    const tavily = await searchTavily(q, { maxResults });
    if (tavily) return tavily;
  } catch (e) {
    console.warn("Tavily search:", e?.message || e);
  }
  try {
    return await searchDuckDuckGoHtml(q, { maxResults });
  } catch (e) {
    console.warn("DuckDuckGo search:", e?.message || e);
    return { provider: "error", query: q, answer: null, hits: [], error: String(e?.message || e) };
  }
}

export async function fetchPageText(url, { timeoutMs = 12_000, maxChars = 6000 } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, text: "", error: "bad_url" };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(u, {
      headers: { "User-Agent": "cryptoanalyzer/web-research (+pool-intelligence)" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) return { ok: false, url: u, text: "", error: `http_${resp.status}` };
    const html = await resp.text();
    return { ok: true, url: u, text: clamp(stripHtml(html), maxChars) };
  } catch (e) {
    return { ok: false, url: u, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Web research pack for pool integrator discovery: search queries + optional pool page scrape.
 */
export async function gatherPoolWebResearch({ poolLabel, poolUrl, issuerSlug } = {}) {
  if (!webSearchEnabled()) {
    return { enabled: false, searches: [], page: null, formatted: "" };
  }
  const label = String(poolLabel || "").trim();
  const slug = String(issuerSlug || "").trim();
  const queries = [
    label ? `"${label}" DeFi vault integrators protocols partners` : null,
    slug ? `${slug} vault yield pool DeFi integrations composability` : null,
    slug && label ? `${slug} ${label} integration deposit collateral` : null,
    label ? `${label} ERC-4626 vault share token integrations` : null,
    slug ? `${slug} protocol partners integrations DeFiLlama` : null,
    label ? `${label} who deposits liquidity curators risk` : null,
  ].filter(Boolean);

  const searches = [];
  const maxQueries = Number(process.env.POOL_WEB_SEARCH_QUERIES || 5);
  for (const q of [...new Set(queries)].slice(0, maxQueries)) {
    const r = await searchWeb(q, { maxResults: 6 });
    searches.push(r);
  }

  let page = null;
  let crawl = null;
  if (poolUrl && /^https?:\/\//i.test(poolUrl)) {
    crawl = await crawlPoolWebsite(poolUrl, { poolLabel }).catch((e) => ({
      enabled: true,
      ok: false,
      error: String(e?.message || e),
      pages: [],
      addresses: [],
      formatted: "",
    }));
    if (!crawl?.ok) {
      page = await fetchPageText(poolUrl);
    }
  }

  const lines = [];
  for (const s of searches) {
    lines.push(`\n### Search (${s.provider}): ${s.query}`);
    if (s.answer) lines.push(`Summary: ${s.answer}`);
    for (const h of (s.hits || []).slice(0, 6)) {
      lines.push(`- ${h.title} | ${h.url}`);
      if (h.snippet) lines.push(`  ${clamp(h.snippet, 280)}`);
    }
  }
  if (crawl?.formatted) {
    lines.push(`\n### Pool site crawl (Playwright)`);
    lines.push(clamp(crawl.formatted, 9000));
    if (crawl.addresses?.length) {
      lines.push(`\nOn-chain addresses from crawl: ${crawl.addresses.slice(0, 12).join(", ")}`);
    }
  } else if (page?.ok && page.text) {
    lines.push(`\n### Pool page (${page.url}) — light fetch`);
    lines.push(clamp(page.text, 3500));
  } else if (page?.url || poolUrl) {
    lines.push(`\n### Pool page fetch failed: ${crawl?.error || page?.error || "unknown"}`);
  }

  const providers = [...new Set(searches.map((s) => s.provider))];
  if (crawl?.ok) providers.push("playwright");

  return {
    enabled: true,
    searches,
    page,
    crawl,
    addresses: crawl?.addresses || [],
    formatted: lines.join("\n").trim(),
    providers,
  };
}
