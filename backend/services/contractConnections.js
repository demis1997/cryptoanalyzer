import { createPublicClient, http, isAddress, getAddress } from "viem";
import { mainnet } from "viem/chains";
import fs from "fs";
import path from "path";

function nowMs() {
  return Date.now();
}

function safeLower(v) {
  return String(v || "").toLowerCase();
}

function normalizeAddr(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!isAddress(s)) return null;
  return getAddress(s);
}

function inferVaultLike(contract) {
  const label = safeLower(contract?.label);
  if (!label) return false;
  return (
    label.includes("vault") ||
    label.includes("market") ||
    label.includes("pool") ||
    label.includes("router") ||
    label.includes("sy ") ||
    label.includes("sy(") ||
    label.includes("pt ") ||
    label.includes("pt(") ||
    label.includes("yt ") ||
    label.includes("yt(")
  );
}

const UNDERLYING_READS = [
  { fn: "asset", abi: [{ type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] },
  { fn: "token", abi: [{ type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] },
  { fn: "underlying", abi: [{ type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] },
  {
    fn: "underlyingAsset",
    abi: [{ type: "function", name: "underlyingAsset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
  },
];

async function tryReadUnderlyingToken({ client, contractAddress, timeoutMs = 1500 }) {
  for (const r of UNDERLYING_READS) {
    try {
      const p = client.readContract({ address: contractAddress, abi: r.abi, functionName: r.fn, args: [] });
      const value = await Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      const addr = normalizeAddr(value);
      if (addr) return { token: addr, evidence: `rpc:${r.fn}()` };
    } catch {
      // ignore
    }
  }
  return null;
}

export function loadEthereumTokenRouterMappings() {
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "backend/data/token_router_mappings.ethereum.json"),
      "utf8"
    );
    const json = JSON.parse(raw);
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

export async function discoverContractConnections({
  origin,
  contracts = [],
  tokenLiquidity = [],
  maxContracts = 150,
  timeoutMsPerRead = 1500,
} = {}) {
  const start = nowMs();
  const rpcUrl = String(process.env.ETH_RPC_URL || "").trim();
  const enabled = Boolean(rpcUrl);

  const out = {
    enabled,
    chain: "ethereum",
    rpc: enabled ? "configured" : "missing",
    nodes: [],
    edges: [],
    evidence: [],
    timingsMs: { total: 0, rpcReads: 0 },
  };
  if (!enabled) {
    out.evidence.push("Missing ETH_RPC_URL; skipping on-chain connection discovery.");
    return out;
  }

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const nodeByAddr = new Map(); // lower -> node
  const addNode = ({ address, label, type, network = "Ethereum", evidence }) => {
    const a = normalizeAddr(address);
    if (!a) return null;
    const key = safeLower(a);
    const existing = nodeByAddr.get(key);
    if (existing) {
      if (label && (!existing.label || existing.label.length < label.length)) existing.label = label;
      if (type && existing.type === "unknown") existing.type = type;
      if (evidence && Array.isArray(existing.evidence) && existing.evidence.length < 4) existing.evidence.push(evidence);
      return existing;
    }
    const n = {
      id: key,
      address: a,
      label: label || a,
      type: type || "unknown",
      network,
      evidence: evidence ? [evidence] : [],
    };
    nodeByAddr.set(key, n);
    return n;
  };

  const addEdge = ({ from, to, relation, evidence }) => {
    const f = normalizeAddr(from);
    const t = normalizeAddr(to);
    if (!f || !t) return;
    out.edges.push({
      from: f,
      to: t,
      relation: relation || "connected",
      evidence: evidence ? [evidence] : [],
    });
  };

  // Seed token nodes from tokenLiquidity list.
  for (const t of Array.isArray(tokenLiquidity) ? tokenLiquidity.slice(0, 200) : []) {
    const addr = normalizeAddr(t?.tokenAddress);
    if (!addr) continue;
    addNode({ address: addr, label: t?.token || "Token", type: "token", evidence: "tokenLiquidity" });
  }

  const vaultCandidates = (Array.isArray(contracts) ? contracts : [])
    .filter((c) => normalizeAddr(c?.address))
    .filter((c) => inferVaultLike(c))
    .slice(0, maxContracts);

  // Hop 1: vault/market -> underlying token via minimal ABI reads.
  const rpcStart = nowMs();
  for (const c of vaultCandidates) {
    const addr = normalizeAddr(c.address);
    if (!addr) continue;
    addNode({ address: addr, label: c.label || "Contract", type: "vault", evidence: "contracts" });
    const res = await tryReadUnderlyingToken({ client, contractAddress: addr, timeoutMs: timeoutMsPerRead });
    if (!res?.token) continue;
    addNode({ address: res.token, label: "Underlying token", type: "token", evidence: res.evidence });
    addEdge({ from: addr, to: res.token, relation: "underlying_token", evidence: res.evidence });
  }
  out.timingsMs.rpcReads = nowMs() - rpcStart;

  // Hop 2: token -> known ecosystem/router contracts (curated mapping).
  const mappings = loadEthereumTokenRouterMappings();
  const tokenMap = mappings?.tokens && typeof mappings.tokens === "object" ? mappings.tokens : {};
  const lowerToTokenAddr = new Map();
  for (const a of Object.keys(tokenMap)) {
    const na = normalizeAddr(a);
    if (na) lowerToTokenAddr.set(safeLower(na), na);
  }

  for (const node of nodeByAddr.values()) {
    if (!node || node.type !== "token") continue;
    const tokenAddr = normalizeAddr(node.address);
    if (!tokenAddr) continue;
    const mappedKey = lowerToTokenAddr.get(safeLower(tokenAddr));
    if (!mappedKey) continue;
    const info = tokenMap[mappedKey] || tokenMap[safeLower(mappedKey)] || null;
    const connections = Array.isArray(info?.connectedContracts) ? info.connectedContracts : [];
    for (const cc of connections) {
      const ca = normalizeAddr(cc?.address);
      if (!ca) continue;
      addNode({
        address: ca,
        label: cc?.label || "Ecosystem contract",
        type: cc?.type || "protocol_router",
        evidence: `mapping:${info?.mappingId || "curated"}`,
      });
      addEdge({
        from: tokenAddr,
        to: ca,
        relation: cc?.relation || "ecosystem_router",
        evidence: `mapping:${info?.mappingId || "curated"}`,
      });
    }
  }

  out.nodes = Array.from(nodeByAddr.values());
  out.timingsMs.total = nowMs() - start;
  if (origin) out.evidence.push(`Connections derived for ${origin}`);
  return out;
}

