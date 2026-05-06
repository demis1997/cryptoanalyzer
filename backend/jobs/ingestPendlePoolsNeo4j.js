import "dotenv/config";
import { neo4jEnabled, neo4jInit, neo4jClose, upsertProtocolGraphNeo4j } from "../db/neo4jGraph.js";
import fetch from "node-fetch";

function chainNameFromId(id) {
  const n = Number(id);
  if (n === 1) return "Ethereum";
  if (n === 42161) return "Arbitrum";
  if (n === 10) return "Optimism";
  if (n === 8453) return "Base";
  if (n === 56) return "BNB Chain";
  if (n === 137) return "Polygon";
  if (n === 43114) return "Avalanche";
  return `Chain ${n}`;
}

function okAddr(a) {
  return /^0x[a-f0-9]{40}$/.test(String(a || "").trim().toLowerCase());
}

function splitChainPrefixedAddress(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)-(0x[a-fA-F0-9]{40})$/);
  if (!m) return { chainId: null, address: null };
  return { chainId: Number(m[1]), address: m[2] };
}

async function fetchAllPendleMarkets({ maxPages = 40, pageLimit = 100 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const skip = page * pageLimit;
    const url = `https://api-v2.pendle.finance/core/v2/markets/all?skip=${skip}&limit=${pageLimit}`;
    const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/pools-ingest" } });
    if (!resp.ok) throw new Error(`Pendle markets API failed: ${resp.status}`);
    const json = await resp.json().catch(() => null);
    const rows = Array.isArray(json?.results) ? json.results : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageLimit) break;
  }
  return all;
}

async function main() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled (set NEO4J_URI/USER/PASSWORD).");
  await neo4jInit();

  const rows = await fetchAllPendleMarkets({ maxPages: 50, pageLimit: 100 });
  const contracts = []; // markets only
  const tokens = []; // PT/YT/SY/underlying
  const seenContracts = new Set();
  const seenTokens = new Set();

  const connNodes = [{ kind: "protocol", id: "protocol:pendle", label: "Pendle", network: "Multi-chain" }];
  const connEdges = [];

  const addMarket = (label, address, chainId) => {
    const a = String(address || "").trim().toLowerCase();
    if (!okAddr(a)) return;
    const key = `${Number(chainId) || 0}:${a}`;
    if (seenContracts.has(key)) return;
    seenContracts.add(key);
    contracts.push({
      label,
      address: a,
      network: chainNameFromId(chainId),
      type: "market",
      evidence: "Source: Pendle markets API",
    });

    connNodes.push({ kind: "contract", id: a, address: a, label, network: chainNameFromId(chainId) });
    connEdges.push({ from: "protocol:pendle", to: a, relation: "has_market", evidence: ["Pendle markets API"] });
  };

  const addToken = (label, address, chainId) => {
    const a = String(address || "").trim().toLowerCase();
    if (!okAddr(a)) return;
    const key = `${Number(chainId) || 0}:${a}`;
    if (seenTokens.has(key)) return;
    seenTokens.add(key);
    tokens.push({ address: a, chain: chainNameFromId(chainId) });
    connNodes.push({ kind: "token", id: a, address: a, label, network: chainNameFromId(chainId) });
  };

  for (const m of rows) {
    const chainId = Number(m?.chainId || 0) || 1;
    const marketAddr = String(m?.address || "").trim();
    addMarket(`Pendle Market: ${m?.name || "Market"}`, marketAddr, chainId);

    const pt = splitChainPrefixedAddress(m?.pt);
    const yt = splitChainPrefixedAddress(m?.yt);
    const sy = splitChainPrefixedAddress(m?.sy);
    const ua = splitChainPrefixedAddress(m?.underlyingAsset);

    const marketLower = okAddr(marketAddr) ? String(marketAddr).toLowerCase() : null;
    const tokTuples = [
      { kind: "pt", label: `Pendle PT (${m?.name || "Market"})`, v: pt },
      { kind: "yt", label: `Pendle YT (${m?.name || "Market"})`, v: yt },
      { kind: "sy", label: `Pendle SY (${m?.name || "Market"})`, v: sy },
      { kind: "underlying", label: `Underlying token (${m?.name || "Market"})`, v: ua },
    ];
    for (const t of tokTuples) {
      if (!t?.v?.address) continue;
      const tChainId = t.v.chainId || chainId;
      const tAddrLower = String(t.v.address).toLowerCase();
      addToken(t.label, t.v.address, tChainId);
      if (marketLower) {
        connEdges.push({
          from: marketLower,
          to: tAddrLower,
          relation: `${t.kind}_token`,
          evidence: ["Pendle markets API"],
        });
      }
    }
  }

  await upsertProtocolGraphNeo4j({
    protocol: {
      id: "defillama:pendle",
      name: "Pendle",
      url: "https://pendle.finance",
      defillamaSlug: "pendle",
    },
    contracts,
    tokens,
    auditors: [],
    docPages: [],
    connections: { nodes: connNodes, edges: connEdges, evidence: ["pendle_pools_ingest"] },
    architecture: null,
    extra: { poolsIngest: { source: "pendle_markets_api", rows: rows.length, markets: contracts.length, tokens: tokens.length } },
  });

  console.log(`[pendle-pools] markets=${rows.length} contracts_inserted=${contracts.length}`);
}

main()
  .catch((e) => {
    console.error("[pendle-pools] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

