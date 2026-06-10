/**
 * Pool / vault address parsing and placeholder filtering (shared across discovery + scoring).
 */
import { parseProtocolPoolUrl } from "./protocolUrlParse.js";

const PLACEHOLDER_EXACT = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  ].map((a) => a.toLowerCase())
);

/** Major assets — only used as underlyings when pool symbol implies them (see underlyingForIntegratorSearch). */
export const GENERIC_UNDERLYING = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
  ].map((a) => a.toLowerCase())
);

export function normalizePoolChain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "ethereum";
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("optimism") || s === "op") return "optimism";
  if (s.includes("base")) return "base";
  if (s.includes("polygon") || s.includes("matic")) return "polygon";
  if (s.includes("avalanche") || s.includes("avax")) return "avalanche";
  if (s.includes("bsc") || s.includes("bnb")) return "bsc";
  if (s.includes("hyperliquid")) return "hyperliquid_l1";
  return s.replace(/[^a-z0-9_-]+/g, "_").slice(0, 24) || "ethereum";
}

/** Zero address, native sentinel, or ≥36 zero nibbles (UI placeholders like 0x00000000…). */
export function isPlaceholderAddress(addr) {
  const a = String(addr || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return true;
  if (PLACEHOLDER_EXACT.has(a)) return true;
  if (GENERIC_UNDERLYING.has(a)) return true;
  const body = a.slice(2);
  const zeros = (body.match(/0/g) || []).length;
  return zeros >= 36;
}

export function filterRealAddresses(addrs) {
  return [...new Set((addrs || []).map((a) => String(a).toLowerCase()))].filter(
    (a) => /^0x[a-f0-9]{40}$/.test(a) && !isPlaceholderAddress(a)
  );
}

/**
 * Parse pool marketing URL: vault contract, market id, chain, protocol kind.
 */
export function extractPoolTargetFromUrl(rawUrl) {
  return parseProtocolPoolUrl(rawUrl);
}

export function yieldsRowMatchesVault(row, addr, chain = null) {
  const a = String(addr || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return false;
  const meta = String(row?.poolMeta || "").toLowerCase();
  const poolId = String(row?.pool || "").toLowerCase();
  const under = (Array.isArray(row?.underlyingTokens) ? row.underlyingTokens : []).map((t) =>
    String(t || "").toLowerCase()
  );
  const hit = under.includes(a) || meta.includes(a) || poolId.includes(a);
  if (!hit) return false;
  if (chain) {
    const want = normalizePoolChain(chain);
    const got = normalizePoolChain(row?.chain);
    if (want && got && want !== got && want !== "ethereum") return false;
  }
  return true;
}

export function filterYieldsRowsByVault(rows, addr, chain = null) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => yieldsRowMatchesVault(r, addr, chain));
  return [...list].sort((a, b) => scoreYieldsRowForVault(b, addr) - scoreYieldsRowForVault(a, addr));
}

function scoreYieldsRowForVault(row, addr) {
  const a = String(addr).toLowerCase();
  let score = Number(row?.tvlUsd) || 0;
  const meta = String(row?.poolMeta || "").toLowerCase();
  const poolId = String(row?.pool || "").toLowerCase();
  if (meta.includes(a)) score += 1e12;
  if (poolId.includes(a)) score += 5e11;
  return score;
}

export function rowMatchesNameHint(row, nameHint) {
  const h = String(nameHint || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  if (!h || h.length < 3) return false;
  const hay = `${row?.symbol || ""} ${row?.poolMeta || ""} ${row?.project || ""}`.toLowerCase();
  const parts = h.split(/\s+/).filter((p) => p.length > 2);
  return parts.some((p) => hay.includes(p));
}

/**
 * Pick the DefiLlama yields row for this specific vault (not highest-TVL sibling pool).
 */
export function selectPrimaryYieldsRow(rows, { vaultAddress = null, chain = null, nameHint = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const vault = vaultAddress ? String(vaultAddress).toLowerCase() : null;
  if (vault && /^0x[a-f0-9]{40}$/.test(vault)) {
    let hits = filterYieldsRowsByVault(list, vault, chain);
    if (!hits.length) hits = filterYieldsRowsByVault(list, vault, null);
    if (hits.length) {
      if (nameHint) {
        const named = hits.filter((r) => rowMatchesNameHint(r, nameHint));
        if (named.length) return named[0];
      }
      return hits[0];
    }
  }

  if (nameHint) {
    const named = list.filter((r) => rowMatchesNameHint(r, nameHint));
    if (named.length) {
      return [...named].sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))[0];
    }
  }

  return [...list].sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))[0];
}

export function derivePoolLabel({ yieldsRows = [], vaultAddress = null, chain = null, nameHint = null, fallback = "" } = {}) {
  const row = selectPrimaryYieldsRow(yieldsRows, { vaultAddress, chain, nameHint });
  if (row) {
    const sym = String(row.symbol || "").trim();
    const proj = String(row.project || "").trim();
    if (sym && proj && sym.toLowerCase() !== proj.toLowerCase()) return `${sym} · ${proj}`;
    if (sym) return sym;
    if (proj) return proj;
  }
  if (nameHint) return nameHint;
  return String(fallback || "").trim() || "Pool";
}
