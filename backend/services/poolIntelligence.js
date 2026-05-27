import {
  discoverProtocolsForPoolAddress,
  discoverProtocolsForPoolWebsite,
  discoverProtocolsForYieldsMarket,
  fetchYieldsPoolsCached,
  defillamaSlugFromWebsite,
} from "./yieldsDiscover.js";
import { getDefiLlamaProtocolApiDetail } from "./defillama.js";
import { formatNeo4jErrorForUser } from "../db/neo4jGraph.js";
import { buildHeuristicRiskAssessment } from "../llm/riskHeuristics.js";
import { buildPoolRiskAssessment } from "../llm/poolScoring.js";
import { runHostedLlmJson } from "../llm/provider.js";
import { gatherPoolWebResearch } from "./webResearch.js";
import { discoverIntegratorsFromWebResearch } from "./integratorExtract.js";
import {
  gatherPoolExternalData,
  applyExternalDataToYieldsRows,
  buildPoolSourceNotes,
} from "./poolDataSources.js";

const GENERIC_UNDERLYING = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
  ].map((a) => a.toLowerCase())
);

function normalizeChain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "ethereum";
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("base")) return "base";
  if (s.includes("optimism")) return "optimism";
  if (s.includes("polygon")) return "polygon";
  return s.replace(/[^a-z0-9_-]+/g, "_").slice(0, 24) || "ethereum";
}

function parsePoolInput({ url, address, chain, project, symbolHint, query } = {}) {
  const q = String(query || url || "").trim();
  if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      kind: "address",
      chain: normalizeChain(chain),
      address: String(address).toLowerCase(),
      label: `Pool ${String(address).slice(0, 10)}…`,
    };
  }
  const key = q.match(/^([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/i);
  if (key) {
    return { kind: "address", chain: key[1].toLowerCase(), address: key[2].toLowerCase(), label: q };
  }
  const bare = q.match(/^(0x[a-fA-F0-9]{40})$/i);
  if (bare) {
    return { kind: "address", chain: normalizeChain(chain), address: bare[1].toLowerCase(), label: bare[1] };
  }
  if (/^https?:\/\//i.test(q)) {
    return { kind: "url", url: q, label: q };
  }
  if (project) {
    return { kind: "market", project: String(project).toLowerCase(), symbolHint: symbolHint || "", label: `${project} ${symbolHint}`.trim() };
  }
  return { kind: "text", query: q, label: q };
}

function underlyingForIntegratorSearch(yieldsRows) {
  const symHay = yieldsRows.map((r) => `${r?.symbol || ""} ${r?.poolMeta || ""}`).join(" ").toLowerCase();
  const allowUsdc = /usdc|usd coin/i.test(symHay);
  const allowUsdt = /usdt|tether/i.test(symHay);
  const allowWeth = /weth|eth|steth/i.test(symHay);
  const out = new Set();
  for (const row of yieldsRows) {
    for (const t of Array.isArray(row?.underlyingTokens) ? row.underlyingTokens : []) {
      const a = String(t || "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(a)) continue;
      if (GENERIC_UNDERLYING.has(a)) {
        if (allowUsdc && a === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") out.add(a);
        if (allowUsdt && a === "0xdac17f958d2ee523a2206206994597c13d831ec7") out.add(a);
        if (allowWeth && a === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") out.add(a);
        continue;
      }
      out.add(a);
    }
  }
  return [...out];
}

function countPoolsWithUnderlying(addr, allPools) {
  const a = String(addr || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return 0;
  let n = 0;
  for (const p of allPools) {
    const under = (Array.isArray(p?.underlyingTokens) ? p.underlyingTokens : []).map((t) =>
      String(t).toLowerCase()
    );
    if (under.includes(a)) n += 1;
  }
  return n;
}

/**
 * Other DefiLlama yield projects that list the same underlying token(s) — exposure integrators.
 */
export function findProtocolsSharingUnderlying(yieldsRows, allPools) {
  const issuerSlugs = new Set(
    yieldsRows.map((r) => String(r?.project || "").trim().toLowerCase()).filter(Boolean)
  );
  const tokens = underlyingForIntegratorSearch(yieldsRows).filter((t) => {
    const n = countPoolsWithUnderlying(t, allPools);
    return n > 0 && n <= 12;
  });
  const vaultCandidates = yieldsRows
    .flatMap((r) => (Array.isArray(r?.underlyingTokens) ? r.underlyingTokens : []))
    .map((t) => String(t).toLowerCase())
    .filter((a) => /^0x[a-f0-9]{40}$/.test(a) && !GENERIC_UNDERLYING.has(a));
  const vaultAddr = vaultCandidates.find((a) => {
    const n = countPoolsWithUnderlying(a, allPools);
    return n > 0 && n <= 12;
  });

  const integrators = new Map();

  const ingest = (row, link) => {
    const slug = String(row?.project || "").trim().toLowerCase();
    if (!slug) return;
    const id = `defillama:${slug}`;
    if (!integrators.has(id)) {
      integrators.set(id, {
        id,
        name: slug,
        url: `https://defillama.com/protocol/${slug}`,
        link,
        tier: issuerSlugs.has(slug) ? "issuer" : "integrator",
        yieldsPools: [],
        totalTvlUsd: 0,
      });
    }
    const ent = integrators.get(id);
    ent.totalTvlUsd += Number(row?.tvlUsd) || 0;
    ent.yieldsPools.push({
      symbol: row?.symbol,
      chain: row?.chain,
      tvlUsd: row?.tvlUsd,
      apy: row?.apy,
      exposure: row?.exposure,
      ilRisk: row?.ilRisk,
    });
  };

  for (const row of yieldsRows) ingest(row, "pool_issuer");

  for (const p of allPools) {
    const under = (Array.isArray(p?.underlyingTokens) ? p.underlyingTokens : []).map((t) =>
      String(t).toLowerCase()
    );
    const sharesVault =
      vaultAddr && /^0x[a-f0-9]{40}$/.test(vaultAddr) && under.includes(vaultAddr);
    const sharesToken =
      !sharesVault && tokens.length && tokens.some((t) => under.includes(t));
    if (!sharesToken && !sharesVault) continue;
    ingest(p, sharesVault ? "same_vault_token" : "shared_underlying");
  }

  return [...integrators.values()]
    .sort((a, b) => {
      if (a.tier === "issuer" && b.tier !== "issuer") return -1;
      if (b.tier === "issuer" && a.tier !== "issuer") return 1;
      return (b.totalTvlUsd || 0) - (a.totalTvlUsd || 0);
    })
    .slice(0, 48);
}

function llmEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_INTELLIGENCE_LLM || "1").trim());
}

/**
 * When DefiLlama only lists the pool issuer: web search + page scrape, then LLM synthesis.
 */
export async function discoverPoolIntegratorsWithLlm({
  poolLabel,
  poolUrl,
  issuerSlug,
  yieldsRows = [],
  webResearch: webResearchIn = null,
} = {}) {
  if (!llmEnabled()) return { integrators: [], webResearch: webResearchIn };
  const summary = (yieldsRows || []).slice(0, 6).map((r) => ({
    project: r?.project,
    symbol: r?.symbol,
    chain: r?.chain,
    poolMeta: r?.poolMeta,
    tvlUsd: r?.tvlUsd,
    apy: r?.apy,
    underlyingTokens: (r?.underlyingTokens || []).slice(0, 4),
  }));
  const webResearch =
    webResearchIn ||
    (await gatherPoolWebResearch({ poolLabel, poolUrl, issuerSlug }));
  const system = `You identify DeFi protocols that integrate with, deposit into, curate, or route liquidity through a specific yield pool or vault.
Use the WEB RESEARCH section (search results and pool page text) as primary evidence when present.
List ALL protocols that integrate, will integrate, route liquidity, accept avUSDC/vault shares as collateral, or are named as partners (Morpho, Pendle, Maple, Ethena, Aerodrome, Uniswap, etc.).
Include live integrations AND planned/future ones (separate entries, confidence low for planned).
Use DefiLlama slugs: morpho-blue, pendle, maple-finance, ethena, aerodrome-finance, uniswap-v3, etc.
Return at least every protocol explicitly named in WEB RESEARCH summaries (e.g. Morpho, Pendle, Maple, Ethena, Aerodrome).
Return JSON only. Do not invent 0x addresses. Exclude the pool issuer unless it is also an integrator.`;
  const user = `
Pool label: ${poolLabel || "unknown"}
Pool URL: ${poolUrl || "n/a"}
Issuer (DefiLlama slug): ${issuerSlug || "unknown"}

DefiLlama yields rows:
${JSON.stringify(summary, null, 2)}

WEB RESEARCH (live search + Playwright pool site crawl + page text):
${webResearch.formatted || "(no web research — set TAVILY_API_KEY or enable POOL_WEB_SEARCH)"}

Return JSON:
{
  "protocols": [
    {
      "slug": "defillama-slug",
      "name": "Display name",
      "relationship": "integrator|curator|allocator|aggregator|partner",
      "confidence": "high|medium|low",
      "note": "one sentence"
    }
  ]
}
`.trim();
  try {
    const r = await runHostedLlmJson({ step: "poolIntegrators", system, user, timeoutMs: 120_000 });
    const rows = Array.isArray(r?.json?.protocols) ? r.json.protocols : [];
    const issuer = String(issuerSlug || "").toLowerCase();
    const out = [];
    const seen = new Set();
    for (const row of rows.slice(0, 20)) {
      const slug = normalizeIntegratorSlug(row?.slug || row?.name);
      if (!slug || slug === issuer || seen.has(slug)) continue;
      seen.add(slug);
      out.push({
        id: `defillama:${slug}`,
        name: String(row?.name || slug).slice(0, 80),
        url: `https://defillama.com/protocol/${slug}`,
        link: "llm_integrator",
        tier: "integrator",
        relationship: row?.relationship || "integrator",
        confidence: row?.confidence || "medium",
        note: row?.note || null,
        totalTvlUsd: 0,
        yieldsPools: [],
      });
    }
    return { integrators: out, webResearch };
  } catch (e) {
    console.warn("pool LLM integrators:", e?.message || e);
    return { integrators: [], webResearch };
  }
}

function mergeLlmIntegrators(integrators, llmResult) {
  const rows = Array.isArray(llmResult) ? llmResult : llmResult?.integrators || [];
  const seen = new Set(integrators.map((p) => p.id));
  for (const p of rows) {
    if (!seen.has(p.id)) {
      integrators.push(p);
      seen.add(p.id);
    }
  }
  return integrators;
}

const EXPOSURE_ONLY_LINKS = new Set(["shared_underlying", "same_vault_token"]);

function filterUsingIntegrators(integrators) {
  return (integrators || []).filter(
    (p) => p.tier !== "issuer" && !EXPOSURE_ONLY_LINKS.has(p.link)
  );
}

function normalizeIntegratorSlug(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^defillama:/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const aliases = {
    morpho: "morpho-blue",
    maple: "maple-finance",
    aerodrome: "aerodrome-finance",
    uniswap: "uniswap-v3",
    gains: "gains-network",
  };
  return aliases[s] || s;
}

function mergeWebMentionIntegrators(integrators, mentions) {
  const seen = new Set(integrators.map((p) => p.id));
  for (const p of mentions || []) {
    if (!p?.id || seen.has(p.id)) continue;
    seen.add(p.id);
    integrators.push(p);
  }
  return integrators;
}

async function augmentIntegratorsFromCrawlAddresses(integrators, addresses, chainHint = "ethereum") {
  const seen = new Set(integrators.map((p) => p.id));
  for (const addr of (addresses || []).slice(0, 8)) {
    if (!/^0x[a-f0-9]{40}$/.test(String(addr || "").toLowerCase())) continue;
    const d = await discoverProtocolsForPoolAddress({
      chain: chainHint,
      address: String(addr).toLowerCase(),
    }).catch(() => ({ protocols: [] }));
    for (const p of d.protocols || []) {
      const id = String(p?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      integrators.push({
        id,
        name: p.name || id,
        url: p.url || null,
        link: "pool_crawl_contract",
        tier: "integrator",
        totalTvlUsd: 0,
        yieldsPools: Array.isArray(p.pools) ? p.pools : [],
      });
    }
  }
  return integrators;
}

/** Enrich discover-url / yields-market payloads with integrators, underlying, and quick risk. */
export async function enrichPoolDiscoverPayload(discover, { poolUrl, useLlm = true } = {}) {
  const allPools = await fetchYieldsPoolsCached();
  let yieldsRows = Array.isArray(discover?.yieldsPools) ? discover.yieldsPools : [];
  if (!yieldsRows.length && discover?.matchedSlug) {
    yieldsRows = allPools
      .filter((p) => String(p?.project || "").toLowerCase() === String(discover.matchedSlug).toLowerCase())
      .slice(0, 40)
      .map((r) => ({
        project: r?.project,
        symbol: r?.symbol,
        chain: r?.chain,
        tvlUsd: r?.tvlUsd,
        apy: r?.apy,
        poolMeta: r?.poolMeta,
        underlyingTokens: r?.underlyingTokens || [],
      }));
  }
  let integrators = findProtocolsSharingUnderlying(yieldsRows, allPools);
  const issuerSlug =
    discover?.matchedSlug ||
    integrators.find((p) => p.tier === "issuer")?.id?.replace(/^defillama:/i, "") ||
    null;
  const nonIssuer = integrators.filter((p) => p.tier !== "issuer");
  let webResearch = null;
  if (poolUrl && /^https?:\/\//i.test(poolUrl)) {
    webResearch = await gatherPoolWebResearch({
      poolLabel: discover?.marketLabel,
      poolUrl,
      issuerSlug,
    }).catch(() => null);
  }
  if (webResearch?.formatted) {
    const mentions = await discoverIntegratorsFromWebResearch(webResearch, {
      issuerSlug,
      poolLabel: discover?.marketLabel,
    });
    integrators = mergeWebMentionIntegrators(integrators, mentions);
  }
  if (webResearch?.addresses?.length) {
    const chainHint = normalizeChain(yieldsRows[0]?.chain || "ethereum");
    integrators = await augmentIntegratorsFromCrawlAddresses(
      integrators,
      webResearch.addresses,
      chainHint
    );
  }
  const usingCount = filterUsingIntegrators(integrators).length;
  if (useLlm && poolUrl && usingCount < 8) {
    const llm = await discoverPoolIntegratorsWithLlm({
      poolLabel: discover?.marketLabel,
      poolUrl,
      issuerSlug,
      yieldsRows,
      webResearch,
    });
    webResearch = llm.webResearch || webResearch;
    integrators = mergeLlmIntegrators(integrators, llm);
  }
  const underlyingTokens = tokensFromRows(yieldsRows, null);
  const issuer = integrators.filter((p) => p.tier === "issuer");
  const usingProtocols = filterUsingIntegrators(integrators);
  const issuerSlugForExt =
    discover?.matchedSlug ||
    issuer[0]?.id?.replace(/^defillama:/i, "") ||
    null;
  const externalData = await gatherPoolExternalData(
    {
      label: discover?.marketLabel,
      issuerSlug: issuerSlugForExt,
      yieldsRows,
      underlyingTokens,
    },
    { webResearch }
  );
  const enrichedRows = applyExternalDataToYieldsRows(yieldsRows, externalData);
  const risk = buildPoolRisk(
    {
      label: discover?.marketLabel,
      url: poolUrl,
      yieldsRows: enrichedRows,
      integrators,
      underlyingTokens,
      issuerSlug: issuerSlugForExt,
    },
    new Map()
  );
  return {
    ...discover,
    yieldsPools: enrichedRows,
    integrators,
    issuer,
    usingProtocols,
    underlyingTokens,
    risk,
    webResearch,
    externalData,
    sourceNotes: buildPoolSourceNotes(externalData),
  };
}

async function resolveContext(input) {
  const parsed = parsePoolInput(input);
  if (parsed.kind === "address") {
    const byAddr = await discoverProtocolsForPoolAddress({
      chain: parsed.chain,
      address: parsed.address,
    });
    const allPools = await fetchYieldsPoolsCached();
    const yieldsRows = allPools.filter((p) => {
      const under = Array.isArray(p?.underlyingTokens) ? p.underlyingTokens : [];
      return (
        under.some((t) => String(t).toLowerCase() === parsed.address) ||
        String(p?.poolMeta || "")
          .toLowerCase()
          .includes(parsed.address)
      );
    });
    const integrators = findProtocolsSharingUnderlying(
      yieldsRows.length ? yieldsRows : [{ project: "unknown", underlyingTokens: [parsed.address] }],
      allPools
    );
    return {
      label: parsed.label,
      poolRef: `contract:${parsed.chain}:${parsed.address}`,
      chain: parsed.chain,
      address: parsed.address,
      yieldsRows: yieldsRows.length ? yieldsRows : [],
      underlyingTokens: tokensFromRows(yieldsRows, parsed.address),
      integrators,
      source: "address+yields",
    };
  }

  if (parsed.kind === "url") {
    const web = await discoverProtocolsForPoolWebsite(parsed.url, { expandUnderlying: false });
    const slug =
      web.matchedSlug ||
      (await defillamaSlugFromWebsite(parsed.url)) ||
      String(web.marketLabel || "").split(" ")[0];
    const allPools = await fetchYieldsPoolsCached();
    const pathHint = (() => {
      try {
        const u = new URL(parsed.url);
        return (u.pathname || "").split("/").filter(Boolean).pop()?.replace(/-pool|-vault/gi, " ") || "";
      } catch {
        return "";
      }
    })();
    const yieldsRows = allPools.filter((p) => {
      const proj = String(p?.project || "").toLowerCase();
      if (slug && proj === slug) return true;
      const hay = `${p?.symbol} ${p?.poolMeta} ${proj}`.toLowerCase();
      return pathHint && hay.includes(pathHint.toLowerCase());
    });
    let integrators = findProtocolsSharingUnderlying(
      yieldsRows.length ? yieldsRows : web.yieldsPools || [],
      allPools
    );
    if (!integrators.length && web.protocols?.length) {
      integrators = web.protocols.map((p) => ({
        ...p,
        tier: "issuer",
        link: "yields",
        totalTvlUsd: 0,
        yieldsPools: [],
      }));
    }
    const nonIssuer = integrators.filter((p) => p.tier !== "issuer");
    let webResearch = await gatherPoolWebResearch({
      poolLabel: web.marketLabel || parsed.url,
      poolUrl: parsed.url,
      issuerSlug: slug,
    }).catch(() => null);
    if (webResearch?.formatted) {
      const mentions = await discoverIntegratorsFromWebResearch(webResearch, {
        issuerSlug: slug,
        poolLabel: web.marketLabel || parsed.url,
      });
      integrators = mergeWebMentionIntegrators(integrators, mentions);
    }
    if (webResearch?.addresses?.length) {
      const chainHint = normalizeChain((yieldsRows[0] || web.yieldsPools?.[0])?.chain || "ethereum");
      integrators = await augmentIntegratorsFromCrawlAddresses(
        integrators,
        webResearch.addresses,
        chainHint
      );
    }
    const usingCount = filterUsingIntegrators(integrators).length;
    if (llmEnabled() && usingCount < 8) {
      const llm = await discoverPoolIntegratorsWithLlm({
        poolLabel: web.marketLabel || parsed.url,
        poolUrl: parsed.url,
        issuerSlug: slug,
        yieldsRows: yieldsRows.length ? yieldsRows : web.yieldsPools || [],
        webResearch,
      });
      webResearch = llm.webResearch || webResearch;
      integrators = mergeLlmIntegrators(integrators, llm);
    }
    return {
      label: web.marketLabel || parsed.url,
      poolRef: slug ? `yieldpool:${slug}:${pathHint || "pool"}` : `market:${web.marketLabel}`,
      url: parsed.url,
      issuerSlug: slug,
      yieldsRows,
      underlyingTokens: tokensFromRows(yieldsRows, null),
      integrators,
      webResearch,
      source: web.source || "url+yields+web",
    };
  }

  const market = await discoverProtocolsForYieldsMarket({
    project: parsed.project || parsed.query,
    symbolHint: parsed.symbolHint || "",
  });
  const allPools = await fetchYieldsPoolsCached();
  let integrators = findProtocolsSharingUnderlying(market.yieldsPools || [], allPools);
  const slug = String(parsed.project || parsed.query || "").toLowerCase();
  let webResearch = null;
  const poolUrl =
    /^https?:\/\//i.test(String(parsed.query || "")) ? String(parsed.query).trim() : null;
  if (poolUrl) {
    webResearch = await gatherPoolWebResearch({
      poolLabel: market.marketLabel || parsed.label,
      poolUrl,
      issuerSlug: slug,
    }).catch(() => null);
    if (webResearch?.formatted) {
      const mentions = await discoverIntegratorsFromWebResearch(webResearch, { issuerSlug: slug });
      integrators = mergeWebMentionIntegrators(integrators, mentions);
    }
  }
  const usingCount = filterUsingIntegrators(integrators).length;
  if (llmEnabled() && (poolUrl || usingCount < 6)) {
    const llm = await discoverPoolIntegratorsWithLlm({
      poolLabel: market.marketLabel || parsed.label,
      poolUrl,
      issuerSlug: slug,
      yieldsRows: market.yieldsPools || [],
      webResearch,
    });
    webResearch = llm.webResearch || webResearch;
    integrators = mergeLlmIntegrators(integrators, llm);
  }
  return {
    label: market.marketLabel || parsed.label,
    poolRef: `market:${market.marketLabel}`,
    yieldsRows: market.yieldsPools || [],
    underlyingTokens: tokensFromRows(market.yieldsPools || [], null),
    integrators,
    webResearch,
    source: "yields_market",
  };
}

function tokensFromRows(rows, extraAddr) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const t of Array.isArray(row?.underlyingTokens) ? row.underlyingTokens : []) {
      const a = String(t || "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(a) || seen.has(a)) continue;
      seen.add(a);
      out.push({
        address: a,
        chain: normalizeChain(row?.chain),
        symbol: row?.symbol || null,
        label: row?.symbol || a.slice(0, 10),
      });
    }
  }
  if (extraAddr && /^0x[a-f0-9]{40}$/.test(extraAddr) && !seen.has(extraAddr)) {
    out.push({ address: extraAddr, chain: "ethereum", symbol: null, label: extraAddr.slice(0, 10) });
  }
  return out;
}

function buildConnectionsGraph(ctx) {
  const poolId = String(ctx.poolRef || "pool:root").toLowerCase();
  const nodes = [{ id: poolId, kind: "pool", label: ctx.label || "Pool", type: "yield_pool" }];
  const edges = [];
  const graphProtocols = [
    ...ctx.integrators.filter((p) => p.tier === "issuer"),
    ...filterUsingIntegrators(ctx.integrators),
  ];
  const seenGraph = new Set();
  for (const p of graphProtocols) {
    const pid = p.id.startsWith("defillama:") ? p.id : `defillama:${p.id}`;
    if (seenGraph.has(pid)) continue;
    seenGraph.add(pid);
    nodes.push({ id: pid, kind: "protocol", label: p.name || pid, type: "protocol" });
    edges.push({
      from: poolId,
      to: pid,
      relation: p.relationship || p.link || "integrator",
      evidence: [p.link || "pool_intelligence"],
    });
  }
  for (const t of ctx.underlyingTokens || []) {
    if (!t?.address) continue;
    const addr = String(t.address).toLowerCase();
    nodes.push({
      id: addr,
      kind: "token",
      label: t.symbol || t.label,
      type: "token",
      address: addr,
      network: t.chain || "ethereum",
      symbol: t.symbol,
    });
    edges.push({ from: poolId, to: addr, relation: "underlying", evidence: ["defillama_yields"] });
  }
  return { nodes, edges };
}

function buildPoolRisk(ctx, protocolDetails) {
  const integrators = ctx.integrators || [];
  const issuer = integrators.filter((p) => p.tier === "issuer");
  const others = filterUsingIntegrators(integrators);
  const rows = ctx.yieldsRows || [];
  const maxApy = rows.reduce((m, r) => Math.max(m, Number(r?.apy) || 0), 0);
  const ilRisks = [...new Set(rows.map((r) => r?.ilRisk).filter(Boolean))];

  const issuerSlug = ctx.issuerSlug || issuer[0]?.id?.replace(/^defillama:/i, "");
  const issuerDetail = issuerSlug ? protocolDetails.get(issuerSlug) : null;
  const poolRubric = buildPoolRiskAssessment(ctx, {
    protocolListedAt: issuerDetail?.listedAt ?? issuerDetail?.listedAtTimestamp ?? null,
  });

  const perProtocol = [];
  for (const p of integrators.slice(0, 24)) {
    const slug = p.id.replace(/^defillama:/i, "");
    const detail = protocolDetails.get(slug);
    const tvl = detail?.tvl ?? p.totalTvlUsd;
    const rubric = buildHeuristicRiskAssessment({
      protocolName: p.name,
      url: p.url || detail?.url,
      analysis: {
        tvl: { valueUsd: typeof tvl === "number" ? tvl : p.totalTvlUsd },
        protocol: {
          name: detail?.name || p.name,
          audits: detail?.audits,
          auditsVerified: detail?.audits ? { count: detail.audits, firms: [] } : null,
        },
      },
    });
    perProtocol.push({
      id: p.id,
      name: p.name,
      tier: p.tier,
      link: p.link,
      overallTotal: rubric.overallTotal,
      sectionTotals: rubric.sectionTotals,
    });
  }

  const notes = [
    `${others.length} protocol(s) linked to this pool (docs, web search, DefiLlama).`,
    `${(ctx.underlyingTokens || []).length} underlying token(s) identified.`,
    `Pool type: ${poolRubric.poolType}. Methodology v${poolRubric.methodologyVersion}.`,
  ];
  if (poolRubric.weightApplied < 1) {
    notes.push(`${Math.round(poolRubric.weightApplied * 100)}% of criteria weighted (N/A / data gaps excluded).`);
  }

  return {
    pool: {
      ...poolRubric,
      integratorCount: others.length,
      issuerCount: issuer.length,
      maxApy,
      ilRisks,
      notes,
    },
    perProtocol,
  };
}

async function fetchProtocolDetails(integrators) {
  const map = new Map();
  await Promise.all(
    integrators.slice(0, 20).map(async (p) => {
      const slug = p.id.replace(/^defillama:/i, "");
      try {
        const d = await getDefiLlamaProtocolApiDetail(slug);
        if (d) map.set(slug, d);
      } catch {
        // ignore
      }
    })
  );
  return map;
}

async function enrichContextForScoring(ctx) {
  const externalData = await gatherPoolExternalData(ctx, { webResearch: ctx.webResearch }).catch((e) => ({
    enabled: false,
    error: String(e?.message || e),
    sources: [],
    scoringHints: {},
  }));
  const yieldsRows = applyExternalDataToYieldsRows(ctx.yieldsRows, externalData);
  return {
    ...ctx,
    yieldsRows,
    externalData,
    sourceNotes: buildPoolSourceNotes(externalData),
  };
}

export async function runPoolIntelligence(
  input,
  { persistNeo4j, persistLocal, upsertConnectionsGraphNeo4j, upsertProtocolGraphNeo4j, localGraphInit, upsertProtocolGraphLocal } = {}
) {
  const ctx = await enrichContextForScoring(await resolveContext(input));
  const protocolDetails = await fetchProtocolDetails(ctx.integrators);
  const risk = buildPoolRisk(ctx, protocolDetails);
  const connections = buildConnectionsGraph(ctx);

  const persisted = { neo4j: false, local: false, errors: [] };
  const rootSlug = ctx.issuerSlug || ctx.integrators?.[0]?.id?.replace(/^defillama:/i, "") || "pool";
  const rootProtocolId = `defillama:${rootSlug}`;

  if (persistLocal && upsertProtocolGraphLocal) {
    try {
      if (localGraphInit) await localGraphInit().catch(() => {});
      await upsertProtocolGraphLocal({
        protocol: { id: rootProtocolId, name: ctx.label, url: ctx.url || null, defillamaSlug: rootSlug },
        connections,
        extra: {
          protocol: {
            poolIntelligence: { at: new Date().toISOString(), integrators: ctx.integrators, underlying: ctx.underlyingTokens },
            poolsFromYields: ctx.yieldsRows,
          },
        },
      });
      persisted.local = true;
    } catch (e) {
      persisted.errors.push(`local: ${e?.message || e}`);
    }
  }

  if (persistNeo4j && upsertProtocolGraphNeo4j) {
    try {
      await upsertProtocolGraphNeo4j({
        protocol: { id: rootProtocolId, name: ctx.label, url: ctx.url || null, defillamaSlug: rootSlug },
        connections,
        extra: { poolIntelligence: ctx },
      });
      if (upsertConnectionsGraphNeo4j) {
        await upsertConnectionsGraphNeo4j({
          rootProtocolId,
          subjectProtocolId: rootProtocolId,
          connections,
        });
      }
      persisted.neo4j = true;
    } catch (e) {
      persisted.errors.push(formatNeo4jErrorForUser(e));
    }
  }

  const graph = {
    ref: ctx.poolRef,
    nodes: connections.nodes.map((n) => {
      if (n.kind === "protocol") return { ref: n.id, kind: "protocol", label: n.label || n.id };
      if (n.kind === "token") {
        const ch = normalizeChain(n.network);
        return { ref: `token:${ch}:${n.address || n.id}`, kind: "token", label: n.label || n.id };
      }
      return { ref: n.id, kind: "yield_pool", label: n.label || n.id };
    }),
    edges: connections.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
  };

  return {
    ok: true,
    label: ctx.label,
    poolRef: ctx.poolRef,
    source: ctx.source,
    underlyingTokens: ctx.underlyingTokens,
    integrators: ctx.integrators,
    issuer: (ctx.integrators || []).filter((p) => p.tier === "issuer"),
    usingProtocols: filterUsingIntegrators(ctx.integrators),
    yieldsPools: ctx.yieldsRows,
    risk,
    graph,
    connections,
    persisted,
    webResearch: ctx.webResearch || null,
    externalData: ctx.externalData || null,
    sourceNotes: ctx.sourceNotes || [],
  };
}
