import "dotenv/config";
import { createPublicClient, http, isAddress, getAddress } from "viem";
import { mainnet, arbitrum, optimism, base, polygon } from "viem/chains";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, upsertProtocolGraphNeo4j } from "../db/neo4jGraph.js";

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!isAddress(s)) return null;
  return getAddress(s);
}

function chainKeyFromViemChain(c) {
  if (!c?.id) return "ethereum";
  if (c.id === 1) return "ethereum";
  if (c.id === 42161) return "arbitrum";
  if (c.id === 10) return "optimism";
  if (c.id === 8453) return "base";
  if (c.id === 137) return "polygon";
  return String(c.id);
}

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

const CTOKEN_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const COMPTROLLER_ABI = [
  { type: "function", name: "getAllMarkets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
];

// Compound v2 Unitroller (proxy) address on mainnet
const COMPOUND_V2_COMPTROLLER = "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b";

async function safeRead(client, call, fallback = null) {
  try {
    return await client.readContract(call);
  } catch {
    return fallback;
  }
}

async function fetchGithubJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/compound-pools-ingest" } });
  if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status} ${url}`);
  return await resp.json();
}

async function listCometDeploymentsDirs() {
  // https://api.github.com/repos/compound-finance/comet/contents/deployments
  const root = await fetchGithubJson("https://api.github.com/repos/compound-finance/comet/contents/deployments");
  return (Array.isArray(root) ? root : []).filter((x) => x?.type === "dir").map((x) => ({ name: x.name, url: x.url }));
}

function chainFromDeploymentDir(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("mainnet")) return mainnet;
  if (s.includes("arbitrum")) return arbitrum;
  if (s.includes("optimism") || s.includes("op")) return optimism;
  if (s.includes("base")) return base;
  if (s.includes("polygon")) return polygon;
  return null;
}

async function extractCometAddresses() {
  const dirs = await listCometDeploymentsDirs();
  const out = []; // { chain, address, label }

  for (const d of dirs) {
    const chain = chainFromDeploymentDir(d.name);
    if (!chain) continue;
    let files = null;
    try {
      files = await fetchGithubJson(d.url);
    } catch {
      continue;
    }
    for (const f of Array.isArray(files) ? files : []) {
      if (f?.type !== "file") continue;
      const name = String(f.name || "");
      if (!name.toLowerCase().endsWith(".json")) continue;
      if (!/comet|configuration|deploy/i.test(name.toLowerCase())) continue;
      if (!f.download_url) continue;
      let j = null;
      try {
        j = await fetchGithubJson(f.download_url);
      } catch {
        continue;
      }
      const candidates = [
        j?.comet,
        j?.cometProxy,
        j?.cometAddress,
        j?.contracts?.comet,
        j?.contracts?.cometProxy,
      ].filter(Boolean);
      for (const c of candidates) {
        const addr = normalizeAddr(c);
        if (!addr) continue;
        out.push({
          chain,
          address: addr.toLowerCase(),
          label: `Compound V3 Comet (${chain.name})`,
          evidence: `GitHub deployments/${d.name}/${name}`,
        });
      }
    }
  }

  // De-dupe by chainId+address
  const seen = new Set();
  const uniq = [];
  for (const x of out) {
    const k = `${x.chain.id}:${x.address}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
  }
  return uniq;
}

async function ingest() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();

  const rpcUrl = String(process.env.ETH_RPC_URL || "").trim();
  if (!rpcUrl) throw new Error("Missing ETH_RPC_URL (needed for on-chain market discovery).");
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  // ---- Compound v2 markets (on-chain) ----
  const markets = await safeRead(client, {
    address: COMPOUND_V2_COMPTROLLER,
    abi: COMPTROLLER_ABI,
    functionName: "getAllMarkets",
    args: [],
  }, []);

  const contracts = [];
  const tokens = [];
  const connNodes = [];
  const connEdges = [];
  const seenTok = new Set();
  const seenCon = new Set();

  // Subject protocol node for ecosystem edges
  connNodes.push({ kind: "protocol", id: "protocol:compound", label: "Compound", network: "Multi-chain" });

  for (const m of Array.isArray(markets) ? markets : []) {
    const cAddr = normalizeAddr(m);
    if (!cAddr) continue;
    const cLower = cAddr.toLowerCase();
    if (seenCon.has(cLower)) continue;
    seenCon.add(cLower);

    const sym = await safeRead(client, { address: cAddr, abi: CTOKEN_ABI, functionName: "symbol", args: [] }, null);
    const nm = await safeRead(client, { address: cAddr, abi: CTOKEN_ABI, functionName: "name", args: [] }, null);
    let underlying = await safeRead(client, { address: cAddr, abi: CTOKEN_ABI, functionName: "underlying", args: [] }, null);
    underlying = normalizeAddr(underlying);

    const label = `Compound v2 Market: ${sym || nm || cAddr}`;
    contracts.push({
      chain: "ethereum",
      address: cLower,
      label,
      type: "market",
      evidence: "Compound v2 Comptroller getAllMarkets()",
    });

    connNodes.push({ kind: "contract", id: cLower, address: cLower, label, network: "Ethereum" });
    connEdges.push({
      from: "protocol:compound",
      to: cLower,
      relation: "has_market",
      evidence: ["Compound v2 Comptroller getAllMarkets()"],
    });

    if (underlying) {
      const uLower = underlying.toLowerCase();
      const usym = await safeRead(client, { address: underlying, abi: ERC20_ABI, functionName: "symbol", args: [] }, null);
      const ulbl = usym ? `Underlying: ${usym}` : "Underlying token";
      if (!seenTok.has(uLower)) {
        seenTok.add(uLower);
        tokens.push({ chain: "ethereum", address: uLower, symbol: usym || null });
        connNodes.push({ kind: "token", id: uLower, address: uLower, label: ulbl, symbol: usym || null, network: "Ethereum" });
      }
      connEdges.push({
        from: cLower,
        to: uLower,
        relation: "underlying_token",
        evidence: ["cToken.underlying()"],
      });
    }
  }

  // ---- Compound v3 comets (best-effort, from GitHub deployments) ----
  let comets = [];
  try {
    comets = await extractCometAddresses();
  } catch {
    comets = [];
  }
  for (const c of comets) {
    const chain = c.chain;
    const chainKey = chainKeyFromViemChain(chain);
    contracts.push({
      chain: chainKey,
      address: c.address,
      label: c.label,
      type: "market",
      evidence: c.evidence,
    });
    connNodes.push({ kind: "contract", id: c.address, address: c.address, label: c.label, network: chain.name });
    connEdges.push({
      from: "protocol:compound",
      to: c.address,
      relation: "has_market",
      evidence: [c.evidence],
    });
  }

  await upsertProtocolGraphNeo4j({
    protocol: { id: "defillama:compound", name: "Compound", url: "https://compound.finance", defillamaSlug: "compound" },
    tokens,
    contracts,
    auditors: [],
    docPages: [],
    connections: { nodes: connNodes, edges: connEdges, evidence: ["compound_pools_ingest"] },
    architecture: null,
    extra: { poolsIngest: { v2Markets: contracts.filter((x) => x.chain === "ethereum").length, v3Comets: comets.length } },
  });

  console.log(`[compound-pools] v2_markets=${markets?.length || 0} v3_comets=${comets.length} contracts_saved=${contracts.length}`);
}

ingest()
  .catch((e) => {
    console.error("[compound-pools] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

