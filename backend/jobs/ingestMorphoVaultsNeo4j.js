import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, upsertProtocolGraphNeo4j } from "../db/neo4jGraph.js";

function okAddr(a) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(a || "").trim());
}

function chainKey(chainId) {
  const n = Number(chainId);
  if (n === 1) return "ethereum";
  if (n === 42161) return "arbitrum";
  if (n === 10) return "optimism";
  if (n === 8453) return "base";
  if (n === 137) return "polygon";
  return String(n || "ethereum");
}

async function gql(query, variables) {
  const resp = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/morpho-vaults-ingest" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`Morpho GraphQL failed: ${resp.status}`);
  if (json.errors?.length) throw new Error(`Morpho GraphQL errors: ${json.errors[0]?.message || "unknown"}`);
  return json.data;
}

async function ingest() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();

  // Keep query cheap to avoid Morpho API 500s from complex selection sets.
  // We treat "exposure" as: vault -> underlying asset token (and protocol -> vault).
  const q = `
  query Vaults($chainIds: [Int!]) {
    vaultV2s(first: 1000, where: { chainId_in: $chainIds }) {
      items {
        address
        symbol
        name
        listed
        asset { address symbol }
        chain { id network }
      }
    }
  }`;

  const chainIds = [1, 8453, 42161, 10, 137];
  const data = await gql(q, { chainIds });
  const items = Array.isArray(data?.vaultV2s?.items) ? data.vaultV2s.items : [];

  const contracts = [];
  const tokens = [];
  const connNodes = [{ kind: "protocol", id: "protocol:morpho", label: "Morpho", network: "Multi-chain" }];
  const connEdges = [];
  const seenC = new Set();
  const seenT = new Set();

  for (const v of items) {
    const addr = String(v?.address || "").toLowerCase();
    if (!okAddr(addr)) continue;
    const cKey = `${chainKey(v?.chain?.id)}:${addr}`;
    if (seenC.has(cKey)) continue;
    seenC.add(cKey);

    const sym = String(v?.symbol || "").trim();
    const name = String(v?.name || "").trim();
    const label = `Morpho Vault: ${sym || name || addr}`;
    const chain = chainKey(v?.chain?.id);

    contracts.push({
      chain,
      address: addr,
      label,
      type: "vault",
      evidence: "Morpho API (vaultV2s)",
    });

    connNodes.push({ kind: "contract", id: addr, address: addr, label, network: v?.chain?.network || chain });
    connEdges.push({
      from: "protocol:morpho",
      to: addr,
      relation: "has_vault",
      evidence: ["Morpho API vaultV2s"],
    });

    const assetAddr = String(v?.asset?.address || "").toLowerCase();
    const assetSym = String(v?.asset?.symbol || "").trim();
    if (okAddr(assetAddr) && !seenT.has(`${chain}:${assetAddr}`)) {
      seenT.add(`${chain}:${assetAddr}`);
      tokens.push({ chain, address: assetAddr, symbol: assetSym || null });
      connNodes.push({ kind: "token", id: assetAddr, address: assetAddr, label: assetSym ? `Token: ${assetSym}` : "Token", symbol: assetSym || null, network: v?.chain?.network || chain });
    }
    if (okAddr(assetAddr)) {
      connEdges.push({
        from: addr,
        to: assetAddr,
        relation: "underlying_token",
        evidence: ["Morpho API vaultV2s.asset"],
      });
    }

    // Note: adapters/allocations are available via heavier queries; we skip them here to keep ingestion stable.
  }

  await upsertProtocolGraphNeo4j({
    protocol: { id: "defillama:morpho", name: "Morpho", url: "https://morpho.org", defillamaSlug: "morpho" },
    tokens,
    contracts,
    auditors: [],
    docPages: [],
    connections: { nodes: connNodes, edges: connEdges, evidence: ["morpho_vaults_ingest"] },
    architecture: null,
    extra: { vaultsIngest: { vaults: contracts.length, chains: chainIds } },
  });

  console.log(`[morpho-vaults] vaults=${contracts.length} tokens=${tokens.length} edges=${connEdges.length}`);
}

ingest()
  .catch((e) => {
    console.error("[morpho-vaults] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

