import { buildDocsCandidates } from "./docsSnippets.js";
import {
  extractAddressesFromText,
  fetchHtmlWithOptionalRender,
  htmlToVisibleText,
} from "./htmlCrawl.js";

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
    `${origin}/blog`,
    `${u.protocol}//docs.${registrable}/`,
    `${u.protocol}//docs.${registrable}/integrations`,
    `${u.protocol}//docs.${registrable}/earn`,
    `${u.protocol}//docs.${registrable}/liquidity-providers/avantis-lp-vault-avusdc`,
    `${u.protocol}//docs.${registrable}/morpho-integration/multi-collateral-usdc-borrowing`
  );
  for (const c of buildDocsCandidates(origin)) {
    if (/integrat|partner|ecosystem|contract|vault|earn|pool|developer|build|blog|composab/i.test(c)) {
      list.push(c);
    }
  }
  return uniqueUrls(list).slice(0, 14);
}

/**
 * Full Playwright-backed crawl of pool site (same stack as protocol Run intelligence).
 */
export async function crawlPoolWebsite(poolUrl, { timeBudgetMs, maxPages } = {}) {
  const url = String(poolUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { enabled: false, ok: false, error: "bad_url", pages: [], addresses: [], formatted: "" };
  }
  if (!poolPlaywrightEnabled()) {
    return { enabled: false, ok: false, error: "disabled", pages: [], addresses: [], formatted: "" };
  }

  const budget = Number(timeBudgetMs || process.env.POOL_CRAWL_BUDGET_MS || 50_000);
  const limit = Number(maxPages || process.env.POOL_CRAWL_MAX_PAGES || 6);
  const candidates = buildPoolCrawlCandidates(url).slice(0, limit);
  const started = Date.now();
  const pages = [];
  const allAddresses = new Set();
  const lines = [];

  for (const pageUrl of candidates) {
    if (Date.now() - started > budget) break;
    const r = await fetchHtmlWithOptionalRender(pageUrl, { forceRender: pageUrl === url }).catch((e) => ({
      ok: false,
      visible: "",
      rendered: false,
      renderError: String(e?.message || e),
      addresses: [],
    }));
    const visible = r.visible || htmlToVisibleText(r.html || "");
    const addrs = [
      ...(Array.isArray(r.addresses) ? r.addresses : []),
      ...extractAddressesFromText(visible),
      ...extractAddressesFromText(r.html || ""),
    ];
    for (const a of addrs) allAddresses.add(a);

    pages.push({
      url: pageUrl,
      ok: r.ok !== false,
      rendered: Boolean(r.rendered),
      renderError: r.renderError || null,
      textLength: visible.length,
      addresses: [...new Set(addrs)].slice(0, 24),
      excerpt: clamp(visible, 2200),
    });

    lines.push(`\n### Crawled page (${r.rendered ? "playwright" : "html"}): ${pageUrl}`);
    if (r.renderError) lines.push(`Render note: ${r.renderError}`);
    if (addrs.length) lines.push(`Contracts found: ${addrs.slice(0, 8).join(", ")}`);
    lines.push(clamp(visible, 2800));

    if (pages.length >= limit) break;
  }

  return {
    enabled: true,
    ok: pages.some((p) => p.ok && p.textLength > 100),
    poolUrl: url,
    pages,
    addresses: [...allAddresses],
    formatted: lines.join("\n").trim(),
    providers: ["playwright"],
  };
}
