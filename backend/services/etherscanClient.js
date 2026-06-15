/**
 * Multi-chain block explorer API (Etherscan v2 unified endpoint).
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";

const EXPLORERS = {
  ethereum: { chainId: 1, host: "etherscan.io" },
  polygon: { chainId: 137, host: "polygonscan.com" },
  arbitrum: { chainId: 42161, host: "arbiscan.io" },
  optimism: { chainId: 10, host: "optimistic.etherscan.io" },
  base: { chainId: 8453, host: "basescan.org" },
};

const txCache = new Map();

function apiKey() {
  return String(process.env.ETHERSCAN_API_KEY || "").trim();
}

function explorerMeta(chain) {
  const c = normalizePoolChain(chain);
  return EXPLORERS[c] || EXPLORERS.ethereum;
}

/** Public explorer URL for a contract / address. */
export function explorerAddressUrl(address, chain) {
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const { host } = explorerMeta(chain);
  return `https://${host}/address/${addr}`;
}

/** Explorer page filtered to internal transactions for an address. */
export function explorerInternalTxUrl(address, chain) {
  const base = explorerAddressUrl(address, chain);
  return base ? `${base}#internaltx` : null;
}

/** Direct link to a transaction on the chain explorer. */
export function explorerTxUrl(txHash, chain) {
  const hash = String(txHash || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) return null;
  const { host } = explorerMeta(chain);
  return `https://${host}/tx/${hash}`;
}

async function etherscanV2Get(params, chain) {
  const key = apiKey();
  if (!key) return { ok: false, error: "missing_api_key" };
  const { chainId } = explorerMeta(chain);
  const qs = new URLSearchParams({ chainid: String(chainId), ...params, apikey: key });
  const url = `https://api.etherscan.io/v2/api?${qs}`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/etherscan" } });
    const json = await resp.json().catch(() => null);
    const status = String(json?.status || "");
    const result = json?.result;
    if (status === "0") {
      const err = typeof result === "string" ? result : json?.message || "NOTOK";
      return { ok: false, error: err };
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function earliestTxFromList(action, address, chain) {
  const r = await etherscanV2Get(
    {
      module: "account",
      action,
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: "1",
      sort: "asc",
    },
    chain
  );
  if (!r.ok || !Array.isArray(r.result) || !r.result.length) return null;
  const tx = r.result[0];
  const ts = Number(tx.timeStamp);
  if (!isFinite(ts) || ts <= 0) return null;
  return { ms: ts * 1000, txHash: tx.hash || null, action };
}

/**
 * Earliest transaction timestamp for a contract (normal or internal).
 * @returns {Promise<{ ms: number, txHash: string, explorerUrl: string }|null>}
 */
export async function getFirstTransactionMs(address, chain) {
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const cacheKey = `${normalizePoolChain(chain)}:${addr}:first_tx`;
  if (txCache.has(cacheKey)) return txCache.get(cacheKey);

  let best = null;
  for (const action of ["txlist", "txlistinternal"]) {
    const hit = await earliestTxFromList(action, addr, chain);
    if (hit && (!best || hit.ms < best.ms)) best = hit;
  }

  if (!best) {
    txCache.set(cacheKey, null);
    return null;
  }

  const out = {
    ms: best.ms,
    txHash: best.txHash,
    explorerUrl:
      explorerTxUrl(best.txHash, chain) || explorerAddressUrl(addr, chain),
  };
  txCache.set(cacheKey, out);
  return out;
}

/** @deprecated Use getFirstTransactionMs */
export async function getFirstInternalTransactionMs(address, chain) {
  return getFirstTransactionMs(address, chain);
}

const logCache = new Map();

/**
 * Earliest event log timestamp via Etherscan (for market creation / first activity).
 */
export async function getEarliestLogTimestamp({
  address,
  chain,
  topic0,
  topic1 = null,
  fromBlock = "0",
} = {}) {
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr) || !topic0) return null;
  const cacheKey = `${normalizePoolChain(chain)}:${addr}:${topic0}:${topic1 || ""}:${fromBlock}`;
  if (logCache.has(cacheKey)) return logCache.get(cacheKey);

  const params = {
    module: "logs",
    action: "getLogs",
    address: addr,
    fromBlock: String(fromBlock),
    toBlock: "latest",
    topic0,
    page: "1",
    offset: "1",
    sort: "asc",
  };
  if (topic1) params.topic1 = topic1;

  const r = await etherscanV2Get(params, chain);
  if (!r.ok || !Array.isArray(r.result) || !r.result.length) {
    logCache.set(cacheKey, null);
    return null;
  }

  const log = r.result[0];
  const ts = Number(log.timeStamp);
  if (!isFinite(ts) || ts <= 0) {
    logCache.set(cacheKey, null);
    return null;
  }

  const out = {
    ms: ts * 1000,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    explorerUrl: explorerInternalTxUrl(addr, chain),
  };
  logCache.set(cacheKey, out);
  return out;
}
