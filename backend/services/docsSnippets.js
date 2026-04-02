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

export function buildDocsCandidates(origin) {
  const base = normalizeOrigin(origin);
  try {
    const u = new URL(base);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    const registrable = parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : host;
    const docsOrigin = `${u.protocol}//docs.${registrable}`;
    const candidates = [
      `${u.origin}/security`,
      `${u.origin}/audits`,
      `${u.origin}/docs`,
      `${u.origin}/docs/security`,
      `${u.origin}/docs/audits`,
      `${u.origin}/docs/contracts`,
      `${u.origin}/contracts`,
      `${u.origin}/documentation`,
      `${u.origin}/documentation/security`,
      `${u.origin}/documentation/audits`,
      `${u.origin}/architecture`,
      `${u.origin}/docs/architecture`,
      `${docsOrigin}/`,
      `${docsOrigin}/security`,
      `${docsOrigin}/audits`,
      `${docsOrigin}/contracts`,
      `${docsOrigin}/architecture`,
    ];
    return Array.from(new Set(candidates));
  } catch {
    return [base];
  }
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
    if (!/(audit|auditor|security|contract|router|vault|pool|market|staking|token|bridge)/i.test(l)) continue;
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
} = {}) {
  const candidates = buildDocsCandidates(origin).slice(0, maxPages);
  const pages = [];
  const evidence = [];
  const allAddrContexts = [];
  const allLines = [];

  for (const url of candidates) {
    const r = await fetchText(url, { timeoutMs: timeoutMsPerPage });
    if (!r.ok || !r.text) continue;
    evidence.push(`Checked: ${url}`);
    pages.push({ url, fetchedAt: new Date().toISOString(), textLen: r.text.length });

    extractAddressContexts(r.text, { max: 18 }).forEach((x) => allAddrContexts.push(x));
    extractKeywordLines(r.text, { max: 18 }).forEach((x) => allLines.push(x));

    if (allLines.length >= 24 && allAddrContexts.length >= 18) break;
  }

  const payload = {
    origin: normalizeOrigin(origin),
    pages,
    addressContexts: allAddrContexts.slice(0, 40),
    lines: allLines.slice(0, 40),
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

