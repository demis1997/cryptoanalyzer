import neo4j from "neo4j-driver";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function truthyEnv(name) {
  return /^(1|true|yes|on)$/i.test(env(name));
}

function normalizeChain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "ethereum";
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("optimism")) return "optimism";
  if (s.includes("base")) return "base";
  if (s.includes("polygon")) return "polygon";
  if (s.includes("avalanche")) return "avalanche";
  if (s.includes("bsc") || s.includes("bnb")) return "bsc";
  if (s.includes("scroll")) return "scroll";
  if (s.includes("mantle")) return "mantle";
  if (s.includes("zksync")) return "zksync";
  if (s.includes("linea")) return "linea";
  return s.replace(/[^a-z0-9_-]+/g, "_").slice(0, 24) || "ethereum";
}

export function neo4jEnabled() {
  // Enable explicitly or when URI is present.
  return truthyEnv("ENABLE_NEO4J_GRAPH") || Boolean(env("NEO4J_URI"));
}

function neo4jConfig() {
  const uri = env("NEO4J_URI");
  const user = env("NEO4J_USER", "neo4j");
  const password = env("NEO4J_PASSWORD");
  const database = env("NEO4J_DATABASE", "neo4j");
  if (!uri || !user || !password) {
    throw new Error("Neo4j is not configured. Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD (and optionally NEO4J_DATABASE).");
  }
  return { uri, user, password, database };
}

let driverSingleton = null;
let driverMeta = null;

function getDriver() {
  if (driverSingleton) return { driver: driverSingleton, meta: driverMeta };
  const cfg = neo4jConfig();
  const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
    maxConnectionPoolSize: 10,
  });
  driverSingleton = driver;
  driverMeta = { uri: cfg.uri, database: cfg.database };
  return { driver, meta: driverMeta };
}

export async function neo4jInit() {
  const { driver, meta } = getDriver();
  const cfg = neo4jConfig();
  // Fail fast with a clear error when credentials/URI are wrong.
  try {
    await driver.verifyConnectivity();
  } catch (err) {
    const msg = String(err?.message || err || "");
    const code = err?.code ? String(err.code) : "";
    const hint =
      /unauthorized|authentication/i.test(msg)
        ? "Aura rejected credentials. Reset the Aura instance DB password and update NEO4J_PASSWORD in .env (username is usually neo4j)."
        : /enotfound|eai_again|dns/i.test(msg)
          ? "DNS/network error. Confirm NEO4J_URI and that your network allows outbound neo4j+s (TLS)."
          : /certificate|tls|ssl/i.test(msg)
            ? "TLS error. Aura requires neo4j+s:// (or bolt+s://). Ensure the URI scheme matches Aura connection details."
            : "";
    throw new Error(
      `Neo4j connectivity check failed${code ? ` (${code})` : ""}: ${msg}${hint ? ` — ${hint}` : ""}`
    );
  }
  const session = driver.session({ database: cfg.database });
  try {
    // Neo4j 5 supports IF NOT EXISTS for constraints. These are safe to run repeatedly.
    await session.run(
      `
      CREATE CONSTRAINT protocol_id IF NOT EXISTS
      FOR (p:Protocol) REQUIRE p.id IS UNIQUE
      `
    );
    await session.run(
      `
      CREATE CONSTRAINT token_key IF NOT EXISTS
      FOR (t:Token) REQUIRE (t.chain, t.address) IS UNIQUE
      `
    );
    await session.run(
      `
      CREATE CONSTRAINT contract_key IF NOT EXISTS
      FOR (c:Contract) REQUIRE (c.chain, c.address) IS UNIQUE
      `
    );
    await session.run(
      `
      CREATE CONSTRAINT auditor_name IF NOT EXISTS
      FOR (a:Auditor) REQUIRE a.name IS UNIQUE
      `
    );
    await session.run(
      `
      CREATE CONSTRAINT doc_url IF NOT EXISTS
      FOR (d:DocPage) REQUIRE d.url IS UNIQUE
      `
    );
    await session.run(
      `
      CREATE CONSTRAINT asset_id IF NOT EXISTS
      FOR (a:Asset) REQUIRE a.id IS UNIQUE
      `
    );
    return { ok: true, meta };
  } finally {
    await session.close();
  }
}

export async function neo4jClose() {
  if (!driverSingleton) return;
  const d = driverSingleton;
  driverSingleton = null;
  driverMeta = null;
  await d.close();
}

export async function searchProtocolsNeo4j({ q, limit = 25 } = {}) {
  const query = String(q || "").trim();
  if (!query) return [];
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));

  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    const res = await session.run(
      `
      MATCH (p:Protocol)
      WHERE
        NOT p.id STARTS WITH 'protocol:'
        AND (
        toLower(coalesce(p.name,'')) CONTAINS toLower($q)
        OR toLower(coalesce(p.url,'')) CONTAINS toLower($q)
        OR toLower(coalesce(p.id,'')) CONTAINS toLower($q)
        )
      RETURN p.id AS id, p.name AS name, p.url AS url, p.updatedAt AS updatedAt
      ORDER BY updatedAt DESC
      LIMIT $limit
      `,
      { q: query, limit: neo4j.int(lim) }
    );
    return res.records.map((r) => ({
      id: r.get("id"),
      name: r.get("name") || null,
      url: r.get("url") || null,
      updatedAt: r.get("updatedAt") || null,
    }));
  } finally {
    await session.close();
  }
}

export async function protocolExistsNeo4j({ id }) {
  const pid = String(id || "").trim();
  if (!pid) return false;
  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    const r = await session.run(`MATCH (p:Protocol {id:$id}) RETURN p.id AS id LIMIT 1`, { id: pid });
    return r.records.length > 0;
  } finally {
    await session.close();
  }
}

export async function findProtocolIdByUrlNeo4j({ url }) {
  const u = String(url || "").trim();
  if (!u) return null;
  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    const r = await session.run(
      `MATCH (p:Protocol) WHERE p.url = $url RETURN p.id AS id ORDER BY p.updatedAt DESC LIMIT 1`,
      { url: u }
    );
    return r.records.length ? (r.records[0].get("id") || null) : null;
  } finally {
    await session.close();
  }
}

/**
 * Related protocols via stored ecosystem graph (ECOSYSTEM_LINK). Returns protocol nodes/edges only.
 * Starts from (root:Protocol {id}) and prefers routing through :SUBJECT_NODE when present.
 */
export async function getRelatedProtocolsNeo4j({ id, hops = 4, limitNodes = 220, limitEdges = 450 } = {}) {
  const pid = String(id || "").trim();
  if (!pid) return { ok: false, error: "Missing id" };
  const maxHops = Math.min(6, Math.max(1, Number(hops) || 4));

  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    // Return protocol nodes reachable via ecosystem graph even when paths traverse tokens/contracts.
    // Then optionally include protocol<->protocol edges among the discovered protocol set.
    const res = await session.run(
      `
      MATCH (root:Protocol {id:$id})
      OPTIONAL MATCH (root)-[:SUBJECT_NODE]->(subject:Protocol)
      WITH root, coalesce(subject, root) AS start
      MATCH path = (start)-[:ECOSYSTEM_LINK*1..${maxHops}]-(m)
      UNWIND nodes(path) AS n
      WITH root, start, collect(DISTINCT n) AS allNodes
      WITH root, start, [x IN allNodes WHERE x:Protocol] AS protos
      WITH root, start, protos
      OPTIONAL MATCH (a:Protocol)-[e:ECOSYSTEM_LINK]->(b:Protocol)
      WHERE a IN protos AND b IN protos
      RETURN
        root.id AS rootId,
        start.id AS startId,
        [x IN protos | {id:x.id, name: x.name, url: x.url}] AS nodes,
        collect(DISTINCT {from:a.id, to:b.id, relation:e.relation, evidence:e.evidence}) AS edges
      `,
      { id: pid }
    );

    if (!res.records.length) return { ok: true, hit: false, id: pid, graph: { nodes: [], edges: [] } };

    const rec = res.records[0];
    const nodes = Array.isArray(rec.get("nodes")) ? rec.get("nodes") : [];
    const edges = Array.isArray(rec.get("edges")) ? rec.get("edges") : [];
    const cleanEdges = edges.filter((e) => e && e.from && e.to);

    return {
      ok: true,
      hit: nodes.length > 0,
      id: pid,
      rootId: rec.get("rootId"),
      startId: rec.get("startId"),
      graph: {
        nodes: nodes.slice(0, limitNodes),
        edges: cleanEdges.slice(0, limitEdges),
      },
    };
  } finally {
    await session.close();
  }
}

const POOL_TYPES = new Set(["pool", "market", "vault", "amm", "lp", "staking"]);

export async function searchPoolsNeo4j({ q, limit = 25 } = {}) {
  const query = String(q || "").trim();
  if (!query) return [];
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));

  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    const res = await session.run(
      `
      MATCH (c:Contract)
      WHERE
        toLower(coalesce(c.label,'')) CONTAINS toLower($q)
        AND (
          toLower(coalesce(c.type,'')) IN ['pool','market','vault','amm','lp','staking']
          OR toLower(coalesce(c.label,'')) CONTAINS 'pool'
          OR toLower(coalesce(c.label,'')) CONTAINS 'market'
          OR toLower(coalesce(c.label,'')) CONTAINS 'vault'
        )
      RETURN c.chain AS chain, c.address AS address, c.label AS label, c.type AS type, c.updatedAt AS updatedAt
      ORDER BY updatedAt DESC
      LIMIT $limit
      `,
      { q: query, limit: neo4j.int(lim) }
    );
    return res.records.map((r) => ({
      chain: r.get("chain") || "ethereum",
      address: r.get("address") || null,
      label: r.get("label") || null,
      type: r.get("type") || null,
      updatedAt: r.get("updatedAt") || null,
    }));
  } finally {
    await session.close();
  }
}

export async function getPoolNeighborhoodNeo4j({ chain = "ethereum", address, hops = 4, limitProtocols = 160, limitPools = 120 } = {}) {
  const ch = String(chain || "ethereum").trim().toLowerCase() || "ethereum";
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return { ok: false, error: "Bad address" };
  const maxHops = Math.min(6, Math.max(1, Number(hops) || 4));

  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  try {
    const res = await session.run(
      `
      MATCH (root:Contract {chain:$chain, address:$address})
      OPTIONAL MATCH path = (root)-[:ECOSYSTEM_LINK*1..${maxHops}]-(m)
      UNWIND (CASE WHEN path IS NULL THEN [root] ELSE nodes(path) END) AS n
      WITH root, collect(DISTINCT n) AS allNodes
      WITH root,
        [x IN allNodes WHERE x:Protocol] AS protos,
        [x IN allNodes WHERE x:Contract AND (toLower(coalesce(x.type,'')) IN ['pool','market','vault','amm','lp','staking'] OR toLower(coalesce(x.label,'')) CONTAINS 'pool' OR toLower(coalesce(x.label,'')) CONTAINS 'market' OR toLower(coalesce(x.label,'')) CONTAINS 'vault')] AS pools
      RETURN
        root.chain AS chain,
        root.address AS address,
        root.label AS label,
        root.type AS type,
        [p IN protos | {id:p.id, name:p.name, url:p.url}] AS protocols,
        [c IN pools | {chain:c.chain, address:c.address, label:c.label, type:c.type}] AS pools
      `,
      { chain: ch, address: addr }
    );

    if (!res.records.length) return { ok: true, hit: false, chain: ch, address: addr };
    const rec = res.records[0];
    const protocols = Array.isArray(rec.get("protocols")) ? rec.get("protocols") : [];
    const pools = Array.isArray(rec.get("pools")) ? rec.get("pools") : [];

    return {
      ok: true,
      hit: true,
      root: {
        chain: rec.get("chain") || ch,
        address: rec.get("address") || addr,
        label: rec.get("label") || null,
        type: rec.get("type") || null,
      },
      protocols: protocols.slice(0, limitProtocols),
      pools: pools.slice(0, limitPools),
    };
  } finally {
    await session.close();
  }
}

function protocolIdFrom({ origin, defillamaSlug }) {
  const s = String(defillamaSlug || "").trim();
  if (s) return `defillama:${s}`;
  try {
    const u = new URL(String(origin || ""));
    return `url:${u.origin}`;
  } catch {
    return `url:${String(origin || "").trim()}`;
  }
}

export async function getProtocolGraphNeo4j({ origin, defillamaSlug }) {
  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const id = protocolIdFrom({ origin, defillamaSlug });
  const session = driver.session({ database: cfg.database });
  try {
    const pRes = await session.run(
      `MATCH (p:Protocol {id:$id}) RETURN p LIMIT 1`,
      { id }
    );
    if (!pRes.records.length) return { ok: true, hit: false, id };
    const p = pRes.records[0].get("p").properties || {};

    const tokensRes = await session.run(
      `
      MATCH (p:Protocol {id:$id})-[:HAS_TOKEN]->(t:Token)
      RETURN t.chain AS chain, t.address AS address, t.symbol AS symbol
      `,
      { id }
    );
    const contractsRes = await session.run(
      `
      MATCH (p:Protocol {id:$id})-[:HAS_CONTRACT]->(c:Contract)
      RETURN c.chain AS chain, c.address AS address, c.label AS label, c.type AS type
      `,
      { id }
    );
    const auditorsRes = await session.run(
      `
      MATCH (p:Protocol {id:$id})-[:AUDITED_BY]->(a:Auditor)
      RETURN a.name AS name
      `,
      { id }
    );
    const docsRes = await session.run(
      `
      MATCH (p:Protocol {id:$id})-[:HAS_DOC_PAGE]->(d:DocPage)
      RETURN d.url AS url, d.hash AS hash, d.fetchedAt AS fetchedAt
      `,
      { id }
    );

    return {
      ok: true,
      hit: true,
      id,
      protocol: {
        id: String(p.id || id),
        name: p.name || null,
        url: p.url || null,
        defillamaSlug: p.defillamaSlug || null,
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
        connectionsJson: p.connectionsJson || null,
        architectureJson: p.architectureJson || null,
        extraJson: p.extraJson || null,
        tokens: tokensRes.records.map((r) => ({
          chain: r.get("chain") || "ethereum",
          address: r.get("address") || null,
          symbol: r.get("symbol") || null,
        })),
        contracts: contractsRes.records.map((r) => ({
          chain: r.get("chain") || "ethereum",
          address: r.get("address") || null,
          label: r.get("label") || null,
          type: r.get("type") || null,
        })),
        auditors: auditorsRes.records.map((r) => ({ name: r.get("name") })),
        docPages: docsRes.records.map((r) => ({
          url: r.get("url"),
          hash: r.get("hash") || null,
          fetchedAt: r.get("fetchedAt") || null,
        })),
      },
    };
  } finally {
    await session.close();
  }
}

export async function getProtocolGraphNeo4jById({ id }) {
  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const pid = String(id || "").trim();
  if (!pid) return { ok: false, error: "Missing id" };
  const session = driver.session({ database: cfg.database });
  try {
    const pRes = await session.run(`MATCH (p:Protocol {id:$id}) RETURN p LIMIT 1`, { id: pid });
    if (!pRes.records.length) return { ok: true, hit: false, id: pid };
    const p = pRes.records[0].get("p").properties || {};

    const tokensRes = await session.run(
      `MATCH (p:Protocol {id:$id})-[:HAS_TOKEN]->(t:Token) RETURN t.chain AS chain, t.address AS address, t.symbol AS symbol`,
      { id: pid }
    );
    const contractsRes = await session.run(
      `MATCH (p:Protocol {id:$id})-[:HAS_CONTRACT]->(c:Contract) RETURN c.chain AS chain, c.address AS address, c.label AS label, c.type AS type`,
      { id: pid }
    );
    const auditorsRes = await session.run(
      `MATCH (p:Protocol {id:$id})-[:AUDITED_BY]->(a:Auditor) RETURN a.name AS name`,
      { id: pid }
    );
    const docsRes = await session.run(
      `MATCH (p:Protocol {id:$id})-[:HAS_DOC_PAGE]->(d:DocPage) RETURN d.url AS url, d.hash AS hash, d.fetchedAt AS fetchedAt`,
      { id: pid }
    );

    return {
      ok: true,
      hit: true,
      id: pid,
      protocol: {
        id: String(p.id || pid),
        name: p.name || null,
        url: p.url || null,
        defillamaSlug: p.defillamaSlug || null,
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
        connectionsJson: p.connectionsJson || null,
        architectureJson: p.architectureJson || null,
        extraJson: p.extraJson || null,
        tokens: tokensRes.records.map((r) => ({
          chain: r.get("chain") || "ethereum",
          address: r.get("address") || null,
          symbol: r.get("symbol") || null,
        })),
        contracts: contractsRes.records.map((r) => ({
          chain: r.get("chain") || "ethereum",
          address: r.get("address") || null,
          label: r.get("label") || null,
          type: r.get("type") || null,
        })),
        auditors: auditorsRes.records.map((r) => ({ name: r.get("name") })),
        docPages: docsRes.records.map((r) => ({
          url: r.get("url"),
          hash: r.get("hash") || null,
          fetchedAt: r.get("fetchedAt") || null,
        })),
      },
    };
  } finally {
    await session.close();
  }
}

export async function upsertProtocolGraphNeo4j({
  protocol,
  tokens = [],
  contracts = [],
  auditors = [],
  docPages = [],
  connections = null,
  architecture = null,
  extra = null,
} = {}) {
  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const p = protocol || {};
  const id = String(p.id || protocolIdFrom({ origin: p.url, defillamaSlug: p.defillamaSlug }));
  const now = new Date().toISOString();

  const session = driver.session({ database: cfg.database });
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `
        MERGE (p:Protocol {id:$id})
        ON CREATE SET p.createdAt = $now
        SET
          p.name = $name,
          p.url = $url,
          p.defillamaSlug = $defillamaSlug,
          p.updatedAt = $now,
          p.connectionsJson = $connectionsJson,
          p.architectureJson = $architectureJson,
          p.extraJson = $extraJson
        `,
        {
          id,
          now,
          name: p.name || null,
          url: p.url || null,
          defillamaSlug: p.defillamaSlug || null,
          connectionsJson: connections ? JSON.stringify(connections) : null,
          architectureJson: architecture ? JSON.stringify(architecture) : null,
          extraJson: extra ? JSON.stringify(extra) : null,
        }
      );

      for (const t of Array.isArray(tokens) ? tokens : []) {
        const addr = String(t?.address || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
        const chain = normalizeChain(t?.chain || t?.network || "ethereum");
        await tx.run(
          `
          MATCH (p:Protocol {id:$id})
          MERGE (t:Token {chain:$chain, address:$address})
          SET t.symbol = coalesce($symbol, t.symbol)
          MERGE (p)-[:HAS_TOKEN]->(t)
          `,
          { id, chain, address: addr, symbol: t?.symbol || t?.token || null }
        );
      }

      for (const c of Array.isArray(contracts) ? contracts : []) {
        const addr = String(c?.address || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
        const chain = normalizeChain(c?.chain || c?.network || "ethereum");
        await tx.run(
          `
          MATCH (p:Protocol {id:$id})
          MERGE (c:Contract {chain:$chain, address:$address})
          SET
            c.label = coalesce($label, c.label),
            c.type = coalesce($type, c.type)
          MERGE (p)-[:HAS_CONTRACT]->(c)
          `,
          { id, chain, address: addr, label: c?.label || null, type: c?.type || null }
        );
      }

      for (const a of Array.isArray(auditors) ? auditors : []) {
        const name = String(a?.name || a || "").trim();
        if (!name) continue;
        await tx.run(
          `
          MATCH (p:Protocol {id:$id})
          MERGE (a:Auditor {name:$name})
          MERGE (p)-[:AUDITED_BY]->(a)
          `,
          { id, name }
        );
      }

      for (const d of Array.isArray(docPages) ? docPages : []) {
        const url = String(d?.url || "").trim();
        if (!url) continue;
        await tx.run(
          `
          MATCH (p:Protocol {id:$id})
          MERGE (d:DocPage {url:$url})
          SET d.hash = $hash, d.fetchedAt = $fetchedAt
          MERGE (p)-[:HAS_DOC_PAGE]->(d)
          `,
          { id, url, hash: d?.hash || null, fetchedAt: d?.fetchedAt || now }
        );
      }
    });

    // Store ecosystem graph as first-class nodes/edges (separate transaction).
    if (connections && typeof connections === "object") {
      try {
        const subjectProtocolId =
          connections?.nodes?.find((n) => n && (n.kind === "protocol" || n.type === "protocol") && String(n.id || "").startsWith("protocol:"))
            ?.id || null;
        await upsertConnectionsGraphNeo4j({
          rootProtocolId: id,
          subjectProtocolId,
          connections,
        });
      } catch {
        // ignore ecosystem failures; base protocol persistence succeeded
      }
    }

    return { ok: true, id };
  } finally {
    await session.close();
  }
}

function isEthAddress(v) {
  return /^0x[a-f0-9]{40}$/.test(String(v || "").trim().toLowerCase());
}

function inferConnNodeLabel(n) {
  return String(n?.label || n?.name || n?.symbol || n?.address || n?.id || "").trim().slice(0, 120) || null;
}

/**
 * Materialize `connections` as first-class nodes/edges in Neo4j.
 * - Protocol nodes: (Protocol {id:"protocol:slug"})
 * - Address nodes: Token/Contract keyed by (chain,address)
 * - Non-address assets: (Asset {id:"token:slug"}) etc
 * - Edges: (a)-[:ECOSYSTEM_LINK {relation, evidence}]->(b)
 */
export async function upsertConnectionsGraphNeo4j({ rootProtocolId, subjectProtocolId, connections } = {}) {
  if (!connections || typeof connections !== "object") return { ok: true, skipped: true };
  const nodes = Array.isArray(connections.nodes) ? connections.nodes : [];
  const edges = Array.isArray(connections.edges) ? connections.edges : [];
  if (!nodes.length && !edges.length) return { ok: true, skipped: true };

  const { driver } = getDriver();
  const cfg = neo4jConfig();
  const session = driver.session({ database: cfg.database });
  const now = new Date().toISOString();

  const nodeIndex = new Map(); // idLower -> normalized descriptor
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const id = String(n.id || n.address || "").trim().toLowerCase();
    if (!id) continue;
    const kind = String(n.kind || n.type || "").trim().toLowerCase();
    nodeIndex.set(id, { id, kind, raw: n });
  }

  const mergeNodeCypher = async (tx, n) => {
    const id = n.id;
    const kind = n.kind;
    const label = inferConnNodeLabel(n.raw);
    const network = String(n.raw?.network || "").trim() || null;
    const symbol = n.raw?.symbol ? String(n.raw.symbol).slice(0, 24) : null;

    if (id.startsWith("protocol:")) {
      await tx.run(
        `
        MERGE (p:Protocol {id:$id})
        ON CREATE SET p.createdAt = coalesce(p.createdAt, $now)
        SET p.name = coalesce($label, p.name), p.updatedAt = $now
        `,
        { id, label, now }
      );
      return;
    }

    if (isEthAddress(id) && kind === "token") {
      await tx.run(
        `
        MERGE (t:Token {chain:$chain, address:$address})
        SET t.symbol = coalesce($symbol, t.symbol), t.label = coalesce($label, t.label), t.updatedAt = $now
        `,
        { chain: "ethereum", address: id, symbol, label, now }
      );
      return;
    }

    if (isEthAddress(id)) {
      const cType = kind || (String(n.raw?.type || "").trim().toLowerCase() || null);
      await tx.run(
        `
        MERGE (c:Contract {chain:$chain, address:$address})
        SET c.label = coalesce($label, c.label), c.type = coalesce($type, c.type), c.updatedAt = $now
        `,
        { chain: "ethereum", address: id, label, type: cType, now }
      );
      return;
    }

    await tx.run(
      `
      MERGE (a:Asset {id:$id})
      SET a.label = coalesce($label, a.label), a.kind = coalesce($kind, a.kind), a.network = coalesce($network, a.network), a.updatedAt = $now
      `,
      { id, label, kind: kind || null, network, now }
    );
  };

  const matchNodeRef = (id) => {
    const sid = String(id || "").trim().toLowerCase();
    const n = nodeIndex.get(sid);
    if (!n) return null;
    if (sid.startsWith("protocol:")) return { refLabel: "Protocol", key: { id: sid } };
    if (isEthAddress(sid) && n.kind === "token") return { refLabel: "Token", key: { chain: "ethereum", address: sid } };
    if (isEthAddress(sid)) return { refLabel: "Contract", key: { chain: "ethereum", address: sid } };
    return { refLabel: "Asset", key: { id: sid } };
  };

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  try {
    // Batch writes to avoid transaction timeouts on Aura
    const nodeBatches = chunk([...nodeIndex.values()], 500);
    for (const batch of nodeBatches) {
      await session.executeWrite(async (tx) => {
        for (const n of batch) await mergeNodeCypher(tx, n);
      });
    }

    // Optionally link root protocol id (defillama:url) to the subject protocol node (protocol:slug)
    const root = String(rootProtocolId || "").trim();
    const subj = String(subjectProtocolId || "").trim().toLowerCase();
    if (root && subj && subj.startsWith("protocol:")) {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
          MATCH (r:Protocol {id:$root})
          MERGE (s:Protocol {id:$subj})
          MERGE (r)-[:SUBJECT_NODE]->(s)
          `,
          { root, subj }
        );
      });
    }

    const edgeBatches = chunk(edges, 500);
    for (const batch of edgeBatches) {
      await session.executeWrite(async (tx) => {
        const rows = [];
        for (const e of batch) {
          if (!e || typeof e !== "object") continue;
          const f = matchNodeRef(e.from);
          const t = matchNodeRef(e.to);
          if (!f || !t) continue;
          const rel = String(e.relation || "associated").trim().slice(0, 64);
          const evidence = Array.isArray(e.evidence) ? e.evidence.map((x) => String(x).slice(0, 220)).slice(0, 8) : [];
          const evStr = evidence.length ? JSON.stringify(evidence) : null;
          rows.push({
            fromKind: String(f.refLabel || "").toLowerCase(),
            fromId: f.key.id || null,
            fromChain: f.key.chain || null,
            fromAddress: f.key.address || null,
            toKind: String(t.refLabel || "").toLowerCase(),
            toId: t.key.id || null,
            toChain: t.key.chain || null,
            toAddress: t.key.address || null,
            relation: rel,
            evidence: evStr,
            now,
          });
        }
        if (!rows.length) return;

        await tx.run(
          `
          UNWIND $rows AS row
          MATCH (a)
          WHERE
            (row.fromKind = "protocol" AND a:Protocol AND a.id = row.fromId) OR
            (row.fromKind = "contract" AND a:Contract AND a.chain = row.fromChain AND a.address = row.fromAddress) OR
            (row.fromKind = "token" AND a:Token AND a.chain = row.fromChain AND a.address = row.fromAddress) OR
            (row.fromKind = "asset" AND a:Asset AND a.id = row.fromId)
          MATCH (b)
          WHERE
            (row.toKind = "protocol" AND b:Protocol AND b.id = row.toId) OR
            (row.toKind = "contract" AND b:Contract AND b.chain = row.toChain AND b.address = row.toAddress) OR
            (row.toKind = "token" AND b:Token AND b.chain = row.toChain AND b.address = row.toAddress) OR
            (row.toKind = "asset" AND b:Asset AND b.id = row.toId)
          MERGE (a)-[r:ECOSYSTEM_LINK {relation: row.relation}]->(b)
          SET r.evidence = coalesce(row.evidence, r.evidence), r.updatedAt = row.now
          `,
          { rows }
        );
      });
    }

    return { ok: true, nodes: nodeIndex.size, edges: edges.length };
  } finally {
    await session.close();
  }
}

