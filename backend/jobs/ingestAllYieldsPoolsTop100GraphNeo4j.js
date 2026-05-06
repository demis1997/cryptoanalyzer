import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, upsertConnectionsGraphNeo4j, upsertProtocolExtraNeo4j } from "../db/neo4jGraph.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTopProtocols({ limit = 100 } = {}) {
  const resp = await fetch("https://api.llama.fi/protocols", {
    headers: { "User-Agent": "cryptoanalyzer/defillama-top-protocols" },
  });
  if (!resp.ok) throw new Error(`DefiLlama protocols failed: ${resp.status}`);
  const rows = await resp.json();
  const list = Array.isArray(rows) ? rows : [];
  list.sort((a, b) => (Number(b?.tvl) || 0) - (Number(a?.tvl) || 0));
  return list.slice(0, Math.max(1, Number(limit) || 100));
}

async function fetchAllYieldsPools() {
  const resp = await fetch("https://yields.llama.fi/pools", {
    headers: { "User-Agent": "cryptoanalyzer/yields-pools" },
  });
  if (!resp.ok) throw new Error(`yields.llama.fi/pools failed: ${resp.status}`);
  const json = await resp.json().catch(() => null);
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return Array.isArray(data) ? data : [];
}

function cleanPoolLabel(p) {
  const sym = String(p?.symbol || "").trim();
  const meta = String(p?.poolMeta || "").trim();
  const chain = String(p?.chain || "").trim();
  const base = meta ? `${sym} • ${meta}` : sym || "Pool";
  return `${base}`.trim();
}

async function main() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();

  const LIMIT = Number(process.env.TOP_N || 100) || 100;
  const MAX_POOLS_PER_PROJECT = Number(process.env.MAX_POOLS || 400) || 400;
  const DELAY_MS = Number(process.env.DELAY_MS || 40) || 40;

  const top = await fetchTopProtocols({ limit: LIMIT });
  const slugs = new Set(top.map((p) => String(p?.slug || "").trim().toLowerCase()).filter(Boolean));

  const pools = await fetchAllYieldsPools();
  const byProject = new Map();
  for (const r of pools) {
    const proj = String(r?.project || "").trim().toLowerCase();
    if (!proj || !slugs.has(proj)) continue;
    if (!byProject.has(proj)) byProject.set(proj, []);
    const arr = byProject.get(proj);
    if (arr.length < MAX_POOLS_PER_PROJECT) arr.push(r);
  }

  console.log(`[yields-graph] top=${top.length} projects_with_pools=${byProject.size} max_per_project=${MAX_POOLS_PER_PROJECT}`);

  let ok = 0;
  let failed = 0;

  for (const slug of slugs) {
    const rows = byProject.get(slug) || [];
    if (!rows.length) continue;

    const subj = `protocol:${slug}`;
    const rootId = `defillama:${slug}`;

    const nodes = [{ kind: "protocol", id: subj, label: slug, network: "Multi-chain" }];
    const edges = [];

    // Also store a readable top list into extraJson for the protocol view.
    const sorted = rows
      .filter((x) => typeof x?.tvlUsd === "number" && isFinite(x.tvlUsd) && x.tvlUsd > 0)
      .sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0));

    const poolsFromYields = sorted.slice(0, 80).map((r) => ({
      name: `${cleanPoolLabel(r)} (${String(r?.chain || "").trim() || "unknown"})`,
      chain: r?.chain || null,
      project: r?.project || null,
      tvlUsd: typeof r?.tvlUsd === "number" ? r.tvlUsd : null,
      apy: typeof r?.apy === "number" ? r.apy : null,
      exposure: r?.exposure || null,
      stablecoin: Boolean(r?.stablecoin),
      ilRisk: r?.ilRisk || null,
      yieldPoolId: r?.pool || null,
    }));

    for (const r of sorted) {
      const pid = String(r?.pool || "").trim();
      if (!pid) continue;
      const id = `yieldpool:${pid}`;
      const chain = String(r?.chain || "").trim() || null;
      nodes.push({
        kind: "yield_pool",
        id,
        label: cleanPoolLabel(r),
        network: chain,
        project: String(r?.project || slug).toLowerCase(),
        tvlUsd: typeof r?.tvlUsd === "number" ? r.tvlUsd : null,
        apy: typeof r?.apy === "number" ? r.apy : null,
      });
      edges.push({
        from: subj,
        to: id,
        relation: "has_yield_pool",
        evidence: ["DefiLlama yields pools API"],
      });
    }

    try {
      await upsertConnectionsGraphNeo4j({
        rootProtocolId: rootId,
        subjectProtocolId: subj,
        connections: { nodes, edges, evidence: ["yields_pools_materialized"] },
      });

      // Merge into protocol extraJson (do not overwrite other extra fields)
      await upsertProtocolExtraNeo4j({
        id: rootId,
        extra: { protocol: { poolsFromYields, poolsFromYieldsMeta: { source: "https://yields.llama.fi/pools", updatedAt: new Date().toISOString(), mode: "all_top100" } } },
      });

      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[yields-graph] failed slug=${slug}:`, String(e?.message || e));
    }

    await sleep(DELAY_MS);
  }

  console.log(`[yields-graph] ok=${ok} failed=${failed}`);
}

main()
  .catch((e) => {
    console.error("[yields-graph] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

