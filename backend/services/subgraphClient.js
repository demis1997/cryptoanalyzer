/**
 * The Graph gateway client (subgraph + deployment endpoints).
 */
import fetch from "node-fetch";

export function subgraphEnabled() {
  return (
    /^(1|true|yes|on)$/i.test(String(process.env.POOL_SUBGRAPH || "1").trim()) &&
    Boolean(String(process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY || "").trim())
  );
}

function apiKey() {
  return String(process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY || "").trim();
}

export function subgraphUrl({ subgraphId, deploymentId } = {}) {
  const key = apiKey();
  if (!key) return null;
  if (deploymentId) {
    return `https://gateway.thegraph.com/api/${key}/deployments/id/${deploymentId}`;
  }
  if (subgraphId) {
    return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${subgraphId}`;
  }
  return null;
}

export async function querySubgraph(endpoint, query, variables = {}) {
  const url = String(endpoint || "").trim();
  if (!url || !query) return { ok: false, data: null, error: "missing_endpoint" };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/subgraph" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.errors?.length) {
    return {
      ok: false,
      data: json?.data || null,
      error: json?.errors?.[0]?.message || `http_${resp.status}`,
    };
  }
  return { ok: true, data: json?.data || null, error: null };
}
