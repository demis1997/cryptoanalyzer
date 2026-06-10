/**
 * Compound V3 (Comet) market metrics — deployment map + on-chain totals.
 */
import fetch from "node-fetch";
import { createPublicClient, http } from "viem";
import { optimism, mainnet, arbitrum, base, polygon } from "viem/chains";
import { normalizePoolChain } from "./poolAddress.js";

const COMET_ABI = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalBorrow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getUtilization",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "baseToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const VIEM_CHAINS = { ethereum: mainnet, optimism, arbitrum, base, polygon };

/** URL slug → github deployment folder */
const SLUG_DEPLOYMENTS = {
  "usdc-op": { chain: "optimism", path: "optimism/usdc", symbol: "USDC" },
  "usdc-arb": { chain: "arbitrum", path: "arbitrum/usdc", symbol: "USDC" },
  "usdc-base": { chain: "base", path: "base/usdc", symbol: "USDC" },
  "usdc-mainnet": { chain: "ethereum", path: "mainnet/usdc", symbol: "USDC" },
  "usdc": { chain: "ethereum", path: "mainnet/usdc", symbol: "USDC" },
  "weth-op": { chain: "optimism", path: "optimism/weth", symbol: "WETH" },
};

const cometCache = new Map();

async function getCometAddress(deploymentPath) {
  if (cometCache.has(deploymentPath)) return cometCache.get(deploymentPath);
  const url = `https://raw.githubusercontent.com/compound-finance/comet/main/deployments/${deploymentPath}/roots.json`;
  const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/compound" } });
  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const addr = json?.comet ? String(json.comet).toLowerCase() : null;
  if (addr) cometCache.set(deploymentPath, addr);
  return addr;
}

function clientForChain(chain) {
  const c = VIEM_CHAINS[normalizePoolChain(chain)];
  if (!c) return null;
  return createPublicClient({ chain: c, transport: http() });
}

export async function fetchCompoundMarket({ marketSlug, chain }) {
  const slug = String(marketSlug || "").toLowerCase();
  const dep = SLUG_DEPLOYMENTS[slug] || {
    chain: normalizePoolChain(chain),
    path: null,
    symbol: slug.split("-")[0]?.toUpperCase() || "USDC",
  };

  if (!dep.path && slug.includes("usdc")) {
    dep.path = `${normalizePoolChain(chain) === "ethereum" ? "mainnet" : normalizePoolChain(chain)}/usdc`;
    dep.chain = normalizePoolChain(chain);
    dep.symbol = "USDC";
  }
  if (!dep.path) return null;

  const cometAddr = await getCometAddress(dep.path);
  if (!cometAddr) return null;

  const client = clientForChain(dep.chain);
  if (!client) return null;

  try {
    const [totalSupply, totalBorrow, utilizationRaw] = await Promise.all([
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "totalSupply" }),
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "totalBorrow" }),
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "getUtilization" }).catch(() => null),
    ]);

    const supply = Number(totalSupply) / 1e6;
    const borrow = Number(totalBorrow) / 1e6;
    let util = null;
    if (utilizationRaw != null) {
      util = Number(utilizationRaw) / 1e18;
    } else if (supply > 0) {
      util = borrow / supply;
    }

    const scoring = {
      totalAssetsUsd: supply > 0 ? supply : null,
      tvlEvidence: supply > 0 ? `Compound Comet totalSupply ~$${Math.round(supply).toLocaleString()} (base units)` : null,
      utilization: util != null && isFinite(util) ? util : null,
      utilizationEvidence: util != null ? `Compound Comet utilization ${(util * 100).toFixed(1)}%` : null,
      oracleType: "Chainlink",
      oracleEvidence: "Compound V3 Chainlink price feeds",
    };

    return {
      symbol: dep.symbol,
      name: `Compound ${dep.symbol} (${dep.chain})`,
      chain: dep.chain,
      vaultAddress: cometAddr,
      project: "compound",
      source: "compound_on_chain",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
