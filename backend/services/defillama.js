import fetch from "node-fetch";
import { chromium } from "playwright";

function htmlToVisibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function baseDomain(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return h;
  return parts.slice(-2).join(".");
}

export async function getDefiLlamaTvl(origin) {
  // Legacy placeholder: current implementation used by the /api/analyze endpoint
  // is “uniswap” TVL. Keep behavior stable.
  const protocolSlug = "uniswap";
  const url = `https://api.llama.fi/tvl/${protocolSlug}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DefiLlama TVL request failed with status ${resp.status}`);
  const data = await resp.json();
  return {
    usd: typeof data === "number" ? data : data?.tvl ?? null,
    source: "defillama",
    raw: data,
  };
}

export async function getDefiLlamaProtocolByUrl(origin) {
  // Matches the protocol entry by URL (best-effort).
  // API: https://api.llama.fi/protocols
  const resp = await fetch("https://api.llama.fi/protocols");
  if (!resp.ok) throw new Error(`DefiLlama protocols request failed: ${resp.status}`);
  const protocols = await resp.json();

  const originHost = safeHost(origin);
  const originBase = baseDomain(originHost);

  const match = protocols.find((p) => {
    const pUrl = typeof p?.url === "string" ? p.url : "";
    const pHost = safeHost(pUrl);
    if (!pHost || !originHost) return false;
    if (pHost === originHost) return true;
    // subdomain match (app.foo.com vs foo.com)
    if (originHost.endsWith("." + pHost)) return true;
    if (pHost.endsWith("." + originHost)) return true;
    // base-domain match
    const pBase = baseDomain(pHost);
    return Boolean(originBase && pBase && originBase === pBase);
  });

  if (!match) {
    // Fallback: try matching by a token from the origin host.
    // Example: `app.morpho.org` -> tries to match protocol slug/name "morpho".
    const hostParts = String(originHost || "")
      .split(".")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const first = hostParts[0] || "";
    const second = hostParts[1] || "";
    const candidate = ["app", "www", "beta", "alpha", "staging", "test"].includes(first) ? second : first;

    if (candidate) {
      const token = candidate.toLowerCase();
      const nameMatch = protocols.find((p) => {
        const slug = typeof p?.slug === "string" ? p.slug.toLowerCase() : "";
        const name = typeof p?.name === "string" ? p.name.toLowerCase() : "";
        return slug === token || name === token || name.includes(token);
      });
      if (nameMatch) {
        return {
          name: nameMatch.name || null,
          slug: nameMatch.slug || null,
          tvlUsd: typeof nameMatch.tvl === "number" ? nameMatch.tvl : null,
          defillamaUrl: nameMatch.url || null,
          chains: Array.isArray(nameMatch.chains) ? nameMatch.chains : [],
          listedAt: typeof nameMatch.listedAt === "number" ? nameMatch.listedAt : null,
          description: typeof nameMatch.description === "string" ? nameMatch.description : null,
          methodology: typeof nameMatch.methodology === "string" ? nameMatch.methodology : null,
          methodologyUrl: typeof nameMatch.methodologyURL === "string" ? nameMatch.methodologyURL : null,
          audits:
            nameMatch?.audits == null ? null : Number.isFinite(Number(nameMatch.audits)) ? Number(nameMatch.audits) : null,
          auditLinks: Array.isArray(nameMatch.audit_links) ? nameMatch.audit_links : [],
          rawProtocol: nameMatch,
        };
      }
    }

    return null;
  }

  return {
    name: match.name || null,
    slug: match.slug || null,
    tvlUsd: typeof match.tvl === "number" ? match.tvl : null,
    defillamaUrl: match.url || null,
    chains: Array.isArray(match.chains) ? match.chains : [],
    listedAt: typeof match.listedAt === "number" ? match.listedAt : null,
    description: typeof match.description === "string" ? match.description : null,
    methodology: typeof match.methodology === "string" ? match.methodology : null,
    methodologyUrl: typeof match.methodologyURL === "string" ? match.methodologyURL : null,
    // audits is usually a string/number; normalize to number or null
    audits:
      match?.audits == null
        ? null
        : Number.isFinite(Number(match.audits))
          ? Number(match.audits)
          : null,
    auditLinks: Array.isArray(match.audit_links) ? match.audit_links : [],
    // keep original for debugging
    rawProtocol: match,
  };
}

function parseCompactMoney(raw, suffix) {
  let v = parseFloat(String(raw || "").replace(/,/g, ""));
  if (!isFinite(v)) return null;
  const s = String(suffix || "").toLowerCase();
  if (s === "k") v *= 1e3;
  else if (s === "m") v *= 1e6;
  else if (s === "b") v *= 1e9;
  return v;
}

const _visibleTextCache = new Map();

async function getVisibleTextFromUrl(url, { waitForText = null, timeoutMs = 60000 } = {}) {
  const cache = _visibleTextCache.get(url) || {};
  const enableRender = String(process.env.DEFI_LLAMA_RENDER || "").toLowerCase() === "1";
  const renderOnMiss = String(process.env.DEFI_LLAMA_RENDER_ON_MISS || "1").toLowerCase() !== "0";

  // Fast path: cached rendered/static text already contains what we need.
  if (cache.renderedText && (!waitForText || String(cache.renderedText).includes(waitForText))) {
    return cache.renderedText;
  }
  if (cache.staticText && (!waitForText || String(cache.staticText).includes(waitForText))) {
    return cache.staticText;
  }

  // 1) Try static HTML first (fast).
  let staticText = cache.staticText || null;
  if (staticText == null) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      });
      if (resp.ok) {
        const html = await resp.text();
        staticText = htmlToVisibleText(html);
        cache.staticText = staticText;
        _visibleTextCache.set(url, cache);
      }
    } catch {
      // Ignore and fall back to rendered content below.
    }
  }

  if (!waitForText || String(staticText || "").includes(waitForText)) {
    return staticText || "";
  }

  // If render is disabled (default), return whatever static HTML text we have.
  // This keeps responses fast; in that mode, waitForText-based metrics may be missing.
  if (!enableRender && !renderOnMiss) {
    return staticText || "";
  }

  // 2) Render fallback (handles SPA/lazy-loaded metrics).
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    return staticText || "";
  }

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Avoid long waits: sample rendered text shortly after DOMContentLoaded and
    // retry briefly if it still doesn't contain the target phrase.
    const sampleWaitMs = Number(process.env.DEFI_LLAMA_RENDER_SAMPLE_WAIT_MS || 1500);
    const retryWindowMs = Number(process.env.DEFI_LLAMA_RENDER_RETRY_WINDOW_MS || 8000);

    await page.waitForTimeout(sampleWaitMs).catch(() => {});

    let renderedText = await page.evaluate(() => (document.body ? document.body.innerText : ""));

    if (waitForText && !String(renderedText).includes(waitForText) && retryWindowMs > 0) {
      const started = Date.now();
      while (Date.now() - started < retryWindowMs) {
        await page.waitForTimeout(500).catch(() => {});
        renderedText = await page.evaluate(() => (document.body ? document.body.innerText : ""));
        if (String(renderedText).includes(waitForText)) break;
      }
    }

    const visibleRendered = htmlToVisibleText(renderedText);
    cache.renderedText = visibleRendered;
    _visibleTextCache.set(url, cache);
    return visibleRendered;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function getDefiLlamaVolume24h(slug) {
  if (!slug) return null;

  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const text = await getVisibleTextFromUrl(protoUrl, { waitForText: "Volume 24h" });

  // Prefer the native token volume line: "$SYMBOL Volume 24h$".
  // This matches what you referenced for Morpho ($MORPHO Volume 24h$) and Pendle ($PENDLE Volume 24h$).
  const tokenRe = /\$([A-Z][A-Z0-9]{1,12})\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const m = tokenRe.exec(text);
  if (m) {
    const v = parseCompactMoney(m[2], m[3]);
    if (v != null) {
      const symbol = m[1] || null;
      return {
        value: v,
        evidence: [`$${symbol} Volume 24h (native token, DefiLlama protocol page)`, protoUrl],
        raw: { matched: m[0], source: "native_token_volume_24h" },
      };
    }
  }

  // Fallback: Key Metrics DEX volume row.
  const dexRe = /DEX\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const dexM = dexRe.exec(text);
  if (!dexM) return { value: null, evidence: ["24h volume not found on DefiLlama protocol page."] };

  const v = parseCompactMoney(dexM[1], dexM[2]);
  if (v == null) return { value: null, evidence: ["24h volume parse failed."] };

  return {
    value: v,
    evidence: ["DEX Volume 24h (DefiLlama protocol page)", protoUrl],
    raw: { matched: dexM[0], source: "dex_volume_24h" },
  };
}

export async function getDefiLlamaTotalRaisedUsd(slug) {
  if (!slug) return null;
  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const text = await getVisibleTextFromUrl(protoUrl, { waitForText: "Total Raised" });

  // Example: "Total Raised$3.7m"
  const re = /Total\s+Raised\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const m = re.exec(text);
  if (!m) {
    return {
      value: null,
      evidence: ["Total raised not found on DefiLlama protocol page."],
      raw: text.slice(0, 2000),
    };
  }

  const raw = m[1];
  const suffix = (m[2] || "").toLowerCase();

  let v = parseFloat(String(raw).replace(/,/g, ""));
  if (!isFinite(v)) return { value: null, evidence: ["Total raised parse failed."] };

  if (suffix === "k") v *= 1e3;
  else if (suffix === "m") v *= 1e6;
  else if (suffix === "b") v *= 1e9;

  return {
    value: v,
    evidence: ["Total raised (from DefiLlama protocol page)", protoUrl],
    raw: { matched: m[0] },
  };
}

export async function getDefiLlamaProtocolInformation(slug) {
  if (!slug) return null;
  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const text = await getVisibleTextFromUrl(protoUrl, { waitForText: "Protocol Information" });

  // Visible text usually contains:
  // "## Protocol Information\n\n<paragraph>\n\n[Website] ...\n\n## Methodology"
  const re = /Protocol Information\s*([\s\S]*?)\s*## Methodology/i;
  const m = re.exec(text);
  if (!m) return null;

  let info = String(m[1] || "").trim();

  // Remove the trailing "links block" like "[Website](...)" if present.
  info = info.replace(/\n\s*\[[A-Za-z][^\n]*?\].*$/s, "").trim();
  return { description: info || null, evidence: ["Protocol Information (DefiLlama protocol page)", protoUrl] };
}

async function fetchTextLimited(url, { maxBytes = 250_000, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Request failed: ${resp.status}`);
    if (!resp.body) return "";

    let total = 0;
    const chunks = [];
    for await (const chunk of resp.body) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) break;
    }
    const buf = Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
    );
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

export async function getDefiLlamaTokenLiquidityFromYields(slugOrName) {
  // Best-effort fallback for cases where the submitted protocol page
  // doesn't expose token-by-token liquidity.
  if (!slugOrName) return null;

  const projects = [];
  // Targeted quality for Morpho (matches your provided DefiLlama yields URL).
  if (String(slugOrName).toLowerCase() === "morpho") {
    projects.push(
      "Morpho V1",
      "Morpho V0 AaveV2",
      "Morpho V0 CompoundV2",
      "Morpho V0 AaveV3"
    );
  } else {
    // Generic attempts: pass slugOrName as a single project value.
    projects.push(String(slugOrName));
  }

  // Construct: https://defillama.com/yields?project=A&project=B...
  const url = `https://defillama.com/yields?${projects
    .map((p) => `project=${encodeURIComponent(p)}`)
    .join("&")}`;

  const html = await fetchTextLimited(url).catch(() => null);
  if (!html) return null;
  const text = htmlToVisibleText(html);

  // Heuristic extraction:
  // Try to find lines that include both a token symbol and "TVL", plus a $ amount.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const tokenRe = /\$?\s*([\d.,]+)\s*([kKmMbB])?/;
  const out = new Map();

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.includes("tvl")) continue;
    // Find a token-ish word before/near the money.
    const tokenMatch = line.match(/\b([A-Z][A-Z0-9]{1,12})\b/);
    if (!tokenMatch) continue;

    const moneyMatch = tokenRe.exec(line);
    if (!moneyMatch) continue;

    const raw = moneyMatch[1];
    const suffix = (moneyMatch[2] || "").toLowerCase();
    let v = parseFloat(String(raw).replace(/,/g, ""));
    if (!isFinite(v)) continue;
    if (suffix === "k") v *= 1e3;
    else if (suffix === "m") v *= 1e6;
    else if (suffix === "b") v *= 1e9;

    const token = tokenMatch[1];
    // Keep the max TVL if a token appears multiple times.
    const key = token.toLowerCase();
    const current = out.get(key);
    if (!current || v > current.liquidityUsd) {
      out.set(key, {
        token,
        liquidityUsd: v,
        evidence: [`DefiLlama yields TVL (best-effort)`, url, line.slice(0, 120)],
      });
    }
  }

  const items = Array.from(out.values()).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return items.length ? items.slice(0, 25) : null;
}

