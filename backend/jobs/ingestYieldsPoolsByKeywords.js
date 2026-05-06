import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, getProtocolGraphNeo4jById, upsertProtocolExtraNeo4j } from "../db/neo4jGraph.js";
import { localGraphInit, upsertProtocolExtra as upsertProtocolExtraLocal } from "../db/localGraph.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
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
  return `${base} (${chain || "unknown"})`.trim();
}

async function readExistingExtra(id) {
  try {
    const g = await getProtocolGraphNeo4jById({ id });
    if (g?.hit && g?.protocol?.extraJson) return JSON.parse(g.protocol.extraJson) || {};
  } catch {
    // ignore
  }
  return {};
}

async function main() {
  const keywords = String(process.env.KEYWORDS || "pendle,aave,kelp,compound,morpho,midas")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const DELAY_MS = Number(process.env.DELAY_MS || 40) || 40;
  const MAX_POOLS_PER_PROJECT = Number(process.env.MAX_POOLS || 2000) || 2000;
  const TOP_POOLS_PER_PROTOCOL = Number(process.env.TOP_POOLS || 40) || 40;
  const SKIP_EXISTING = truthy(process.env.SKIP_EXISTING || "0");

  if (!neo4jEnabled()) throw new Error("Neo4j not enabled.");
  await neo4jInit();
  await localGraphInit().catch(() => {});

  const pools = await fetchAllYieldsPools();

  // Group by yields project (usually close to defillama slug)
  const byProject = new Map();
  for (const r of pools) {
    const proj = String(r?.project || "").trim().toLowerCase();
    if (!proj) continue;
    if (!keywords.some((k) => proj.includes(k))) continue;
    if (!byProject.has(proj)) byProject.set(proj, []);
    const arr = byProject.get(proj);
    if (arr.length < MAX_POOLS_PER_PROJECT) arr.push(r);
  }

  console.log(`[yields-keywords] keywords=${keywords.join(",")} projects=${byProject.size}`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const [proj, rows] of byProject.entries()) {
    const id = `defillama:${proj}`;

    if (SKIP_EXISTING) {
      const existing = await readExistingExtra(id);
      const have = Array.isArray(existing?.protocol?.poolsFromYields) && existing.protocol.poolsFromYields.length > 0;
      if (have) {
        skipped += 1;
        continue;
      }
    }

    const sorted = rows
      .filter((x) => typeof x?.tvlUsd === "number" && isFinite(x.tvlUsd) && x.tvlUsd > 0)
      .sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))
      .slice(0, TOP_POOLS_PER_PROTOCOL);

    const poolsFromYields = sorted.map((r) => ({
      name: cleanPoolLabel(r),
      chain: r?.chain || null,
      project: r?.project || null,
      tvlUsd: typeof r?.tvlUsd === "number" ? r.tvlUsd : null,
      apy: typeof r?.apy === "number" ? r.apy : null,
      exposure: r?.exposure || null,
      stablecoin: Boolean(r?.stablecoin),
      ilRisk: r?.ilRisk || null,
      // Keep the yields pool id (uuid) as a stable identifier (not an address)
      yieldPoolId: r?.pool || null,
    }));

    const existingExtra = await readExistingExtra(id);
    const next = {
      ...(existingExtra && typeof existingExtra === "object" ? existingExtra : {}),
      protocol: {
        ...((existingExtra && typeof existingExtra === "object" ? existingExtra.protocol : null) || {}),
        poolsFromYields,
        poolsFromYieldsMeta: {
          source: "https://yields.llama.fi/pools",
          updatedAt: new Date().toISOString(),
          mode: "keywords",
          keywords,
        },
      },
    };

    try {
      await upsertProtocolExtraNeo4j({ id, extra: next });
      await upsertProtocolExtraLocal({ id, name: proj, url: null, extra: next }).catch(() => {});
      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[yields-keywords] failed project=${proj}:`, String(e?.message || e));
    }

    await sleep(DELAY_MS);
  }

  console.log(`[yields-keywords] ok=${ok} skipped=${skipped} failed=${failed}`);
}

main()
  .catch((e) => {
    console.error("[yields-keywords] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

