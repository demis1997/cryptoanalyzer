/**
 * Inventory Neo4j graph contents (counts, samples). Run: node scripts/neo4j-audit.mjs
 */
import "dotenv/config";
import neo4j from "neo4j-driver";
import { normalizeNeo4jUri, neo4jEnabled } from "../backend/db/neo4jGraph.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function int(v) {
  if (v == null) return 0;
  if (typeof v === "object" && typeof v.toNumber === "function") return v.toNumber();
  return Number(v) || 0;
}

function hostFromUri(uri) {
  try {
    return new URL(uri.replace(/^bolt\+s:/i, "https:").replace(/^bolt:/i, "http:")).hostname;
  } catch {
    return "(unknown)";
  }
}

if (!neo4jEnabled()) {
  console.error("Neo4j not configured. Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env");
  process.exit(1);
}

const uri = normalizeNeo4jUri(env("NEO4J_URI"));
const user = env("NEO4J_USER", "neo4j");
const password = env("NEO4J_PASSWORD");
const database = env("NEO4J_DATABASE", "neo4j");
const hostMatch = uri.match(/\/\/([a-f0-9]+)\.databases\.neo4j\.io/i);
const dbCandidates = [...new Set([database, hostMatch?.[1], "neo4j"].filter(Boolean))];

if (!uri || !password) {
  console.error("Missing NEO4J_URI or NEO4J_PASSWORD");
  process.exit(1);
}

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

let session = null;
let activeDb = null;
try {
  await driver.verifyConnectivity();
  let lastErr = null;
  for (const db of dbCandidates) {
    const s = driver.session({ database: db });
    try {
      await s.run("RETURN 1");
      session = s;
      activeDb = db;
      break;
    } catch (e) {
      lastErr = e;
      await s.close().catch(() => {});
    }
  }
  if (!session) throw lastErr || new Error("No database found");
  console.log(`Connected: ${hostFromUri(uri)} (database: ${activeDb})\n`);

  const nodeLabels = await session.run(`
    MATCH (n)
    UNWIND labels(n) AS label
    RETURN label, count(*) AS c
    ORDER BY c DESC
  `);
  const relTypes = await session.run(`
    MATCH ()-[r]->()
    RETURN type(r) AS type, count(*) AS c
    ORDER BY c DESC
  `);
  const totalNodes = await session.run(`MATCH (n) RETURN count(n) AS c`);
  const totalRels = await session.run(`MATCH ()-[r]->() RETURN count(r) AS c`);

  console.log("=== Totals ===");
  console.log(`Nodes: ${int(totalNodes.records[0]?.get("c"))}`);
  console.log(`Relationships: ${int(totalRels.records[0]?.get("c"))}\n`);

  console.log("=== Nodes by label ===");
  for (const rec of nodeLabels.records) {
    console.log(`  ${rec.get("label")}: ${int(rec.get("c"))}`);
  }

  console.log("\n=== Relationships by type ===");
  for (const rec of relTypes.records) {
    console.log(`  ${rec.get("type")}: ${int(rec.get("c"))}`);
  }

  const poolContracts = await session.run(`
    MATCH (c:Contract)
    WHERE toLower(coalesce(c.type,'')) IN ['pool','market','vault','amm','lp','staking']
       OR toLower(coalesce(c.label,'')) CONTAINS 'pool'
       OR toLower(coalesce(c.label,'')) CONTAINS 'market'
       OR toLower(coalesce(c.label,'')) CONTAINS 'vault'
    RETURN count(c) AS c
  `);
  const contractTypes = await session.run(`
    MATCH (c:Contract)
    RETURN coalesce(c.type,'(none)') AS type, count(*) AS c
    ORDER BY c DESC LIMIT 20
  `);
  const assetKinds = await session.run(`
    MATCH (a:Asset)
    RETURN coalesce(a.kind,'(none)') AS kind, count(*) AS c
    ORDER BY c DESC LIMIT 20
  `);

  console.log("\n=== Pools / markets (Contract nodes) ===");
  console.log(`  Pool-like contracts: ${int(poolContracts.records[0]?.get("c"))}`);
  console.log("  Contract types (top):");
  for (const rec of contractTypes.records) {
    console.log(`    ${rec.get("type")}: ${int(rec.get("c"))}`);
  }

  console.log("\n=== Assets (yield pools etc.) ===");
  for (const rec of assetKinds.records) {
    console.log(`  ${rec.get("kind")}: ${int(rec.get("c"))}`);
  }

  const protocols = await session.run(`
    MATCH (p:Protocol)
    RETURN p.id AS id, coalesce(p.name, p.id) AS name, p.url AS url
    ORDER BY name
    LIMIT 80
  `);
  console.log(`\n=== Protocols (up to 80 of ${int((await session.run(`MATCH (p:Protocol) RETURN count(p) AS c`)).records[0]?.get("c"))}) ===`);
  for (const rec of protocols.records) {
    const name = String(rec.get("name") || "").slice(0, 48);
    const id = String(rec.get("id") || "").slice(0, 56);
    console.log(`  ${name} — ${id}`);
  }

  const poolSample = await session.run(`
    MATCH (c:Contract)
    WHERE toLower(coalesce(c.type,'')) IN ['pool','market','vault','amm','lp','staking']
       OR toLower(coalesce(c.label,'')) CONTAINS 'pool'
    RETURN c.chain AS chain, c.address AS address, c.label AS label, c.type AS type
    ORDER BY c.label
    LIMIT 25
  `);
  console.log("\n=== Sample pool-like contracts (25) ===");
  for (const rec of poolSample.records) {
    console.log(
      `  ${String(rec.get("label") || "?").slice(0, 40)} [${rec.get("type")}] ${rec.get("chain")}:${String(rec.get("address") || "").slice(0, 12)}…`
    );
  }

  const assetSample = await session.run(`
    MATCH (a:Asset)
    RETURN a.id AS id, a.kind AS kind, a.label AS label, a.project AS project
    ORDER BY a.label
    LIMIT 25
  `);
  console.log("\n=== Sample assets (25) ===");
  for (const rec of assetSample.records) {
    console.log(`  ${rec.get("kind")}: ${String(rec.get("label") || rec.get("id")).slice(0, 50)} (${rec.get("project") || ""})`);
  }

  const ecoEdges = await session.run(`
    MATCH ()-[e:ECOSYSTEM_LINK]->()
    RETURN count(e) AS c
  `);
  console.log(`\n=== Ecosystem graph ===`);
  console.log(`  ECOSYSTEM_LINK edges: ${int(ecoEdges.records[0]?.get("c"))}`);
} catch (err) {
  console.error("Audit failed:", err?.message || err);
  process.exit(1);
} finally {
  await session.close();
  await driver.close();
}
