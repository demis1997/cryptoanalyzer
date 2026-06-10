/**
 * Resolve vault address + pool URL from a plain-text query (no 0x, no URL).
 * Web search → protocol pages → address extraction.
 */
import { searchWeb } from "./webResearch.js";
import { extractPoolTargetFromUrl, filterRealAddresses } from "./poolAddress.js";
import { fetchMorphoVaultByAddress } from "./morphoVault.js";

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_TEXT_RESOLVE || "1").trim());
}

function guessIssuerSlug(query) {
  const q = String(query || "").toLowerCase();
  if (/morpho|steakusdc|steakhouse|metamorpho/i.test(q)) return "morpho";
  if (/pendle|pt-/i.test(q)) return "pendle";
  if (/aave/i.test(q)) return "aave";
  if (/euler/i.test(q)) return "euler";
  if (/compound/i.test(q)) return "compound";
  if (/curve/i.test(q)) return "curve";
  return null;
}

/**
 * @returns {{ vaultAddress, chain, poolUrl, nameHint, issuerSlug, webResearch, source }}
 */
export async function resolvePoolFromTextQuery(query, { trace = null } = {}) {
  const q = String(query || "").trim();
  const out = {
    vaultAddress: null,
    chain: null,
    poolUrl: null,
    nameHint: q,
    issuerSlug: guessIssuerSlug(q),
    webResearch: null,
    source: null,
  };
  if (!q || q.length < 2 || !enabled()) return out;

  trace?.step?.("Text query → web search for pool address", { detail: q, kind: "source" });

  const slug = out.issuerSlug;
  const queries = [
    `"${q}" DeFi vault pool contract address`,
    slug ? `site:app.morpho.org OR site:morpho.org "${q}"` : null,
    slug === "pendle" ? `site:app.pendle.finance "${q}" market` : null,
    slug ? `${slug} ${q} vault 0x ethereum arbitrum base` : null,
    `${q} pool TVL total liquidity vault address`,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_TEXT_SEARCH_QUERIES || 4) || 4;
  const searches = [];
  const candidateUrls = [];
  const candidateAddrs = new Map();

  for (const searchQ of [...new Set(queries)].slice(0, maxQ)) {
    const s = await searchWeb(searchQ, { maxResults: 6 });
    searches.push(s);
    for (const h of s.hits || []) {
      const url = String(h.url || "");
      if (/morpho\.org|pendle\.finance|aave\.com|euler\.finance|curve\.fi|defillama\.com\/yields/i.test(url)) {
        candidateUrls.push(url);
      }
      const addrs = filterRealAddresses([...String(`${h.title} ${h.snippet} ${url}`).matchAll(/0x[a-fA-F0-9]{40}/g)].map((m) => m[0]));
      for (const a of addrs) {
        candidateAddrs.set(a.toLowerCase(), (candidateAddrs.get(a.toLowerCase()) || 0) + 1);
      }
      if (/^https?:\/\//i.test(url)) {
        const target = extractPoolTargetFromUrl(url);
        if (target.vaultAddress) {
          candidateAddrs.set(target.vaultAddress, (candidateAddrs.get(target.vaultAddress) || 0) + 5);
          if (target.chain) out.chain = out.chain || target.chain;
        }
        if (target.url && !out.poolUrl) out.poolUrl = target.url;
      }
    }
  }

  out.poolUrl = out.poolUrl || candidateUrls.find((u) => /app\.|vault|pool|market|earn/i.test(u)) || candidateUrls[0] || null;

  if (out.poolUrl) {
    const target = extractPoolTargetFromUrl(out.poolUrl);
    if (target.vaultAddress) candidateAddrs.set(target.vaultAddress, (candidateAddrs.get(target.vaultAddress) || 0) + 10);
    if (target.chain) out.chain = out.chain || target.chain;
    if (target.nameHint) out.nameHint = target.nameHint;
  }

  const sortedAddrs = [...candidateAddrs.entries()].sort((a, b) => b[1] - a[1]);
  for (const [addr] of sortedAddrs.slice(0, 5)) {
    if (slug === "morpho" || /morpho|steak|vault/i.test(q)) {
      for (const chain of [out.chain || "ethereum", "base", "arbitrum"]) {
        const morpho = await fetchMorphoVaultByAddress(addr, chain).catch(() => null);
        if (morpho?.address) {
          out.vaultAddress = morpho.address.toLowerCase();
          out.chain = chain;
          out.source = "text_search+morpho_api";
          if (!out.poolUrl) out.poolUrl = `https://app.morpho.org/${chain}/vault/${out.vaultAddress}`;
          trace?.step?.("Vault resolved via Morpho API", {
            kind: "source",
            detail: `${morpho.symbol || morpho.name} · ${out.vaultAddress.slice(0, 10)}…`,
          });
          break;
        }
      }
    }
    if (out.vaultAddress) break;
    out.vaultAddress = addr;
    out.source = "text_search+address_extract";
  }

  const lines = [];
  for (const s of searches) {
    lines.push(`\n### Text resolve search (${s.provider}): ${s.query}`);
    if (s.answer) lines.push(`Summary: ${s.answer}`);
    for (const h of (s.hits || []).slice(0, 4)) {
      lines.push(`- ${h.title} | ${h.url}`);
    }
  }
  out.webResearch = { enabled: true, searches, formatted: lines.join("\n").trim(), providers: [...new Set(searches.map((s) => s.provider))] };

  if (out.vaultAddress) {
    trace?.step?.("Pool address from text search", {
      kind: "source",
      detail: `${out.chain || "ethereum"}:${out.vaultAddress.slice(0, 10)}…${out.poolUrl ? ` · ${out.poolUrl}` : ""}`,
    });
  } else {
    trace?.step?.("Pool address not found from text", {
      kind: "info",
      detail: "Paste pool dashboard URL or 0x address · set TAVILY_API_KEY",
    });
  }

  return out;
}
