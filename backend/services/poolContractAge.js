/**
 * Pool age (P.6) from the first on-chain transaction on the pool contract.
 */
import { getContractDeployedAtMs } from "./contractDeployTime.js";
import {
  getFirstTransactionMs,
  explorerAddressUrl,
} from "./etherscanClient.js";
import { normalizePoolChain } from "./poolAddress.js";

const POOL_AGE_RANK = {
  on_chain_first_tx: 0,
  on_chain_internal_tx: 0,
  on_chain_deploy: 1,
  subgraph: 2,
  protocol_api: 3,
  pool_page: 4,
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

/**
 * Resolve pool creation time for P.6 scoring.
 * Priority: first contract transaction (block explorer) → contract bytecode deploy (RPC).
 */
export async function resolvePoolCreatedAtMs({
  address = null,
  chain = "ethereum",
} = {}) {
  const addr = String(address || "").toLowerCase();
  const c = normalizePoolChain(chain);

  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;

  const first = await getFirstTransactionMs(addr, c);
  if (first?.ms) {
    return {
      poolCreatedAt: first.ms,
      poolAgeSource: "on_chain_first_tx",
      poolAgeEvidence: `First contract transaction ${new Date(first.ms).toISOString().slice(0, 10)} (block explorer)`,
      poolAgeExplorerUrl: first.explorerUrl,
    };
  }

  const deployedMs = await getContractDeployedAtMs(addr, c);
  if (deployedMs) {
    return {
      poolCreatedAt: deployedMs,
      poolAgeSource: "on_chain_deploy",
      poolAgeEvidence: `Contract bytecode first seen ${new Date(deployedMs).toISOString().slice(0, 10)} (RPC)`,
      poolAgeExplorerUrl: explorerAddressUrl(addr, c),
    };
  }

  return null;
}
