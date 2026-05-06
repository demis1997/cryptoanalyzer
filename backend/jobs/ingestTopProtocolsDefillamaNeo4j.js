import "dotenv/config";
import fetch from "node-fetch";
import {
  neo4jEnabled,
  neo4jInit,
  neo4jClose,
  upsertProtocolGraphNeo4j,
  protocolExistsNeo4j,
} from "../db/neo4jGraph.js";
import { getDefiLlamaProtocolApiDetail } from "../services/defillama.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
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

function safeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  try {
    return new URL(s).toString();
  } catch {
    try {
      return new URL(`https://${s}`).toString();
    } catch {
      return null;
    }
  }
}

function assetIdForSymbol(sym) {
  const s = String(sym || "").trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "");
  return s ? `asset:token:${s}` : null;
}

async function main() {
  if (!neo4jEnabled()) throw new Error("Neo4j not enabled (set NEO4J_URI/USER/PASSWORD).");
  await neo4jInit();

  const LIMIT = Number(process.env.TOP_N || process.env.N || 100) || 100;
  const SKIP_EXISTING = truthy(process.env.SKIP_EXISTING || "0");
  const DELAY_MS = Number(process.env.DELAY_MS || 120) || 120;

  const protocols = await fetchTopProtocols({ limit: LIMIT });
  console.log(`[defillama-top] fetched=${protocols.length} skip_existing=${SKIP_EXISTING ? 1 : 0}`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of protocols) {
    const slug = String(p?.slug || "").trim();
    if (!slug) continue;
    const id = `defillama:${slug}`;
    const name = String(p?.name || slug);
    const url = safeUrl(p?.url) || (slug ? `https://defillama.com/protocol/${encodeURIComponent(slug)}` : null);

    if (SKIP_EXISTING) {
      const exists = await protocolExistsNeo4j({ id }).catch(() => false);
      if (exists) {
        skipped += 1;
        continue;
      }
    }

    let detail = null;
    try {
      detail = await getDefiLlamaProtocolApiDetail(slug);
    } catch {
      detail = null;
    }

    const tvlUsd = Number(p?.tvl) || null;
    const category = String(p?.category || detail?.category || "").trim() || null;
    const chains = Array.isArray(p?.chains) ? p.chains : Array.isArray(detail?.chains) ? detail.chains : [];
    const description = String(p?.description || detail?.description || "").trim() || null;
    const auditLinks = Array.isArray(detail?.auditLinks) ? detail.auditLinks : Array.isArray(p?.audit_links) ? p.audit_links : [];
    const topTokenLiquidity = Array.isArray(detail?.topTokenLiquidity) ? detail.topTokenLiquidity : [];

    // Build a lightweight connections graph: Protocol -> Asset(TokenSymbol) exposures.
    const subj = `protocol:${slug.toLowerCase()}`;
    const nodes = [{ kind: "protocol", id: subj, label: name, network: "Multi-chain" }];
    const edges = [];
    const seenAsset = new Set();

    for (const t of topTokenLiquidity.slice(0, 50)) {
      const sym = String(t?.token || "").trim();
      if (!sym) continue;
      const assetId = assetIdForSymbol(sym);
      if (!assetId) continue;
      if (!seenAsset.has(assetId)) {
        seenAsset.add(assetId);
        nodes.push({ kind: "asset", id: assetId, label: `Token: ${sym}`, network: "Multi-chain" });
      }
      edges.push({
        from: subj,
        to: assetId,
        relation: "exposed_to",
        evidence: [`DefiLlama tokensInUsd (latest)`, detail?.apiUrl || `https://api.llama.fi/protocol/${slug}`],
      });
    }

    // Surface user-friendly links as doc pages (audits + website + defillama page).
    const docPages = [];
    const addDoc = (u) => {
      const uu = safeUrl(u);
      if (!uu) return;
      docPages.push({ url: uu, evidence: "DefiLlama" });
    };
    addDoc(url);
    addDoc(`https://defillama.com/protocol/${slug}`);
    (auditLinks || []).slice(0, 12).forEach(addDoc);

    try {
      await upsertProtocolGraphNeo4j({
        protocol: { id, name, url, defillamaSlug: slug },
        tokens: [],
        contracts: [],
        auditors: [],
        docPages,
        connections: { nodes, edges, evidence: ["defillama_tokensInUsd_exposures"] },
        architecture: null,
        extra: {
          protocol: {
            name,
            slug,
            url,
            tvlUsd,
            category,
            chains,
            description,
            auditLinks,
            topTokenLiquidity,
            fetchedAt: new Date().toISOString(),
            source: "defillama",
          },
        },
      });
      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[defillama-top] failed slug=${slug}:`, String(e?.message || e));
    }

    await sleep(DELAY_MS);
  }

  console.log(`[defillama-top] ok=${ok} skipped=${skipped} failed=${failed}`);
}

main()
  .catch((e) => {
    console.error("[defillama-top] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

