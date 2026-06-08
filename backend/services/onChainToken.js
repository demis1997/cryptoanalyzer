import { createPublicClient, http, parseAbi } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { normalizePoolChain } from "./poolAddress.js";

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ERC4626_ABI = parseAbi(["function asset() view returns (address)"]);

const CHAINS = {
  ethereum: mainnet,
  arbitrum,
  optimism,
  base,
  polygon,
};

const RPC = {
  ethereum: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
  arbitrum: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  optimism: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  polygon: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
};

const clients = new Map();

function clientForChain(chain) {
  const key = normalizePoolChain(chain);
  if (clients.has(key)) return clients.get(key);
  const viemChain = CHAINS[key] || mainnet;
  const rpc = RPC[key] || RPC.ethereum;
  const c = createPublicClient({ chain: viemChain, transport: http(rpc) });
  clients.set(key, c);
  return c;
}

function cleanSymbol(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 32) return null;
  return s;
}

/**
 * Read ERC-20 symbol/name/decimals from chain (any vault/share token).
 */
export async function readErc20Metadata(address, chain = "ethereum") {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  try {
    const client = clientForChain(chain);
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }).catch(() => null),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }).catch(() => null),
    ]);
    return {
      address: addr,
      chain: normalizePoolChain(chain),
      symbol: cleanSymbol(symbol),
      name: cleanSymbol(name) || null,
      decimals: typeof decimals === "number" ? decimals : null,
      source: "on_chain_erc20",
    };
  } catch {
    return null;
  }
}

/** ERC-4626 vault → underlying asset address. */
export async function readErc4626Underlying(address, chain = "ethereum") {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  try {
    const client = clientForChain(chain);
    const asset = await client.readContract({ address: addr, abi: ERC4626_ABI, functionName: "asset" });
    const a = String(asset || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(a)) return null;
    const meta = await readErc20Metadata(a, chain);
    return { assetAddress: a, assetMeta: meta, source: "on_chain_erc4626" };
  } catch {
    return null;
  }
}
