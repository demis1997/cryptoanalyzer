import fetch from "node-fetch";
import { searchWeb, fetchPageText } from "./webResearch.js";
import { parsePoolPageMetrics } from "./poolPageParse.js";

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_DUNE_SEARCH || "1").trim());
}

function duneApiEnabled() {
  return Boolean(String(process.env.DUNE_API_KEY || "").trim());
}

const DUNE_CHAIN = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  polygon: "polygon",
};

async function pollDuneExecution(executionId, { maxWaitMs = 45_000 } = {}) {
  const key = String(process.env.DUNE_API_KEY || "").trim();
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const statusResp = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/status`, {
      headers: { "X-DUNE-API-KEY": key },
    });
    if (!statusResp.ok) return null;
    const status = await statusResp.json().catch(() => ({}));
    const state = String(status?.state || "").toUpperCase();
    if (state === "QUERY_STATE_COMPLETED") {
      const resResp = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
        headers: { "X-DUNE-API-KEY": key },
      });
      if (!resResp.ok) return null;
      return resResp.json().catch(() => null);
    }
    if (state === "QUERY_STATE_FAILED" || state === "FAILED") return null;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * Optional: run parameterized Dune query for vault TVL (set DUNE_VAULT_TVL_QUERY_ID).
 * Query should accept {{vault_address}} and {{chain}} parameters.
 */
export async function duneVaultTvlQuery(vaultAddress, chain = "ethereum") {
  if (!duneApiEnabled()) return null;
  const queryId = String(process.env.DUNE_VAULT_TVL_QUERY_ID || "").trim();
  if (!queryId) return null;
  const addr = String(vaultAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const key = String(process.env.DUNE_API_KEY || "").trim();
  const ch = DUNE_CHAIN[String(chain || "").toLowerCase()] || "ethereum";
  try {
    const resp = await fetch(`https://api.dune.com/api/v1/query/${queryId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DUNE-API-KEY": key },
      body: JSON.stringify({
        query_parameters: { vault_address: addr, chain: ch },
        performance: "medium",
      }),
    });
    if (!resp.ok) return { ok: false, error: `execute_${resp.status}` };
    const exec = await resp.json().catch(() => ({}));
    const executionId = exec?.execution_id;
    if (!executionId) return { ok: false, error: "no_execution_id" };
    const results = await pollDuneExecution(executionId);
    const row = results?.result?.rows?.[0];
    const tvl = Number(row?.tvl_usd ?? row?.tvl ?? row?.total_usd);
    if (!isFinite(tvl) || tvl <= 0) return { ok: false, error: "no_tvl_row" };
    return {
      ok: true,
      tvlUsd: tvl,
      source: "dune",
      evidence: `Dune query ${queryId} for ${addr.slice(0, 10)}…`,
      url: `https://dune.com/queries/${queryId}`,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Web search + scrape Dune dashboards for pool TVL / metrics (Dune "AI" via search summaries).
 */
export async function gatherDunePoolResearch({
  poolLabel,
  symbol,
  issuerSlug,
  vaultAddress,
  chain,
} = {}) {
  if (!enabled()) return { enabled: false, searches: [], formatted: "", hints: {} };

  const label = String(poolLabel || "").trim();
  const sym = String(symbol || "").trim();
  const slug = String(issuerSlug || "").trim();
  const addr = String(vaultAddress || "").toLowerCase();
  const queries = [
    `site:dune.com ${slug} ${sym} pool TVL liquidity deposits`,
    `site:dune.com ${label} ${sym} vault`,
    addr ? `site:dune.com ${addr.slice(0, 10)} ${sym} TVL` : null,
    `dune analytics ${slug} ${sym} ${label} pool total liquidity`,
    `dune.com dashboard ${slug} ${sym} utilization LLTV`,
  ].filter(Boolean);

  const maxQ = Number(process.env.POOL_DUNE_SEARCH_QUERIES || 3) || 3;
  const searches = [];
  for (const q of [...new Set(queries)].slice(0, maxQ)) {
    searches.push(await searchWeb(q, { maxResults: 5 }));
  }

  const hints = {};
  const lines = [];
  const duneUrls = new Set();

  for (const s of searches) {
    lines.push(`\n### Dune search (${s.provider}): ${s.query}`);
    if (s.answer) lines.push(`Dune AI summary: ${s.answer}`);
    for (const h of (s.hits || []).slice(0, 5)) {
      lines.push(`- ${h.title} | ${h.url}`);
      if (h.snippet) lines.push(`  ${String(h.snippet).slice(0, 280)}`);
      if (/dune\.com/i.test(h.url || "")) duneUrls.add(h.url);
      const parsed = parsePoolPageMetrics(`${h.title} ${h.snippet}`);
      if (parsed.poolTvlUsd && !hints.poolTvlUsd) {
        hints.poolTvlUsd = parsed.poolTvlUsd;
        hints.tvlSource = "dune";
        hints.tvlEvidence = `Dune search snippet: "${(h.snippet || h.title || "").slice(0, 80)}"`;
      }
      Object.assign(hints, parsed);
    }
  }

  for (const url of [...duneUrls].slice(0, 2)) {
    const page = await fetchPageText(url, { maxChars: 5000 });
    if (page?.ok && page.text) {
      lines.push(`\n### Dune page scrape: ${url}`);
      lines.push(page.text.slice(0, 2000));
      const parsed = parsePoolPageMetrics(page.text);
      if (parsed.poolTvlUsd) {
        hints.poolTvlUsd = parsed.poolTvlUsd;
        hints.tvlSource = "dune";
        hints.tvlEvidence = `Parsed from Dune dashboard page`;
      }
      Object.assign(hints, parsed);
    }
  }

  if (addr && duneApiEnabled()) {
    const dq = await duneVaultTvlQuery(addr, chain);
    if (dq?.ok && dq.tvlUsd) {
      hints.poolTvlUsd = dq.tvlUsd;
      hints.tvlSource = "dune";
      hints.tvlEvidence = dq.evidence;
      lines.push(`\n### Dune API query: TVL $${Math.round(dq.tvlUsd).toLocaleString()}`);
    }
  }

  return {
    enabled: true,
    searches,
    formatted: lines.join("\n").trim(),
    hints,
    providers: [...new Set(searches.map((s) => s.provider))],
  };
}
