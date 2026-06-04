import path from "path";
import fs from "fs";
import initSqlJs from "sql.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function dbPath() {
  const p = env("INTELLIGENCE_TRACES_PATH", path.join(process.cwd(), "data", "intelligence-traces.sqlite"));
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
  fs.writeFileSync(p, Buffer.from(db.export()));
}

async function getDb() {
  if (dbSingleton) return dbSingleton;
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

export async function intelligenceTracesInit() {
  const db = await getDb();
  run(
    db,
    `create table if not exists intelligence_traces (
      id text primary key,
      kind text not null,
      query text,
      label text,
      trace_json text not null,
      created_at text not null default (datetime('now'))
    )`
  );
  run(db, `create index if not exists idx_intel_traces_kind on intelligence_traces(kind)`);
  run(db, `create index if not exists idx_intel_traces_created on intelligence_traces(created_at desc)`);
  persistDb(db);
}

export async function saveIntelligenceTrace(trace) {
  await intelligenceTracesInit();
  const db = await getDb();
  const payload = trace && typeof trace === "object" ? trace : {};
  const id = String(payload.id || `saved_${Date.now()}`);
  const kind = String(payload.kind || "unknown");
  const query = String(payload.query || "");
  const label = String(payload.label || query || kind);
  const json = JSON.stringify(payload);
  run(
    db,
    `insert or replace into intelligence_traces (id, kind, query, label, trace_json, created_at)
     values (?, ?, ?, ?, ?, datetime('now'))`,
    [id, kind, query, label, json]
  );
  persistDb(db);
  return { id, kind, query, label, savedAt: new Date().toISOString() };
}

export async function getIntelligenceTrace(id) {
  await intelligenceTracesInit();
  const db = await getDb();
  const row = get(db, `select trace_json as traceJson from intelligence_traces where id = ?`, [String(id)]);
  if (!row?.traceJson) return null;
  try {
    return JSON.parse(row.traceJson);
  } catch {
    return null;
  }
}

export async function listIntelligenceTraces({ kind, limit = 30 } = {}) {
  await intelligenceTracesInit();
  const db = await getDb();
  const lim = Math.min(100, Math.max(1, Number(limit) || 30));
  const k = kind ? String(kind).trim() : "";
  const sql = k
    ? `select id, kind, query, label, created_at as createdAt from intelligence_traces where kind = ? order by created_at desc limit ?`
    : `select id, kind, query, label, created_at as createdAt from intelligence_traces order by created_at desc limit ?`;
  return k ? all(db, sql, [k, lim]) : all(db, sql, [lim]);
}
