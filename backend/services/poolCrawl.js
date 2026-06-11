import { buildDocsCandidates } from "./docsSnippets.js";
import {
  extractAddressesFromText,
  fetchHtmlWithOptionalRender,
  htmlToVisibleText,
} from "./htmlCrawl.js";
import { parsePoolPageContent } from "./poolPageStructuredParse.js";
import { mergePageMetricsIntoHints } from "./poolPageParse.js";

function poolPlaywrightEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.POOL_PLAYWRIGHT_CRAWL || "1").trim());
}

function clamp(s, max = 5000) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const s = String(u || "").trim();
    if (!/^https?:\/\//i.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isSpecificPoolPage(pathname) {
  return /\/(market|vault|pool|reserve|markets|earn\/|position|comet|isolation-mode)\//i.test(
    String(pathname || "")
  );
}

/**
 * URLs to crawl for a pool marketing / earn page (pool URL first, then integrations/docs on same site).
 */
export function buildPoolCrawlCandidates(poolUrl) {
  let u;
  try {
    u = new URL(String(poolUrl || "").trim());
  } catch {
    return [];
  }
  const origin = u.origin;
  const host = u.hostname.replace(/^www\./i, "");
  const parts = host.split(".").filter(Boolean);
  const registrable = parts.length >= 2 ? parts.slice(-2).join(".") : host;
  const paths = (u.pathname || "").split("/").filter(Boolean);

  if (isSpecificPoolPage(u.pathname)) {
    const list = [u.href];
    if (paths.length > 2) {
      list.push(`${origin}/${paths.slice(0, -1).join("/")}`);
    }
    return uniqueUrls(list);
  }

  const list = [u.href];
  if (paths.length > 1) {
    list.push(`${origin}/${paths.slice(0, -1).join("/")}`);
  }
  list.push(
    `${origin}/earn`,
    `${origin}/vault`,
    `${origin}/pools`,
    `${origin}/integrations`,
    `${origin}/partners`,
    `${origin}/ecosystem`,
    `${u.protocol}//docs.${registrable}/`,
    `${u.protocol}//docs.${registrable}/integrations`
  );
  for (const c of buildDocsCandidates(origin)) {
    if (/integrat|partner|ecosystem|contract|vault|earn|pool|developer|build|composab/i.test(c)) {
      list.push(c);
    }
  }
  return uniqueUrls(list).slice(0, 14);
}

function parsePageMetrics(r, pageUrl, poolUrl) {
  const innerText = r.innerText || r.visible || htmlToVisibleText(r.html || "");
  return parsePoolPageContent({
    innerText,
    html: r.html || "",
    url: pageUrl,
    poolLabel: poolUrl,
  });
}

/**
 * Full Playwright-backed crawl of pool site (same stack as protocol Run intelligence).
 */
export async function crawlPoolWebsite(poolUrl, { timeBudgetMs, maxPages, poolLabel } = {}) {
  const url = String(poolUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return {
      enabled: false,
      ok: false,
      error: "bad_url",
      pages: [],
      addresses: [],
      formatted: "",
      structuredHints: {},
    };
  }
  if (!poolPlaywrightEnabled()) {
    return {
      enabled: false,
      ok: false,
      error: "disabled",
      pages: [],
      addresses: [],
      formatted: "",
      structuredHints: {},
    };
  }

  const budget = Number(timeBudgetMs || process.env.POOL_CRAWL_BUDGET_MS || 55_000);
  const limit = Number(maxPages || process.env.POOL_CRAWL_MAX_PAGES || 6);
  const candidates = buildPoolCrawlCandidates(url).slice(0, limit);
  const started = Date.now();
  const pages = [];
  const allAddresses = new Set();
  const lines = [];
  let structuredHints = {};

  for (let i = 0; i < candidates.length; i++) {
    const pageUrl = candidates[i];
    if (Date.now() - started > budget) break;
    const isPrimary = pageUrl === url || i === 0;
    const r = await fetchHtmlWithOptionalRender(pageUrl, { forceRender: isPrimary }).catch((e) => ({
      ok: false,
      visible: "",
      innerText: "",
      rendered: false,
      renderError: String(e?.message || e),
      addresses: [],
    }));
    const visible = r.innerText || r.visible || htmlToVisibleText(r.html || "");
    const addrs = [
      ...(Array.isArray(r.addresses) ? r.addresses : []),
      ...extractAddressesFromText(visible),
      ...extractAddressesFromText(r.html || ""),
    ];
    for (const a of addrs) allAddresses.add(a);

    const pageMetrics = parsePageMetrics(r, pageUrl, poolLabel || url);
    if (isPrimary || Object.keys(pageMetrics).length > Object.keys(structuredHints).length) {
      structuredHints = mergePageMetricsIntoHints(structuredHints, pageMetrics);
    }

    pages.push({
      url: pageUrl,
      ok: r.ok !== false,
      rendered: Boolean(r.rendered),
      renderError: r.renderError || null,
      textLength: visible.length,
      addresses: [...new Set(addrs)].slice(0, 24),
      excerpt: clamp(visible, 3200),
      metrics: pageMetrics,
      primary: isPrimary,
    });

    lines.push(`\n### Crawled page (${r.rendered ? "playwright" : "html"}): ${pageUrl}`);
    if (r.renderError) lines.push(`Render note: ${r.renderError}`);
    if (pageMetrics.poolTvlUsd != null) {
      lines.push(
        `Parsed TVL: $${Math.round(pageMetrics.poolTvlUsd).toLocaleString()} (${pageMetrics.tvlEvidence || "structured"})`
      );
    }
    if (pageMetrics.utilization != null) {
      lines.push(`Parsed utilization: ${(pageMetrics.utilization * 100).toFixed(1)}%`);
    }
    if (pageMetrics.lltv != null) lines.push(`Parsed LLTV: ${pageMetrics.lltv}%`);
    if (addrs.length) lines.push(`Contracts found: ${addrs.slice(0, 8).join(", ")}`);
    lines.push(clamp(visible, 4000));

    if (isSpecificPoolPage(new URL(url).pathname) && isPrimary && visible.length > 200) {
      break;
    }
    if (pages.length >= limit) break;
  }

  return {
    enabled: true,
    ok: pages.some((p) => p.ok && p.textLength > 100),
    poolUrl: url,
    pages,
    addresses: [...allAddresses],
    formatted: lines.join("\n").trim(),
    structuredHints,
    providers: ["playwright"],
  };
}
