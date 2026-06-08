/**
 * External data for pool intelligence beyond DefiLlama yields alone.
 * CoinGecko, CoinMarketCap (optional key), yields APY history, inspector web search.
 */
import fetch from "node-fetch";
import { searchWeb } from "./webResearch.js";
import { selectPrimaryYieldsRow } from "./poolAddress.js";

const CG_PLATFORM = {
  ethereum: "ethereum",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  base: "base",
  polygon: "polygon-pos",
  avalanche: "avalanche",
  bsc: "binance-smart-chain",
};

function enabled(name, defaultOn = true) {
  const v = process.env[name];
  if (v == null || v === "") return defaultOn;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function clamp(s, max = 500) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function stddev(nums) {
  if (!nums.length) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
  return Math.sqrt(v);
}

function apyCvFromChart(points) {
  const apys = (points || [])
    .map((p) => Number(p?.apy))
    .filter((x) => isFinite(x) && x >= 0)
    .slice(-30);
  if (apys.length < 5) return null;
  const mean = apys.reduce((a, b) => a + b, 0) / apys.length;
  if (mean <= 0) return null;
  return stddev(apys) / mean;
}

/** DefiLlama yields historical APY → P.9 stability CV */
export async function fetchDefiLlamaYieldsChart(poolId) {
  const id = String(poolId || "").trim();
  if (!id) return null;
  const url = `https://yields.llama.fi/chart/${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/pool-data" } });
    if (!resp.ok) return { ok: false, url, error: `http_${resp.status}` };
    const json = await resp.json().catch(() => ({}));
    const data = Array.isArray(json?.data) ? json.data : [];
    const apyCv30d = apyCvFromChart(data);
    return { ok: true, url, points: data.length, apyCv30d, latest: data[data.length - 1] || null };
  } catch (e) {
    return { ok: false, url, error: String(e?.message || e) };
  }
}

async function coinGeckoFetch(path) {
  const base = String(process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3").replace(/\/$/, "");
  const headers = { "User-Agent": "cryptoanalyzer/pool-data" };
  const key = String(process.env.COINGECKO_API_KEY || "").trim();
  if (key) headers["x-cg-pro-api-key"] = key;
  const resp = await fetch(`${base}${path}`, { headers });
  if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
  return resp.json();
}

export async function fetchCoinGeckoByContract(chain, address) {
  if (!enabled("POOL_COINGECKO", true)) return null;
  const platform = CG_PLATFORM[normalizeChainKey(chain)] || "ethereum";
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  try {
    const j = await coinGeckoFetch(`/coins/${platform}/contract/${addr}?localization=false&tickers=false&community_data=false&developer_data=false`);
    return {
      ok: true,
      source: "CoinGecko",
      url: `https://www.coingecko.com/en/coins/${j?.id || ""}`,
      id: j?.id,
      symbol: j?.symbol,
      name: j?.name,
      marketCapRank: j?.market_cap_rank ?? null,
      marketCapUsd: j?.market_data?.market_cap?.usd ?? null,
    };
  } catch (e) {
    return { ok: false, source: "CoinGecko", error: String(e?.message || e) };
  }
}

export async function fetchCoinGeckoSearchSymbol(symbol) {
  if (!enabled("POOL_COINGECKO", true)) return null;
  const sym = String(symbol || "").trim();
  if (!sym || sym.length > 12) return null;
  try {
    const list = await coinGeckoFetch(`/search?query=${encodeURIComponent(sym)}`);
    const coins = Array.isArray(list?.coins) ? list.coins : [];
    const hit = coins.find((c) => String(c?.symbol || "").toLowerCase() === sym.toLowerCase()) || coins[0];
    if (!hit?.id) return null;
    const j = await coinGeckoFetch(
      `/coins/${encodeURIComponent(hit.id)}?localization=false&tickers=false&community_data=false&developer_data=false`
    );
    return {
      ok: true,
      source: "CoinGecko",
      url: `https://www.coingecko.com/en/coins/${j?.id}`,
      id: j?.id,
      symbol: j?.symbol,
      name: j?.name,
      marketCapRank: j?.market_cap_rank ?? null,
      marketCapUsd: j?.market_data?.market_cap?.usd ?? null,
    };
  } catch (e) {
    return { ok: false, source: "CoinGecko", error: String(e?.message || e) };
  }
}

export async function fetchCoinMarketCapQuotes(symbols) {
  if (!enabled("POOL_COINMARKETCAP", true)) return null;
  const key = String(process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "").trim();
  if (!key) return { ok: false, source: "CoinMarketCap", skipped: true, reason: "CMC_API_KEY not set" };
  const syms = [...new Set((symbols || []).map((s) => String(s || "").toUpperCase()).filter((s) => /^[A-Z0-9]{2,12}$/.test(s)))].slice(0, 5);
  if (!syms.length) return null;
  try {
    const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(syms.join(","))}`;
    const resp = await fetch(url, {
      headers: {
        "X-CMC_PRO_API_KEY": key,
        Accept: "application/json",
      },
    });
    if (!resp.ok) throw new Error(`CMC ${resp.status}`);
    const json = await resp.json();
    const data = json?.data || {};
    const quotes = {};
    for (const sym of syms) {
      const row = data[sym]?.[0] || data[sym];
      if (!row) continue;
      const q = row.quote?.USD || {};
      quotes[sym] = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        rank: row.cmc_rank,
        priceUsd: q.price,
        marketCapUsd: q.market_cap,
        volume24hUsd: q.volume_24h,
        url: row.slug ? `https://coinmarketcap.com/currencies/${row.slug}/` : null,
      };
    }
    return { ok: true, source: "CoinMarketCap", url: "https://coinmarketcap.com/", quotes };
  } catch (e) {
    return { ok: false, source: "CoinMarketCap", error: String(e?.message || e) };
  }
}

const INSPECTOR_QUERIES = [
  { id: "defisafety", template: (slug, label) => `site:defisafety.com ${slug || label} DeFi score` },
  { id: "exponential", template: (slug, label) => `site:exponential.fi ${slug || label} risk rating pool` },
  { id: "llamarisk", template: (slug) => `${slug} DeFi risk rating LlamaRisk OR "risk rating" defillama` },
  { id: "openaudit", template: (slug, label) => `${slug || label} smart contract audit trail DeFi` },
  { id: "rated", template: (slug, label) => `site:rated.network ${slug || label} staking queue withdrawal` },
];

/**
 * Targeted web search for third-party pool / protocol inspectors (no API keys).
 */
export async function gatherInspectorSearches({ issuerSlug, poolLabel, symbol } = {}) {
  if (!enabled("POOL_INSPECTOR_SEARCH", true)) return { enabled: false, searches: [] };
  const slug = String(issuerSlug || "").trim();
  const label = String(poolLabel || "").trim();
  const sym = String(symbol || "").trim();
  const maxQ = Number(process.env.POOL_INSPECTOR_SEARCH_QUERIES || 3) || 3;
  const searches = [];
  for (const def of INSPECTOR_QUERIES.slice(0, maxQ)) {
    const q = def.template(slug, label || sym);
    if (!q?.trim()) continue;
    const r = await searchWeb(q, { maxResults: 4 });
    searches.push({ inspector: def.id, ...r });
  }
  const snippets = [];
  for (const s of searches) {
    for (const h of (s.hits || []).slice(0, 3)) {
      snippets.push({ inspector: s.inspector, title: h.title, url: h.url, snippet: h.snippet });
    }
  }
  return { enabled: true, searches, snippets, inspectors: searches.map((s) => s.inspector) };
}

/** Pull oracle / LLTV / utilization hints from crawled + inspector text for scoring. */
export function parseScoringHintsFromText(text) {
  const t = String(text || "");
  const hints = {};
  if (/chainlink/i.test(t)) {
    hints.oracleType = /derived|composite|wsteth\/eth/i.test(t) ? "chainlink_derived" : "chainlink";
  } else if (/pyth/i.test(t)) hints.oracleType = "pyth";
  else if (/twap/i.test(t)) hints.oracleType = /30\s*min|1800/i.test(t) ? "twap_long" : "twap_short";

  const lltv = t.match(/\b(?:LLTV|LTV|loan[- ]to[- ]value|liquidation\s+threshold)[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i);
  if (lltv) hints.lltv = Number(lltv[1]);

  const util = t.match(/\butilization[:\s]*(\d{2,3}(?:\.\d+)?)\s*%/i);
  if (util) hints.utilization = Number(util[1]) / 100;

  const cap = t.match(/\b(?:supply|borrow)\s+cap[:\s]*(\d{2,3}(?:\.\d+)?)\s*%\s*(?:filled|util)/i);
  if (cap) hints.capUtilization = Number(cap[1]) / 100;

  const defiScore = t.match(/defi\s*safety\s*score[:\s]*(\d{1,3})\s*\/\s*100/i);
  if (defiScore) hints.defiSafetyScore = Number(defiScore[1]);

  const expRisk = t.match(/exponential[^.]{0,40}?\b(risk\s*rating|rating)[:\s]*([A-D][+-]?|\d\/\d)/i);
  if (expRisk) hints.exponentialRating = expRisk[2];

  return hints;
}

function normalizeChainKey(chain) {
  const s = String(chain || "").trim().toLowerCase();
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("base")) return "base";
  if (s.includes("optimism")) return "optimism";
  if (s.includes("polygon")) return "polygon";
  return "ethereum";
}

function primaryRow(rows, opts = {}) {
  return selectPrimaryYieldsRow(rows, opts);
}

/**
 * Gather all external sources for a pool context.
 */
export async function gatherPoolExternalData(ctx, { webResearch = null } = {}) {
  const row = primaryRow(ctx?.yieldsRows, {
    vaultAddress: ctx?.vaultAddress,
    chain: ctx?.chain,
    nameHint: ctx?.nameHint,
  });
  const sources = [];
  const notes = [];
  const scoringHints = {};
  let chart = null;

  if (row?.pool && enabled("POOL_DEFILLAMA_CHART", true)) {
    chart = await fetchDefiLlamaYieldsChart(row.pool);
    sources.push({
      id: "defillama_chart",
      label: "DefiLlama yields APY history",
      provider: "DefiLlama",
      url: chart?.url,
      ok: chart?.ok,
      detail: chart?.apyCv30d != null ? `30d APY CV ≈ ${chart.apyCv30d.toFixed(3)} (${chart.points} points)` : chart?.error || "no data",
    });
    if (chart?.apyCv30d != null) scoringHints.apyCv30d = chart.apyCv30d;
  }

  const tokens = Array.isArray(ctx?.underlyingTokens) ? ctx.underlyingTokens : [];
  const cgResults = [];
  for (const tok of tokens.slice(0, 3)) {
    const cg = await fetchCoinGeckoByContract(tok.chain, tok.address);
    if (cg) cgResults.push({ token: tok.symbol || tok.address, ...cg });
  }
  if (!cgResults.length && row?.symbol) {
    const cg = await fetchCoinGeckoSearchSymbol(String(row.symbol).replace(/[^a-zA-Z0-9]/g, ""));
    if (cg) cgResults.push({ token: row.symbol, ...cg });
  }
  for (const cg of cgResults) {
    sources.push({
      id: "coingecko",
      label: `CoinGecko · ${cg.token || cg.symbol || "token"}`,
      provider: "CoinGecko",
      url: cg.url,
      ok: cg.ok,
      detail: cg.ok
        ? `rank #${cg.marketCapRank ?? "—"}, mcap $${cg.marketCapUsd ? Math.round(cg.marketCapUsd).toLocaleString() : "—"}`
        : cg.error || "lookup failed",
    });
    if (cg.ok && cg.marketCapRank != null && cg.marketCapRank <= 100) {
      scoringHints.top100Token = true;
    }
  }

  const symForCmc = [
    row?.symbol,
    ...tokens.map((t) => t.symbol),
  ]
    .map((s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase())
    .filter((s) => s.length >= 2 && s.length <= 10);
  const cmc = await fetchCoinMarketCapQuotes(symForCmc);
  if (cmc && !cmc.skipped) {
    sources.push({
      id: "coinmarketcap",
      label: "CoinMarketCap quotes",
      provider: "CoinMarketCap",
      url: cmc.url,
      ok: cmc.ok,
      detail: cmc.ok
        ? Object.entries(cmc.quotes || {})
            .map(([s, q]) => `${s} rank #${q.rank ?? "—"}`)
            .join(", ") || "quotes"
        : cmc.error || "failed",
    });
    const first = Object.values(cmc.quotes || {})[0];
    if (first?.rank != null && first.rank <= 100) scoringHints.top100Token = true;
  } else if (cmc?.skipped) {
    sources.push({
      id: "coinmarketcap",
      label: "CoinMarketCap",
      provider: "CoinMarketCap",
      ok: false,
      detail: "Set CMC_API_KEY in .env to enable",
    });
  }

  const inspectors = await gatherInspectorSearches({
    issuerSlug: ctx?.issuerSlug,
    poolLabel: ctx?.label,
    symbol: row?.symbol,
  });
  if (inspectors.enabled) {
    for (const sn of inspectors.snippets || []) {
      sources.push({
        id: `inspector_${sn.inspector}`,
        label: `Inspector · ${sn.inspector}`,
        provider: "Web search",
        url: sn.url,
        ok: Boolean(sn.url),
        detail: clamp(sn.title || sn.snippet, 120),
      });
    }
    const blob = [
      webResearch?.formatted || "",
      ...(inspectors.searches || []).flatMap((s) => (s.hits || []).map((h) => `${h.title} ${h.snippet}`)),
    ].join("\n");
    Object.assign(scoringHints, parseScoringHintsFromText(blob));
    if (webResearch?.crawl?.formatted) {
      Object.assign(scoringHints, parseScoringHintsFromText(webResearch.crawl.formatted));
    }
  }

  sources.unshift({
    id: "defillama_yields",
    label: "DefiLlama yields",
    provider: "DefiLlama",
    url: row?.project ? `https://defillama.com/protocol/${encodeURIComponent(row.project)}` : "https://defillama.com/yields",
    ok: Boolean(row),
    detail: row
      ? `${row.project || "?"} · ${row.symbol || "?"} · TVL $${row.tvlUsd ? Math.round(row.tvlUsd).toLocaleString() : "—"}`
      : "No yields row matched",
  });

  return {
    enabled: true,
    sources,
    notes,
    scoringHints,
    coinGecko: cgResults,
    coinMarketCap: cmc,
    defillamaChart: chart || null,
    inspectors,
  };
}

/** Merge external hints into yields rows used by poolScoring. */
export function applyExternalDataToYieldsRows(yieldsRows, externalData, rowOpts = {}) {
  const hints = externalData?.scoringHints || {};
  if (!Array.isArray(yieldsRows) || !yieldsRows.length) return yieldsRows || [];
  const rows = yieldsRows.map((r) => ({ ...r }));
  const primaryRow = selectPrimaryYieldsRow(rows, rowOpts);
  const idx = primaryRow ? rows.findIndex((r) => r === primaryRow || r?.pool === primaryRow?.pool) : 0;
  const safeIdx = idx >= 0 ? idx : 0;
  const primary = { ...rows[safeIdx] };
  if (hints.apyCv30d != null) primary.apyCv30d = hints.apyCv30d;
  if (hints.utilization != null) primary.utilization = hints.utilization;
  if (hints.lltv != null) primary.lltv = hints.lltv;
  if (hints.capUtilization != null) primary.capUtilization = hints.capUtilization;
  if (hints.oracleType === "chainlink") primary.oracleType = "Chainlink";
  else if (hints.oracleType === "chainlink_derived") primary.oracleType = "Chainlink derived";
  else if (hints.oracleType === "pyth") primary.oracleType = "Pyth";
  else if (hints.oracleType === "twap_long") primary.oracleType = "TWAP 30min";
  else if (hints.oracleType === "twap_short") primary.oracleType = "TWAP";
  if (hints.top100Token) primary.assetRankHint = "top100";
  if (externalData?.defillamaChart?.apyCv30d != null) primary.apyCv30d = externalData.defillamaChart.apyCv30d;
  else if (primary.apyCv30d == null && isFinite(Number(primary.sigma))) {
    primary.apyCv30d = Number(primary.sigma);
  }
  rows[safeIdx] = primary;
  return rows;
}

export function buildPoolSourceNotes(externalData) {
  return (externalData?.sources || []).map((s) => ({
    label: s.label,
    source: s.provider,
    detail: s.detail || "",
    url: s.url || null,
  }));
}
