/**
 * SparkLend reserve metrics via on-chain AaveProtocolDataProvider (Spark address registry).
 */
import { formatUnits } from "viem";
import { clientForChain } from "./onChainToken.js";
import { moralisTokenPriceUsd } from "./moralisClient.js";
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";
import { resolvePoolCreatedAtMs } from "./poolContractAge.js";

/** Spark address registry — Ethereum mainnet (sparkdotfi/spark-address-registry). */
const SPARK_ETHEREUM = {
  protocolDataProvider: "0xFc21d6d146E6086B8359705C8b28512a983db0cb",
};

const PROTOCOL_DATA_PROVIDER_ABI = [
  {
    type: "function",
    name: "getReserveData",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint40" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getReserveTokensAddresses",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getReserveConfigurationData",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" },
      { type: "bool" },
    ],
    stateMutability: "view",
  },
];

const KNOWN_SYMBOLS = {
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
};

function sparkDataProvider(chain) {
  const c = normalizePoolChain(chain);
  if (c === "ethereum") return SPARK_ETHEREUM.protocolDataProvider;
  return null;
}

export async function fetchSparkReserve({ chain, underlyingAsset }) {
  const addr = String(underlyingAsset || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;

  const provider = sparkDataProvider(chain);
  if (!provider) return null;

  try {
    const client = clientForChain(chain);
    const [reserveData, configData, tokenAddrs] = await Promise.all([
      client.readContract({
        address: provider,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [addr],
      }),
      client.readContract({
        address: provider,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: "getReserveConfigurationData",
        args: [addr],
      }),
      client.readContract({
        address: provider,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: "getReserveTokensAddresses",
        args: [addr],
      }),
    ]);

    const decimals = Number(configData[0]) || 18;
    const totalAToken = reserveData[2];
    const totalStableDebt = reserveData[3];
    const totalVariableDebt = reserveData[4];
    const supply = Number(formatUnits(totalAToken, decimals));
    const debt = Number(formatUnits(totalStableDebt, decimals)) + Number(formatUnits(totalVariableDebt, decimals));
    const util = supply > 0 ? debt / supply : null;

    let tvlUsd = null;
    let priceUsd = null;
    const moralisPrice = await moralisTokenPriceUsd(addr, chain).catch(() => null);
    if (moralisPrice?.usdPrice) priceUsd = moralisPrice.usdPrice;
    if (priceUsd == null) {
      const chainKey = normalizePoolChain(chain);
      const dl = await fetch(
        `https://coins.llama.fi/prices/current/${chainKey}:${addr}`,
        { headers: { "User-Agent": "cryptoanalyzer/spark-reserve" } }
      ).catch(() => null);
      const dlJson = dl?.ok ? await dl.json().catch(() => null) : null;
      const key = `${chainKey}:${addr}`;
      priceUsd = Number(dlJson?.coins?.[key]?.price);
      if (!isFinite(priceUsd)) priceUsd = null;
    }
    const available = Math.max(0, supply - debt);
    if (priceUsd != null && available > 0) {
      tvlUsd = available * priceUsd;
    } else if (priceUsd != null && supply > 0) {
      tvlUsd = supply * priceUsd;
    }

    const ltvPct = Number(configData[1]) / 100;
    const liqThreshPct = Number(configData[2]) / 100;
    const sym = KNOWN_SYMBOLS[addr] || "reserve";

    const aTokenAddr = String(tokenAddrs?.[0] || "").toLowerCase();
    const ageMeta = aTokenAddr
      ? await resolvePoolCreatedAtMs({ address: aTokenAddr, chain, protocolKind: "spark_reserve" })
      : null;

    const scoring = {
      totalAssetsUsd: tvlUsd,
      supplyAssetsUsd: priceUsd != null && supply > 0 ? supply * priceUsd : null,
      liquidityAssetsUsd: tvlUsd,
      tvlEvidence:
        tvlUsd != null
          ? `Spark on-chain available liquidity ~$${Math.round(tvlUsd).toLocaleString()} (supply − debt)`
          : null,
      utilization: util != null && isFinite(util) ? util : null,
      utilizationEvidence:
        util != null ? `Spark reserve utilization ${(util * 100).toFixed(1)}% (variable+stable debt / supply)` : null,
      lltvPct: isFinite(liqThreshPct) && liqThreshPct > 0 ? liqThreshPct : isFinite(ltvPct) ? ltvPct : null,
      lltvEvidence:
        isFinite(liqThreshPct) && liqThreshPct > 0
          ? `Spark liquidation threshold ${liqThreshPct.toFixed(1)}%`
          : isFinite(ltvPct)
            ? `Spark LTV ${ltvPct.toFixed(1)}%`
            : null,
      oracleType: "Chainlink",
      oracleEvidence: "SparkLend Chainlink oracle infrastructure",
      poolCreatedAt: ageMeta?.poolCreatedAt ?? null,
      poolAgeEvidence: ageMeta?.poolAgeEvidence ?? null,
      poolAgeSource: ageMeta?.poolAgeSource ?? null,
      poolAgeExplorerUrl: ageMeta?.poolAgeExplorerUrl ?? null,
    };

    return {
      symbol: sym,
      name: `Spark ${sym}`,
      chain: normalizePoolChain(chain),
      underlyingAsset: addr,
      project: "spark",
      source: "spark_on_chain",
      underlyingTokens: [addr],
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
