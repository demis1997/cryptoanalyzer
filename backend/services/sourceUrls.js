/**
 * Specific source URLs for activity logs and scoring criterion citations.
 */
import { explorerAddressUrl, explorerInternalTxUrl, explorerTxUrl } from "./etherscanClient.js";
import { normalizePoolChain } from "./poolAddress.js";

export { explorerAddressUrl, explorerInternalTxUrl, explorerTxUrl };

export function defillamaYieldsPoolUrl(poolId) {
  const id = String(poolId || "").trim();
  if (!id) return null;
  return `https://defillama.com/yields/pool/${encodeURIComponent(id)}`;
}

export function defillamaProtocolUrl(slug) {
  const s = String(slug || "").trim();
  if (!s) return null;
  return `https://defillama.com/protocol/${encodeURIComponent(s)}`;
}

export function theGraphSubgraphUrl(subgraphId) {
  const id = String(subgraphId || "").trim();
  if (!id) return null;
  return `https://thegraph.com/explorer/subgraphs/${id}`;
}

export function morphoGraphqlUrl() {
  return "https://api.morpho.org/graphql";
}

export function aaveGraphqlUrl() {
  return "https://api.v3.aave.com/graphql";
}

export function morphoMarketPageUrl(chain, marketId, slugHint = "") {
  const c = normalizePoolChain(chain);
  const id = String(marketId || "").toLowerCase();
  if (!id) return `https://app.morpho.org/${c}`;
  const slug = slugHint ? `/${slugHint}` : "";
  return `https://app.morpho.org/${c}/market/${id}${slug}`;
}

export function aaveReserveUrl(chain, underlyingAsset) {
  const addr = String(underlyingAsset || "").toLowerCase();
  const marketName = normalizePoolChain(chain) === "polygon" ? "proto_polygon_v3" : `proto_${normalizePoolChain(chain)}_v3`;
  if (!addr) return "https://app.aave.com/markets/";
  return `https://app.aave.com/reserve-overview/?underlyingAsset=${addr}&marketName=${marketName}`;
}

export function compoundMarketUrl(marketSlug) {
  const slug = String(marketSlug || "").trim();
  if (!slug) return "https://app.compound.finance/markets";
  return `https://app.compound.finance/markets/${encodeURIComponent(slug)}`;
}

export function pendlePoolUrl(chain, marketAddress) {
  const c = normalizePoolChain(chain);
  const addr = String(marketAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "https://app.pendle.finance/";
  const chainParam = c === "ethereum" ? "ethereum" : c;
  return `https://app.pendle.finance/trade/pools/${addr}?chain=${chainParam}`;
}

export function sparkReserveUrl(chain, underlyingAsset) {
  const c = normalizePoolChain(chain);
  const addr = String(underlyingAsset || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return "https://app.spark.fi/";
  return `https://app.spark.fi/markets/${c}/${addr}`;
}

export function morphoVaultUrl(chain, address) {
  const c = normalizePoolChain(chain);
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return `https://app.morpho.org/${c}`;
  return `https://app.morpho.org/${c}/vault/${addr}`;
}

export function duneSearchUrl(query) {
  const q = String(query || "").trim();
  if (!q) return "https://dune.com/search";
  return `https://dune.com/search?q=${encodeURIComponent(q)}`;
}
