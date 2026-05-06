import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, getProtocolGraphNeo4jById, upsertProtocolExtraNeo4j } from "../db/neo4jGraph.js";
import { localGraphInit, upsertProtocolExtra as upsertProtocolExtraLocal } from "../db/localGraph.js";

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
  const project = String(p?.project || "").trim();
  const base = meta ? `${sym} • ${meta}` : sym || "Pool";
  return `${base} (${chain || project || "unknown"})`.trim();
}

async function main() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();
  await localGraphInit().catch(() => {});

  const LIMIT = Number(process.env.TOP_N || process.env.N || 100) || 100;
  const DELAY_MS = Number(process.env.DELAY_MS || 40) || 40;

  const top = await fetchTopProtocols({ limit: LIMIT });
  const slugs = new Set(top.map((p) => String(p?.slug || "").trim().toLowerCase()).filter(Boolean));

  const pools = await fetchAllYieldsPools();
  const byProject = new Map(); // slug -> pools[]
  for (const row of pools) {
    const proj = String(row?.project || "").trim().toLowerCase();
    if (!proj || !slugs.has(proj)) continue;
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(row);
  }

  let ok = 0;
  let failed = 0;

  for (const p of top) {
    const slug = String(p?.slug || "").trim().toLowerCase();
    if (!slug) continue;
    const id = `defillama:${slug}`;

    const rows = (byProject.get(slug) || [])
      .filter((x) => typeof x?.tvlUsd === "number" && isFinite(x.tvlUsd) && x.tvlUsd > 0)
      .sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))
      .slice(0, 15);

    // Merge into existing extraJson (don’t overwrite exposures/audits etc.)
    let existingExtra = {};
    try {
      const g = await getProtocolGraphNeo4jById({ id });
      if (g?.hit && g?.protocol?.extraJson) existingExtra = JSON.parse(g.protocol.extraJson) || {};
    } catch {
      existingExtra = {};
    }

    const poolsFromYields = rows.map((r) => ({
      name: cleanPoolLabel(r),
      chain: r?.chain || null,
      project: r?.project || null,
      tvlUsd: typeof r?.tvlUsd === "number" ? r.tvlUsd : null,
      apy: typeof r?.apy === "number" ? r.apy : null,
      exposure: r?.exposure || null,
      stablecoin: Boolean(r?.stablecoin),
      ilRisk: r?.ilRisk || null,
    }));

    const next = {
      ...(existingExtra && typeof existingExtra === "object" ? existingExtra : {}),
      protocol: {
        ...((existingExtra && typeof existingExtra === "object" ? existingExtra.protocol : null) || {}),
        poolsFromYields,
        poolsFromYieldsMeta: {
          source: "https://yields.llama.fi/pools",
          updatedAt: new Date().toISOString(),
        },
      },
    };

    try {
      await upsertProtocolExtraNeo4j({ id, extra: next });
      // Also write to local graph so pool search works even without Neo4j (e.g. Vercel).
      await upsertProtocolExtraLocal({ id, name: String(p?.name || ""), url: String(p?.url || ""), extra: next }).catch(() => {});
      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[yields-top] failed slug=${slug}:`, String(e?.message || e));
    }

    await sleep(DELAY_MS);
  }

  console.log(`[yields-top] ok=${ok} failed=${failed} projects_with_pools=${byProject.size}`);
}

main()
  .catch((e) => {
    console.error("[yields-top] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

