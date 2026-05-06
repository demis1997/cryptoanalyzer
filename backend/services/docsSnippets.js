import fetch from "node-fetch";
import crypto from "crypto";

function normalizeOrigin(raw) {
  try {
    return new URL(String(raw || "")).origin;
  } catch {
    return String(raw || "").trim();
  }
}

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

async function fetchText(url, { timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, text: "" };
    const html = await resp.text();
    return { ok: true, status: resp.status, text: htmlToVisibleText(html) };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err?.message ? String(err.message) : String(err) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchRaw(url, { timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) return { ok: false, status: resp.status, text: "" };
    return { ok: true, status: resp.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err?.message ? String(err.message) : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export function buildDocsCandidates(origin) {
  const base = normalizeOrigin(origin);
  try {
    const u = new URL(base);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    const registrable = parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : host;
    const docsOrigin = `${u.protocol}//docs.${registrable}`;
    // Many protocols host docs/security on the registrable root (e.g. app.foo.com -> foo.com/docs/security).
    const rootOrigin = `${u.protocol}//${registrable}`;
    const candidates = [
      `${u.origin}/`,
      `${rootOrigin}/`,
      `${u.origin}/security`,
      `${rootOrigin}/security`,
      `${u.origin}/audits`,
      `${rootOrigin}/audits`,
      `${u.origin}/integrations`,
      `${rootOrigin}/integrations`,
      `${u.origin}/ecosystem`,
      `${rootOrigin}/ecosystem`,
      `${u.origin}/partners`,
      `${rootOrigin}/partners`,
      `${u.origin}/developers`,
      `${rootOrigin}/developers`,
      `${u.origin}/developer`,
      `${rootOrigin}/developer`,
      `${u.origin}/dev`,
      `${rootOrigin}/dev`,
      `${u.origin}/build`,
      `${rootOrigin}/build`,
      `${u.origin}/build-with-us`,
      `${rootOrigin}/build-with-us`,
      `${u.origin}/build-with`,
      `${rootOrigin}/build-with`,
      `${u.origin}/learn`,
      `${rootOrigin}/learn`,
      `${u.origin}/faq`,
      `${rootOrigin}/faq`,
      `${u.origin}/terms`,
      `${rootOrigin}/terms`,
      `${u.origin}/governance`,
      `${rootOrigin}/governance`,
      `${u.origin}/risk`,
      `${rootOrigin}/risk`,
      `${u.origin}/docs`,
      `${rootOrigin}/docs`,
      `${u.origin}/docs/security`,
      `${rootOrigin}/docs/security`,
      `${u.origin}/docs/audits`,
      `${rootOrigin}/docs/audits`,
      `${u.origin}/docs/contracts`,
      `${rootOrigin}/docs/contracts`,
      `${u.origin}/docs/integrations`,
      `${rootOrigin}/docs/integrations`,
      `${u.origin}/docs/ecosystem`,
      `${rootOrigin}/docs/ecosystem`,
      `${u.origin}/docs/partners`,
      `${rootOrigin}/docs/partners`,
      `${u.origin}/docs/developers`,
      `${rootOrigin}/docs/developers`,
      `${u.origin}/docs/developer`,
      `${rootOrigin}/docs/developer`,
      `${u.origin}/docs/dev`,
      `${rootOrigin}/docs/dev`,
      `${u.origin}/docs/build`,
      `${rootOrigin}/docs/build`,
      `${u.origin}/contracts`,
      `${rootOrigin}/contracts`,
      `${u.origin}/documentation`,
      `${rootOrigin}/documentation`,
      `${u.origin}/documentation/security`,
      `${rootOrigin}/documentation/security`,
      `${u.origin}/documentation/audits`,
      `${rootOrigin}/documentation/audits`,
      `${u.origin}/documentation/integrations`,
      `${rootOrigin}/documentation/integrations`,
      `${u.origin}/documentation/ecosystem`,
      `${rootOrigin}/documentation/ecosystem`,
      `${u.origin}/documentation/partners`,
      `${rootOrigin}/documentation/partners`,
      `${u.origin}/documentation/developers`,
      `${rootOrigin}/documentation/developers`,
      `${u.origin}/architecture`,
      `${rootOrigin}/architecture`,
      `${u.origin}/docs/architecture`,
      `${rootOrigin}/docs/architecture`,
      `${docsOrigin}/`,
      `${docsOrigin}/security`,
      `${docsOrigin}/audits`,
      `${docsOrigin}/contracts`,
      `${docsOrigin}/architecture`,
      `${docsOrigin}/integrations`,
      `${docsOrigin}/ecosystem`,
      `${docsOrigin}/partners`,
      `${docsOrigin}/developers`,
    ];
    return Array.from(new Set(candidates));
  } catch {
    return [base];
  }
}

function isSameOriginUrl(url, origin) {
  try {
    const u = new URL(url);
    const o = new URL(origin);
    return u.origin === o.origin;
  } catch {
    return false;
  }
}

function normalizeToAbsolute(href, baseUrl) {
  try {
    const u = new URL(String(href || ""), baseUrl);
    // strip hash for dedupe
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function extractSameOriginCandidateLinks(html, origin, { limit = 80 } = {}) {
  const out = [];
  const seen = new Set();
  const t = String(html || "");
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(t)) && out.length < limit) {
    const href = String(m[1] || "").trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    const abs = normalizeToAbsolute(href, origin);
    if (!abs) continue;
    if (!isSameOriginUrl(abs, origin)) continue;
    if (!/\/(docs|doc|documentation|security|audit|audits|contracts?|integrations?|ecosystem|partners?|developers?|developer|dev|build|architecture|risk|governance)\b/i.test(
      abs
    )) {
      continue;
    }
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function extractSitemapLocs(xml, origin, { limit = 120 } = {}) {
  const out = [];
  const seen = new Set();
  const t = String(xml || "");
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(t)) && out.length < limit) {
    const loc = String(m[1] || "").trim();
    if (!loc) continue;
    const abs = normalizeToAbsolute(loc, origin);
    if (!abs) continue;
    if (!isSameOriginUrl(abs, origin)) continue;
    if (
      !/\/(docs|doc|documentation|security|audit|audits|contracts?|integrations?|ecosystem|partners?|developers?|developer|dev|build|architecture|risk|governance)\b/i.test(
        abs
      )
    ) {
      continue;
    }
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export function extractAddressContexts(text, { max = 40 } = {}) {
  const t = String(text || "");
  const out = [];
  const re = /0x[a-fA-F0-9]{40}/g;
  let m;
  while ((m = re.exec(t)) && out.length < max) {
    const addr = m[0];
    const start = Math.max(0, m.index - 140);
    const end = Math.min(t.length, m.index + addr.length + 220);
    const ctx = t.slice(start, end).replace(/\s+/g, " ").trim();
    out.push({ address: addr, context: ctx });
  }
  return out;
}

export function extractKeywordLines(text, { max = 30 } = {}) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const l of lines) {
    if (
      !/(audit|auditor|security|contract|router|vault|pool|market|staking|token|bridge|integrat|partner|liquidity|yield|lido|pendle|aave|curve|uniswap|wrapped|steth|wsteth|underlying|issuer|protocol)/i.test(
        l
      )
    )
      continue;
    out.push(l.slice(0, 320));
    if (out.length >= max) break;
  }
  return out;
}

export function hashSnippets(payload) {
  const s = JSON.stringify(payload || {});
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function fetchDocsSnippets({
  origin,
  maxPages = 8,
  timeoutMsPerPage = 10_000,
  /** When doc URLs fail (SPA/403), use visible text already extracted during analyze. */
  fallbackVisibleText = "",
} = {}) {
  const baseOrigin = normalizeOrigin(origin);
  const baseCandidates = buildDocsCandidates(baseOrigin);

  // "Internet research" layer (bounded):
  // - Try sitemap.xml (fast, no JS)
  // - Try same-origin link discovery from homepage + /docs
  const extraCandidates = [];
  try {
    const sm = await fetchRaw(`${baseOrigin}/sitemap.xml`, { timeoutMs: Math.min(8000, timeoutMsPerPage) });
    if (sm?.ok && sm.text) {
      extractSitemapLocs(sm.text, baseOrigin, { limit: 140 }).forEach((u) => extraCandidates.push(u));
    }
  } catch {
    // ignore
  }
  try {
    const home = await fetchRaw(`${baseOrigin}/`, { timeoutMs: Math.min(8000, timeoutMsPerPage) });
    if (home?.ok && home.text) {
      extractSameOriginCandidateLinks(home.text, baseOrigin, { limit: 90 }).forEach((u) => extraCandidates.push(u));
    }
  } catch {
    // ignore
  }
  try {
    const docs = await fetchRaw(`${baseOrigin}/docs`, { timeoutMs: Math.min(8000, timeoutMsPerPage) });
    if (docs?.ok && docs.text) {
      extractSameOriginCandidateLinks(docs.text, baseOrigin, { limit: 90 }).forEach((u) => extraCandidates.push(u));
    }
  } catch {
    // ignore
  }

  const candidates = Array.from(new Set([...baseCandidates, ...extraCandidates])).slice(0, Math.max(1, Number(maxPages) || 8));
  const pages = [];
  const evidence = [];
  const allAddrContexts = [];
  const allLines = [];

  for (const url of candidates) {
    const r = await fetchText(url, { timeoutMs: timeoutMsPerPage });
    if (!r.ok || !r.text) continue;
    evidence.push(`Checked: ${url}`);
    pages.push({ url, fetchedAt: new Date().toISOString(), textLen: r.text.length });

    extractAddressContexts(r.text, { max: 28 }).forEach((x) => allAddrContexts.push(x));
    extractKeywordLines(r.text, { max: 28 }).forEach((x) => allLines.push(x));

    if (allLines.length >= 48 && allAddrContexts.length >= 36) break;
  }

  const fb = String(fallbackVisibleText || "").trim();
  if (!evidence.length && fb.length >= 120) {
    evidence.push("Used analyze HTML snapshot (no standalone docs pages returned usable text).");
    pages.push({
      url: `${normalizeOrigin(origin)}#analyze-snapshot`,
      fetchedAt: new Date().toISOString(),
      textLen: fb.length,
    });
    extractAddressContexts(fb, { max: 70 }).forEach((x) => allAddrContexts.push(x));
    extractKeywordLines(fb, { max: 70 }).forEach((x) => allLines.push(x));
  }

  const payload = {
    origin: normalizeOrigin(origin),
    pages,
    addressContexts: allAddrContexts.slice(0, 70),
    lines: allLines.slice(0, 90),
  };
  const hash = hashSnippets(payload);

  return {
    ok: evidence.length > 0,
    origin: payload.origin,
    hash,
    pages,
    addressContexts: payload.addressContexts,
    lines: payload.lines,
    evidence: evidence.length ? evidence : ["No docs pages reachable."],
  };
}

