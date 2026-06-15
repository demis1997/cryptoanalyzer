/**
 * Granular trace steps for web search, page crawl, and block explorer lookups.
 */

function hostFromUrl(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function providerLabel(provider) {
  const p = String(provider || "").toLowerCase();
  if (p === "tavily") return "Tavily";
  if (p === "duckduckgo") return "DuckDuckGo";
  if (p === "disabled" || p === "none") return "web search (off)";
  return provider || "web search";
}

function shortUrl(url, max = 72) {
  const u = String(url || "");
  if (u.length <= max) return u;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 25)}…` : parsed.pathname;
    return `${parsed.hostname}${path}${parsed.search ? "…" : ""}`;
  } catch {
    return `${u.slice(0, max)}…`;
  }
}

export function traceWebSearch(trace, { provider, query, hits = [], answer = null } = {}) {
  if (!trace?.step) return;
  const q = String(query || "").trim();
  if (!q) return;
  const topHits = (hits || []).filter((h) => h?.url).slice(0, 6);
  trace.step(`Web search · ${providerLabel(provider)}`, {
    kind: "source",
    phase: "web_search",
    detail: [
      `Query: ${q.slice(0, 160)}`,
      answer ? `Summary: ${String(answer).slice(0, 120)}` : null,
      topHits.length ? `${topHits.length} result(s)` : "no results",
    ]
      .filter(Boolean)
      .join(" · "),
    sources: topHits.map((h) => ({
      label: String(h.title || hostFromUrl(h.url) || "result").slice(0, 56),
      url: h.url,
    })),
  });
}

export function traceCrawlPage(trace, { url, rendered = false, ok = true, textLength = 0, metrics = {}, error = null } = {}) {
  if (!trace?.step || !url) return;
  const host = hostFromUrl(url) || "page";
  const parts = [
    rendered ? "Playwright render" : "HTTP fetch",
    ok ? `${textLength.toLocaleString()} chars` : "failed",
  ];
  if (metrics.poolTvlUsd != null) parts.push(`TVL $${Math.round(metrics.poolTvlUsd).toLocaleString()}`);
  if (metrics.utilization != null) parts.push(`util ${(metrics.utilization * 100).toFixed(1)}%`);
  if (metrics.lltv != null) parts.push(`LLTV ${metrics.lltv}%`);
  if (error) parts.push(String(error).slice(0, 80));

  trace.step(`Crawl · ${host}`, {
    kind: ok ? "source" : "error",
    phase: "crawl",
    detail: `${shortUrl(url)} · ${parts.join(" · ")}`,
    sources: [{ label: shortUrl(url, 96), url }],
  });
}

export function traceLightFetch(trace, { url, ok = true, error = null } = {}) {
  if (!trace?.step || !url) return;
  trace.step(`Fetch · ${hostFromUrl(url) || "page"}`, {
    kind: ok ? "source" : "error",
    phase: "fetch",
    detail: ok ? shortUrl(url) : `${shortUrl(url)} · ${error || "failed"}`,
    sources: [{ label: shortUrl(url, 96), url }],
  });
}

export function traceBlockExplorer(trace, { label, url, detail } = {}) {
  if (!trace?.step) return;
  trace.step(label || "Block explorer", {
    kind: "source",
    phase: "explorer",
    detail: detail || shortUrl(url),
    sources: url ? [{ label: hostFromUrl(url) || "explorer", url }] : [],
  });
}

export function traceProtocolApi(trace, { label, url, detail } = {}) {
  if (!trace?.step) return;
  trace.step(label || "Protocol API", {
    kind: "source",
    phase: "protocol_api",
    detail: detail || "",
    sources: url ? [{ label: shortUrl(url, 80), url }] : [],
  });
}
