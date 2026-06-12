/**
 * Compound V3 (Comet) market metrics — deployment map + on-chain totals.
 */
import fetch from "node-fetch";
import { createPublicClient, http, parseAbi } from "viem";
import { optimism, mainnet, arbitrum, base, polygon } from "viem/chains";
import { normalizePoolChain } from "./poolAddress.js";
import { resolvePoolCreatedAtMs } from "./poolContractAge.js";
import { compoundMarketUrl } from "./sourceUrls.js";
import { moralisTokenPriceUsd } from "./moralisClient.js";

const COMET_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function getUtilization() view returns (uint64)",
  "function baseToken() view returns (address)",
]);

const ERC20_DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

const VIEM_CHAINS = { ethereum: mainnet, optimism, arbitrum, base, polygon };

const STABLE_BASES = new Set([
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC op
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC arb
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
]);

/** URL slug → github deployment folder */
const SLUG_DEPLOYMENTS = {
  "usdc-op": { chain: "optimism", path: "optimism/usdc", symbol: "USDC" },
  "usdc-arb": { chain: "arbitrum", path: "arbitrum/usdc", symbol: "USDC" },
  "usdc-base": { chain: "base", path: "base/usdc", symbol: "USDC" },
  "usdc-mainnet": { chain: "ethereum", path: "mainnet/usdc", symbol: "USDC" },
  usdc: { chain: "ethereum", path: "mainnet/usdc", symbol: "USDC" },
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

async function baseTokenUsdPrice(baseToken, chain) {
  const addr = String(baseToken).toLowerCase();
  if (STABLE_BASES.has(addr)) return 1;
  const moralis = await moralisTokenPriceUsd(addr, chain).catch(() => null);
  if (moralis?.usdPrice && isFinite(Number(moralis.usdPrice))) return Number(moralis.usdPrice);
  const chainKey = normalizePoolChain(chain);
  const dl = await fetch(`https://coins.llama.fi/prices/current/${chainKey}:${addr}`, {
    headers: { "User-Agent": "cryptoanalyzer/compound" },
  }).catch(() => null);
  const dlJson = dl?.ok ? await dl.json().catch(() => null) : null;
  const p = Number(dlJson?.coins?.[`${chainKey}:${addr}`]?.price);
  return isFinite(p) && p > 0 ? p : null;
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
    const [totalSupply, totalBorrow, utilizationRaw, baseToken] = await Promise.all([
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "totalSupply" }),
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "totalBorrow" }),
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "getUtilization" }).catch(() => null),
      client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: "baseToken" }),
    ]);

    const decimals = Number(
      await client.readContract({
        address: baseToken,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      })
    );
    const dec = isFinite(decimals) && decimals > 0 ? decimals : 6;
    const supply = Number(totalSupply) / 10 ** dec;
    const borrow = Number(totalBorrow) / 10 ** dec;
    const cash = Math.max(0, supply - borrow);

    let util = null;
    if (utilizationRaw != null) {
      util = Number(utilizationRaw) / 1e18;
    } else if (supply > 0) {
      util = borrow / supply;
    }

    const priceUsd = await baseTokenUsdPrice(baseToken, dep.chain);
    const supplyUsd = priceUsd != null && supply > 0 ? supply * priceUsd : null;
    const cashUsd = priceUsd != null && cash > 0 ? cash * priceUsd : cash > 0 ? cash : null;

    const ageMeta = await resolvePoolCreatedAtMs({
      address: cometAddr,
      chain: dep.chain,
      protocolKind: "compound_market",
    });

    const scoring = {
      totalAssetsUsd: cashUsd,
      supplyAssetsUsd: supplyUsd,
      liquidityAssetsUsd: cashUsd,
      tvlEvidence:
        cashUsd != null
          ? `Compound Comet cash liquidity $${Math.round(cashUsd).toLocaleString()} (supply − borrow)`
          : null,
      poolCreatedAt: ageMeta?.poolCreatedAt ?? null,
      poolAgeEvidence: ageMeta?.poolAgeEvidence ?? null,
      poolAgeSource: ageMeta?.poolAgeSource ?? null,
      poolAgeExplorerUrl: ageMeta?.poolAgeExplorerUrl ?? null,
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
      sourceUrl: compoundMarketUrl(marketSlug),
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
