/**
 * Pool identity + metrics resolution.
 * TVL priority: protocol/contract API → Playwright pool page → analytics (DL/Dune) → web search.
 */
import { parsePoolPageMetrics, mergePageMetricsIntoHints } from "./poolPageParse.js";
import { readErc20Metadata, readErc4626VaultTvlUsd } from "./onChainToken.js";
import { moralisErc20Metadata } from "./moralisClient.js";
import { gatherDunePoolResearch } from "./duneResearch.js";
import { searchWeb } from "./webResearch.js";
import { findPendleMarket, extractPendleScoringMeta } from "./pendleMarket.js";
import { pickBestTvlCandidate, tvlConfidenceForSource } from "./tvlSourcePriority.js";
import { fetchPoolSubgraphMetrics, subgraphExplorerUrlForPool } from "./poolSubgraph.js";
import { resolvePoolCreatedAtMs } from "./poolContractAge.js";
import {
  defillamaYieldsPoolUrl,
  explorerInternalTxUrl,
} from "./sourceUrls.js";

function defillamaTvlAllowed() {
  return /^(1|true|yes|on)$/i.test(String(process.env.POOL_DEFILLAMA_TVL || "0").trim());
}

function collectSearchBlobs(webResearch) {
  return [
    webResearch?.formatted || "",
    webResearch?.scoringResearch?.formatted || "",
    webResearch?.duneResearch?.formatted || "",
    ...(webResearch?.searches || []).flatMap((s) => [
      s.answer || "",
      ...(s.hits || []).map((h) => `${h.title} ${h.snippet}`),
    ]),
    ...(webResearch?.scoringResearch?.searches || []).flatMap((s) =>
      (s.hits || []).map((h) => `${h.title} ${h.snippet}`)
    ),
  ].filter(Boolean);
}

async function searchPoolMetricsWeb(ctx) {
  const label = String(ctx?.label || "").trim();
  const sym = String(ctx?.symbol || ctx?.yieldsRow?.symbol || "").trim();
  const slug = String(ctx?.issuerSlug || "").trim();
  const url = String(ctx?.url || "").trim();
  let siteHost = null;
  if (/^https?:\/\//i.test(url)) {
    try {
      siteHost = new URL(url).hostname;
    } catch {
      siteHost = null;
    }
  }
  const queries = [
    url ? `${url} TVL total liquidity utilization LLTV` : null,
    label && siteHost ? `site:${siteHost} "${label}" TVL total liquidity utilization` : null,
    label ? `"${label}" pool TVL total liquidity deposits utilization LLTV` : null,
    sym && slug ? `${slug} ${sym} pool page TVL utilization loan-to-value LLTV` : null,
    /pendle|pt-/i.test(`${label} ${sym}`)
      ? `${label || sym} Pendle days to maturity expiry PT liquidity secondary market`
      : null,
    sym && slug ? `${slug} ${sym} morpho aave euler vault dashboard utilization` : null,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_METRICS_SEARCH_QUERIES || 4) || 4;
  const searches = [];
  const hints = {};
  for (const q of [...new Set(queries)].slice(0, maxQ)) {
    try {
      const s = await searchWeb(q, { maxResults: 5 });
      searches.push(s);
      const blob = [s.answer, ...(s.hits || []).map((h) => `${h.title} ${h.snippet}`)].join("\n");
      mergePageMetricsIntoHints(hints, parsePoolPageMetrics(blob));
    } catch {
      /* skip */
    }
  }
  return { searches, hints };
}

/**
 * Resolve pool address, name, and scoring metrics from multiple sources.
 */
export async function resolvePoolMetrics(ctx = {}, { webResearch = null, yieldsRow = null, trace = null } = {}) {
  const row = yieldsRow || {};
  const vaultAddress = String(ctx?.vaultAddress || row?.vaultAddress || "").toLowerCase();
  const chain = ctx?.chain || row?.chain || "ethereum";
  const scoringHints = {};
  const tvlCandidates = [];
  const sources = [];

  // Tier 1: protocol API / on-chain (contract address)
  const vaultMeta = ctx?.vaultMeta?.scoring || ctx?.vaultMeta;
  if (vaultMeta?.totalAssetsUsd != null && isFinite(Number(vaultMeta.totalAssetsUsd))) {
    tvlCandidates.push({
      value: Number(vaultMeta.totalAssetsUsd),
      source: "protocol_api",
      evidence: vaultMeta.tvlEvidence || "Protocol API totalAssetsUsd",
    });
    sources.push({
      id: "protocol_api",
      label: "Protocol API",
      provider: ctx?.vaultMeta?.source || "protocol",
      ok: true,
      detail: vaultMeta.tvlEvidence || `TVL $${Math.round(vaultMeta.totalAssetsUsd).toLocaleString()}`,
    });
  }
  if (vaultMeta?.pendleAmmLiquidityUsd != null && isFinite(Number(vaultMeta.pendleAmmLiquidityUsd))) {
    Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, vaultMeta));
  }

  const subgraphMeta = await fetchPoolSubgraphMetrics(ctx).catch(() => null);
  const sgScoring = subgraphMeta?.scoring;
  if (sgScoring?.totalAssetsUsd != null && isFinite(Number(sgScoring.totalAssetsUsd))) {
    tvlCandidates.push({
      value: Number(sgScoring.totalAssetsUsd),
      source: "subgraph",
      evidence: sgScoring.tvlEvidence || "Subgraph indexed pool TVL",
    });
    Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, sgScoring));
    sources.push({
      id: "subgraph",
      label: "The Graph subgraph",
      provider: subgraphMeta?.protocol || "subgraph",
      ok: true,
      detail: sgScoring.tvlEvidence || `TVL $${Math.round(sgScoring.totalAssetsUsd).toLocaleString()}`,
      url: subgraphMeta?.subgraphUrl || subgraphExplorerUrlForPool(ctx),
      subgraphId: subgraphMeta?.subgraphId || null,
    });
  } else if (subgraphMeta?.error) {
    sources.push({
      id: "subgraph",
      label: "The Graph subgraph",
      provider: "subgraph",
      ok: false,
      detail: String(subgraphMeta.error).slice(0, 120),
    });
  }

  const poolAgeAddr =
    vaultMeta?.vaultAddress ||
    vaultAddress ||
    ctx?.vaultAddress ||
    (ctx?.protocolKind === "aave_reserve" ? ctx?.underlyingAsset : null);
  const onChainAge = await resolvePoolCreatedAtMs({
    address: poolAgeAddr,
    chain,
    marketId: ctx?.marketId,
    protocolKind: ctx?.protocolKind,
  }).catch(() => null);
  if (onChainAge?.poolCreatedAt) {
    Object.assign(scoringHints, onChainAge);
    sources.push({
      id: "pool_age_on_chain",
      label: "On-chain pool age",
      provider: "block explorer",
      ok: true,
      detail: onChainAge.poolAgeEvidence,
      url: onChainAge.poolAgeExplorerUrl || explorerInternalTxUrl(poolAgeAddr, chain),
    });
  }

  if (/^0x[a-f0-9]{40}$/.test(vaultAddress)) {
    const onChainTvl = await readErc4626VaultTvlUsd(vaultAddress, chain);
    if (onChainTvl?.tvlUsd) {
      tvlCandidates.push({
        value: onChainTvl.tvlUsd,
        source: "on_chain",
        evidence: onChainTvl.evidence,
      });
      sources.push({
        id: "on_chain_tvl",
        label: "On-chain ERC-4626",
        provider: "viem",
        ok: true,
        detail: onChainTvl.evidence,
      });
    }

    let identity = await readErc20Metadata(vaultAddress, chain);
    if (!identity?.name) {
      const moralis = await moralisErc20Metadata(vaultAddress, chain);
      if (moralis) identity = moralis;
    }
    if (identity) {
      scoringHints.poolName = identity.name || identity.symbol;
      scoringHints.poolSymbol = identity.symbol;
      scoringHints.poolAddress = vaultAddress;
      sources.push({
        id: "on_chain_identity",
        label: "On-chain token",
        provider: identity.source || "viem",
        ok: true,
        detail: `${identity.symbol || "?"}${identity.name ? ` · ${identity.name}` : ""}`,
      });
    }
  }

  const needsPendleMetrics =
    !scoringHints.pendleDaysToMaturity &&
    !scoringHints.pendleAmmLiquidityUsd &&
    !scoringHints.poolTvlUsd;
  if (
    needsPendleMetrics ||
    /pendle/i.test(`${ctx?.issuerSlug || ""} ${ctx?.label || ""} ${ctx?.url || ""}`)
  ) {
    const pendleHit = await findPendleMarket({
      address: vaultAddress,
      chain,
      nameHint: ctx?.label || row?.symbol,
      poolUrl: ctx?.url,
    }).catch(() => null);
    if (pendleHit?.market) {
      const pendleMeta = extractPendleScoringMeta(pendleHit.market);
      Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, pendleMeta || {}));
      const pendleTvl =
        pendleMeta?.pendleAmmLiquidityUsd != null && isFinite(Number(pendleMeta.pendleAmmLiquidityUsd))
          ? Number(pendleMeta.pendleAmmLiquidityUsd)
          : pendleMeta?.tvlUsd;
      if (pendleTvl != null && isFinite(Number(pendleTvl)) && Number(pendleTvl) > 0) {
        tvlCandidates.push({
          value: Number(pendleTvl),
          source: "protocol_api",
          evidence:
            pendleMeta?.pendleAmmLiquidityUsd != null
              ? pendleMeta.tvlEvidence || "Pendle API AMM liquidity"
              : pendleMeta.tvlEvidence || "Pendle API totalTvl",
        });
      }
      sources.push({
        id: "pendle_api",
        label: "Pendle API",
        provider: "Pendle",
        ok: true,
        detail: [
          pendleMeta?.pendleDaysToMaturity != null ? `${pendleMeta.pendleDaysToMaturity}d to maturity` : null,
          pendleMeta?.pendleAmmLiquidityUsd != null
            ? `AMM $${Math.round(pendleMeta.pendleAmmLiquidityUsd).toLocaleString()}`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        url: "https://api-v2.pendle.finance",
      });
    }
  }

  // Tier 2: Playwright pool page crawl only (not Tavily snippets)
  const primaryPage = webResearch?.crawl?.pages?.find((p) => p.primary) || webResearch?.crawl?.pages?.[0];
  const crawlStructured =
    webResearch?.crawl?.structuredHints ||
    (primaryPage?.metrics ? primaryPage.metrics : null) ||
    {};
  const pageText = primaryPage?.innerText || primaryPage?.excerpt || "";
  const fromPage = parsePoolPageMetrics(pageText, {
    innerText: pageText,
    html: primaryPage?.html || "",
    url: ctx?.url || primaryPage?.url,
    poolLabel: ctx?.label,
    marketId: ctx?.marketId || null,
  });
  const fromFormatted =
    !fromPage.poolTvlUsd && webResearch?.crawl?.formatted
      ? parsePoolPageMetrics(webResearch.crawl.formatted, {
          url: ctx?.url,
          poolLabel: ctx?.label,
          marketId: ctx?.marketId || null,
        })
      : {};
  const crawlParsed = mergePageMetricsIntoHints(
    mergePageMetricsIntoHints(crawlStructured, fromPage),
    fromFormatted
  );
  Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, crawlParsed));
  const hasProtocolTvl = tvlCandidates.some((c) => c.source === "protocol_api" || c.source === "on_chain");
  if (crawlParsed.poolTvlUsd && !hasProtocolTvl) {
    tvlCandidates.push({
      value: crawlParsed.poolTvlUsd,
      source: "pool_page",
      evidence: crawlParsed.tvlEvidence || "Parsed from Playwright pool page crawl",
    });
    sources.push({
      id: "pool_page_crawl",
      label: "Pool page (Playwright)",
      provider: "Crawl",
      ok: true,
      detail: crawlParsed.tvlEvidence || `TVL $${Math.round(crawlParsed.poolTvlUsd).toLocaleString()}`,
      url: ctx?.url || null,
    });
  }

  // Tier 3: Dune + DefiLlama analytics
  const duneResearch = await gatherDunePoolResearch({
    poolLabel: ctx?.label,
    symbol: row?.symbol,
    issuerSlug: ctx?.issuerSlug,
    vaultAddress: /^0x[a-f0-9]{40}$/.test(vaultAddress) ? vaultAddress : null,
    chain,
  });
  if (webResearch) webResearch.duneResearch = duneResearch;
  Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, duneResearch.hints || {}));
  if (duneResearch.hints?.poolTvlUsd) {
    tvlCandidates.push({
      value: duneResearch.hints.poolTvlUsd,
      source: "dune",
      evidence: duneResearch.hints.tvlEvidence || "Dune Analytics",
    });
    sources.push({
      id: "dune",
      label: "Dune Analytics",
      provider: "Dune",
      ok: true,
      detail: `TVL $${Math.round(duneResearch.hints.poolTvlUsd).toLocaleString()}`,
      url: "https://dune.com",
    });
  }

  if (row?.tvlUsd != null && isFinite(Number(row.tvlUsd)) && row?.pool) {
    tvlCandidates.push({
      value: Number(row.tvlUsd),
      source: "defillama",
      evidence: row.tvlUncertain
        ? "DefiLlama yields row (symbol match — reference only)"
        : `DefiLlama yields pool ${String(row.pool).slice(0, 8)}…`,
    });
    sources.push({
      id: "defillama_yields",
      label: "DefiLlama yields",
      provider: "DefiLlama",
      ok: !row.tvlUncertain,
      detail: `TVL $${Math.round(row.tvlUsd).toLocaleString()}${row.tvlUncertain ? " (uncertain match)" : ""}`,
      url: defillamaYieldsPoolUrl(row.pool),
    });
  }

  // Tier 4: Web search (Tavily) — never outranks contract API or Playwright
  const searchBlobs = collectSearchBlobs(webResearch);
  const searchParsed = parsePoolPageMetrics(searchBlobs.join("\n"));
  mergePageMetricsIntoHints(scoringHints, searchParsed);
  if (searchParsed.poolTvlUsd) {
    tvlCandidates.push({
      value: searchParsed.poolTvlUsd,
      source: "web_search",
      evidence: searchParsed.tvlEvidence || "Parsed from web search snippets",
    });
  }

  const metricsSearch = await searchPoolMetricsWeb({ ...ctx, yieldsRow: row, symbol: row.symbol });
  Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, metricsSearch.hints));
  if (metricsSearch.hints.poolTvlUsd) {
    tvlCandidates.push({
      value: metricsSearch.hints.poolTvlUsd,
      source: "web_search",
      evidence: metricsSearch.hints.tvlEvidence || "Web search pool metrics",
    });
  }

  const allowDl = defillamaTvlAllowed();
  const bestTvl = pickBestTvlCandidate(tvlCandidates, { allowDefillama: allowDl });
  if (bestTvl) {
    scoringHints.poolTvlUsd = bestTvl.value;
    scoringHints.tvlSource = bestTvl.source;
    scoringHints.tvlEvidence = bestTvl.evidence;
  } else if (row?.tvlUsd != null) {
    scoringHints.defillamaTvlUsd = row.tvlUsd;
    scoringHints.tvlUncertain = true;
  }

  scoringHints.tvlCandidates = tvlCandidates.map((c) => ({
    source: c.source,
    value: c.value,
    evidence: c.evidence,
    confidence: tvlConfidenceForSource(c.source),
  }));

  const poolIdentity = {
    address: scoringHints.poolAddress || (/^0x[a-f0-9]{40}$/.test(vaultAddress) ? vaultAddress : null),
    name: scoringHints.poolName || ctx?.label || row?.vaultTokenName || row?.symbol || null,
    symbol: scoringHints.poolSymbol || row?.vaultTokenSymbol || row?.symbol || null,
    tvlUsd: bestTvl?.value ?? null,
    tvlSource: bestTvl?.source ?? null,
    tvlEvidence: bestTvl?.evidence ?? null,
    tvlCandidates: scoringHints.tvlCandidates,
  };

  if (trace) {
    trace.step("Pool metrics (source priority)", {
      kind: bestTvl ? "source" : "error",
      detail: [
        poolIdentity.name ? `name: ${poolIdentity.name}` : null,
        poolIdentity.address ? `addr ${poolIdentity.address.slice(0, 10)}…` : null,
        bestTvl
          ? `TVL $${Math.round(bestTvl.value).toLocaleString()} (${bestTvl.source}, ${tvlConfidenceForSource(bestTvl.source)} confidence)`
          : "TVL unresolved",
        scoringHints.utilization != null
          ? `util ${((scoringHints.utilization > 1 ? scoringHints.utilization : scoringHints.utilization * 100)).toFixed(1)}%`
          : null,
        scoringHints.lltv != null ? `LLTV ${scoringHints.lltv}%` : null,
        tvlCandidates.length > 1 ? `${tvlCandidates.length} TVL sources ranked` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      sources: sources.slice(0, 8).map((s) => ({ label: s.label, url: s.url || null })),
    });
  }

  return {
    scoringHints,
    poolIdentity,
    sources,
    metricsSearch,
    duneResearch,
  };
}
