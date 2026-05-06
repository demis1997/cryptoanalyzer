import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, upsertConnectionsGraphNeo4j } from "../db/neo4jGraph.js";

function okAddr(a) {
  return /^0x[a-f0-9]{40}$/.test(String(a || "").trim().toLowerCase());
}

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
    const resp = await fetch(url, { headers: { "User-Agent": "cryptoanalyzer/pendle-exposures" } });
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
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();

  const rows = await fetchAllPendleMarkets({ maxPages: 50, pageLimit: 100 });

  const nodes = [{ kind: "protocol", id: "protocol:pendle", label: "Pendle", network: "Multi-chain" }];
  const edges = [];
  const seenNode = new Set(nodes.map((n) => n.id));
  const seenEdge = new Set();

  const addNode = (kind, id, label, network) => {
    const sid = String(id || "").trim().toLowerCase();
    if (!sid) return;
    if (seenNode.has(sid)) return;
    seenNode.add(sid);
    nodes.push({ kind, id: sid, label, network });
  };

  const addEdge = (from, to, relation) => {
    const f = String(from || "").trim().toLowerCase();
    const t = String(to || "").trim().toLowerCase();
    if (!f || !t) return;
    const k = `${f}|${relation}|${t}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from: f, to: t, relation, evidence: ["Pendle markets API"] });
  };

  for (const m of rows) {
    const chainId = Number(m?.chainId || 0) || 1;
    const market = String(m?.address || "").trim().toLowerCase();
    if (!okAddr(market)) continue;
    addNode("contract", market, `Pendle Market: ${m?.name || "Market"}`, chainNameFromId(chainId));
    addEdge("protocol:pendle", market, "has_market");

    const pt = splitChainPrefixedAddress(m?.pt);
    const yt = splitChainPrefixedAddress(m?.yt);
    const sy = splitChainPrefixedAddress(m?.sy);
    const ua = splitChainPrefixedAddress(m?.underlyingAsset);

    const toks = [
      { rel: "pt_token", label: `Pendle PT (${m?.name || "Market"})`, v: pt },
      { rel: "yt_token", label: `Pendle YT (${m?.name || "Market"})`, v: yt },
      { rel: "sy_token", label: `Pendle SY (${m?.name || "Market"})`, v: sy },
      { rel: "underlying_token", label: `Underlying token (${m?.name || "Market"})`, v: ua },
    ];
    for (const t of toks) {
      if (!t?.v?.address) continue;
      const addr = String(t.v.address).trim().toLowerCase();
      if (!okAddr(addr)) continue;
      addNode("token", addr, t.label, chainNameFromId(t.v.chainId || chainId));
      addEdge(market, addr, t.rel);
    }
  }

  await upsertConnectionsGraphNeo4j({
    rootProtocolId: "defillama:pendle",
    subjectProtocolId: "protocol:pendle",
    connections: { nodes, edges, evidence: ["pendle_exposures_ingest"] },
  });

  console.log(`[pendle-exposures] markets=${rows.length} nodes=${nodes.length} edges=${edges.length}`);
}

main()
  .catch((e) => {
    console.error("[pendle-exposures] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

