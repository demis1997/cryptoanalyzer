/**
 * Pool age (P.6) from on-chain activity — first internal tx on pool contract, or first market event.
 */
import { parseAbiItem } from "viem";
import { clientForChain } from "./onChainToken.js";
import { getContractDeployedAtMs } from "./contractDeployTime.js";
import {
  getFirstInternalTransactionMs,
  getEarliestLogTimestamp,
  explorerInternalTxUrl,
} from "./etherscanClient.js";
import { normalizePoolChain } from "./poolAddress.js";

const MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const MORPHO_CREATE_MARKET_TOPIC =
  "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
const MORPHO_SUPPLY_TOPIC = "0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0";

const SUPPLY_EVENT = parseAbiItem(
  "event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"
);
const CREATE_MARKET_EVENT = parseAbiItem(
  "event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)"
);

const POOL_AGE_RANK = {
  on_chain_internal_tx: 0,
  on_chain_market_event: 1,
  on_chain_deploy: 2,
  subgraph: 3,
  protocol_api: 4,
  pool_page: 5,
};

export function poolAgeSourceRank(source) {
  const s = String(source || "").toLowerCase();
  if (s in POOL_AGE_RANK) return POOL_AGE_RANK[s];
  return 99;
}

export function shouldReplacePoolAge(existing, incoming) {
  if (!incoming?.poolCreatedAt) return false;
  if (!existing?.poolCreatedAt) return true;
  return poolAgeSourceRank(incoming.poolAgeSource) < poolAgeSourceRank(existing.poolAgeSource);
}

async function firstMorphoMarketActivityMs(marketId, chain) {
  const id = String(marketId || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(id)) return null;
  const c = normalizePoolChain(chain);
  const deployFrom =
    c === "ethereum" ? "18800000" : c === "base" ? "12000000" : "0";

  for (const [topic0, label] of [
    [MORPHO_CREATE_MARKET_TOPIC, "CreateMarket"],
    [MORPHO_SUPPLY_TOPIC, "Supply"],
  ]) {
    const log = await getEarliestLogTimestamp({
      address: MORPHO_BLUE,
      chain: c,
      topic0,
      topic1: id,
      fromBlock: deployFrom,
    });
    if (log?.ms) {
      return {
        ms: log.ms,
        evidence: `Morpho Blue first ${label} on-chain ${new Date(log.ms).toISOString().slice(0, 10)}`,
        source: "on_chain_market_event",
        explorerUrl: log.explorerUrl,
      };
    }
  }

  const client = clientForChain(c);
  if (!client) return null;
  const maxRange = 40_000n;
  try {
    const latest = await client.getBlockNumber();
    let start = BigInt(deployFrom);
    for (const event of [CREATE_MARKET_EVENT, SUPPLY_EVENT]) {
      for (let from = start; from <= latest; from += maxRange) {
        const to = from + maxRange > latest ? latest : from + maxRange;
        const logs = await client.getLogs({
          address: MORPHO_BLUE,
          event,
          args: { id },
          fromBlock: from,
          toBlock: to,
        });
        if (!logs?.length) continue;
        logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
        const block = await client.getBlock({ blockNumber: logs[0].blockNumber });
        const ms = block?.timestamp != null ? Number(block.timestamp) * 1000 : null;
        if (ms) {
          return {
            ms,
            evidence: `Morpho Blue first ${event.name} on-chain ${new Date(ms).toISOString().slice(0, 10)} (RPC)`,
            source: "on_chain_market_event",
            explorerUrl: explorerInternalTxUrl(MORPHO_BLUE, c),
          };
        }
      }
    }
  } catch {
    /* RPC limits */
  }
  return null;
}

/**
 * Resolve pool creation time for P.6 scoring.
 * Priority: first internal tx on pool contract → Morpho market event → contract bytecode deploy.
 */
export async function resolvePoolCreatedAtMs({
  address = null,
  chain = "ethereum",
  marketId = null,
  protocolKind = null,
} = {}) {
  const addr = String(address || "").toLowerCase();
  const c = normalizePoolChain(chain);

  if (/^0x[a-f0-9]{40}$/.test(addr)) {
    const internal = await getFirstInternalTransactionMs(addr, c);
    if (internal?.ms) {
      return {
        poolCreatedAt: internal.ms,
        poolAgeSource: "on_chain_internal_tx",
        poolAgeEvidence: `First internal tx ${new Date(internal.ms).toISOString().slice(0, 10)} (block explorer)`,
        poolAgeExplorerUrl: internal.explorerUrl,
      };
    }

    const deployedMs = await getContractDeployedAtMs(addr, c);
    if (deployedMs) {
      return {
        poolCreatedAt: deployedMs,
        poolAgeSource: "on_chain_deploy",
        poolAgeEvidence: `Contract bytecode first seen ${new Date(deployedMs).toISOString().slice(0, 10)} (RPC)`,
        poolAgeExplorerUrl: explorerInternalTxUrl(addr, c),
      };
    }
  }

  if (protocolKind === "morpho_market" || /^0x[a-f0-9]{64}$/.test(String(marketId || ""))) {
    const market = await firstMorphoMarketActivityMs(marketId, c);
    if (market?.ms) {
      return {
        poolCreatedAt: market.ms,
        poolAgeSource: market.source,
        poolAgeEvidence: market.evidence,
        poolAgeExplorerUrl: market.explorerUrl,
      };
    }
  }

  return null;
}
