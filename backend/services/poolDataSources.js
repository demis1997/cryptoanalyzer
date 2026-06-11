/**
 * External data for pool intelligence beyond DefiLlama yields alone.
 * CoinGecko, CoinMarketCap (optional key), yields APY history, inspector web search.
 */
import fetch from "node-fetch";
import { searchWeb } from "./webResearch.js";
import { selectPrimaryYieldsRow, yieldsRowMatchesVault, rowMatchesNameHint } from "./poolAddress.js";
import { parsePoolPageMetrics, mergePageMetricsIntoHints } from "./poolPageParse.js";
import { readErc20Metadata } from "./onChainToken.js";
import { mergeTvlIntoRow } from "./tvlSourcePriority.js";

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

function defillamaScoringFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "0").trim());
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
    const first = data[0];
    const firstTs = first?.timestamp ? Number(first.timestamp) : null;
    const firstMs =
      firstTs != null && isFinite(firstTs) ? (firstTs > 1e12 ? firstTs : firstTs * 1000) : null;
    return {
      ok: true,
      url,
      points: data.length,
      apyCv30d,
      firstTimestampMs: firstMs,
      latest: data[data.length - 1] || null,
    };
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

/** Pull oracle / LLTV / utilization / pool TVL / Pendle maturity from crawled + inspector text. */
export function parseScoringHintsFromText(text) {
  const t = String(text || "");
  const hints = parsePoolPageMetrics(t);

  const defiScore = t.match(/defi\s*safety\s*score[:\s]*(\d{1,3})\s*\/\s*100/i);
  if (defiScore) hints.defiSafetyScore = Number(defiScore[1]);

  const expRisk = t.match(/exponential[^.]{0,40}?\b(risk\s*rating|rating)[:\s]*([A-D][+-]?|\d\/\d)/i);
  if (expRisk) hints.exponentialRating = expRisk[2];

  return hints;
}

function isPendleRow(row) {
  return /pendle/i.test(String(row?.project || row?.issuerSlug || ""));
}

/** P.7 for Pendle uses AMM liquidity (pool UI), not DefiLlama token TVL or totalTvl. */
function applyPendleAmmTvlForScoring(primary) {
  if (!isPendleRow(primary)) return;
  const amm = primary.pendleAmmLiquidityUsd ?? primary.ammLiquidityUsd;
  if (amm == null || !isFinite(Number(amm)) || Number(amm) <= 0) return;
  if (primary.tvlSource === "pool_page") return;
  const current = Number(primary.tvlUsd ?? 0);
  const looksLikeAggregate =
    primary.tvlUncertain ||
    /defillama/i.test(String(primary.tvlSource || "")) ||
    current > Number(amm) * 3 ||
    current >= 500_000_000;
  if (!primary.tvlUsd || looksLikeAggregate) {
    primary.defillamaTvlUsd = primary.defillamaTvlUsd ?? primary.tvlUsd;
    primary.tvlUsd = Number(amm);
    primary.tvlSource = "protocol_api";
    primary.tvlEvidence = `Pendle AMM liquidity $${Math.round(amm).toLocaleString()}`;
    primary.tvlUncertain = false;
  }
}

function inferTvlMatchQuality(row, rowOpts = {}) {
  const vault = rowOpts.vaultAddress ? String(rowOpts.vaultAddress).toLowerCase() : null;
  if (vault && /^0x[a-f0-9]{40}$/.test(vault) && yieldsRowMatchesVault(row, vault, rowOpts.chain)) {
    return "vault";
  }
  if (row?.tvlSource === "pool_page" || row?.tvlSource === "protocol_api" || row?.tvlSource === "protocol_url_match")
    return "verified";
  const poolId = String(row?.pool || "").toLowerCase();
  const meta = String(row?.poolMeta || "").toLowerCase();
  if (vault && (poolId.includes(vault) || meta.includes(vault))) return "pool_id";
  if (rowOpts.nameHint && rowMatchesNameHint(row, rowOpts.nameHint) && row?.pool) return "name_hint";
  if (row?.pool) return "defillama_pool";
  return "symbol";
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
  const scoringHints = { ...(ctx?.metricsResolution?.scoringHints || {}) };
  let chart = null;

  const webBlob = [
    webResearch?.formatted || "",
    webResearch?.crawl?.formatted || "",
    webResearch?.scoringResearch?.formatted || "",
    webResearch?.duneResearch?.formatted || "",
  ]
    .filter(Boolean)
    .join("\n");
  if (webBlob.trim()) {
    const webParsed = parseScoringHintsFromText(webBlob);
    delete webParsed.poolTvlUsd;
    delete webParsed.tvlSource;
    delete webParsed.tvlEvidence;
    Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, webParsed));
    sources.push({
      id: "web_research_parse",
      label: "Web search + pool page parse",
      provider: "Web",
      ok: true,
      detail: [
        scoringHints.poolTvlUsd != null ? `TVL $${Math.round(scoringHints.poolTvlUsd).toLocaleString()}` : null,
        scoringHints.apyBase != null ? `apyBase ${scoringHints.apyBase}%` : scoringHints.apy != null ? `apy ${scoringHints.apy}%` : null,
        scoringHints.utilization != null ? `util ${(scoringHints.utilization * 100).toFixed(1)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "parsed crawl/search text",
    });
  }

  if (row?.pool && defillamaScoringFlag("POOL_DEFILLAMA_CHART")) {
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
  const resolvedTokens = [];
  for (const tok of tokens.slice(0, 4)) {
    const addr = String(tok?.address || "").toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(addr) && (!tok?.symbol || /^0x/i.test(String(tok.symbol)))) {
      const meta = await readErc20Metadata(addr, tok.chain || row?.chain || ctx?.chain);
      if (meta?.symbol) {
        resolvedTokens.push({ ...tok, symbol: meta.symbol, label: meta.name || meta.symbol });
        continue;
      }
    }
    resolvedTokens.push(tok);
  }
  const cgResults = [];
  for (const tok of resolvedTokens.slice(0, 3)) {
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
    row?.vaultTokenSymbol,
    ...resolvedTokens.map((t) => t.symbol),
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
    const inspectorBlob = (inspectors.searches || [])
      .flatMap((s) => (s.hits || []).map((h) => `${h.title} ${h.snippet}`))
      .join("\n");
    if (inspectorBlob) {
      const inspParsed = parseScoringHintsFromText(inspectorBlob);
      delete inspParsed.poolTvlUsd;
      delete inspParsed.tvlSource;
      Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, inspParsed));
    }
  }

  const yieldsUrl = row?.pool
    ? `https://defillama.com/yields/pool/${encodeURIComponent(row.pool)}`
    : row?.project
      ? `https://defillama.com/protocol/${encodeURIComponent(row.project)}`
      : "https://defillama.com/yields";
  if (defillamaScoringFlag("POOL_DEFILLAMA_REFERENCE") && row) {
    sources.push({
      id: "defillama_yields",
      label: "DefiLlama yields (reference only)",
      provider: "DefiLlama",
      url: yieldsUrl,
      ok: true,
      detail: `${row.project || "?"} · ${row.symbol || "?"} · not used for scoring unless POOL_DEFILLAMA_APY/TVL=1`,
    });
  }

  return {
    enabled: true,
    sources,
    notes,
    scoringHints,
    resolvedUnderlyingTokens: resolvedTokens,
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
  const tvlMatchQuality = inferTvlMatchQuality(primary, rowOpts);
  primary.tvlMatchQuality = tvlMatchQuality;

  if (hints.poolTvlUsd != null && isFinite(Number(hints.poolTvlUsd))) {
    const merged = mergeTvlIntoRow(primary, {
      value: Number(hints.poolTvlUsd),
      source: hints.tvlSource || "pool_page",
      evidence: hints.tvlEvidence || "Parsed from pool web page",
    });
    Object.assign(primary, merged);
  }
  if (hints.tvlCandidates?.length) {
    primary.tvlCandidates = hints.tvlCandidates;
  }
  if (!primary.tvlUsd || primary.tvlUncertain) {
    const allowDl = /^(1|true|yes|on)$/i.test(String(process.env.POOL_DEFILLAMA_TVL || "0").trim());
    const authoritativeTvl =
      tvlMatchQuality === "vault" ||
      tvlMatchQuality === "verified" ||
      (tvlMatchQuality === "pool_id" && rowOpts.vaultAddress) ||
      /^(protocol_api|pool_page|on_chain|dune|protocol_url_match)$/i.test(String(primary.tvlSource || ""));
    const dlTvlOk =
      allowDl &&
      (tvlMatchQuality === "vault" ||
        (tvlMatchQuality === "name_hint" && rowOpts.nameHint) ||
        (tvlMatchQuality === "pool_id" && rowOpts.vaultAddress));
    if (!authoritativeTvl && !dlTvlOk) {
      primary.defillamaTvlUsd = primary.tvlUsd;
      const pendleAmm = primary.pendleAmmLiquidityUsd ?? primary.ammLiquidityUsd;
      if (isPendleRow(primary) && pendleAmm != null && isFinite(Number(pendleAmm)) && Number(pendleAmm) > 0) {
        primary.tvlUsd = Number(pendleAmm);
        primary.tvlSource = "protocol_api";
        primary.tvlEvidence = `Pendle AMM liquidity $${Math.round(pendleAmm).toLocaleString()}`;
        primary.tvlUncertain = false;
      } else {
        primary.tvlUsd = null;
        primary.tvlUncertain = true;
        primary.tvlEvidence = allowDl
          ? "DefiLlama yields TVL is not pool-specific — parse pool page or resolve vault address"
          : "DefiLlama TVL disabled for scoring (POOL_DEFILLAMA_TVL=0) — use pool page, on-chain, or Dune";
      }
    } else if (primary.tvlUsd != null && /defillama/i.test(String(primary.tvlSource || ""))) {
      primary.tvlSource = primary.tvlSource || (tvlMatchQuality === "vault" ? "defillama_vault" : "defillama_pool");
      primary.tvlUncertain = false;
    }
  }

  const allowDlApy = defillamaScoringFlag("POOL_DEFILLAMA_APY");
  if (!allowDlApy && primary.apySource !== "protocol_api") {
    primary.apy = null;
    primary.apyBase = null;
    primary.apyReward = null;
    primary.sigma = null;
    primary.count = null;
  }

  if (hints.apy != null && isFinite(Number(hints.apy))) {
    primary.apy = Number(hints.apy);
    primary.apySource = hints.apySource || "pool_page";
    primary.apyEvidence = hints.apyEvidence || "Parsed from web research";
  }
  if (hints.apyBase != null && isFinite(Number(hints.apyBase))) {
    primary.apyBase = Number(hints.apyBase);
    primary.apySource = hints.apySource || "pool_page";
    primary.apyEvidence = hints.apyEvidence || primary.apyEvidence || "Parsed from web research";
  }
  if (hints.apyReward != null && isFinite(Number(hints.apyReward))) {
    primary.apyReward = Number(hints.apyReward);
  }
  if (hints.apyCv30d != null) {
    primary.apyCv30d = hints.apyCv30d;
    if (hints.apyStabilityEvidence) primary.apyStabilityEvidence = hints.apyStabilityEvidence;
  }
  if (hints.utilization != null) {
    primary.utilization = hints.utilization;
    if (hints.utilizationEvidence) primary.utilizationEvidence = hints.utilizationEvidence;
  }
  if (hints.lltv != null) {
    primary.lltv = hints.lltv;
    if (hints.lltvEvidence) primary.lltvEvidence = hints.lltvEvidence;
  }
  if (hints.capUtilization != null) primary.capUtilization = hints.capUtilization;
  if (hints.poolCreatedAt != null) {
    primary.poolCreatedAt = hints.poolCreatedAt;
    if (hints.poolAgeEvidence) primary.poolAgeEvidence = hints.poolAgeEvidence;
  }
  if (hints.pendleDaysToMaturity != null) {
    primary.pendleDaysToMaturity = hints.pendleDaysToMaturity;
    primary.daysToMaturity = hints.daysToMaturity;
    if (hints.maturityEvidence) primary.maturityEvidence = hints.maturityEvidence;
  }
  if (hints.pendleSecondaryMarket != null) {
    primary.pendleSecondaryMarket = hints.pendleSecondaryMarket;
    primary.pendleSecondaryEvidence = hints.pendleSecondaryEvidence;
  }
  if (hints.poolAddress) primary.vaultAddress = hints.poolAddress;
  if (hints.poolName) primary.vaultTokenName = hints.poolName;
  if (hints.poolSymbol) primary.vaultTokenSymbol = hints.poolSymbol;
  if (hints.pendleAmmLiquidityUsd != null) {
    primary.pendleAmmLiquidityUsd = Number(hints.pendleAmmLiquidityUsd);
    primary.ammLiquidityUsd = Number(hints.ammLiquidityUsd ?? hints.pendleAmmLiquidityUsd);
  }
  if (hints.withdrawalQueueDays != null) {
    primary.withdrawalQueueDays = Number(hints.withdrawalQueueDays);
    primary.withdrawalQueueEvidence = hints.withdrawalQueueEvidence || null;
  }
  if (hints.vaultCooldownDays != null) {
    primary.vaultCooldownDays = Number(hints.vaultCooldownDays);
    primary.vaultCooldownEvidence = hints.vaultCooldownEvidence || null;
  }
  if (hints.stakingSecondaryMarket != null) {
    primary.stakingSecondaryMarket = hints.stakingSecondaryMarket;
    primary.stakingSecondaryEvidence = hints.stakingSecondaryEvidence || null;
  }
  if (hints.oracleType === "chainlink") primary.oracleType = "Chainlink";
  else if (hints.oracleType === "chainlink_derived") primary.oracleType = "Chainlink derived";
  else if (hints.oracleType === "pyth") primary.oracleType = "Pyth";
  else if (hints.oracleType === "twap_long") primary.oracleType = "TWAP 30min";
  else if (hints.oracleType === "twap_short") primary.oracleType = "TWAP";
  if (hints.top100Token) primary.assetRankHint = "top100";
  if (defillamaScoringFlag("POOL_DEFILLAMA_CHART") && externalData?.defillamaChart?.apyCv30d != null) {
    primary.apyCv30d = externalData.defillamaChart.apyCv30d;
    primary.apyStabilityEvidence = "DefiLlama 30d APY coefficient of variation";
  } else if (allowDlApy && primary.apyCv30d == null && isFinite(Number(primary.sigma))) {
    primary.apyCv30d = Number(primary.sigma);
    primary.apyStabilityEvidence = "DefiLlama yields sigma (POOL_DEFILLAMA_APY=1)";
  }
  applyPendleAmmTvlForScoring(primary);
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
