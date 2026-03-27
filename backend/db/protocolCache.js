import crypto from "crypto";

function stableStringify(value) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v == null) return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const keys = Object.keys(v).sort();
    const out = {};
    for (const k of keys) out[k] = norm(v[k]);
    return out;
  };
  return JSON.stringify(norm(value));
}

export function computeProtocolCacheHash(analysis) {
  const a = analysis || {};
  const p = a.protocol || {};
  const tokens = Array.isArray(a.tokenLiquidity) ? a.tokenLiquidity : [];
  const contracts = Array.isArray(a.contracts) ? a.contracts : [];

  const core = {
    protocol: {
      name: p.name || null,
      url: p.url || null,
      chains: Array.isArray(p.chains) ? p.chains : null,
      audits: p.audits || null,
      auditsVerified: p.auditsVerified || null,
      totalRaisedUsd: p.totalRaisedUsd || null,
    },
    tvlUsd: a?.tvl?.valueUsd ?? null,
    volume24h: a?.txsPerDay?.value ?? null,
    tokenLiquidity: tokens.map((t) => ({
      token: t?.token || t?.asset || t?.symbol || null,
      address: t?.contractAddress || t?.tokenAddress || t?.address || null,
      liquidityUsd: typeof t?.liquidityUsd === "number" ? t.liquidityUsd : null,
      liquidityLabel: t?.liquidityLabel || null,
    })),
    contracts: contracts.map((c) => ({
      label: c?.label || null,
      network: c?.network || null,
      address: c?.address || null,
    })),
  };

  const s = stableStringify(core);
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function stripWalletSpecificFields(analysis) {
  const a = analysis && typeof analysis === "object" ? { ...analysis } : {};
  delete a.wallet;
  delete a.allocations;
  delete a.exposures;
  return a;
}

export function protocolKeyFrom({ defillama, origin }) {
  const slug = typeof defillama?.slug === "string" && defillama.slug.trim() ? defillama.slug.trim() : null;
  if (slug) return { protocolKey: `defillama:${slug}`, slug, originHost: safeHost(origin) };
  const host = safeHost(origin);
  return { protocolKey: host ? `host:${host}` : `url:${String(origin || "")}`, slug: null, originHost: host };
}

function safeHost(url) {
  try {
    const u = new URL(String(url || ""));
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function getSql() {
  // Lazy import so local runs don't require Postgres.
  const { sql } = await import("@vercel/postgres");
  return sql;
}

export async function protocolCacheInit() {
  const sql = await getSql();
  await sql`
    create table if not exists protocol_cache (
      protocol_key text primary key,
      slug text null,
      origin_host text null,
      protocol_name text null,
      protocol_url text null,
      analysis_json jsonb not null,
      analysis_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `;
}

export async function protocolCacheGetLatest({ protocolKey }) {
  const sql = await getSql();
  const r = await sql`
    select protocol_key, slug, origin_host, protocol_name, protocol_url,
           analysis_json, analysis_hash, created_at, updated_at
    from protocol_cache
    where protocol_key = ${protocolKey}
    limit 1;
  `;
  return r?.rows?.[0] || null;
}

export async function protocolCacheUpsert({ protocolKey, slug, originHost, protocolName, protocolUrl, analysisJson, analysisHash }) {
  const sql = await getSql();
  const r = await sql`
    insert into protocol_cache (protocol_key, slug, origin_host, protocol_name, protocol_url, analysis_json, analysis_hash)
    values (${protocolKey}, ${slug}, ${originHost}, ${protocolName}, ${protocolUrl}, ${analysisJson}, ${analysisHash})
    on conflict (protocol_key) do update set
      slug = excluded.slug,
      origin_host = excluded.origin_host,
      protocol_name = excluded.protocol_name,
      protocol_url = excluded.protocol_url,
      analysis_json = excluded.analysis_json,
      analysis_hash = excluded.analysis_hash,
      updated_at = now()
    returning protocol_key, updated_at;
  `;
  return r?.rows?.[0] || null;
}

