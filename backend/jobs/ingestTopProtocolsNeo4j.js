import "dotenv/config";
import fetch from "node-fetch";
import { neo4jEnabled, neo4jInit, neo4jClose, protocolExistsNeo4j } from "../db/neo4jGraph.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "cryptoanalyzer/neo4j-ingest" },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, body, { timeoutMs = 240_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/neo4j-ingest" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}: ${text.slice(0, 900)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

function isRetryableNetworkError(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("socket hang up") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("the operation was aborted") ||
    m.includes("aborted") ||
    m.includes("eai_again") ||
    m.includes("enotfound") ||
    m.includes("fetch failed")
  );
}

async function postJsonWithRetry(url, body, { tries = 3, timeoutMs = 240_000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await postJson(url, body, { timeoutMs });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (attempt >= tries || !isRetryableNetworkError(msg)) throw e;
      const backoffMs = 500 * Math.pow(2, attempt - 1);
      console.warn(`[neo4j-ingest] retry ${attempt}/${tries} after error: ${msg}`);
      await sleep(backoffMs);
    }
  }
  throw lastErr || new Error("retry failed");
}

/**
 * Ingest top protocols into Neo4j by driving the existing /api/llm-analyze pipeline.
 *
 * Requirements:
 * - `server.js` must be running (default `http://localhost:3000`).
 * - Neo4j env configured (`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`) and enabled (`ENABLE_NEO4J_GRAPH=1`).
 * - LLM env configured if you want auditors/ecosystem extraction (see `.env.example`).
 */
async function main() {
  const apiBase = env("API_BASE", "http://localhost:3000");
  const limit = Math.max(1, Math.min(250, Number(env("TOP_N", "100")) || 100));
  const perProtocolDelayMs = Math.max(0, Number(env("DELAY_MS", "400")) || 0);
  const forceRefresh = env("FORCE_REFRESH", "1") === "1";
  const tries = Math.max(1, Math.min(6, Number(env("TRIES", "3")) || 3));
  const skipExisting = env("SKIP_EXISTING", "1") === "1";
  const callTimeoutMs = Math.max(30_000, Number(env("CALL_TIMEOUT_MS", "240000")) || 240_000);
  const excludeCategories = new Set(
    String(env("EXCLUDE_CATEGORIES", "CEX"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  if (!neo4jEnabled()) {
    throw new Error("Neo4j is not enabled. Set ENABLE_NEO4J_GRAPH=1 (and Neo4j credentials envs).");
  }
  await neo4jInit();

  const protocols = await fetchJson("https://api.llama.fi/protocols", { timeoutMs: 30_000 });
  const sorted = (Array.isArray(protocols) ? protocols : [])
    .filter((p) => p && typeof p === "object")
    .filter((p) => {
      const cat = String(p?.category || "").trim();
      if (!cat) return true;
      return !excludeCategories.has(cat);
    })
    .filter((p) => typeof p?.tvl === "number" && isFinite(p.tvl) && p.tvl > 0)
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
    .slice(0, limit);

  console.log(`[neo4j-ingest] protocols=${sorted.length} apiBase=${apiBase} forceRefresh=${forceRefresh}`);

  let ok = 0;
  let fail = 0;
  const errors = [];

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const name = String(p?.name || p?.slug || "").trim() || `protocol_${i + 1}`;
    const urlRaw = String(p?.url || "").trim();
    const slug = String(p?.slug || "").trim();

    // Some DefiLlama entries have no website URL. Fall back to the DefiLlama protocol page.
    const url = urlRaw || (slug ? `https://defillama.com/protocol/${encodeURIComponent(slug)}` : "");
    if (!url) {
      fail++;
      errors.push({ slug, name, error: "missing_url_and_slug" });
      continue;
    }

    try {
      const id = slug ? `defillama:${slug}` : null;
      if (skipExisting && id) {
        const exists = await protocolExistsNeo4j({ id }).catch(() => false);
        if (exists) {
          ok++;
          console.log(`[${i + 1}/${sorted.length}] SKIP ${name} (${slug || "no-slug"})`);
          if (perProtocolDelayMs) await sleep(perProtocolDelayMs);
          continue;
        }
      }

      const r = await postJsonWithRetry(
        `${apiBase}/api/llm-analyze`,
        { url, forceRefresh },
        { tries, timeoutMs: callTimeoutMs }
      );
      const persisted = Boolean(r?.neo4j?.persisted);
      if (!persisted) {
        throw new Error(r?.neo4j?.error || r?.error || "neo4j not persisted");
      }
      ok++;
      console.log(`[${i + 1}/${sorted.length}] OK ${name} (${slug || "no-slug"})`);
    } catch (err) {
      fail++;
      const msg = String(err?.message || err);
      errors.push({ slug, name, url, error: msg.slice(0, 800) });
      console.warn(`[${i + 1}/${sorted.length}] FAIL ${name} (${slug || "no-slug"}): ${msg}`);
    }

    if (perProtocolDelayMs) await sleep(perProtocolDelayMs);
  }

  console.log(`[neo4j-ingest] done ok=${ok} fail=${fail}`);
  if (errors.length) {
    console.log("[neo4j-ingest] sample errors:", errors.slice(0, 8));
  }
}

main()
  .catch((e) => {
    console.error("[neo4j-ingest] fatal:", e?.message ? String(e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await neo4jClose().catch(() => {});
  });

