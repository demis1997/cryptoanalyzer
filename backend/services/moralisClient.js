import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";

const MORALIS_CHAIN = {
  ethereum: "eth",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  polygon: "polygon",
  bsc: "bsc",
  avalanche: "avalanche",
};

function enabled() {
  return Boolean(String(process.env.MORALIS_API_KEY || "").trim());
}

function moralisChain(chain) {
  return MORALIS_CHAIN[normalizePoolChain(chain)] || "eth";
}

async function moralisGet(path, params = {}) {
  const key = String(process.env.MORALIS_API_KEY || "").trim();
  if (!key) return null;
  const qs = new URLSearchParams(params).toString();
  const url = `https://deep-index.moralis.io/api/v2.2${path}${qs ? `?${qs}` : ""}`;
  try {
    const resp = await fetch(url, {
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
    if (!resp.ok) return { ok: false, status: resp.status, error: `http_${resp.status}` };
    const json = await resp.json().catch(() => ({}));
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** ERC-20 metadata (name, symbol, decimals) via Moralis. */
export async function moralisErc20Metadata(address, chain = "ethereum") {
  if (!enabled()) return null;
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const r = await moralisGet("/erc20/metadata", {
    chain: moralisChain(chain),
    addresses: JSON.stringify([addr]),
  });
  if (!r?.ok) return null;
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row) return null;
  return {
    address: addr,
    chain: normalizePoolChain(chain),
    symbol: row.symbol || null,
    name: row.name || null,
    decimals: typeof row.decimals === "number" ? row.decimals : null,
    source: "moralis",
  };
}

/** USD price for ERC-20 contract. */
export async function moralisTokenPriceUsd(address, chain = "ethereum") {
  if (!enabled()) return null;
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const r = await moralisGet(`/erc20/${addr}/price`, { chain: moralisChain(chain) });
  if (!r?.ok) return null;
  const usd = Number(r.json?.usdPrice);
  if (!isFinite(usd) || usd <= 0) return null;
  return { usdPrice: usd, source: "moralis", address: addr };
}

/** Token balance of a contract address (vault contract balance in underlying). */
export async function moralisWalletTokenBalances(address, chain = "ethereum") {
  if (!enabled()) return null;
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const r = await moralisGet(`/${addr}/erc20`, { chain: moralisChain(chain) });
  if (!r?.ok) return null;
  return { tokens: Array.isArray(r.json) ? r.json : [], source: "moralis" };
}
