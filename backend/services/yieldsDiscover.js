import fetch from "node-fetch";
import {
  extractPoolTargetFromUrl,
  filterYieldsRowsByVault,
  derivePoolLabel,
  isPlaceholderAddress,
  selectPrimaryYieldsRow,
  GENERIC_UNDERLYING,
} from "./poolAddress.js";
import { fullYieldsPoolRow } from "./yieldsPoolRow.js";

let cache = null;
let cacheAt = 0;
const TTL_MS = 5 * 60 * 1000;

function normalizeChainName(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "ethereum";
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("optimism")) return "optimism";
  if (s.includes("base")) return "base";
  if (s.includes("polygon") || s.includes("matic")) return "polygon";
  if (s.includes("avalanche") || s.includes("avax")) return "avalanche";
  if (s.includes("bsc") || s.includes("bnb")) return "bsc";
  return s.replace(/[^a-z0-9_-]+/g, "_").slice(0, 24) || "ethereum";
}

export async function fetchYieldsPoolsCached() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  const resp = await fetch("https://yields.llama.fi/pools", {
    headers: { "User-Agent": "cryptoanalyzer/yields-discover" },
  });
  if (!resp.ok) throw new Error(`yields.llama.fi/pools failed: ${resp.status}`);
  const json = await resp.json().catch(() => null);
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  cache = data;
  cacheAt = Date.now();
  return cache;
}

/**
 * Find yield pool rows and parent projects for an on-chain address (LP/vault token).
 */
export async function discoverProtocolsForPoolAddress({ chain = "ethereum", address } = {}) {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr) || isPlaceholderAddress(addr)) {
    return { protocols: [], yieldsPools: [] };
  }

  const pools = await fetchYieldsPoolsCached();
  const chainHint = normalizeChainName(chain);
  const matches = pools.filter((p) => {
    const under = Array.isArray(p?.underlyingTokens) ? p.underlyingTokens : [];
    const underHit = under.some((t) => String(t || "").toLowerCase() === addr);
    const metaHit = String(p?.poolMeta || "").toLowerCase().includes(addr);
    if (!underHit && !metaHit) return false;
    const pChain = normalizeChainName(p?.chain);
    return pChain === chainHint || chainHint === "ethereum" || !p?.chain;
  });

  const byProject = new Map();
  for (const row of matches) {
    const slug = String(row?.project || "").trim().toLowerCase();
    if (!slug) continue;
    const id = `defillama:${slug}`;
    if (!byProject.has(id)) {
      byProject.set(id, {
        id,
        name: slug,
        url: `https://defillama.com/protocol/${encodeURIComponent(slug)}`,
        source: "yields.llama.fi",
        pools: [],
      });
    }
    byProject.get(id).pools.push({
      symbol: row?.symbol || null,
      tvlUsd: typeof row?.tvlUsd === "number" ? row.tvlUsd : null,
      apy: typeof row?.apy === "number" ? row.apy : null,
      chain: row?.chain || null,
      exposure: row?.exposure || null,
    });
  }

  return {
    protocols: [...byProject.values()],
    yieldsPools: matches.slice(0, 30).map((r) => ({
      project: r?.project || null,
      symbol: r?.symbol || null,
      chain: r?.chain || null,
      tvlUsd: r?.tvlUsd ?? null,
      apy: r?.apy ?? null,
    })),
  };
}

const PROJECT_ALIASES = {
  morpho: ["morpho-blue", "morpho-aave", "morpho-compound"],
  avantis: ["avantis"],
};

let protocolsListCache = null;
let protocolsListCacheAt = 0;

export async function fetchDefillamaProtocolsCached() {
  if (protocolsListCache && Date.now() - protocolsListCacheAt < TTL_MS) return protocolsListCache;
  const resp = await fetch("https://api.llama.fi/protocols", {
    headers: { "User-Agent": "cryptoanalyzer/yields-discover" },
  });
  if (!resp.ok) throw new Error(`DefiLlama protocols failed: ${resp.status}`);
  protocolsListCache = await resp.json();
  protocolsListCacheAt = Date.now();
  return Array.isArray(protocolsListCache) ? protocolsListCache : [];
}

export async function defillamaSlugFromWebsite(rawUrl) {
  let host = "";
  try {
    host = new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const list = await fetchDefillamaProtocolsCached();
  const hit = list.find((p) => {
    const u = String(p?.url || "").toLowerCase();
    return u.includes(host);
  });
  return hit?.slug ? String(hit.slug).toLowerCase() : null;
}

function projectCandidates(project) {
  const p = String(project || "").trim().toLowerCase();
  const aliases = PROJECT_ALIASES[p] || [p];
  return [...new Set([p, ...aliases].filter(Boolean))];
}

function hintIsOnlyProjectName(hint, projects) {
  const h = String(hint || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  if (!h) return true;
  return projects.some((p) => h === p || h.startsWith(`${p} `) || p.startsWith(h.split(" ")[0] || ""));
}

function poolRowMatchesHint(row, hint, projects) {
  if (!hint || hintIsOnlyProjectName(hint, projects)) return true;
  const sym = String(row?.symbol || "").toLowerCase();
  const meta = String(row?.poolMeta || "").toLowerCase();
  const proj = String(row?.project || "").toLowerCase();
  if (sym.includes(hint) || meta.includes(hint) || proj.includes(hint)) return true;
  if (/vault/i.test(hint) && /vault/i.test(meta)) return true;
  if (/pool/i.test(hint) && (meta.includes("pool") || sym.includes("pool"))) return true;
  return false;
}

function mapYieldsPoolRow(r) {
  return fullYieldsPoolRow(r);
}

/**
 * Marketing URLs without 0x (e.g. morpho.org/usdt-pool) → DefiLlama yields rows + protocols per underlying token.
 */
export async function discoverProtocolsForYieldsMarket({ project, symbolHint = "", expandUnderlying = false } = {}) {
  const hint = String(symbolHint || "").trim().toLowerCase();
  const projects = projectCandidates(project);
  const pools = await fetchYieldsPoolsCached();
  let matches = pools.filter((p) => {
    const proj = String(p?.project || "").trim().toLowerCase();
    if (!projects.includes(proj)) return false;
    return poolRowMatchesHint(p, hint, projects);
  });
  if (!matches.length) {
    matches = pools.filter((p) => projects.includes(String(p?.project || "").trim().toLowerCase()));
  }

  const protocolMap = new Map();
  const addProtocol = (p, link = "yields") => {
    const id = String(p?.id || "").trim();
    if (!id) return;
    if (!protocolMap.has(id)) {
      protocolMap.set(id, {
        id,
        name: p.name || id,
        url: p.url || null,
        link,
        yieldsPools: Array.isArray(p.pools) ? [...p.pools] : [],
      });
    } else if (Array.isArray(p.pools)) {
      protocolMap.get(id).yieldsPools.push(...p.pools);
    }
  };

  for (const slug of projects) {
    addProtocol({
      id: `defillama:${slug}`,
      name: slug,
      url: `https://defillama.com/protocol/${slug}`,
      pools: matches
        .filter((r) => String(r?.project || "").toLowerCase() === slug)
        .map((r) => ({
          symbol: r?.symbol,
          tvlUsd: r?.tvlUsd,
          apy: r?.apy,
          chain: r?.chain,
        })),
    });
  }

  const related = [];
  if (expandUnderlying) {
    const seenAddr = new Set();
    for (const row of matches) {
      const under = Array.isArray(row?.underlyingTokens) ? row.underlyingTokens : [];
      for (const t of under) {
        const addr = String(t || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(addr) || seenAddr.has(addr) || GENERIC_UNDERLYING.has(addr)) continue;
        seenAddr.add(addr);
        const chain = normalizeChainName(row?.chain);
        const d = await discoverProtocolsForPoolAddress({ chain, address: addr }).catch(() => ({
          protocols: [],
        }));
        for (const p of d.protocols || []) {
          const id = String(p?.id || "").trim();
          if (!id || protocolMap.has(id)) continue;
          related.push({
            id,
            name: p.name || id,
            url: p.url || null,
            link: "underlying_token",
            yieldsPools: [],
          });
        }
      }
    }
  }

  const primary = [...protocolMap.values()].map((p) => ({ ...p, tier: "primary" }));
  const protocols = [...primary, ...related.slice(0, 12).map((p) => ({ ...p, tier: "related" }))];

  return {
    protocols,
    primary,
    related: related.slice(0, 12),
    yieldsPools: matches.slice(0, 40).map(mapYieldsPoolRow),
    marketLabel: hint ? `${project} · ${symbolHint}` : String(project),
  };
}

/**
 * Pool marketing site with no DB row — match DefiLlama protocol by domain, then yields pools live.
 */
export async function discoverProtocolsForPoolWebsite(
  rawUrl,
  { expandUnderlying = false, vaultAddress = null, chain = null, nameHint = null } = {}
) {
  let u = null;
  try {
    u = new URL(String(rawUrl || "").trim());
  } catch {
    return { ok: false, error: "Bad URL", protocols: [], yieldsPools: [] };
  }

  const fromUrl = extractPoolTargetFromUrl(rawUrl);
  const vault = (vaultAddress || fromUrl.vaultAddress || "").toLowerCase();
  const chainHint = chain || fromUrl.chain;
  const pathHint = nameHint || fromUrl.nameHint || "";

  const pools = await fetchYieldsPoolsCached();
  if (vault && /^0x[a-f0-9]{40}$/.test(vault)) {
    let matches = filterYieldsRowsByVault(pools, vault, chainHint);
    if (!matches.length) matches = filterYieldsRowsByVault(pools, vault, null);
    const primary = selectPrimaryYieldsRow(matches, { vaultAddress: vault, chain: chainHint, nameHint: pathHint });
    const slug = primary?.project || (await defillamaSlugFromWebsite(rawUrl));
    const marketLabel = derivePoolLabel({
      yieldsRows: matches,
      vaultAddress: vault,
      chain: chainHint,
      nameHint: pathHint,
      fallback: pathHint || vault.slice(0, 10),
    });
    const protocolMap = new Map();
    if (slug) {
      protocolMap.set(`defillama:${slug}`, {
        id: `defillama:${slug}`,
        name: slug,
        url: `https://defillama.com/protocol/${slug}`,
        link: "yields_vault",
        tier: "issuer",
        yieldsPools: matches.slice(0, 12).map((r) => ({
          symbol: r?.symbol,
          tvlUsd: r?.tvlUsd,
          apy: r?.apy,
          chain: r?.chain,
        })),
      });
    }
    return {
      ok: true,
      source: "yields_vault_address",
      matchedSlug: slug || null,
      vaultAddress: vault,
      protocols: [...protocolMap.values()],
      primary: [...protocolMap.values()],
      related: [],
      yieldsPools: matches.slice(0, 40).map(mapYieldsPoolRow),
      marketLabel,
    };
  }

  const slug = await defillamaSlugFromWebsite(rawUrl);
  if (slug) {
    const r = await discoverProtocolsForYieldsMarket({
      project: slug,
      symbolHint: pathHint || "",
      expandUnderlying,
    });
    if (pathHint && r.yieldsPools?.length > 1) {
      const narrowed = r.yieldsPools.filter((row) => poolRowMatchesHint(row, pathHint, projectCandidates(slug)));
      if (narrowed.length) {
        r.yieldsPools = narrowed;
        r.marketLabel = derivePoolLabel({
          yieldsRows: narrowed,
          nameHint: pathHint,
          fallback: r.marketLabel,
        });
      }
    }
    return { ok: true, source: "defillama_protocols+yields", matchedSlug: slug, ...r };
  }

  // Unknown domain: search yields by path keywords (no Neo4j / DB required)
  const keywords = [pathHint, u.hostname.replace(/^www\./, "").split(".")[0]]
    .map((s) => String(s || "").trim().toLowerCase())
    .filter((s) => s && s.length > 2);

  const matches = pools.filter((p) => {
    const hay = `${p?.project || ""} ${p?.symbol || ""} ${p?.poolMeta || ""}`.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  });

  const byProject = new Map();
  for (const row of matches) {
    const proj = String(row?.project || "").trim().toLowerCase();
    if (!proj) continue;
    if (!byProject.has(proj)) {
      byProject.set(proj, {
        id: `defillama:${proj}`,
        name: proj,
        url: `https://defillama.com/protocol/${proj}`,
        link: "yields",
        tier: "primary",
        yieldsPools: [],
      });
    }
    byProject.get(proj).yieldsPools.push({
      symbol: row?.symbol,
      tvlUsd: row?.tvlUsd,
      apy: row?.apy,
      chain: row?.chain,
    });
  }

  const primary = [...byProject.values()]
    .sort((a, b) => {
      const ta = (a.yieldsPools || []).reduce((s, p) => s + (Number(p?.tvlUsd) || 0), 0);
      const tb = (b.yieldsPools || []).reduce((s, p) => s + (Number(p?.tvlUsd) || 0), 0);
      return tb - ta;
    })
    .slice(0, 8);

  return {
    ok: true,
    source: "yields_keyword",
    matchedSlug: null,
    protocols: primary,
    primary,
    related: [],
    yieldsPools: matches.slice(0, 30).map(mapYieldsPoolRow),
    marketLabel: pathHint || keywords[0] || "pool",
  };
}
