/**
 * Web-first pool identity + metrics resolution.
 * Priority: pool page / crawl > protocol API > on-chain > Dune > Moralis > DefiLlama (opt-in).
 */
import { parsePoolPageMetrics, mergePageMetricsIntoHints } from "./poolPageParse.js";
import { readErc20Metadata, readErc4626VaultTvlUsd } from "./onChainToken.js";
import { moralisErc20Metadata } from "./moralisClient.js";
import { gatherDunePoolResearch } from "./duneResearch.js";
import { searchWeb } from "./webResearch.js";

const TVL_SOURCE_RANK = {
  pool_page: 0,
  protocol_api: 1,
  on_chain: 2,
  dune: 3,
  moralis: 4,
  defillama: 5,
};

function defillamaTvlAllowed() {
  return /^(1|true|yes|on)$/i.test(String(process.env.POOL_DEFILLAMA_TVL || "0").trim());
}

function pickBestCandidate(candidates, { allowDefillama = false } = {}) {
  const list = (candidates || []).filter((c) => c?.value != null && isFinite(Number(c.value)) && Number(c.value) > 0);
  const filtered = allowDefillama ? list : list.filter((c) => c.source !== "defillama");
  if (!filtered.length) return null;
  filtered.sort((a, b) => (TVL_SOURCE_RANK[a.source] ?? 99) - (TVL_SOURCE_RANK[b.source] ?? 99));
  return filtered[0];
}

function collectTextBlobs(webResearch) {
  return [
    webResearch?.crawl?.formatted || "",
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

  const blobs = collectTextBlobs(webResearch);
  const pageParsed = parsePoolPageMetrics(blobs.join("\n"));
  Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, pageParsed));
  if (pageParsed.poolTvlUsd) {
    tvlCandidates.push({
      value: pageParsed.poolTvlUsd,
      source: "pool_page",
      evidence: pageParsed.tvlEvidence || "Parsed from pool site / web crawl",
    });
  }

  const metricsSearch = await searchPoolMetricsWeb({ ...ctx, yieldsRow: row, symbol: row.symbol });
  Object.assign(scoringHints, mergePageMetricsIntoHints(scoringHints, metricsSearch.hints));
  if (metricsSearch.hints.poolTvlUsd) {
    tvlCandidates.push({
      value: metricsSearch.hints.poolTvlUsd,
      source: "pool_page",
      evidence: metricsSearch.hints.tvlEvidence || "Web search pool metrics",
    });
  }

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

  const vaultMeta = ctx?.vaultMeta?.scoring || ctx?.vaultMeta;
  if (vaultMeta?.totalAssetsUsd != null && isFinite(Number(vaultMeta.totalAssetsUsd))) {
    tvlCandidates.push({
      value: Number(vaultMeta.totalAssetsUsd),
      source: "protocol_api",
      evidence: vaultMeta.tvlEvidence || "Protocol API totalAssetsUsd",
    });
  }

  if (defillamaTvlAllowed() && row?.tvlUsd != null && !row?.tvlUncertain) {
    tvlCandidates.push({
      value: Number(row.tvlUsd),
      source: "defillama",
      evidence: "DefiLlama yields row (POOL_DEFILLAMA_TVL=1)",
    });
  }

  const bestTvl = pickBestCandidate(tvlCandidates, { allowDefillama: defillamaTvlAllowed() });
  if (bestTvl) {
    scoringHints.poolTvlUsd = bestTvl.value;
    scoringHints.tvlSource = bestTvl.source;
    scoringHints.tvlEvidence = bestTvl.evidence;
  } else if (row?.tvlUsd != null) {
    scoringHints.defillamaTvlUsd = row.tvlUsd;
    scoringHints.tvlUncertain = true;
  }

  const poolIdentity = {
    address: scoringHints.poolAddress || (/^0x[a-f0-9]{40}$/.test(vaultAddress) ? vaultAddress : null),
    name: scoringHints.poolName || ctx?.label || row?.vaultTokenName || row?.symbol || null,
    symbol: scoringHints.poolSymbol || row?.vaultTokenSymbol || row?.symbol || null,
    tvlUsd: bestTvl?.value ?? null,
    tvlSource: bestTvl?.source ?? null,
    tvlEvidence: bestTvl?.evidence ?? null,
    tvlCandidates: tvlCandidates.map((c) => ({
      source: c.source,
      value: c.value,
      evidence: c.evidence,
    })),
  };

  if (trace) {
    trace.step("Pool metrics (web-first)", {
      kind: bestTvl ? "source" : "error",
      detail: [
        poolIdentity.name ? `name: ${poolIdentity.name}` : null,
        poolIdentity.address ? `addr ${poolIdentity.address.slice(0, 10)}…` : null,
        bestTvl ? `TVL $${Math.round(bestTvl.value).toLocaleString()} (${bestTvl.source})` : "TVL unresolved",
        scoringHints.utilization != null
          ? `util ${((scoringHints.utilization > 1 ? scoringHints.utilization : scoringHints.utilization * 100)).toFixed(1)}%`
          : null,
        scoringHints.lltv != null ? `LLTV ${scoringHints.lltv}%` : null,
        scoringHints.pendleDaysToMaturity != null ? `maturity ${scoringHints.pendleDaysToMaturity}d` : null,
        tvlCandidates.length > 1 ? `${tvlCandidates.length} TVL sources compared` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      sources: sources.slice(0, 6).map((s) => ({ label: s.label, url: s.url || null })),
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
