import path from "path";
import fs from "fs";
import initSqlJs from "sql.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function dbPath() {
  const p = env("LOCAL_GRAPH_PATH", path.join(process.cwd(), "data", "graph.sqlite"));
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

let dbSingleton = null;
let sqlSingleton = null;

async function getSql() {
  if (sqlSingleton) return sqlSingleton;
  sqlSingleton = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });
  return sqlSingleton;
}

function readDbFile() {
  const p = dbPath();
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch {
    // ignore
  }
  return null;
}

function persistDb(db) {
  const p = dbPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(p, Buffer.from(data));
}

async function getDb() {
  if (dbSingleton) return dbSingleton;
  const p = dbPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const SQL = await getSql();
  const file = readDbFile();
  dbSingleton = file ? new SQL.Database(file) : new SQL.Database();
  return dbSingleton;
}

function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows[0] || null;
}

export function protocolIdFrom({ origin, defillamaSlug }) {
  const s = String(defillamaSlug || "").trim();
  if (s) return `defillama:${s}`;
  try {
    const u = new URL(String(origin || ""));
    return `url:${u.origin}`;
  } catch {
    return `url:${String(origin || "").trim()}`;
  }
}

export async function localGraphInit() {
  const db = await getDb();
  db.exec(`
    create table if not exists protocols (
      id text primary key,
      name text,
      url text,
      defillama_slug text,
      connections_json text,
      architecture_json text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_protocols_url on protocols(url);

    create table if not exists tokens (
      chain text not null,
      address text not null,
      symbol text,
      primary key (chain, address)
    );

    create table if not exists contracts (
      chain text not null,
      address text not null,
      label text,
      type text,
      primary key (chain, address)
    );

    create table if not exists auditors (
      name text primary key
    );

    create table if not exists protocol_tokens (
      protocol_id text not null,
      chain text not null,
      address text not null,
      primary key (protocol_id, chain, address)
    );

    create table if not exists protocol_contracts (
      protocol_id text not null,
      chain text not null,
      address text not null,
      primary key (protocol_id, chain, address)
    );

    create table if not exists protocol_auditors (
      protocol_id text not null,
      auditor_name text not null,
      primary key (protocol_id, auditor_name)
    );

    create table if not exists doc_pages (
      url text primary key,
      hash text,
      fetched_at text
    );

    create table if not exists protocol_doc_pages (
      protocol_id text not null,
      doc_url text not null,
      primary key (protocol_id, doc_url)
    );
  `);
  persistDb(db);
  return { ok: true, path: dbPath() };
}

export async function getProtocolGraph({ origin, defillamaSlug }) {
  const db = await getDb();
  const id = protocolIdFrom({ origin, defillamaSlug });
  const p = get(db, `select * from protocols where id = ? limit 1`, [id]);
  if (!p) return { ok: true, hit: false, id };

  const tokens = all(
    db,
    `select t.chain, t.address, t.symbol
     from protocol_tokens pt join tokens t
     on pt.chain=t.chain and pt.address=t.address
     where pt.protocol_id=?`,
    [id]
  );
  const contracts = all(
    db,
    `select c.chain, c.address, c.label, c.type
     from protocol_contracts pc join contracts c
     on pc.chain=c.chain and pc.address=c.address
     where pc.protocol_id=?`,
    [id]
  );
  const auditors = all(
    db,
    `select a.name
     from protocol_auditors pa join auditors a
     on pa.auditor_name=a.name
     where pa.protocol_id=?`,
    [id]
  );
  const docPages = all(
    db,
    `select d.url, d.hash, d.fetched_at as fetchedAt
     from protocol_doc_pages pd join doc_pages d
     on pd.doc_url=d.url
     where pd.protocol_id=?`,
    [id]
  );

  return {
    ok: true,
    hit: true,
    id,
    protocol: {
      id: p.id,
      name: p.name,
      url: p.url,
      defillamaSlug: p.defillama_slug,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      connectionsJson: p.connections_json,
      architectureJson: p.architecture_json,
      tokens,
      contracts,
      auditors,
      docPages,
    },
  };
}

export async function upsertProtocolGraph({
  protocol,
  tokens = [],
  contracts = [],
  auditors = [],
  docPages = [],
  connections = null,
  architecture = null,
} = {}) {
  const db = await getDb();
  const p = protocol || {};
  const id = String(p.id || protocolIdFrom({ origin: p.url, defillamaSlug: p.defillamaSlug }));
  const now = new Date().toISOString();

  run(
    db,
    `
insert into protocols (id, name, url, defillama_slug, connections_json, architecture_json, created_at, updated_at)
values (?, ?, ?, ?, ?, ?, ?, ?)
on conflict(id) do update set
  name=excluded.name,
  url=excluded.url,
  defillama_slug=excluded.defillama_slug,
  connections_json=excluded.connections_json,
  architecture_json=excluded.architecture_json,
  updated_at=excluded.updated_at
    `,
    [
      id,
      p.name || null,
      p.url || null,
      p.defillamaSlug || null,
      connections ? JSON.stringify(connections) : null,
      architecture ? JSON.stringify(architecture) : null,
      now,
      now,
    ]
  );

  // Upsert tokens + mapping
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const addr = String(t?.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    run(
      db,
      `insert into tokens (chain,address,symbol) values (?,?,?)
       on conflict(chain,address) do update set symbol=coalesce(excluded.symbol, tokens.symbol)`,
      ["ethereum", addr, t?.symbol || t?.token || null]
    );
    run(
      db,
      `insert into protocol_tokens (protocol_id, chain, address) values (?,?,?)
       on conflict(protocol_id,chain,address) do nothing`,
      [id, "ethereum", addr]
    );
  }

  // Upsert contracts + mapping
  for (const c of Array.isArray(contracts) ? contracts : []) {
    const addr = String(c?.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    run(
      db,
      `insert into contracts (chain,address,label,type) values (?,?,?,?)
       on conflict(chain,address) do update set
         label=coalesce(excluded.label, contracts.label),
         type=coalesce(excluded.type, contracts.type)`,
      ["ethereum", addr, c?.label || null, c?.type || null]
    );
    run(
      db,
      `insert into protocol_contracts (protocol_id, chain, address) values (?,?,?)
       on conflict(protocol_id,chain,address) do nothing`,
      [id, "ethereum", addr]
    );
  }

  // Upsert auditors + mapping
  for (const a of Array.isArray(auditors) ? auditors : []) {
    const name = String(a?.name || a || "").trim();
    if (!name) continue;
    run(db, `insert into auditors (name) values (?) on conflict(name) do nothing`, [name]);
    run(
      db,
      `insert into protocol_auditors (protocol_id, auditor_name) values (?,?)
       on conflict(protocol_id,auditor_name) do nothing`,
      [id, name]
    );
  }

  // Doc pages
  for (const d of Array.isArray(docPages) ? docPages : []) {
    const url = String(d?.url || "").trim();
    if (!url) continue;
    run(
      db,
      `insert into doc_pages (url,hash,fetched_at) values (?,?,?)
       on conflict(url) do update set hash=excluded.hash, fetched_at=excluded.fetched_at`,
      [url, d?.hash || null, d?.fetchedAt || now]
    );
    run(
      db,
      `insert into protocol_doc_pages (protocol_id, doc_url) values (?,?)
       on conflict(protocol_id,doc_url) do nothing`,
      [id, url]
    );
  }

  persistDb(db);
  return { ok: true, id, path: dbPath() };
}

export async function closeLocalGraph() {
  if (dbSingleton) {
    const db = dbSingleton;
    dbSingleton = null;
    try {
      persistDb(db);
    } catch {
      // ignore
    }
    db.close();
  }
}

