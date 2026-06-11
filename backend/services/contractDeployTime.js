/**
 * Resolve contract deployment timestamp via bytecode binary search (no Etherscan required).
 */
import { clientForChain } from "./onChainToken.js";

const deployCache = new Map();

function cacheKey(chain, address) {
  return `${chain}:${String(address).toLowerCase()}`;
}

/** @returns {Promise<number|null>} deployment time in ms */
export async function getContractDeployedAtMs(address, chain) {
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const key = cacheKey(chain, addr);
  if (deployCache.has(key)) return deployCache.get(key);

  const client = clientForChain(chain);
  if (!client) return null;

  try {
    const latest = await client.getBlockNumber();
    const hasCode = async (blockNumber) => {
      const code = await client.getBytecode({ address: addr, blockNumber });
      return Boolean(code && code !== "0x");
    };
    if (!(await hasCode(latest))) {
      deployCache.set(key, null);
      return null;
    }

    let lo = 0n;
    let hi = latest;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1n;
    }

    const block = await client.getBlock({ blockNumber: lo });
    const ms = block?.timestamp != null ? Number(block.timestamp) * 1000 : null;
    deployCache.set(key, ms);
    return ms;
  } catch {
    deployCache.set(key, null);
    return null;
  }
}
