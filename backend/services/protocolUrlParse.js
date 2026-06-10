/**
 * Protocol-specific pool URL parsing (Aave, Morpho, Compound, Pendle, Spark, etc.).
 */
import { filterRealAddresses, isPlaceholderAddress, normalizePoolChain } from "./poolAddress.js";

const CHAIN_SEGMENTS = {
  ethereum: "ethereum",
  mainnet: "ethereum",
  arbitrum: "arbitrum",
  optimism: "optimism",
  op: "optimism",
  base: "base",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};

function humanizeSegment(seg) {
  return String(seg || "")
    .replace(/-pool$/i, "")
    .replace(/-vault$/i, "")
    .replace(/\.html?$/i, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chainFromAaveMarketName(marketName) {
  const m = String(marketName || "").toLowerCase();
  if (m.includes("base")) return "base";
  if (m.includes("arb") || m.includes("arbitrum")) return "arbitrum";
  if (m.includes("op") || m.includes("optimism")) return "optimism";
  if (m.includes("polygon") || m.includes("matic")) return "polygon";
  if (m.includes("avalanche") || m.includes("avax")) return "avalanche";
  return "ethereum";
}

function chainFromCompoundSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (s.endsWith("-op") || s.includes("optimism")) return "optimism";
  if (s.endsWith("-arb") || s.includes("arbitrum")) return "arbitrum";
  if (s.endsWith("-base") || s.includes("base")) return "base";
  if (s.endsWith("-poly") || s.includes("polygon")) return "polygon";
  return "ethereum";
}

function isBytes32Hex(s) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(s || ""));
}

function isEvmAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s || "")) && !isPlaceholderAddress(s);
}

/** Query-param asset addresses (DAI/USDC/WETH) are valid pool identifiers. */
function isUnderlyingParamAddress(s) {
  const a = String(s || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return false;
  if (a === "0x0000000000000000000000000000000000000000") return false;
  if (a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return false;
  return true;
}

/** Solana base58 pubkey (32–44 chars). */
function extractSolanaAddress(hay) {
  const m = String(hay || "").match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
  return m?.[1] || null;
}

/**
 * @returns {import('./poolAddress.js').PoolUrlTarget & { marketId?: string, underlyingAsset?: string, issuerSlug?: string, protocolKind?: string, marketSlug?: string, solanaAddress?: string }}
 */
export function parseProtocolPoolUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  const out = {
    url,
    vaultAddress: null,
    marketId: null,
    underlyingAsset: null,
    chain: null,
    nameHint: null,
    issuerSlug: null,
    protocolKind: null,
    marketSlug: null,
    solanaAddress: null,
  };
  if (!/^https?:\/\//i.test(url)) return out;

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = decodeURIComponent(u.pathname || "");
    const parts = path.split("/").filter(Boolean);
    const search = decodeURIComponent(`${u.search || ""}${u.hash || ""}`);
    const hay = `${path} ${search}`;

    // --- Aave reserve overview ---
    if (host === "app.aave.com" && path.includes("reserve-overview")) {
      const underlying = u.searchParams.get("underlyingAsset");
      const marketName = u.searchParams.get("marketName") || "";
      if (isUnderlyingParamAddress(underlying)) {
        out.underlyingAsset = underlying.toLowerCase();
        out.vaultAddress = underlying.toLowerCase();
        out.chain = chainFromAaveMarketName(marketName);
        out.issuerSlug = /v3/i.test(marketName) ? "aave-v3" : "aave";
        out.protocolKind = "aave_reserve";
        out.nameHint = out.nameHint || "reserve";
      }
    }

    // --- Spark (Aave-fork style markets/{chainId}/{underlying}) ---
    if (host.includes("spark.fi") && parts[0] === "markets" && parts.length >= 3) {
      const chainId = Number(parts[1]);
      const chainMap = { 1: "ethereum", 42161: "arbitrum", 10: "optimism", 8453: "base", 137: "polygon" };
      const asset = parts[2];
      if (isUnderlyingParamAddress(asset)) {
        out.underlyingAsset = asset.toLowerCase();
        out.vaultAddress = asset.toLowerCase();
        out.chain = chainMap[chainId] || "ethereum";
        out.issuerSlug = "spark";
        out.protocolKind = "spark_reserve";
      }
    }

    // --- Morpho vault or market ---
    if (host === "app.morpho.org" && parts.length >= 3) {
      const chainSeg = parts[0];
      const kind = parts[1];
      const id = parts[2];
      out.chain = CHAIN_SEGMENTS[chainSeg.toLowerCase()] || normalizePoolChain(chainSeg);
      out.issuerSlug = "morpho";
      if (kind === "vault" && isEvmAddress(id)) {
        out.vaultAddress = id.toLowerCase();
        out.protocolKind = "morpho_vault";
        out.nameHint = humanizeSegment(parts[3]) || null;
      } else if (kind === "market" && isBytes32Hex(id)) {
        out.marketId = id.toLowerCase();
        out.protocolKind = "morpho_market";
        out.nameHint = humanizeSegment(parts[3]) || null;
      }
    }

    // --- Pendle ---
    if (host.includes("pendle.finance")) {
      out.issuerSlug = "pendle";
      out.protocolKind = "pendle_market";
      const chainParam = u.searchParams.get("chain");
      if (chainParam) out.chain = normalizePoolChain(chainParam);
      const addrs = filterRealAddresses([...hay.matchAll(/0x[a-fA-F0-9]{40}/gi)].map((m) => m[0]));
      if (addrs.length) out.vaultAddress = addrs.find((a) => path.toLowerCase().includes(a)) || addrs[0];
      out.nameHint = out.nameHint || humanizeSegment(parts[parts.length - 1]) || null;
    }

    // --- Compound markets/{slug} ---
    if (host.includes("compound.finance") && parts[0] === "markets" && parts[1]) {
      out.marketSlug = parts[1].toLowerCase();
      out.chain = chainFromCompoundSlug(out.marketSlug);
      out.issuerSlug = "compound";
      out.protocolKind = "compound_market";
      out.nameHint = out.marketSlug.replace(/-/g, " ");
    }

    // --- Hyperliquid vault ---
    if (host.includes("hyperliquid.xyz") && parts[0] === "vaults" && isEvmAddress(parts[1])) {
      out.vaultAddress = parts[1].toLowerCase();
      out.chain = "hyperliquid_l1";
      out.issuerSlug = "hyperliquid";
      out.protocolKind = "hyperliquid_vault";
    }

    // --- Maple earn ---
    if (host.includes("maple.finance")) {
      out.issuerSlug = "maple-finance";
      out.protocolKind = "maple_pool";
      out.chain = out.chain || "ethereum";
      if (/syrupusdc/i.test(hay)) out.nameHint = "syrupUSDC";
      else if (parts[0] === "earn" || !parts.length) out.nameHint = "syrupUSDC";
      else out.nameHint = out.nameHint || humanizeSegment(parts[parts.length - 1]) || "maple pool";
    }

    // --- Fluid lending ---
    if (host.includes("fluid.io")) {
      out.issuerSlug = "fluid";
      out.protocolKind = "fluid_lending";
      const chainNum = Number(parts[1]);
      const chainFromNum = { 1: "ethereum", 42161: "arbitrum", 8453: "base" };
      out.chain = chainFromNum[chainNum] || out.chain || "ethereum";
      if (/wsteth/i.test(hay)) out.nameHint = "wstETH";
      else if (parts[0] === "lending") out.nameHint = "wstETH";
    }

    // --- Kamino (Solana) ---
    if (host.includes("kamino.com")) {
      out.issuerSlug = "kamino";
      out.protocolKind = "kamino_vault";
      out.chain = "solana";
      out.solanaAddress = extractSolanaAddress(hay);
      const slugSeg = parts.find((p) => /steakhouse|usdc|vault|lend/i.test(p) && p.includes("-"));
      out.nameHint = slugSeg || parts.find((p) => /steakhouse/i.test(p)) || humanizeSegment(parts[parts.length - 1]);
    }

    // Generic 0x fallback when not set
    if (!out.vaultAddress && !out.marketId) {
      const found = filterRealAddresses([...hay.matchAll(/0x[a-fA-F0-9]{40}/gi)].map((m) => m[0]));
      if (found.length) {
        const inPath = found.filter((a) => path.toLowerCase().includes(a));
        out.vaultAddress = (inPath.length ? inPath[inPath.length - 1] : found[found.length - 1]).toLowerCase();
      }
    }

    if (!out.chain && out.vaultAddress) {
      const chainInUrl = hay.match(/(ethereum|arbitrum|optimism|base|polygon|avalanche|bsc)/i);
      if (chainInUrl) out.chain = normalizePoolChain(chainInUrl[1]);
      else if (u.searchParams.get("chain")) out.chain = normalizePoolChain(u.searchParams.get("chain"));
    }

    if (!out.nameHint) {
      const nameSegs = parts.filter(
        (s) => !/^0x[a-fA-F0-9]{40}$/i.test(s) && !isBytes32Hex(s) && !/^\d+$/.test(s)
      );
      const hints = nameSegs.map(humanizeSegment).filter((s) => s.length > 2);
      out.nameHint = hints.length ? hints[hints.length - 1] : null;
    }
  } catch {
    // ignore
  }

  return out;
}
