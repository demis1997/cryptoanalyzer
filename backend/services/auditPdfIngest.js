import fetch from "node-fetch";
import { extractAddressContexts, extractKeywordLines } from "./docsSnippets.js";

async function loadPdfParse() {
  // pdf-parse depends on pdfjs-dist which expects certain Canvas/DOM polyfills in Node.
  // On serverless runtimes (e.g. Vercel), this can crash at import time if optional deps are missing.
  try {
    // Best-effort polyfills (if available)
    if (!globalThis.DOMMatrix || !globalThis.ImageData || !globalThis.Path2D) {
      try {
        const canvas = await import("@napi-rs/canvas");
        if (!globalThis.DOMMatrix && canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
        if (!globalThis.ImageData && canvas.ImageData) globalThis.ImageData = canvas.ImageData;
        if (!globalThis.Path2D && canvas.Path2D) globalThis.Path2D = canvas.Path2D;
      } catch {
        // ignore; we'll still try to import pdf-parse and fall back if it fails
      }
    }

    const mod = await import("pdf-parse");
    // pdf-parse v2 exports PDFParse (class) in ESM builds
    const PDFParse = mod?.PDFParse || mod?.default?.PDFParse || mod?.default || null;
    if (!PDFParse) return null;
    return PDFParse;
  } catch {
    return null;
  }
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function isProbablyPdfUrl(url) {
  const u = String(url || "").toLowerCase();
  return u.includes(".pdf") || u.includes("pdf");
}

async function fetchBufferLimited(url, { timeoutMs = 18_000, maxBytes = 8_000_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) return { ok: false, status: resp.status, buffer: null };
    if (!resp.body) return { ok: false, status: resp.status, buffer: null };
    let total = 0;
    const chunks = [];
    for await (const chunk of resp.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) break;
    }
    return { ok: true, status: resp.status, buffer: Buffer.concat(chunks) };
  } catch (err) {
    return { ok: false, status: 0, buffer: null, error: err?.message ? String(err.message) : String(err) };
  } finally {
    clearTimeout(t);
  }
}

function clampText(s, maxChars) {
  const t = String(s || "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + `\n[truncated:${t.length - maxChars} chars]`;
}

/**
 * Fetch and parse a small set of audit PDFs and convert them into extra "docs lines"
 * and address contexts for the LLM.
 *
 * This is intentionally bounded: PDF parsing can be expensive.
 */
export async function ingestAuditPdfsIntoDocsPack({
  docsPack,
  auditLinks = [],
  maxPdfs = 3,
} = {}) {
  const pack = docsPack && typeof docsPack === "object" ? { ...docsPack } : null;
  if (!pack) return null;

  // Vercel serverless runtime is sensitive to native canvas/pdfjs deps.
  // Skip PDF ingestion there; we still keep audit URLs as evidence via DefiLlama/Docs scraping.
  if (process.env.VERCEL === "1" || process.env.VERCEL === "true") return pack;
  if (String(process.env.DISABLE_PDF_PARSE || "0") === "1") return pack;

  const links = uniq(auditLinks)
    .filter((u) => typeof u === "string" && u.trim())
    .slice(0, 15);
  if (!links.length) return pack;

  const pages = Array.isArray(pack.pages) ? [...pack.pages] : [];
  const evidence = Array.isArray(pack.evidence) ? [...pack.evidence] : [];
  const addressContexts = Array.isArray(pack.addressContexts) ? [...pack.addressContexts] : [];
  const lines = Array.isArray(pack.lines) ? [...pack.lines] : [];

  let parsed = 0;
  const PDFParse = await loadPdfParse();
  if (!PDFParse) return pack;

  for (const url of links) {
    if (parsed >= Math.max(1, Number(maxPdfs) || 3)) break;
    if (!isProbablyPdfUrl(url)) continue;

    const r = await fetchBufferLimited(url, { timeoutMs: 20_000, maxBytes: 10_000_000 });
    if (!r.ok || !r.buffer) continue;

    let text = "";
    try {
      const parser = new PDFParse({ data: r.buffer });
      const out = await parser.getText().catch(() => null);
      await parser.destroy().catch(() => {});
      text = String(out?.text || "").trim();
    } catch {
      text = "";
    }
    if (!text || text.length < 200) continue;

    parsed += 1;
    evidence.push(`Downloaded audit PDF: ${url}`);
    pages.push({ url, fetchedAt: new Date().toISOString(), textLen: text.length, kind: "pdf" });

    // Feed the LLM a bounded subset: keyword lines + address contexts.
    extractAddressContexts(text, { max: 50 }).forEach((x) => addressContexts.push(x));
    extractKeywordLines(text, { max: 80 }).forEach((x) => lines.push(x));

    // Add a tiny “header” line so the LLM sees provenance.
    lines.push(`AUDIT_PDF_SOURCE: ${url}`);
    lines.push(...clampText(text, 2200).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 18));
  }

  return {
    ...pack,
    pages: pages.slice(0, 25),
    evidence: evidence.slice(0, 60),
    addressContexts: addressContexts.slice(0, 90),
    lines: lines.slice(0, 140),
  };
}

