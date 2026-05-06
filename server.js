import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import fs from "fs";
import dns from "dns";
import { chromium } from "playwright";
import multer from "multer";
import mammoth from "mammoth";
import JSZip from "jszip";
import {
  getDefiLlamaTvl as getDefiLlamaTvlFromModule,
  getDefiLlamaProtocolByUrl as getDefiLlamaProtocolByUrlFromModule,
  getDefiLlamaVolume24h as getDefiLlamaVolume24hFromModule,
  getDefiLlamaTotalRaisedUsd as getDefiLlamaTotalRaisedUsdFromModule,
  getDefiLlamaProtocolInformation as getDefiLlamaProtocolInformationFromModule,
  getDefiLlamaTokenLiquidityFromYields as getDefiLlamaTokenLiquidityFromYieldsFromModule,
  getDefiLlamaProtocolApiDetail as getDefiLlamaProtocolApiDetailFromModule,
} from "./backend/services/defillama.js";
import { buildEvidenceNotes } from "./backend/services/evidenceNotes.js";
import { getPendleMarketSnapshot as getPendleMarketSnapshotFromModule } from "./backend/services/pendle.js";
import { buildHeuristicRiskAssessment as buildHeuristicRiskAssessmentFromModule } from "./backend/llm/riskHeuristics.js";
import {
  computeProtocolCacheHash,
  protocolCacheGetLatest,
  protocolCacheInit,
  protocolCacheUpsert,
  protocolKeyFrom,
  stripWalletSpecificFields,
} from "./backend/db/protocolCache.js";
import { discoverContractConnections } from "./backend/services/contractConnections.js";
import {
  localGraphInit,
  getProtocolGraph as getProtocolGraphLocal,
  getProtocolGraphById as getProtocolGraphLocalById,
  searchProtocols as searchLocalProtocols,
  searchYieldPoolsLocal,
  getLocalGraphOverview,
  upsertProtocolGraph as upsertProtocolGraphLocal,
  upsertProtocolExtra as upsertProtocolExtraLocal,
  protocolIdFrom,
} from "./backend/db/localGraph.js";
import {
  neo4jEnabled,
  neo4jInit,
  getProtocolGraphNeo4j,
  getProtocolGraphNeo4jById,
  upsertProtocolGraphNeo4j,
  searchProtocolsNeo4j,
  getRelatedProtocolsNeo4j,
  findProtocolIdByUrlNeo4j,
  searchPoolsNeo4j,
  getPoolNeighborhoodNeo4j,
} from "./backend/db/neo4jGraph.js";
import { fetchDocsSnippets } from "./backend/services/docsSnippets.js";
import { ingestAuditPdfsIntoDocsPack } from "./backend/services/auditPdfIngest.js";
import {
  extractAuditorsWithHostedLlm,
  inferContractGraphWithHostedLlm,
  inferArchitectureWithHostedLlm,
  mergeConnectionGraphs,
  graphAugmentationFromDefillamaApi,
  subjectProtocolNodeId,
} from "./backend/services/aiEnrich.js";
import { resetHostedLlmRoute } from "./backend/llm/provider.js";

function extractAuditorsHeuristic({ docsPack, defillamaApi } = {}) {
  const lines = Array.isArray(docsPack?.lines) ? docsPack.lines.join("\n") : "";
  const ev = Array.isArray(docsPack?.evidence) ? docsPack.evidence : [];
  const links = Array.isArray(defillamaApi?.auditLinks) ? defillamaApi.auditLinks : [];
  const text = `${lines}\n${links.join("\n")}\n${ev.join("\n")}`.toLowerCase();

  const candidates = [
    { name: "Trail of Bits", re: /trail\s*of\s*bits|trailofbits/ },
    { name: "OpenZeppelin", re: /openzeppelin/ },
    { name: "Quantstamp", re: /quantstamp/ },
    { name: "ChainSecurity", re: /chainsecurity/ },
    { name: "Spearbit", re: /spearbit/ },
    { name: "Sigma Prime", re: /sigma\s*prime/ },
    { name: "Least Authority", re: /least\s*authority/ },
    { name: "Runtime Verification", re: /runtime\s*verification/ },
    { name: "Halborn", re: /halborn/ },
    { name: "MixBytes", re: /mixbytes/ },
    { name: "CertiK", re: /certik/ },
    { name: "PeckShield", re: /peckshield/ },
    { name: "SlowMist", re: /slowmist/ },
    { name: "OtterSec", re: /ottersec/ },
    { name: "Coinspect", re: /coinspect/ },
    { name: "Solidified", re: /solidified/ },
  ];

  const out = [];
  for (const c of candidates) {
    if (c.re.test(text)) out.push({ name: c.name });
  }

  // Also infer from audit link hostnames (best-effort).
  for (const u of links) {
    const s = String(u || "").toLowerCase();
    if (s.includes("trailofbits")) out.push({ name: "Trail of Bits" });
    if (s.includes("openzeppelin")) out.push({ name: "OpenZeppelin" });
    if (s.includes("quantstamp")) out.push({ name: "Quantstamp" });
    if (s.includes("chainsecurity")) out.push({ name: "ChainSecurity" });
    if (s.includes("spearbit")) out.push({ name: "Spearbit" });
    if (s.includes("halborn")) out.push({ name: "Halborn" });
    if (s.includes("mixbytes")) out.push({ name: "MixBytes" });
    if (s.includes("certik")) out.push({ name: "CertiK" });
  }

  // Dedupe
  const seen = new Set();
  const deduped = [];
  for (const a of out) {
    const n = String(a?.name || "").trim();
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push({ name: n });
    if (deduped.length >= 12) break;
  }

  return {
    auditors: deduped,
    evidence: [
      "heuristic_auditor_extraction",
      ...(links.length ? [`Audit links considered: ${links.slice(0, 6).join(", ")}`] : []),
      ...(ev.length ? ev.slice(0, 4) : []),
    ],
  };
}

async function fetchDefillamaApiDetailBestEffort(slugLike) {
  const raw = String(slugLike || "").trim();
  if (!raw) return null;
  const variants = Array.from(
    new Set([
      raw,
      raw.replace(/_/g, "-"),
      raw.replace(/-/g, "_"),
    ])
  )
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  for (const v of variants) {
    const d = await getDefiLlamaProtocolApiDetailFromModule(v).catch(() => null);
    if (d && d.apiUrl) return d;
  }
  return null;
}

async function expandConnectionsWithDefillama({ connections, maxProtocols = 6 } = {}) {
  const conn = connections && typeof connections === "object" ? connections : null;
  if (!conn) return conn;
  const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
  const protocolNodes = nodes.filter((n) => n && (n.kind === "protocol" || n.type === "protocol") && typeof n.id === "string");
  const slugs = protocolNodes
    .map((n) => String(n.id || ""))
    .filter((id) => id.startsWith("protocol:"))
    .map((id) => id.slice("protocol:".length))
    .filter(Boolean);
  const uniqSlugs = Array.from(new Set(slugs)).slice(0, Math.max(1, Number(maxProtocols) || 6));

  let out = conn;
  for (const s of uniqSlugs) {
    const api = await fetchDefillamaApiDetailBestEffort(s);
    if (!api) continue;
    const subjectId = `protocol:${String(s).trim()}`;
    const aug = graphAugmentationFromDefillamaApi({
      defillamaApi: api,
      subjectProtocolId: subjectId,
      subjectDisplayName: api.name || s,
    });
    out = mergeConnectionGraphs(out, aug);
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Node DNS can prefer IPv6 in some environments, which can cause flaky resolution/connectivity
// to Cloudflare-fronted hosts even when curl works. Prefer IPv4 first for stability.
try {
  if (typeof dns?.setDefaultResultOrder === "function") dns.setDefaultResultOrder("ipv4first");
} catch {
  // ignore
}

// Local/dev fallback cache for report generation.
// Vercel should rely on Postgres; local runs often don't have it configured.
const inMemoryProtocolSnapshotCache = new Map(); // protocolKey -> { analysis, updatedAtMs }

const app = express();
export { app };
export default app;
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Some endpoints (e.g. report generation) may accept large JSON payloads locally.
// Vercel callers should prefer sending {url/protocolKey} and using Postgres-backed cache.
app.use(express.json({ limit: "25mb" }));

const PROTOCOL_CACHE_TTL_MS = Number(process.env.PROTOCOL_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const ENABLE_PROTOCOL_DB_CACHE = String(process.env.ENABLE_PROTOCOL_DB_CACHE || "1") === "1";

function slugKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "unknown";
}

function parseAllAddresses(text) {
  const out = [];
  const s = String(text || "");
  const re = /0x[a-fA-F0-9]{40}/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

function parseCsvText(csvText) {
  const s = String(csvText || "");
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      cur = "";
      const isEmpty = row.every((c) => String(c || "").trim() === "");
      if (!isEmpty) rows.push(row);
      row = [];
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  row.push(cur);
  if (!row.every((c) => String(c || "").trim() === "")) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || "").trim());
  const out = [];
  for (const r of rows.slice(1)) {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] == null ? "" : String(r[i]);
    out.push(obj);
  }
  return out;
}

function relationshipToRelation(rel) {
  const r = String(rel || "").trim().toLowerCase();
  if (!r) return "unknown_link";
  if (r === "audited_by") return "audited_by";
  if (r === "issues_token") return "issues_token";
  if (r === "uses_token") return "uses_token";
  if (r === "connected_to") return "connected_to";
  return r.replace(/[^a-z0-9]+/g, "_");
}

function toImportGraph({ rootProtocol, rows }) {
  const root = String(rootProtocol || "").trim();
  const rootSlug = slugKey(root);
  const protocolId = `import:${rootSlug}`;

  const nodes = [];
  const edges = [];

  const ensureNode = (n) => {
    if (!n || !n.id) return;
    if (seenNodes.has(n.id)) return;
    seenNodes.add(n.id);
    nodes.push(n);
  };

  const seenNodes = new Set();
  const makeNodeId = (type, name, addr) => {
    const t = String(type || "entity").trim().toLowerCase();
    const n = String(name || "").trim();
    const a = String(addr || "").trim().toLowerCase();
    if (a && /^0x[a-f0-9]{40}$/.test(a)) return a;
    return `${t}:${slugKey(n || "unknown")}`;
  };

  ensureNode({ kind: "protocol", id: `protocol:${rootSlug}`, name: root, label: root, network: "Multi-chain" });

  const auditors = [];
  const notes = [];
  const tokens = [];
  const contracts = [];

  for (const raw of rows) {
    const sourceName = raw.source_name || raw.sourceName || "";
    const sourceType = raw.source_type || raw.sourceType || "entity";
    const targetName = raw.target_name || raw.targetName || "";
    const targetType = raw.target_type || raw.targetType || "entity";
    const chain = raw.chain || "";
    const relationship = raw.relationship || raw.relation || "";
    const rel = relationshipToRelation(relationship);
    const rowNotes = raw.notes || raw.note || "";

    const addresses = parseAllAddresses(rowNotes);
    const addr = addresses.length ? addresses[0] : "";

    const fromId = makeNodeId(sourceType, sourceName, "");
    const toId = makeNodeId(targetType, targetName, addr);

    ensureNode({
      kind: String(sourceType || "entity").toLowerCase(),
      id: fromId,
      name: String(sourceName || "").trim() || null,
      label: String(sourceName || "").trim() || fromId,
      network: chain || "Unknown",
    });
    ensureNode({
      kind: String(targetType || "entity").toLowerCase(),
      id: toId,
      address: /^0x[a-f0-9]{40}$/.test(String(addr || "").toLowerCase()) ? String(addr).toLowerCase() : undefined,
      name: String(targetName || "").trim() || null,
      label: String(targetName || "").trim() || toId,
      network: chain || "Unknown",
    });

    edges.push({
      from: fromId,
      to: toId,
      relation: rel,
      evidence: rowNotes ? String(rowNotes).slice(0, 360) : `Imported: ${relationship}`,
    });

    if (String(rel) === "audited_by" && String(targetType || "").toLowerCase() === "auditor") {
      const n = String(targetName || "").trim();
      if (n) auditors.push({ name: n });
    }
    if (rowNotes) notes.push(rowNotes);

    if (String(targetType || "").toLowerCase().includes("token") && /^0x[a-f0-9]{40}$/.test(String(addr || "").toLowerCase())) {
      tokens.push({ chain, address: addr, symbol: String(targetName || "").trim() });
    }
    if (String(targetType || "").toLowerCase().includes("contract") && /^0x[a-f0-9]{40}$/.test(String(addr || "").toLowerCase())) {
      contracts.push({ chain, address: addr, label: String(targetName || "").trim(), type: String(targetType || "") });
    }
  }

  // Attach root links if missing.
  // If rows define root_protocol but omit explicit root node linking, we still keep full edges.

  return {
    protocol: { id: protocolId, name: root, url: `import:${rootSlug}`, defillamaSlug: null },
    connections: { nodes, edges, evidence: [`Imported relationships for ${root}`] },
    auditors,
    tokens,
    contracts,
    notes,
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    routes: {
      analyze: "GET /api/analyze?url=...",
      riskSchema: "GET /api/risk-schema",
      riskAssessment: "POST /api/risk-assessment",
      localGraph: "GET /api/local-graph?limit=20",
      reportHtml: "POST /api/report/html",
      netcheck: "GET /api/netcheck",
    },
  });
});

app.get("/api/netcheck", async (req, res) => {
  const targets = [
    "https://app.pendle.finance/",
    "https://api-v2.pendle.finance/core/v2/markets/all?skip=0&limit=1",
    "https://api.llama.fi/protocols",
  ];
  const results = [];
  for (const url of targets) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
        signal: controller.signal,
      });
      results.push({
        url,
        ok: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type") || null,
      });
    } catch (err) {
      results.push({
        url,
        ok: false,
        status: 0,
        error: String(err?.message || err),
      });
    } finally {
      clearTimeout(t);
    }
  }
  res.json({ ok: true, results });
});

app.get("/api/local-graph", async (req, res) => {
  try {
    await localGraphInit().catch(() => {});
    const limit = Number(req.query.limit || 40);
    const overview = await getLocalGraphOverview({ limit });
    res.json({
      ok: true,
      hostedEnrich: String(process.env.ENABLE_HOSTED_ENRICH || "0") === "1",
      llmProvider: String(process.env.LLM_PROVIDER || "cursor"),
      ...overview,
    });
  } catch (err) {
    console.error("/api/local-graph error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/import/relationships", async (req, res) => {
  try {
    await localGraphInit().catch(() => {});
    const { format, text } = req.body || {};
    const fmt = String(format || "").toLowerCase().trim();
    const payloadText = String(text || "");
    if (!payloadText.trim()) return res.status(400).json({ ok: false, error: "Missing text" });

    let rows = null;
    if (fmt === "json" || payloadText.trim().startsWith("[")) {
      rows = JSON.parse(payloadText);
    } else if (fmt === "csv") {
      rows = parseCsvText(payloadText);
    } else {
      return res.status(400).json({ ok: false, error: "Unknown format (use json or csv)" });
    }
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ ok: false, error: "No rows found" });

    const byRoot = new Map();
    for (const r of rows) {
      const root = String(r?.root_protocol || r?.rootProtocol || "").trim() || "unknown";
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(r);
    }

    const imported = [];
    for (const [rootProtocol, group] of byRoot.entries()) {
      const g = toImportGraph({ rootProtocol, rows: group });
      await upsertProtocolGraphLocal({
        protocol: g.protocol,
        tokens: g.tokens,
        contracts: g.contracts,
        auditors: g.auditors,
        docPages: [],
        connections: g.connections,
        architecture: null,
      });
      imported.push({ rootProtocol, id: g.protocol.id, rows: group.length, auditors: g.auditors.length });
    }

    return res.json({ ok: true, imported });
  } catch (err) {
    console.error("/api/import/relationships error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

function parseDocxFields(rawText) {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const joined = lines.join("\n");

  const pick = (re) => {
    const m = re.exec(joined);
    return m && m[1] ? String(m[1]).trim() : null;
  };

  function sectionSlice(startRe, endRe) {
    const startIdx = lines.findIndex((l) => startRe.test(l));
    if (startIdx < 0) return [];
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (endRe.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    return lines.slice(startIdx, endIdx);
  }

  const protocolName =
    pick(/^\s*Protocol\s*\n\s*([^\n]{2,120})/mi) ||
    pick(/^\s*Protocol name\s*:\s*([^\n]{2,120})/mi) ||
    null;

  const origin =
    pick(/^\s*Input resolved from:\s*(https?:\/\/[^\s]+)\s*$/mi) ||
    pick(/^\s*URL\s*:\s*(https?:\/\/[^\s]+)\s*$/mi) ||
    null;

  const riskScore =
    pick(/^\s*Overall risk score\s*\n\s*([^\n]{1,80})/mi) ||
    pick(/^\s*Overall risk score\s*:\s*([^\n]{1,80})/mi) ||
    null;

  // Concise description: prefer section 1.
  const descSection = sectionSlice(/^\s*1\.\s*Concise protocol description/i, /^\s*2\.\s*Assumptions and scope/i);
  const description = descSection.length
    ? descSection
        .slice(1)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800)
    : null;

  // Sources / methodology: pull the “prioritizes primary…” paragraph.
  const sourcesPara = pick(/prioritizes primary and near-primary sources:\s*([^\n]+(?:\n[^\n]+){0,3})/i);

  // Auditors: look for “Audited by …” lines and also the Verified auditors table section.
  const auditorNames = new Set();
  for (const l of lines) {
    const m = /audited by\s+(.+)/i.exec(l);
    if (!m) continue;
    const chunk = m[1].replace(/\.\s*$/, "");
    chunk
      .split(/,| and | & /i)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => auditorNames.add(n));
  }

  const verifiedAuditorsSection = sectionSlice(
    /^\s*3\.\s*Verified auditors and security references/i,
    /^\s*4\.\s*/i
  );
  if (verifiedAuditorsSection.length) {
    // Heuristic: names are standalone lines followed by coverage/status/notes rows.
    // Capture capitalized / brand-like tokens and common audit orgs; ignore headers.
    const ignore = new Set(["entity", "coverage", "verification status", "notes"]);
    for (const l of verifiedAuditorsSection) {
      const s = String(l || "").trim();
      if (!s) continue;
      if (ignore.has(s.toLowerCase())) continue;
      if (s.length > 48) continue;
      // Avoid capturing "Verified" or similar table cells.
      if (/^verified$/i.test(s)) continue;
      if (/compound/i.test(s) && s.length > 12) continue;
      // Likely auditor name (contains letters, maybe spaces).
      if (/^[a-z0-9][a-z0-9 ._-]{1,48}$/i.test(s)) {
        // Skip obvious non-names from table.
        if (/^formal verification|bug bounty/i.test(s)) continue;
        auditorNames.add(s);
      }
    }
  }

  // Risk overview table section.
  const riskSection = sectionSlice(/^\s*7\.\s*Structured risk overview/i, /^\s*8\.\s*/i);
  const riskRows = [];
  if (riskSection.length) {
    // Table-like: Risk area / Assessment / Rationale repeated as 3-line chunks.
    for (let i = 0; i < riskSection.length - 3; i++) {
      const a = riskSection[i];
      const b = riskSection[i + 1];
      const c = riskSection[i + 2];
      if (!a || !b || !c) continue;
      if (/^risk area$/i.test(a) || /^assessment$/i.test(b) || /^rationale$/i.test(c)) continue;
      if (/^overall risk score$/i.test(a)) continue;
      if (b.length <= 24 && c.length >= 12) {
        // a: area, b: assessment, c: rationale
        if (/^\d+\./.test(a)) continue;
        riskRows.push({ area: a, assessment: b, rationale: c });
      }
      if (riskRows.length >= 20) break;
    }
  }

  // Connected protocols table (assets -> issuer). Present as 5-line chunks before section 6 heading.
  const connectedIdx = lines.findIndex((l) => /^6\.\s*Connected protocols/i.test(l));
  const assetRows = [];
  if (connectedIdx > 10) {
    const window = lines.slice(Math.max(0, connectedIdx - 140), connectedIdx);
    // Try reading from bottom upwards to avoid earlier unrelated sections.
    for (let i = 0; i < window.length - 4; i++) {
      const token = window[i];
      const role = window[i + 1];
      const issuer = window[i + 2];
      const chain = window[i + 3];
      const note = window[i + 4];
      if (!token || !issuer) continue;
      if (token.length > 20) continue;
      if (!/[A-Za-z]/.test(token)) continue;
      if (issuer.length > 60) continue;
      if (!/[A-Za-z]/.test(issuer)) continue;
      if (!/collateral|underlying|base|token/i.test(role)) continue;
      assetRows.push({ token, role, issuer, chain, note });
      if (assetRows.length >= 40) break;
    }
  }

  return {
    protocolName,
    origin,
    riskScore,
    description,
    sources: sourcesPara ? sourcesPara.replace(/\s+/g, " ").trim().slice(0, 900) : null,
    auditors: Array.from(auditorNames).slice(0, 30),
    riskOverview: riskRows.slice(0, 18),
    connectedAssets: assetRows.slice(0, 40),
  };
}

app.post("/api/import/docx", upload.single("file"), async (req, res) => {
  try {
    await localGraphInit().catch(() => {});
    const f = req.file;
    if (!f || !f.buffer) return res.status(400).json({ ok: false, error: "Missing DOCX file" });

    const extracted = await mammoth.extractRawText({ buffer: f.buffer });
    const rawText = String(extracted?.value || "");
    const fields = parseDocxFields(rawText);
    const name = fields.protocolName || (f.originalname ? f.originalname.replace(/\.docx$/i, "") : "Imported DOCX");
    const slug = slugKey(name);
    const protocolId = `import:${slug}`;
    const protocolUrl = fields.origin || `import:docx:${slug}`;

    // Persist the original DOCX and extract embedded media.
    const safeFolder = String(protocolId).replace(/[^a-zA-Z0-9._-]+/g, "_");
    const baseDir = path.join(process.cwd(), "data", "imports", safeFolder);
    const mediaDir = path.join(baseDir, "media");
    try {
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(path.join(baseDir, "report.docx"), f.buffer);
    } catch (e) {
      console.warn("DOCX persist failed:", e?.message ? String(e.message) : String(e));
    }

    const media = [];
    try {
      const zip = await JSZip.loadAsync(f.buffer);
      const entries = Object.keys(zip.files || {}).filter((p) => p.startsWith("word/media/"));
      for (const p of entries.slice(0, 40)) {
        const file = zip.file(p);
        if (!file) continue;
        const filename = p.split("/").pop() || "image";
        const outPath = path.join(mediaDir, filename);
        const buf = await file.async("nodebuffer");
        fs.writeFileSync(outPath, buf);
        media.push({
          filename,
          url: `/imports/${encodeURIComponent(safeFolder)}/media/${encodeURIComponent(filename)}`,
        });
      }
    } catch (e) {
      console.warn("DOCX media extraction failed:", e?.message ? String(e.message) : String(e));
    }

    const auditors = Array.isArray(fields.auditors) ? fields.auditors.map((n) => ({ name: n })) : [];

    // Build a lightweight relationship graph from parsed “connected assets” rows.
    const nodes = [];
    const edges = [];
    const seen = new Set();
    const rootPid = `protocol:${slugKey(name)}`;
    const addNode = (n) => {
      if (!n?.id) return;
      if (seen.has(n.id)) return;
      seen.add(n.id);
      nodes.push(n);
    };
    addNode({ kind: "protocol", id: rootPid, label: name, name });

    for (const row of Array.isArray(fields.connectedAssets) ? fields.connectedAssets : []) {
      const tokenId = `token:${slugKey(row.token)}`;
      const issuerPid = `protocol:${slugKey(String(row.issuer).split("/")[0])}`;
      addNode({ kind: "token", id: tokenId, label: row.token, symbol: row.token, network: row.chain || "Unknown" });
      addNode({ kind: "protocol", id: issuerPid, label: row.issuer, name: row.issuer, network: row.chain || "Unknown" });
      edges.push({
        from: rootPid,
        to: tokenId,
        relation: "lists_asset",
        evidence: `DOCX: ${row.role}${row.note ? ` — ${row.note}` : ""}`.slice(0, 300),
      });
      edges.push({
        from: tokenId,
        to: issuerPid,
        relation: "issued_by",
        evidence: `DOCX: issuer = ${row.issuer}`.slice(0, 240),
      });
      if (edges.length >= 120) break;
    }

    const extra = {
      importType: "docx",
      filename: f.originalname || null,
      mimeType: f.mimetype || null,
      docxUrl: `/imports/${encodeURIComponent(safeFolder)}/report.docx`,
      media,
      extractedText: rawText,
      extractedFields: fields,
    };

    await upsertProtocolGraphLocal({
      protocol: { id: protocolId, name, url: protocolUrl, defillamaSlug: null },
      tokens: [],
      contracts: [],
      auditors,
      docPages: [],
      connections: { nodes, edges, evidence: ["Imported DOCX"] },
      architecture: null,
      extra,
    });

    // Attach this DOCX to an existing protocol record when we can identify it
    // (e.g. url:https://app.compound.finance, defillama:slug, etc.)
    try {
      if (fields?.origin) {
        const u = new URL(String(fields.origin));
        const urlId = `url:${u.origin}`;
        await upsertProtocolExtraLocal({
          id: urlId,
          name,
          url: u.origin,
          extra,
        }).catch(() => {});
      }
    } catch {
      // ignore
    }

    return res.json({ ok: true, id: protocolId, name, url: protocolUrl, auditors: auditors.length });
  } catch (err) {
    console.error("/api/import/docx error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/import/search", async (req, res) => {
  try {
    await localGraphInit().catch(() => {});
    const q = String(req.query.q || "").trim();
    const results = await searchLocalProtocols({ q, limit: Number(req.query.limit || 25) });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/import/protocol", async (req, res) => {
  try {
    await localGraphInit().catch(() => {});
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    const g = await getProtocolGraphLocalById({ id });
    if (!g.ok) return res.status(500).json(g);
    if (!g.hit) return res.status(404).json({ ok: true, hit: false, id });
    const p = g.protocol || {};
    const out = {
      origin: p.url || null,
      cache: { protocolKey: g.id, hit: true, source: "local_graph" },
      llmEnrich: { enabled: false, source: "imported" },
      protocol: {
        name: p.name || null,
        url: p.url || null,
        auditsVerified: Array.isArray(p.auditors) && p.auditors.length ? { count: p.auditors.length, firms: p.auditors.map((a) => a.name) } : null,
      },
      contracts: (p.contracts || []).map((c) => ({
        label: c.label || "Contract",
        network: c.chain || "Unknown",
        address: c.address,
        evidence: "Source: imported file",
      })),
      tokenLiquidity: (p.tokens || []).map((t) => ({
        token: t.symbol || "Token",
        tokenAddress: t.address,
        liquidityUsd: null,
        evidence: ["Source: imported file"],
      })),
    };
    try {
      if (p.connectionsJson) out.connections = JSON.parse(p.connectionsJson);
    } catch {}
    try {
      if (p.extraJson) out.imported = JSON.parse(p.extraJson);
    } catch {}
    // Evidence notes: show import provenance and latest update.
    out.evidenceNotes = [
      { label: "Imported protocol", source: "User upload", detail: `Loaded from local graph DB (${g.id}).` },
      ...(out.protocol?.auditsVerified?.firms?.length ? [{ label: "Auditors (imported)", source: "User upload", detail: out.protocol.auditsVerified.firms.join(", ") }] : []),
    ];
    return res.json({ ok: true, data: out });
  } catch (err) {
    console.error("/api/import/protocol error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Database API (Neo4j-first, with local graph fallback)
app.get("/api/db/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Number(req.query.limit || 25);
    await localGraphInit().catch(() => {});

    if (neo4jEnabled()) {
      const results = await searchProtocolsNeo4j({ q, limit }).catch(() => []);
      return res.json({ ok: true, source: "neo4j", results });
    }
    const results = await searchLocalProtocols({ q, limit });
    return res.json({ ok: true, source: "local_graph", results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/db/protocol", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    await localGraphInit().catch(() => {});
    const g = neo4jEnabled()
      ? await getProtocolGraphNeo4jById({ id })
      : await getProtocolGraphLocalById({ id });

    if (!g.ok) return res.status(500).json(g);
    if (!g.hit) return res.status(404).json({ ok: true, hit: false, id });

    const p = g.protocol || {};
    const out = { ok: true, hit: true, id: g.id, protocol: p, source: neo4jEnabled() ? "neo4j" : "local_graph" };
    try {
      if (p.connectionsJson) out.connections = JSON.parse(p.connectionsJson);
    } catch {}
    try {
      if (p.architectureJson) out.architecture = JSON.parse(p.architectureJson);
    } catch {}
    try {
      if (p.extraJson) out.extra = JSON.parse(p.extraJson);
    } catch {}
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/db/related", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const hops = Number(req.query.hops || 4);
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!neo4jEnabled()) {
      return res.json({ ok: true, source: "local_graph", hit: true, id, graph: { nodes: [], edges: [] } });
    }
    const r = await getRelatedProtocolsNeo4j({ id, hops });
    if (!r.ok) return res.status(500).json(r);
    return res.json({ ok: true, source: "neo4j", ...r });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/db/pool/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Number(req.query.limit || 25);
    await localGraphInit().catch(() => {});

    // Prefer Neo4j pool contracts when available
    if (neo4jEnabled()) {
      const results = await searchPoolsNeo4j({ q, limit }).catch(() => []);
      if (results.length) return res.json({ ok: true, source: "neo4j", results });
    }

    // Fallback: coworker-friendly pools stored in local_graph extra_json (DefiLlama yields)
    const yieldPools = await searchYieldPoolsLocal({ q, limit }).catch(() => []);
    return res.json({ ok: true, source: "local_graph", results: yieldPools });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/db/pool/neighborhood", async (req, res) => {
  try {
    const chain = String(req.query.chain || "ethereum").trim();
    const address = String(req.query.address || "").trim();
    const hops = Number(req.query.hops || 4);
    if (!neo4jEnabled()) return res.json({ ok: true, source: "local_graph", hit: false });
    const r = await getPoolNeighborhoodNeo4j({ chain, address, hops });
    if (!r.ok) return res.status(400).json(r);
    return res.json({ ok: true, source: "neo4j", ...r });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Static assets after explicit /api/health and /api/local-graph.
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
// Serve imported doc assets (docx + extracted media).
app.use("/imports", express.static(path.join(process.cwd(), "data", "imports")));
app.use(express.static(__dirname));

app.get("/api/analyze", async (req, res) => {
  const url = req.query.url;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url query parameter." });
  }

  const origin = normalizeUrl(url);

  try {
    const [tvl, contracts, txs, investors] = await Promise.all([
      getDefiLlamaTvlFromModule(origin).catch((err) => {
        console.error("DefiLlama TVL error:", err.message);
        return null;
      }),
      getEtherscanContracts(origin).catch((err) => {
        console.error("Etherscan contracts error:", err.message);
        return [];
      }),
      getTransactionsPerDay(origin).catch((err) => {
        console.error("Tx per day error:", err.message);
        return null;
      }),
      getInvestorsStub(origin).catch((err) => {
        console.error("Investors stub error:", err.message);
        return [];
      }),
    ]);

    return res.json({
      origin,
      contracts,
      tvl,
      investors,
      txsPerDay: txs,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error while analyzing protocol." });
  }
});

function bodyTruthyFlag(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return /^(1|true|yes|on)$/i.test(v.trim());
  return false;
}

function withTimeout(promise, ms, label) {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label || "operation"} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

app.post("/api/llm-analyze", async (req, res) => {
  const { url, walletAddress } = req.body || {};
  const forceRefresh = bodyTruthyFlag((req.body || {}).forceRefresh);

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' in request body." });
  }

  const origin = normalizeUrl(url);

  try {
    // Local graph DB init (always local file). No credentials needed.
    await localGraphInit().catch(() => {});
    // Optional Neo4j graph init (best-effort).
    if (neo4jEnabled()) {
      await neo4jInit().catch((err) => {
        console.warn("Neo4j init failed; continuing with SQLite graph cache:", err?.message ? String(err.message) : String(err));
      });
    }

    const hasPostgres = Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
    if (ENABLE_PROTOCOL_DB_CACHE && hasPostgres) {
      // best-effort init (safe on repeated calls / cold starts)
      await protocolCacheInit().catch(() => {});
    }

    let defillamaMatchError = null;
    const defillama = await getDefiLlamaProtocolByUrlFromModule(origin).catch((err) => {
      defillamaMatchError = err?.message ? String(err.message) : String(err);
      console.warn("DefiLlama protocol match error:", defillamaMatchError);
      return null;
    });
    const defillamaApiDetail = defillama?.slug
      ? await getDefiLlamaProtocolApiDetailFromModule(defillama.slug).catch(() => null)
      : null;

    // Graph-first: if protocol graph exists and no wallet requested, return it.
    const defillamaSlug = defillama?.slug || null;
    const graph = neo4jEnabled()
      ? await getProtocolGraphNeo4j({ origin, defillamaSlug }).catch(() => null)
      : await getProtocolGraphLocal({ origin, defillamaSlug }).catch(() => null);
    if (!forceRefresh && graph?.ok && graph?.hit && !(walletAddress && String(walletAddress).trim())) {
      const p = graph.protocol || {};
      const fallbackTokens =
        Array.isArray(defillamaApiDetail?.topTokenLiquidity) ? defillamaApiDetail.topTokenLiquidity : [];
      const fallbackContracts = [];
      // If DefiLlama exposes a canonical contract/token address, surface it as a contract in cache view.
      if (typeof defillamaApiDetail?.addressRaw === "string" && defillamaApiDetail.addressRaw.includes("0x")) {
        const m = defillamaApiDetail.addressRaw.match(/(0x[a-fA-F0-9]{40})/);
        if (m && m[1]) {
          fallbackContracts.push({
            label: `${defillamaApiDetail?.name || p.name || "Protocol"} contract`,
            network: defillamaApiDetail?.addressChain || "Unknown",
            address: m[1].toLowerCase(),
            evidence: defillamaApiDetail.apiUrl || "DefiLlama protocol API",
          });
        }
      }
      const out = {
        origin,
        cache: { protocolKey: graph.id, hit: true, source: graph.source || (neo4jEnabled() ? "neo4j" : "local_graph") },
        llmEnrich: {
          enabled: false,
          source: graph.source || (neo4jEnabled() ? "neo4j" : "local_graph"),
          note:
            "Served from SQLite graph cache (fast path). Enable “Full refresh” in the UI or POST forceRefresh: true to re-crawl the site and run hosted LLM.",
        },
        protocol: {
          name: p.name || null,
          url: p.url || origin,
          auditsVerified: p.auditors?.length ? { count: p.auditors.length, firms: p.auditors.map((a) => a.name) } : null,
        },
        tokenLiquidity: (p.tokens || []).length
          ? (p.tokens || []).map((t) => ({
              token: t.symbol || "Token",
              tokenAddress: t.address,
              liquidityUsd: null,
              evidence: ["Source: graph cache"],
            }))
          : fallbackTokens,
        contracts: (p.contracts || []).length
          ? (p.contracts || []).map((c) => ({
              label: c.label || "Contract",
              network: "Ethereum",
              address: c.address,
              evidence: "Source: graph cache",
            }))
          : fallbackContracts,
      };
      // Persist connection/architecture json if present
      try {
        if (p.connectionsJson) out.connections = JSON.parse(p.connectionsJson);
      } catch {}
      try {
        if (p.architectureJson) out.protocol.architecture = JSON.parse(p.architectureJson);
      } catch {}
      try {
        out.evidenceNotes = buildEvidenceNotes(out, {
          defillama,
          defillamaApi: defillamaApiDetail,
          origin,
        });
      } catch {
        // ignore
      }
      return res.json(out);
    }

    // Cache-first (protocol-level). Wallet allocations are never cached.
    let { protocolKey, slug, originHost } = protocolKeyFrom({ defillama, origin });
    if (!protocolKey) {
      try {
        const u = new URL(origin);
        protocolKey = `origin:${u.host.toLowerCase()}`;
        originHost = originHost || u.host.toLowerCase();
      } catch {
        protocolKey = `origin:${String(originHost || origin).toLowerCase()}`;
      }
    }
    let cached = null;
    let cacheMeta = null;
    // Always surface a protocolKey so clients can request reports without resending full analysis.
    cacheMeta = { protocolKey, hit: false, updatedAt: null, ageMs: null, stale: true };

    if (ENABLE_PROTOCOL_DB_CACHE && hasPostgres) {
      cached = await protocolCacheGetLatest({ protocolKey }).catch(() => null);
      if (cached?.analysis_json) {
        const updatedAtMs = cached.updated_at ? new Date(cached.updated_at).getTime() : 0;
        const ageMs = updatedAtMs ? Date.now() - updatedAtMs : null;
        const stale = typeof ageMs === "number" ? ageMs > PROTOCOL_CACHE_TTL_MS : true;
        cacheMeta = { protocolKey, hit: true, updatedAt: cached.updated_at || null, ageMs, stale };

        // If cache is fresh and no wallet is requested, return cached immediately (fast path)
        // except when cached core data is clearly incomplete (empty token/contracts),
        // in which case we refresh to heal stale/partial snapshots.
        const cachedAnalysis = cached.analysis_json || {};
        const cachedTokens = Array.isArray(cachedAnalysis?.tokenLiquidity) ? cachedAnalysis.tokenLiquidity : [];
        const cachedContracts = Array.isArray(cachedAnalysis?.contracts) ? cachedAnalysis.contracts : [];
        const cacheIncomplete =
          cachedTokens.length === 0 ||
          cachedContracts.length === 0;
        if (!forceRefresh && !stale && !cacheIncomplete && !(walletAddress && String(walletAddress).trim())) {
          const out = { ...(cached.analysis_json || {}) };
          out.cache = cacheMeta;
          if (!Array.isArray(out.evidenceNotes) || !out.evidenceNotes.length) {
            try {
              out.evidenceNotes = buildEvidenceNotes(out, {
                defillama,
                defillamaApi: defillamaApiDetail,
                origin,
              });
            } catch {
              // ignore
            }
          }
          return res.json(out);
        }
      } else {
        cacheMeta = { protocolKey, hit: false, updatedAt: null, ageMs: null, stale: true };
      }
    }

    const defiLlamaSlug =
      defillama?.slug ||
      (defillama?.defillamaUrl
        ? (() => {
            try {
              const u = new URL(defillama.defillamaUrl);
              const parts = u.pathname.split("/").filter(Boolean);
              return parts[parts.length - 1] || null;
            } catch {
              return null;
            }
          })()
        : null);

    const page = await Promise.race([
      fetchHtmlWithOptionalRender(origin),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              status: 0,
              html: "",
              extracted: {},
              rendered: false,
              renderError: "HTML fetch timeout",
            }),
          8000
        )
      ),
    ]).catch((err) => ({
      ok: false,
      status: 0,
      html: "",
      extracted: {},
      rendered: false,
      renderError: err?.message ? String(err.message) : String(err),
    }));

    // Some protocols (or local networks) can block/timeout HTML fetches.
    // Continue best-effort using structured sources (DefiLlama/Pendle/etc.) instead of failing the whole analysis.
    const html = page?.ok && page.html ? page.html : "";

    // Heuristic extraction directly from the full HTML (no LLM).
    const tvlFromHtml = extractTvlFromHtml(html);
    const tokenLiquidity = (page.extracted?.tokenLiquidity?.length
      ? page.extracted.tokenLiquidity
      : extractTokenLiquidityFromHtml(html));

    // Fallback: if the submitted page doesn't expose token liquidity (or exposes too little),
    // pull a best-effort token+TVL list from DefiLlama yields.
    let tokenLiquidityFinal = tokenLiquidity;
    const isPendleLike = /pendle/i.test(String(defillama?.name || "")) || /pendle\.finance/i.test(origin);
    let pendleSnapshot = null;
    if (isPendleLike) {
      pendleSnapshot = await getPendleMarketSnapshotFromModule({ origin }).catch((err) => {
        console.warn("Pendle markets snapshot error:", err?.message ? String(err.message) : String(err));
        return null;
      });
      if (Array.isArray(pendleSnapshot?.tokenLiquidity) && pendleSnapshot.tokenLiquidity.length) {
        tokenLiquidityFinal = pendleSnapshot.tokenLiquidity;
      }
    }

    const tokenRowsHaveAddresses = Array.isArray(tokenLiquidity)
      ? tokenLiquidity.some((t) => /^0x[a-fA-F0-9]{40}$/.test(String(t?.tokenAddress || t?.contractAddress || t?.address || "").trim()))
      : false;
    const tokenCount = Array.isArray(tokenLiquidity) ? tokenLiquidity.length : 0;

    // Fallback: if on-page extraction is sparse OR lacks on-chain addresses, prefer DefiLlama yields.
    // Many protocol apps are JS-heavy; when Playwright rendering is skipped/blocked, HTML-visible text can undercount tokens.
    if (
      defiLlamaSlug &&
      (tokenCount <= 12 || !tokenRowsHaveAddresses)
    ) {
      const fromYields = await getDefiLlamaTokenLiquidityFromYieldsFromModule(defiLlamaSlug).catch(() => null);
      if (Array.isArray(fromYields) && fromYields.length) {
        // Merge, prefer richer yield-derived list but keep any on-page rows too.
        const seen = new Set();
        const merged = [];
        const add = (row) => {
          if (!row) return;
          const key = String(row?.token || row?.asset || "").toLowerCase();
          const addr = String(row?.tokenAddress || row?.contractAddress || row?.address || "").toLowerCase();
          const k = addr && addr.startsWith("0x") ? addr : key;
          if (!k) return;
          if (seen.has(k)) return;
          seen.add(k);
          merged.push(row);
        };
        fromYields.forEach(add);
        tokenLiquidity.forEach(add);
        tokenLiquidityFinal = merged;
      }
    }

    // Investors are not extracted; we show DefiLlama "Total raised" instead.
    const investorsFromHtml = [];

    // Keep the HTML snippet for the local model very small so we stay within
    // the 2048 token context window. This is enough for titles, headings, and key descriptions.
    const snippet = html.slice(0, 800);

    // Website LLM analysis can be slow (and can block the request) on some hosts.
    // Default to heuristic/non-LLM behavior unless explicitly enabled.
    // Default ON: user prefers AI-assisted doc/architecture extraction.
    // Set ENABLE_WEBSITE_LLM=0 to disable.
    const enableWebsiteLlm = String(process.env.ENABLE_WEBSITE_LLM || "1").toLowerCase() === "1";
    const analysis = enableWebsiteLlm
      ? await runWebsiteAnalysisWithGpt4All(origin, snippet).catch((err) => {
          console.warn("LLM website analysis failed, falling back to non-LLM data:", err.message);
          return null;
        })
      : null;

    // Enrich: DefiLlama TVL + basic metadata
    const enriched = analysis ? { ...analysis } : {};
    // Attach Pendle snapshot metadata now that `enriched` exists.
    if (pendleSnapshot && typeof pendleSnapshot === "object") {
      enriched.pendle = {
        ok: true,
        chainId: pendleSnapshot.chainId || null,
        tokenLiquidity: Array.isArray(pendleSnapshot.tokenLiquidity) ? pendleSnapshot.tokenLiquidity.length : 0,
        contracts: Array.isArray(pendleSnapshot.contracts) ? pendleSnapshot.contracts.length : 0,
        evidence: Array.isArray(pendleSnapshot.evidence) ? pendleSnapshot.evidence : [],
      };
    }
    // Also merge discovered contracts (markets/PT/YT/SY) when present.
    if (Array.isArray(pendleSnapshot?.contracts) && pendleSnapshot.contracts.length) {
      const byAddr = new Set(
        (Array.isArray(enriched.contracts) ? enriched.contracts : [])
          .map((c) => String(c?.address || "").toLowerCase())
          .filter(Boolean)
      );
      enriched.contracts = Array.isArray(enriched.contracts) ? enriched.contracts : [];
      for (const c of pendleSnapshot.contracts.slice(0, 120)) {
        const a = String(c?.address || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(a)) continue;
        if (byAddr.has(a)) continue;
        byAddr.add(a);
        enriched.contracts.push({
          label: c.label || "Contract",
          network: c.network || "Ethereum",
          address: c.address,
          evidence: c.evidence || "Source: Pendle markets API",
        });
      }
    }

    // Always return protocol metadata so the frontend can render an identity even
    // when the LLM fails and DefiLlama has no match.
    enriched.protocol = {
      ...(enriched.protocol || {}),
      url: origin,
      name: (enriched?.protocol?.name || defillama?.name || inferNameFromUrl(origin)),
    };
    if (defillama?.listedAt && !enriched.protocol.listedAt) {
      enriched.protocol.listedAt = defillama.listedAt;
    }
    if (Array.isArray(defillama?.chains) && defillama.chains.length) {
      enriched.protocol.chains = defillama.chains;
    }

    // Prefer DefiLlama description/methodology/audits when available.
    if (!enriched.protocol.description && defillama?.description) {
      enriched.protocol.description = defillama.description;
    }
    if (!enriched.protocol.methodology && defillama?.methodology) {
      enriched.protocol.methodology = defillama.methodology;
    }
    if (!enriched.protocol.methodologyUrl && defillama?.methodologyUrl) {
      enriched.protocol.methodologyUrl = defillama.methodologyUrl;
    }
    if (enriched.protocol.audits == null && defillama?.audits != null) {
      enriched.protocol.audits = defillama.audits;
    }
    if ((!enriched.protocol.auditLinks || !enriched.protocol.auditLinks.length) && defillama?.auditLinks?.length) {
      enriched.protocol.auditLinks = defillama.auditLinks;
    }

    // Docs-first audit verification (best-effort). Helps correct stale/incorrect metadata.
    const auditVerify = await verifyAuditsFromProtocolDocs({
      origin,
      protocolName: enriched?.protocol?.name || defillama?.name || null,
    }).catch((err) => ({
      count: null,
      firms: [],
      evidence: [`Audit verification failed: ${err?.message ? String(err.message) : String(err)}`],
    }));
    enriched.protocol.auditsVerified = auditVerify;

    // Compatibility: some clients expect `origin` at the top level.
    enriched.origin = origin;

    // Step-4 aligned fields
    enriched.chainsSupported = Array.isArray(defillama?.chains) ? defillama.chains : (enriched.protocol.chains || []);
    enriched.pageType = inferPageType({ url: origin });
    enriched.urlAnalysis = analyzeInputUrl(origin);

    // Protocol description + features (best-effort from rendered text)
    if (!enriched.protocol.description || !enriched.protocol.features) {
      const protoInfo = extractProtocolInfoFromHtml(html, {
        protocolName: enriched.protocol.name,
        knownTokens: Array.isArray(tokenLiquidityFinal)
          ? tokenLiquidityFinal.map((t) => t.token).filter(Boolean)
          : [],
      });
      if (protoInfo?.description && !enriched.protocol.description) {
        enriched.protocol.description = protoInfo.description;
      }
      if (Array.isArray(protoInfo?.features) && !Array.isArray(enriched.protocol.features)) {
        enriched.protocol.features = protoInfo.features;
      }
      if (protoInfo?.nativeToken && !enriched.protocol.nativeToken) {
        enriched.protocol.nativeToken = protoInfo.nativeToken;
      }
    }

    if (defillama?.tvlUsd != null) {
      enriched.tvl = {
        valueUsd: defillama.tvlUsd,
        evidence: [
          `DefiLlama TVL for ${defillama.name}: https://defillama.com/protocol/${defillama.slug}`,
        ],
      };
    }

    // If no DefiLlama match, fall back to TVL found directly on the website.
    if (!enriched.tvl) {
      const domMetric = page.extracted?.bestMetric?.usd
        ? page.extracted.bestMetric
        : null;

      const tokenLiquiditySumUsd =
        Array.isArray(tokenLiquidity) && tokenLiquidity.length
          ? tokenLiquidity.reduce(
              (acc, t) => acc + (typeof t.liquidityUsd === "number" ? t.liquidityUsd : 0),
              0
            )
          : 0;

      // If we have a per-token liquidity table, prefer summing it. This is the most
      // reliable cross-site fallback for dashboards that show token rows.
      if (tokenLiquiditySumUsd > 0) {
        enriched.tvl = {
          valueUsd: tokenLiquiditySumUsd,
          evidence: [
            `Sum of per-token liquidity: ${tokenLiquidity.length} tokens (from rendered page)`,
          ],
        };
      } else if (domMetric) {
        enriched.tvl = {
          valueUsd: domMetric.usd,
          evidence: [
            `${domMetric.label}: ${domMetric.moneyLabel} (from rendered page)`,
          ],
        };
      } else if (tvlFromHtml) {
        enriched.tvl = {
          valueUsd: tvlFromHtml.valueUsd,
          evidence: [
            `${tvlFromHtml.text}${
              page.rendered ? " (from rendered page)" : ""
            }`,
          ],
        };
      } else {
        enriched.tvl = { valueUsd: null, evidence: [] };
      }
    }

    if (!Array.isArray(enriched.tokenLiquidity) || enriched.tokenLiquidity.length === 0) {
      enriched.tokenLiquidity = tokenLiquidityFinal;
    }

    // Step-4 aligned: asset list
    if (!Array.isArray(enriched.assets) || enriched.assets.length === 0) {
      enriched.assets = (Array.isArray(enriched.tokenLiquidity) ? enriched.tokenLiquidity : []).map((t) => ({
        symbol: t.token || t.asset || null,
        liquidityUsd: typeof t.liquidityUsd === "number" ? t.liquidityUsd : null,
        evidence: t.evidence || [],
      }));
    }

    function slugifyForDefiLlama(name) {
      return String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    }

    // Total raised (replaces investors UI)
    const totalRaisedSlugs = Array.from(
      new Set(
        [
          defiLlamaSlug,
          defillama?.slug,
          defillama?.name ? slugifyForDefiLlama(defillama.name) : null,
          enriched?.protocol?.name ? slugifyForDefiLlama(enriched.protocol.name) : null,
        ].filter(Boolean)
      )
    );

    let totalRaisedCandidate = null;
    let totalRaisedEvidence = [];
    for (const s of totalRaisedSlugs) {
      const tr = await getDefiLlamaTotalRaisedUsdFromModule(s).catch((err) => {
        console.warn("DefiLlama totalRaised error:", err.message);
        return { value: null, evidence: [`Total raised request failed for slug "${s}": ${err.message}`] };
      });
      if (tr?.evidence && Array.isArray(tr.evidence) && tr.evidence.length && !totalRaisedEvidence.length) {
        totalRaisedEvidence = tr.evidence;
      }
      if (tr && typeof tr.value === "number") {
        totalRaisedCandidate = tr;
        break;
      }
    }

    if (totalRaisedCandidate?.value != null && typeof totalRaisedCandidate.value === "number") {
      enriched.protocol.totalRaisedUsd = totalRaisedCandidate.value;
    }
    // Always attach evidence for troubleshooting (even if parse failed).
    enriched.protocol.totalRaisedEvidence = totalRaisedCandidate?.evidence || totalRaisedEvidence || [];

    // Protocol Information (DefiLlama) -> map into our existing description slot
    let defiProtocolInfo = null;
    for (const s of totalRaisedSlugs) {
      const info = await getDefiLlamaProtocolInformationFromModule(s).catch(() => null);
      if (info?.description) {
        defiProtocolInfo = info;
        break;
      }
    }
    if (defiProtocolInfo?.description) enriched.protocol.description = defiProtocolInfo.description;

    enriched.investors = [];

    // Wallet allocations (optional): summarize token flows between the wallet and detected contracts.
    if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
      const debank = await getWalletProtocolsFromDebank({ walletAddress: walletAddress.trim() }).catch((err) => {
        console.warn("Debank wallet protocols error:", err.message);
        return null;
      });
      const covalent =
        !Array.isArray(debank?.allocations) || debank.allocations.length === 0
          ? await getWalletAllocationsFromCovalent({ walletAddress: walletAddress.trim() }).catch((err) => {
              console.warn("Covalent wallet allocations error:", err.message);
              return null;
            })
          : null;

      const alloc = await getWalletAllocationsFromEtherscan({
        walletAddress: walletAddress.trim(),
        contracts: Array.isArray(enriched.contracts) ? enriched.contracts : [],
      }).catch((err) => {
        console.warn("Wallet allocations error:", err.message);
        return null;
      });
      const etherscanHoldings =
        !Array.isArray(alloc?.allocations) || alloc.allocations.length === 0
          ? await getWalletHoldingsFromEtherscan({ walletAddress: walletAddress.trim() }).catch((err) => {
              console.warn("Etherscan wallet holdings error:", err.message);
              return null;
            })
          : null;

      const merged = [];
      if (Array.isArray(alloc?.allocations)) merged.push(...alloc.allocations);
      if (Array.isArray(etherscanHoldings?.allocations)) merged.push(...etherscanHoldings.allocations);
      if (Array.isArray(debank?.allocations)) merged.push(...debank.allocations);
      if (Array.isArray(covalent?.allocations)) merged.push(...covalent.allocations);
      if (merged.length) enriched.allocations = merged;

      const walletEvidence = [
        ...(Array.isArray(alloc?.evidence) ? alloc.evidence : []),
        ...(Array.isArray(etherscanHoldings?.evidence) ? etherscanHoldings.evidence : []),
        ...(Array.isArray(debank?.evidence) ? debank.evidence : []),
        ...(Array.isArray(covalent?.evidence) ? covalent.evidence : []),
      ];
      if (walletEvidence.length) {
        enriched.wallet = { address: walletAddress.trim(), evidence: walletEvidence };
      }
    }

    /*
    if (cryptoRank?.investors?.length) {
      enriched.investors = cryptoRank.investors.map((n) => ({
        name: n,
        role: "Investor",
        evidence: cryptoRank.evidence || [],
      }));
    } else if (!enriched.investors) {
      enriched.investors = [];
    }
    */

    // Contracts: if LLM didn't find any, try extraction as fallback.
    // Important: only consider explorer links and *visible text* to avoid pulling
    // random addresses from bundled scripts which cannot be labeled reliably.
    if (!Array.isArray(enriched.contracts) || enriched.contracts.length === 0) {
      enriched.contracts = extractContractsFromHtml(html, { visibleTextOnly: true });
    }

    // If no visible-text contracts exist, but rendered DOM has explorer links, expose them as contracts.
    if (
      Array.isArray(enriched.contracts) &&
      enriched.contracts.length === 0 &&
      Array.isArray(page.extracted?.contractLinks) &&
      page.extracted.contractLinks.length
    ) {
      enriched.contracts = page.extracted.contractLinks.map((cl) => ({
        label: cl.label && cl.label.length <= 80 ? cl.label : "Explorer link",
        network: "Unknown",
        address: cl.address,
        evidence: cl.href,
      }));
    }

    // If still empty, use any addresses found in rendered hrefs (e.g. pool links).
    if (
      Array.isArray(enriched.contracts) &&
      enriched.contracts.length === 0 &&
      Array.isArray(page.extracted?.hrefAddresses) &&
      page.extracted.hrefAddresses.length
    ) {
      const seen = new Set();
      enriched.contracts = page.extracted.hrefAddresses
        .filter((h) => {
          const k = String(h.address).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 25)
        .map((h) => ({
          label: h.label && h.label.length <= 100 ? h.label : "Address link",
          network: "Unknown",
          address: h.address,
          evidence: h.href,
        }));
    }

    // 24h Volume (DefiLlama): protocol-level metric (works for any protocol with a DefiLlama match).
    if (!enriched.txsPerDay || (enriched.txsPerDay && enriched.txsPerDay.value == null)) {
      const volume = await getDefiLlamaVolume24hFromModule(defiLlamaSlug).catch((err) => {
        console.warn("DefiLlama volume24h error:", err.message);
        return null;
      });
      if (volume && typeof volume.value === "number") {
        enriched.txsPerDay = {
          value: volume.value,
          evidence: volume.evidence || [],
          source: "defillama",
        };
      } else {
        enriched.txsPerDay = { value: null, evidence: volume?.evidence || [] };
      }
    }

    // Step-4 aligned: pools / asset info (best-effort)
    if (!Array.isArray(enriched.pools) || enriched.pools.length === 0) {
      const pools = [];
      const seenPool = new Set();
      const hrefs = Array.isArray(page.extracted?.hrefAddresses) ? page.extracted.hrefAddresses : [];
      for (const h of hrefs) {
        const hint = String(h.href || "").toLowerCase();
        const isPool = hint.includes("pool") || hint.includes("pools") || hint.includes("market") || hint.includes("markets");
        if (!isPool) continue;
        const addr = String(h.address || "").toLowerCase();
        if (!addr || seenPool.has(addr)) continue;
        seenPool.add(addr);
        pools.push({
          poolContract: h.address,
          tokenPair: null,
          network: inferNetworkFromUrl(origin),
          evidence: [h.href],
        });
        if (pools.length >= 15) break;
      }
      enriched.pools = pools;
    }

    // If we rendered the page, use contract links discovered from the DOM to improve labeling.
    if (Array.isArray(page.extracted?.contractLinks) && page.extracted.contractLinks.length) {
      const byAddr = new Map(
        (enriched.contracts || []).map((c) => [String(c.address).toLowerCase(), c])
      );
      for (const cl of page.extracted.contractLinks) {
        const key = String(cl.address).toLowerCase();
        const existing = byAddr.get(key);
        const label = cl.label && cl.label.length <= 80 ? cl.label : "Explorer link";
        if (existing) {
          if (existing.label?.startsWith("Detected contract")) {
            existing.label = label;
          }
          if (!existing.evidence) existing.evidence = cl.href ? cl.href : undefined;
        } else {
          enriched.contracts.push({
            label,
            network: "Unknown",
            address: cl.address,
            evidence: cl.href,
          });
        }
      }
    }

    // Pendle structured contracts (router/market/PT/YT/SY/underlying) from official API.
    if (Array.isArray(pendleSnapshot?.contracts) && pendleSnapshot.contracts.length) {
      if (!Array.isArray(enriched.contracts)) enriched.contracts = [];
      const byAddr = new Map(
        (enriched.contracts || []).map((c) => [String(c.address || "").toLowerCase(), c])
      );
      for (const c of pendleSnapshot.contracts) {
        const key = String(c.address || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(key)) continue;
        if (byAddr.has(key)) continue;
        enriched.contracts.push({
          label: c.label || "Contract",
          network: c.network || "Unknown",
          address: c.address,
          evidence: c.evidence || "Source: Pendle markets API",
        });
        byAddr.set(key, c);
      }
    }

    // Additional labeling: if rendered DOM provides context around an address, infer a role label.
    if (Array.isArray(page.extracted?.addressContexts) && page.extracted.addressContexts.length) {
      const byAddr = new Map(
        (enriched.contracts || []).map((c) => [String(c.address).toLowerCase(), c])
      );
      for (const ac of page.extracted.addressContexts) {
        const key = String(ac.address).toLowerCase();
        const existing = byAddr.get(key);
        if (!existing) continue;
        const inferred = inferContractLabelFromText(ac.context);
        if (inferred && (!existing.label || /contract \(|detected/i.test(existing.label))) {
          existing.label = inferred;
        }
        if (ac.context && !existing.evidence) {
          existing.evidence = ac.context;
        }
      }
    }

    // AI-powered architecture inference (router/amm/vault/token graph).
    // This uses only extracted facts + visible text; no web browsing.
    try {
      const visibleText = htmlToVisibleText(html);
      const arch = await inferArchitectureWithGpt4All({
        protocolName: enriched?.protocol?.name || defillama?.name || null,
        origin,
        tokens: enriched.tokenLiquidity || [],
        contracts: enriched.contracts || [],
        urlAnalysis: enriched.urlAnalysis || {},
        visibleText,
      });
      if (arch) {
        enriched.protocol.architecture = arch;
      }
    } catch (err) {
      console.warn("Architecture inference failed:", err?.message ? String(err.message) : String(err));
    }

    // Final contract enrichment: ensure router/token/vault contracts are surfaced
    // even when DOM render extraction is unavailable.
    enrichContractsFromKnownSources({ enriched, origin });

    // Connected contracts graph (Ethereum-only): vault/market -> underlying token (RPC) -> ecosystem routers (curated).
    try {
      const connections = await discoverContractConnections({
        origin,
        contracts: enriched.contracts || [],
        tokenLiquidity: enriched.tokenLiquidity || [],
      });
      if (connections && typeof connections === "object") {
        enriched.connections = connections;

        // Merge discovered nodes into contracts list for UI visibility.
        if (Array.isArray(enriched.connections?.nodes) && enriched.connections.nodes.length) {
          const byAddr = new Map((enriched.contracts || []).map((c) => [String(c.address || "").toLowerCase(), c]));
          for (const n of enriched.connections.nodes) {
            const key = String(n.address || "").toLowerCase();
            if (!/^0x[a-f0-9]{40}$/.test(key)) continue;
            if (byAddr.has(key)) continue;
            enriched.contracts.push({
              label: n.label || "Connected contract",
              network: n.network || "Ethereum",
              address: n.address,
              evidence: Array.isArray(n.evidence) && n.evidence.length ? n.evidence.join(" | ") : "Source: connections graph",
            });
            byAddr.set(key, n);
          }
        }
      }
    } catch (err) {
      console.warn("Connection discovery failed:", err?.message ? String(err.message) : String(err));
    }

    if (defillamaApiDetail) {
      const sid = subjectProtocolNodeId(defillama?.slug, enriched?.protocol?.name || defillama?.name);
      const aug = graphAugmentationFromDefillamaApi({
        defillamaApi: defillamaApiDetail,
        subjectProtocolId: sid,
        subjectDisplayName: enriched?.protocol?.name || defillama?.name || "Protocol",
      });
      enriched.connections = mergeConnectionGraphs(enriched.connections || { nodes: [], edges: [], evidence: [] }, aug);
    }

    // Hosted LLM (Cursor Cloud Agents): docs + optional analyze-page fallback. Graph DB is always persisted below.
    let fetchedDocs = null;
    try {
      const enableHostedEnrich = String(process.env.ENABLE_HOSTED_ENRICH || "0") === "1";
      const analyzeVisible = html ? htmlToVisibleText(html) : "";
      if (enableHostedEnrich) {
        resetHostedLlmRoute();
        enriched.llmEnrich = {
          enabled: true,
          provider: process.env.LLM_PROVIDER || null,
          docsFetched: false,
        };
        fetchedDocs = await fetchDocsSnippets({
          origin,
          fallbackVisibleText: analyzeVisible.slice(0, 25_000),
        }).catch(() => null);
        if (fetchedDocs?.ok && defillamaApiDetail?.auditLinks?.length) {
          fetchedDocs = await ingestAuditPdfsIntoDocsPack({
            docsPack: fetchedDocs,
            auditLinks: defillamaApiDetail.auditLinks,
            maxPdfs: Number(process.env.AUDIT_PDF_MAX || 3),
          }).catch(() => fetchedDocs);
        }
        enriched.llmEnrich.docsFetched = Boolean(fetchedDocs?.ok);
        if (Array.isArray(fetchedDocs?.evidence) && fetchedDocs.evidence.some((e) => String(e).includes("snapshot"))) {
          enriched.llmEnrich.usedAnalyzeHtmlFallback = true;
        }
        if (!fetchedDocs?.ok) {
          enriched.llmEnrich.hostedPipelineSkipped = "no_usable_docs_text";
        }

        if (fetchedDocs?.ok) {
          enriched.llmEnrich.hostedPipelineRan = true;
          const llmStepErrors = [];
          const catchLlm = (step) => (err) => {
            const msg = String(err?.message || err).slice(0, 800);
            llmStepErrors.push({ step, message: msg });
            console.warn(`Hosted LLM step "${step}" failed:`, msg);
            return null;
          };
          const haveAuditorsAlready =
            Array.isArray(enriched.protocol.auditsVerified?.firms) &&
            enriched.protocol.auditsVerified.firms.length > 0;
          const heuristicAuditors = !haveAuditorsAlready
            ? extractAuditorsHeuristic({ docsPack: fetchedDocs, defillamaApi: defillamaApiDetail })
            : null;
          let auditorsRes = null;
          if (haveAuditorsAlready) {
            auditorsRes = {
              auditors: enriched.protocol.auditsVerified.firms.map((n) => ({ name: String(n) })),
              evidence: Array.isArray(enriched.protocol.auditsVerified?.evidence)
                ? enriched.protocol.auditsVerified.evidence
                : [],
            };
          } else if (heuristicAuditors?.auditors?.length) {
            auditorsRes = {
              auditors: heuristicAuditors.auditors,
              evidence: heuristicAuditors.evidence || [],
              llmRoute: { usedComposerFallback: false, usedHeuristicFallback: true },
            };
          } else {
            const auditorsTimeoutMs = Number(
              process.env.HOSTED_AUDITORS_TIMEOUT_MS ||
                process.env.CURSOR_CLOUD_AGENTS_AUDITORS_TIMEOUT_MS ||
                120_000
            );
            try {
              auditorsRes = await withTimeout(
                extractAuditorsWithHostedLlm({
                  protocolName: enriched?.protocol?.name || defillama?.name || null,
                  origin,
                  docs: fetchedDocs,
                  defillamaApi: defillamaApiDetail,
                }),
                auditorsTimeoutMs,
                "auditors"
              );
            } catch (err) {
              auditorsRes = catchLlm("auditors")(err);
            }
          }
          enriched.llmEnrich.reusedAuditorsFromEarlyPass = haveAuditorsAlready;

          const graphRes = await inferContractGraphWithHostedLlm({
            protocolName: enriched?.protocol?.name || defillama?.name || null,
            origin,
            docs: fetchedDocs,
            knownTokens: enriched.tokenLiquidity || [],
            knownContracts: enriched.contracts || [],
            subjectDefillamaSlug: defillama?.slug || null,
            defillamaApi: defillamaApiDetail,
            research: {
              tvlUsd: enriched?.tvl?.valueUsd ?? null,
              volume24h: enriched?.txsPerDay?.value ?? null,
              totalRaisedUsd: enriched?.protocol?.totalRaisedUsd ?? null,
              auditsCountHint: enriched?.protocol?.auditsVerified?.count ?? enriched?.protocol?.audits ?? null,
            },
          }).catch(catchLlm("contractGraph"));

          const archRes = await inferArchitectureWithHostedLlm({
            protocolName: enriched?.protocol?.name || defillama?.name || null,
            origin,
            docs: fetchedDocs,
            knownTokens: enriched.tokenLiquidity || [],
            knownContracts: enriched.contracts || [],
          }).catch(catchLlm("architecture"));
          if (llmStepErrors.length) enriched.llmEnrich.llmStepErrors = llmStepErrors;

          if (auditorsRes?.auditors?.length) {
            enriched.protocol.auditsVerified = {
              count: auditorsRes.auditors.length,
              firms: auditorsRes.auditors.map((a) => a.name),
              evidence: auditorsRes.evidence || [],
            };
          }

          if (graphRes && (graphRes.nodes?.length || graphRes.edges?.length)) {
            const existing = enriched.connections || { nodes: [], edges: [], evidence: [] };
            enriched.connections = mergeConnectionGraphs(existing, {
              nodes: graphRes.nodes || [],
              edges: graphRes.edges || [],
              evidence: graphRes.evidence || [],
            });
          }

          // Free multi-hop enrichment: for each protocol node discovered, pull DefiLlama detail and add deterministic edges.
          // This reduces LLM guesswork and expands 1 hop further without web search APIs.
          try {
            enriched.connections = await expandConnectionsWithDefillama({
              connections: enriched.connections,
              maxProtocols: Number(process.env.DEFILLAMA_EXPAND_MAX || 6),
            });
          } catch {
            // ignore
          }

          if (archRes?.architecture) {
            enriched.protocol.architecture = archRes.architecture;
          }

          enriched.llmEnrich.auditors = auditorsRes?.auditors?.length ?? 0;
          enriched.llmEnrich.graphNodes = graphRes?.nodes?.length ?? 0;
          enriched.llmEnrich.graphEdges = graphRes?.edges?.length ?? 0;
          enriched.llmEnrich.architecture = Boolean(archRes?.architecture);
          if (
            auditorsRes?.llmRoute?.usedComposerFallback ||
            graphRes?.llmRoute?.usedComposerFallback ||
            archRes?.llmRoute?.usedComposerFallback
          ) {
            enriched.llmEnrich.usedComposerApiFallback = true;
            enriched.llmEnrich.effectiveProvider = "cursor_composer_api";
          }
        }
      } else {
        enriched.llmEnrich = { enabled: false, provider: null, docsFetched: false };
      }
    } catch (err) {
      enriched.llmEnrich = {
        ...(enriched.llmEnrich || {}),
        enabled: true,
        error: err?.message ? String(err.message) : String(err),
      };
      console.warn("Hosted enrichment failed:", err?.message ? String(err.message) : String(err));
    }

    try {
      const graphProtocol = {
        id: protocolIdFrom({ origin, defillamaSlug: defillama?.slug || null }),
        name: enriched?.protocol?.name || defillama?.name || null,
        url: enriched?.protocol?.url || origin,
        defillamaSlug: defillama?.slug || null,
      };
      const tokensForGraph = (Array.isArray(enriched.tokenLiquidity) ? enriched.tokenLiquidity : [])
        .slice(0, 200)
        .map((t) => ({
          address: t?.tokenAddress || t?.contractAddress || t?.address || null,
          symbol: t?.token || t?.symbol || t?.asset || null,
        }));
      const contractsForGraph = (Array.isArray(enriched.contracts) ? enriched.contracts : [])
        .slice(0, 800)
        .map((c) => ({
          address: c?.address || null,
          label: c?.label || null,
          type: c?.type || null,
        }));
      const firmList = Array.isArray(enriched.protocol?.auditsVerified?.firms) ? enriched.protocol.auditsVerified.firms : [];
      const auditorsForGraph = firmList.map((n) => ({ name: String(n) }));
      await upsertProtocolGraphLocal({
        protocol: graphProtocol,
        tokens: tokensForGraph,
        contracts: contractsForGraph,
        auditors: auditorsForGraph,
        docPages: (fetchedDocs?.ok ? fetchedDocs.pages || [] : []).map((p) => ({
          url: p.url,
          hash: fetchedDocs.hash,
          fetchedAt: p.fetchedAt,
        })),
        connections: enriched.connections || null,
        architecture: enriched.protocol.architecture || null,
        extra: {
          protocol: enriched.protocol || null,
          tvl: enriched.tvl || null,
          llmEnrich: enriched.llmEnrich || null,
          pendle: enriched.pendle || null,
          urlAnalysis: enriched.urlAnalysis || null,
          pageType: enriched.pageType || null,
          chainsSupported: enriched.chainsSupported || null,
          evidenceNotes: enriched.evidenceNotes || null,
        },
      });
      enriched.localGraph = { persisted: true, protocolId: graphProtocol.id };
      if (enriched.llmEnrich && typeof enriched.llmEnrich === "object") {
        enriched.llmEnrich.graphPersisted = true;
      }
      if (neo4jEnabled()) {
        try {
          await upsertProtocolGraphNeo4j({
            protocol: graphProtocol,
            tokens: tokensForGraph,
            contracts: contractsForGraph,
            auditors: auditorsForGraph,
            docPages: (fetchedDocs?.ok ? fetchedDocs.pages || [] : []).map((p) => ({
              url: p.url,
              hash: fetchedDocs.hash,
              fetchedAt: p.fetchedAt,
            })),
            connections: enriched.connections || null,
            architecture: enriched.protocol.architecture || null,
            extra: {
              protocol: enriched.protocol || null,
              tvl: enriched.tvl || null,
              llmEnrich: enriched.llmEnrich || null,
              pendle: enriched.pendle || null,
              urlAnalysis: enriched.urlAnalysis || null,
              pageType: enriched.pageType || null,
              chainsSupported: enriched.chainsSupported || null,
              evidenceNotes: enriched.evidenceNotes || null,
            },
          });
          enriched.neo4j = { persisted: true, protocolId: graphProtocol.id };
        } catch (neoErr) {
          enriched.neo4j = { persisted: false, error: String(neoErr?.message || neoErr) };
          console.warn("Neo4j persist failed:", neoErr?.message ? String(neoErr.message) : String(neoErr));
        }
      }
    } catch (persistErr) {
      enriched.localGraph = { persisted: false, error: String(persistErr?.message || persistErr) };
      if (enriched.llmEnrich && typeof enriched.llmEnrich === "object") {
        enriched.llmEnrich.graphPersisted = false;
      }
      console.warn("Local graph persist failed:", persistErr?.message ? String(persistErr.message) : String(persistErr));
    }

    // Surface where the HTML came from for debugging/evidence.
    enriched.page = {
      fetched: true,
      rendered: page.rendered,
      notes: page.rendered
        ? ["Content extracted after JavaScript rendering."]
        : [
            "Content extracted from raw HTML response (no JavaScript).",
            ...(page.renderError ? [`Playwright render error: ${page.renderError}`] : []),
          ],
    };
    if (page.rendered) {
      enriched.page.notes.push(
        `Extracted tokenLiquidity=${Array.isArray(enriched.tokenLiquidity) ? enriched.tokenLiquidity.length : 0}, contracts=${Array.isArray(enriched.contracts) ? enriched.contracts.length : 0}`
      );
    }

    if (cacheMeta) {
      enriched.cache = forceRefresh ? { ...cacheMeta, fullRefresh: true } : cacheMeta;
    }

    // Update in-memory snapshot cache (best-effort). Strip wallet-specific fields for safety.
    try {
      if (protocolKey) {
        const toStore = stripWalletSpecificFields(enriched);
        const updatedAtMs = Date.now();
        inMemoryProtocolSnapshotCache.set(protocolKey, { analysis: toStore, updatedAtMs });
        // Also key by origin host and origin URL for easy lookup without DefiLlama.
        try {
          const u = new URL(origin);
          const h = u.host.toLowerCase();
          inMemoryProtocolSnapshotCache.set(`origin:${h}`, { analysis: toStore, updatedAtMs });
          inMemoryProtocolSnapshotCache.set(`host:${h}`, { analysis: toStore, updatedAtMs });
          inMemoryProtocolSnapshotCache.set(`url:${origin}`, { analysis: toStore, updatedAtMs });
        } catch {
          // ignore
        }
        // Simple bounded size to avoid unbounded growth in dev.
        if (inMemoryProtocolSnapshotCache.size > 30) {
          const firstKey = inMemoryProtocolSnapshotCache.keys().next().value;
          if (firstKey) inMemoryProtocolSnapshotCache.delete(firstKey);
        }
      }
    } catch {
      // ignore
    }

    // Persist protocol snapshot (wallet stripped)
    if (ENABLE_PROTOCOL_DB_CACHE && hasPostgres) {
      const toStore = stripWalletSpecificFields(enriched);
      const hash = computeProtocolCacheHash(toStore);
      const cachedHash = cached?.analysis_hash || null;
      if (!cachedHash || cachedHash !== hash) {
        await protocolCacheUpsert({
          protocolKey,
          slug,
          originHost,
          protocolName: toStore?.protocol?.name || null,
          protocolUrl: toStore?.protocol?.url || origin,
          analysisJson: toStore,
          analysisHash: hash,
        }).catch(() => {});
      }
    }

    try {
      enriched.evidenceNotes = buildEvidenceNotes(enriched, {
        defillama: defillamaMatchError ? { ...(defillama || {}), _matchError: defillamaMatchError } : defillama,
        defillamaApi: defillamaApiDetail,
        origin,
      });
    } catch {
      // ignore
    }

    res.json(enriched);
  } catch (err) {
    console.error("Error in /api/llm-analyze:", err);
    res.status(500).json({ error: "Unexpected error in /api/llm-analyze." });
  }
});

async function crawlInvestorPages(origin, { knownTokens = [] } = {}) {
  const u = new URL(origin);
  const base = `${u.protocol}//${u.host}`;

  // Keep this crawl cheap: too many rendered pages makes /api/llm-analyze feel "stuck".
  const candidates = ["/", "/investors", "/backers", "/funding", "/partners", "/about", "/press"];

  const visited = new Set();
  // name -> { name, evidence[], count }
  const results = new Map();

  const start = Date.now();
  const TIME_BUDGET_MS = 25_000;
  let renderAttempts = 0;
  const MAX_RENDER_ATTEMPTS = 2;

  for (const path of candidates) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    const url = base + path;
    if (visited.has(url)) continue;
    visited.add(url);

    // First try: raw HTML only (fast)
    const rawPage = await fetchHtmlRaw(url, 8000).catch(() => null);
    const htmlToParse = rawPage?.html || "";
    let names = extractInvestorsFromHtml(htmlToParse, { knownTokens });
    if (!Array.isArray(names) || !names.length) continue;

    for (const n of names) {
      const key = String(n).toLowerCase();
      const ev = results.get(key) || { name: n, evidence: [], count: 0 };
      ev.count += 1;
      if (ev.evidence.length < 3) ev.evidence.push(url);
      results.set(key, ev);
    }

    // Stop early if we have a decent list.
    if (results.size >= 12) break;

    // If raw HTML didn't contain anything, try rendering just a couple pages.
    if (renderAttempts < MAX_RENDER_ATTEMPTS && results.size < 6) {
      const renderedPage = await fetchHtmlWithOptionalRender(url).catch(() => null);
      if (renderedPage?.ok && renderedPage?.html) {
        const renderedNames = extractInvestorsFromHtml(renderedPage.html, { knownTokens });
        for (const n of renderedNames) {
          const key = String(n).toLowerCase();
          const ev = results.get(key) || { name: n, evidence: [], count: 0 };
          ev.count += 1;
          if (ev.evidence.length < 3) ev.evidence.push(url);
          results.set(key, ev);
        }
        renderAttempts++;
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 25);
}

async function fetchHtmlRaw(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, html: "" };
    const html = await resp.text();
    return { ok: true, status: resp.status, html };
  } finally {
    clearTimeout(t);
  }
}

function extractProtocolInfoFromHtml(html, { protocolName, knownTokens }) {
  const raw = String(html || "");
  const visible = htmlToVisibleText(raw);
  const lower = visible.toLowerCase();

  const titleMatch = raw.match(/<title[^>]*>([^<]{1,180})<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  const metaDescMatch = raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].replace(/\s+/g, " ").trim() : "";

  // Build a short description from meta description or first meaningful lines.
  let description = metaDesc;
  if (!description) {
    const lines = visible
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const pick = [];
    for (const l of lines) {
      if (l.length < 40) continue;
      if (l.length > 220) continue;
      if (/cookie|privacy|terms|connect wallet|all rights reserved/i.test(l)) continue;
      pick.push(l);
      if (pick.length >= 2) break;
    }
    description = pick.join(" ");
  }
  if (!description && title) description = title;
  if (description) description = description.slice(0, 320);

  // Feature detection (generic keywords)
  const features = [];
  const add = (key, label) => {
    if (key && !features.includes(label)) features.push(label);
  };

  if (/\bswap(s|ping)?\b|\btrade\b|\bdex\b/.test(lower)) add(true, "Swaps / trading");
  if (/\bstake\b|\bstaking\b|\breward(s)?\b|\bearn\b/.test(lower)) add(true, "Staking / rewards");
  if (/\blend\b|\blending\b|\bborrow\b|\bloan(s)?\b/.test(lower)) add(true, "Lending / borrowing");
  if (/\bbridge\b|\bcross[- ]chain\b/.test(lower)) add(true, "Bridging / cross-chain");
  if (/\byield\b|\bapy\b|\bapr\b|\bpool(s)?\b|\bliquidity\b/.test(lower)) add(true, "Yield / liquidity pools");
  if (/\bgovernance\b|\bvote\b|\bproposal(s)?\b/.test(lower)) add(true, "Governance");
  if (/\baudit\b|\baudited\b|\bsecurity\b/.test(lower)) add(true, "Security / audits (mentions)");

  // Native token best-effort: look for "$TOKEN", "TOKEN token", or a known token that matches protocol name.
  let nativeToken = null;
  const dollar = visible.match(/\$([A-Z][A-Z0-9]{2,10})\b/);
  if (dollar) nativeToken = dollar[1];

  if (!nativeToken) {
    const tokenWord = visible.match(/\b([A-Z][A-Z0-9]{2,10})\b\s+(token|governance token|staking token)\b/i);
    if (tokenWord) nativeToken = tokenWord[1];
  }

  if (!nativeToken && protocolName && Array.isArray(knownTokens)) {
    const pn = String(protocolName).toLowerCase();
    const candidate = knownTokens.find((t) => String(t).toLowerCase() === pn);
    if (candidate) nativeToken = candidate;
  }

  return {
    title,
    description: description || null,
    features,
    nativeToken: nativeToken || null,
  };
}

async function estimateTxsPerDayFromEtherscan({ contracts, apiKey }) {
  if (!apiKey) {
    return { value: null, evidence: ["ETHERSCAN_API_KEY not configured."] };
  }

  const ethCandidates = (contracts || [])
    .filter((c) => String(c?.network || "").toLowerCase() === "ethereum" || String(c?.network || "").toLowerCase() === "unknown")
    .map((c) => String(c.address || ""))
    .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a));

  const uniq = Array.from(new Set(ethCandidates.map((a) => a.toLowerCase()))).slice(0, 10);
  if (uniq.length === 0) {
    return { value: null, evidence: ["No Ethereum contract address available to query Etherscan."] };
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const since = now - dayMs;

  // Query up to 10 candidates and pick the most active in the last 24h.
  let best = { address: null, count: 0 };
  const per = [];

  for (const addrLower of uniq) {
    const addr = addrLower;
    const url =
      "https://api.etherscan.io/api?module=account&action=txlist" +
      `&address=${encodeURIComponent(addr)}` +
      "&page=1&offset=200&sort=desc" +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      per.push({ address: addr, tx24h: 0, note: `HTTP ${resp.status}` });
      continue;
    }
    const json = await resp.json().catch(() => null);

    // Etherscan returns: { status: "1"|"0", message: "...", result: [...]|"...error..." }
    const status = String(json?.status || "");
    const message = String(json?.message || "");
    const result = json?.result;
    if (status === "0") {
      const errText = typeof result === "string" ? result : message || "NOTOK";
      const note = `Etherscan NOTOK: ${errText}`.slice(0, 140);
      per.push({ address: addr, tx24h: 0, note });
      // If the key is invalid or rate-limited, stop early and return the reason.
      if (/invalid api key|missing api key|rate limit|max rate|not authorized/i.test(errText)) {
        return { value: null, evidence: [note] };
      }
      continue;
    }

    const txs = Array.isArray(result) ? result : [];

    let count = 0;
    for (const t of txs) {
      const ts = Number(t.timeStamp) * 1000;
      if (!isFinite(ts)) continue;
      if (ts < since) break;
      count++;
    }

    per.push({ address: addr, tx24h: count, note: "OK" });
    if (count > best.count) best = { address: addr, count };
  }

  if (!best.address) {
    return {
      value: null,
      evidence: [
        "Etherscan returned no tx data for detected addresses.",
        `Candidates checked: ${per
          .map((p) => `${p.address.slice(0, 6)}…=${p.tx24h}${p.note ? ` (${p.note})` : ""}`)
          .join(", ")}`,
      ],
    };
  }

  return {
    value: best.count,
    evidence: [
      `Etherscan txlist: ${best.count} tx in last 24h for ${best.address}`,
      `https://etherscan.io/address/${best.address}`,
      `Candidates checked: ${per.map((p) => `${p.address.slice(0, 6)}…=${p.tx24h}${p.note ? ` (${p.note})` : ""}`).join(", ")}`,
    ],
  };
}

function inferPageType({ url }) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "").toLowerCase();
    if (p.includes("/trade/pools/") || p.includes("/pools/0x")) return "pool_page";
    if (p.includes("/trade/markets") || p.includes("/markets")) return "markets_page";
    if (p.includes("/docs") || p.includes("/documentation")) return "docs_page";
    return "protocol_site";
  } catch {
    return "protocol_site";
  }
}

function inferNetworkFromUrl(url) {
  try {
    const u = new URL(url);
    const chain = (u.searchParams.get("chain") || "").toLowerCase();
    if (chain) return chain[0].toUpperCase() + chain.slice(1);
    return null;
  } catch {
    return null;
  }
}

function analyzeInputUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname || "";
    const chain = u.searchParams.get("chain") || null;
    const m = pathname.match(/(0x[a-fA-F0-9]{40})/);
    const poolAddress = m ? m[1] : null;
    const pageType = inferPageType({ url });
    return {
      inputUrl: url,
      pageType,
      chain,
      poolAddress,
    };
  } catch {
    return { inputUrl: url, pageType: "protocol_site", chain: null, poolAddress: null };
  }
}

function defaultSystemChromeCandidates() {
  const out = [];
  if (process.platform === "darwin") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else if (process.platform === "linux") {
    out.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    );
  } else if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    out.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  return out;
}

function firstExistingChromeExecutable() {
  for (const p of defaultSystemChromeCandidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return "";
}

async function loadCachedAnalysisForReport({ analysisIn, protocolKey, url }) {
  const hasPostgres = Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
  let analysis = analysisIn;

  if ((!analysis || typeof analysis !== "object") && hasPostgres && (protocolKey || url)) {
    await protocolCacheInit().catch(() => {});
    let key = protocolKey || null;
    if (!key && url) {
      const defillama = await getDefiLlamaProtocolByUrlFromModule(normalizeUrl(url)).catch(() => null);
      key = protocolKeyFrom({ defillama, origin: normalizeUrl(url) })?.protocolKey || null;
      if (!key) {
        try {
          const u = new URL(normalizeUrl(url));
          key = `origin:${u.host.toLowerCase()}`;
        } catch {
          key = null;
        }
      }
    }
    if (key) {
      const cached = await protocolCacheGetLatest({ protocolKey: key }).catch(() => null);
      if (cached?.analysis_json) analysis = cached.analysis_json;
    }
  }

  if ((!analysis || typeof analysis !== "object") && (protocolKey || url)) {
    let key = protocolKey || null;
    if (!key && url) {
      try {
        const defillama = await getDefiLlamaProtocolByUrlFromModule(normalizeUrl(url)).catch(() => null);
        key = protocolKeyFrom({ defillama, origin: normalizeUrl(url) })?.protocolKey || null;
        if (!key) {
          try {
            const u = new URL(normalizeUrl(url));
            key = `origin:${u.host.toLowerCase()}`;
          } catch {
            key = null;
          }
        }
      } catch {
        key = null;
      }
    }
    if (key) {
      const cachedMem = inMemoryProtocolSnapshotCache.get(key);
      if (cachedMem?.analysis) analysis = cachedMem.analysis;
    }
    if ((!analysis || typeof analysis !== "object") && url) {
      try {
        const origin = normalizeUrl(url);
        const u = new URL(origin);
        const h = u.host.toLowerCase();
        const candidates = [`origin:${h}`, `host:${h}`, `url:${origin}`];
        for (const c of candidates) {
          const cachedMem = inMemoryProtocolSnapshotCache.get(c);
          if (cachedMem?.analysis) {
            analysis = cachedMem.analysis;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return analysis;
}

async function renderPdfBufferWithPlaywright(html) {
  const isVercel = String(process.env.VERCEL || "") !== "";
  const forceNoSandbox = String(process.env.PLAYWRIGHT_PDF_NO_SANDBOX || "").toLowerCase() === "1";
  const launchArgs =
    isVercel || forceNoSandbox
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : ["--disable-dev-shm-usage"];

  const candidates = [];
  const envExe = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (envExe) candidates.push(envExe);
  const sys = firstExistingChromeExecutable();
  if (sys) candidates.push(sys);
  candidates.push(null);

  let lastErr = null;
  for (const executablePath of candidates) {
    let browser;
    try {
      const launchOpts = { headless: true, args: launchArgs };
      if (executablePath) launchOpts.executablePath = executablePath;
      browser = await chromium.launch(launchOpts);
      const context = await browser.newContext({ viewport: { width: 1240, height: 1754 } });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
      });
      await context.close();
      await browser.close().catch(() => {});
      return pdf;
    } catch (e) {
      lastErr = e;
      if (browser) await browser.close().catch(() => {});
    }
  }
  throw lastErr || new Error("Playwright PDF generation failed.");
}

app.get("/api/risk-schema", (req, res) => {
  try {
    const schemaPath = path.join(__dirname, "risk_schema.json");
    const schemaRaw = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(schemaRaw);
    res.json(schema);
  } catch (err) {
    console.error("Failed to load risk_schema.json:", err);
    res.status(500).json({ error: "Failed to load risk schema." });
  }
});

app.post("/api/report/pdf", async (req, res) => {
  const { analysis: analysisIn, riskAssessment, generatedAt, protocolKey, url } = req.body || {};
  const analysis = await loadCachedAnalysisForReport({ analysisIn, protocolKey, url });

  if (!analysis || typeof analysis !== "object") {
    return res.status(400).json({
      error: "Missing analysis. Run Analyze first (to populate cache), then download PDF again.",
    });
  }

  const protocolName = analysis?.protocol?.name || "Protocol";
  let html;
  try {
    html = buildPdfReportHtml({ analysis, riskAssessment, generatedAt });
  } catch (err) {
    console.error("PDF HTML build error:", err);
    return res.status(500).json({
      error: "Failed to build PDF HTML.",
      detail: String(err?.message || err),
    });
  }

  try {
    const pdf = await renderPdfBufferWithPlaywright(html);
    const filename = `${safePdfFilename(protocolName)}-report.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(pdf);
  } catch (err) {
    console.error("PDF report generation error:", err);
    const detail = String(err?.message || err);
    let hint = null;
    if (/executable doesn't exist|browserType\.launch/i.test(detail)) {
      hint =
        "Tried Playwright + system Chrome/Edge if installed. Run: npm run browsers — or use Download PDF (HTML fallback) or POST /api/report/html.";
    }
    return res.status(500).json({
      error: "Failed to generate PDF report.",
      detail,
      hint,
    });
  }
});

app.post("/api/report/html", async (req, res) => {
  const { analysis: analysisIn, riskAssessment, generatedAt, protocolKey, url } = req.body || {};
  const analysis = await loadCachedAnalysisForReport({ analysisIn, protocolKey, url });
  if (!analysis || typeof analysis !== "object") {
    return res.status(400).json({
      error: "Missing analysis. Run Analyze first (to populate cache), then try again.",
    });
  }
  const protocolName = analysis?.protocol?.name || "Protocol";
  let html;
  try {
    html = buildPdfReportHtml({ analysis, riskAssessment, generatedAt });
  } catch (err) {
    console.error("Report HTML build error:", err);
    return res.status(500).json({ error: "Failed to build report HTML.", detail: String(err?.message || err) });
  }
  const filename = `${safePdfFilename(protocolName)}-report.html`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(html);
});

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildAgentGraphArtifacts({ analysis, relatedGraph = null, maxEdges = 900 } = {}) {
  const rootName = analysis?.protocol?.name || "Unknown";
  const rootId = analysis?.neo4j?.protocolId || analysis?.localGraph?.protocolId || analysis?.cache?.protocolKey || rootName;

  const conn = analysis?.connections && typeof analysis.connections === "object" ? analysis.connections : null;
  const nodes = Array.isArray(conn?.nodes) ? conn.nodes : [];
  const edges = Array.isArray(conn?.edges) ? conn.edges : [];

  const nodeById = new Map();
  for (const n of nodes) {
    const id = String(n?.id || n?.address || "").toLowerCase();
    if (!id) continue;
    nodeById.set(id, n);
  }

  const subjectProtocolId =
    nodes.find((n) => n && (n.kind === "protocol" || n.type === "protocol") && String(n.id || "").startsWith("protocol:"))
      ?.id || null;

  const auditors = Array.isArray(analysis?.protocol?.auditsVerified?.firms) ? analysis.protocol.auditsVerified.firms : [];

  const rows = [];
  const addRow = (r) => {
    if (!r) return;
    rows.push({
      root_protocol: rootName,
      source_name: r.source_name || "Unknown",
      source_type: r.source_type || "Unknown",
      relationship: r.relationship || "CONNECTED_TO",
      target_name: r.target_name || "Unknown",
      target_type: r.target_type || "Unknown",
      chain: r.chain || "Unknown",
      notes: r.notes || "",
    });
  };

  // Auditor edges
  for (const a of auditors.slice(0, 40)) {
    addRow({
      source_name: rootName,
      source_type: "Protocol",
      relationship: "AUDITED_BY",
      target_name: String(a),
      target_type: "Auditor",
      chain: "Off-chain",
      notes: "Verified from docs pack (best-effort).",
    });
  }

  // Connection edges (from analysis.connections)
  const inferType = (n) => {
    const kind = String(n?.kind || n?.type || "").toLowerCase();
    if (kind === "protocol") return "Protocol";
    if (kind === "token") return "Token";
    if (kind === "contract") return "Contract";
    if (String(n?.id || "").startsWith("protocol:")) return "Protocol";
    if (/^0x[a-f0-9]{40}$/i.test(String(n?.id || n?.address || ""))) return "Contract";
    return kind ? kind : "Unknown";
  };
  const labelOf = (n, fallback) => String(n?.label || n?.name || n?.symbol || fallback || "Unknown").trim();
  const chainOf = (n) => String(n?.network || n?.chain || "Unknown").trim();

  for (const e of edges.slice(0, maxEdges)) {
    const fromId = String(e?.from || "").toLowerCase();
    const toId = String(e?.to || "").toLowerCase();
    if (!fromId || !toId) continue;
    const fromN = nodeById.get(fromId) || { id: fromId };
    const toN = nodeById.get(toId) || { id: toId };
    addRow({
      source_name: labelOf(fromN, fromId),
      source_type: inferType(fromN),
      relationship: String(e?.relation || "CONNECTED_TO"),
      target_name: labelOf(toN, toId),
      target_type: inferType(toN),
      chain: chainOf(fromN) || chainOf(toN) || "Unknown",
      notes: Array.isArray(e?.evidence) ? e.evidence.join(" | ").slice(0, 400) : "",
    });
  }

  // Related protocols up to 4 hops (Neo4j)
  const relNodes = Array.isArray(relatedGraph?.nodes) ? relatedGraph.nodes : [];
  for (const rp of relNodes.slice(0, 260)) {
    if (!rp?.id) continue;
    if (rp.id === rootId || rp.id === subjectProtocolId) continue;
    addRow({
      source_name: rootName,
      source_type: "Protocol",
      relationship: "CONNECTED_TO",
      target_name: rp.name || rp.id,
      target_type: "Protocol",
      chain: "Multi-chain",
      notes: "From Neo4j hop expansion (up to 4 hops).",
    });
  }

  const csvHeader = ["root_protocol", "source_name", "source_type", "relationship", "target_name", "target_type", "chain", "notes"];
  const csv = [csvHeader.join(",")]
    .concat(
      rows.map((r) =>
        csvHeader.map((k) => csvEscape(r[k])).join(",")
      )
    )
    .join("\n");

  const json = {
    rootProtocol: rootName,
    rootProtocolId: rootId,
    subjectProtocolNodeId: subjectProtocolId,
    rows,
  };

  return { csv, json };
}

function buildMonotoneRelationshipSvg({ analysis, relatedGraph } = {}) {
  const rootLabel = String(analysis?.protocol?.name || "Protocol").slice(0, 32);
  const nodes = Array.isArray(relatedGraph?.nodes) ? relatedGraph.nodes : [];
  const max = Math.min(60, nodes.length);
  const width = 980;
  const height = 80 + Math.max(1, Math.ceil(max / 3)) * 70;

  // Simple 3-column tree-ish layout (monotone, professional).
  const cols = 3;
  const colW = Math.floor(width / cols);
  const padX = 22;
  const padY = 60;

  const items = nodes.slice(0, max).map((n) => ({
    id: n.id,
    label: String(n.name || n.id || "Protocol").slice(0, 28),
  }));

  const root = { x: Math.floor(width / 2), y: 28, label: rootLabel };
  const points = items.map((it, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    return {
      ...it,
      x: padX + c * colW + Math.floor(colW / 2),
      y: padY + r * 64,
    };
  });

  const lines = points
    .map((p) => `<line x1="${root.x}" y1="${root.y + 14}" x2="${p.x}" y2="${p.y - 10}" stroke="#334155" stroke-width="1" />`)
    .join("");
  const bubbles = points
    .map(
      (p) => `
      <g>
        <rect x="${p.x - 150}" y="${p.y - 20}" width="300" height="36" rx="12" fill="#0b1220" stroke="#334155" />
        <text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="12" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(p.label)}</text>
      </g>`
    )
    .join("");

  return `
  <svg width="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Protocol relationship tree">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#020617" rx="18" />
    <g>
      <rect x="${root.x - 160}" y="${root.y - 18}" width="320" height="40" rx="14" fill="#0b1220" stroke="#38bdf8" stroke-width="1.5" />
      <text x="${root.x}" y="${root.y + 7}" text-anchor="middle" font-size="13" fill="#e5e7eb" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${escapeHtml(root.label)}</text>
    </g>
    ${lines}
    ${bubbles}
    <text x="${width - 16}" y="${height - 14}" text-anchor="end" font-size="10" fill="#64748b" font-family="system-ui, -apple-system, Segoe UI, sans-serif">Monotone relationship view (top ${max})</text>
  </svg>
  `;
}

app.post("/api/agent/report", async (req, res) => {
  const { url, protocolKey, riskAssessment } = req.body || {};
  let analysis = await loadCachedAnalysisForReport({ analysisIn: null, protocolKey, url });
  if (!analysis || typeof analysis !== "object") {
    // Fallback: load from local graph cache (sqlite) or neo4j stored protocol payload.
    try {
      await localGraphInit().catch(() => {});
      const origin = url ? normalizeUrl(url) : null;
      if (origin) {
        let g = null;
        if (neo4jEnabled()) {
          // Prefer exact URL match, because most entries are keyed by defillama:slug, not url:origin.
          const pid = await findProtocolIdByUrlNeo4j({ url: origin }).catch(() => null);
          g = pid ? await getProtocolGraphNeo4jById({ id: pid }).catch(() => null) : null;
          if (!g) {
            g = await getProtocolGraphNeo4j({ origin, defillamaSlug: null }).catch(() => null);
          }
        } else {
          g = await getProtocolGraphLocal({ origin, defillamaSlug: null }).catch(() => null);
        }
        const p = g?.protocol || null;
        if (g?.ok && g?.hit && p) {
          let extra = null;
          try {
            extra = p.extraJson ? JSON.parse(p.extraJson) : null;
          } catch {}
          let connections = null;
          try {
            connections = p.connectionsJson ? JSON.parse(p.connectionsJson) : null;
          } catch {}
          let architecture = null;
          try {
            architecture = p.architectureJson ? JSON.parse(p.architectureJson) : null;
          } catch {}
          analysis = {
            origin,
            protocol: extra?.protocol || { name: p.name || null, url: p.url || origin },
            tvl: extra?.tvl || null,
            chainsSupported: extra?.chainsSupported || null,
            pageType: extra?.pageType || null,
            urlAnalysis: extra?.urlAnalysis || null,
            llmEnrich: extra?.llmEnrich || null,
            evidenceNotes: extra?.evidenceNotes || null,
            tokenLiquidity: (p.tokens || []).map((t) => ({
              token: t.symbol || "Token",
              tokenAddress: t.address,
              liquidityUsd: null,
              evidence: ["Source: graph cache"],
            })),
            contracts: (p.contracts || []).map((c) => ({
              label: c.label || "Contract",
              network: c.chain || "Unknown",
              address: c.address,
              evidence: "Source: graph cache",
            })),
            connections,
            architecture,
            localGraph: { persisted: true, protocolId: g.id },
            neo4j: g.id?.startsWith("defillama:") ? { persisted: true, protocolId: g.id } : null,
            cache: { protocolKey: g.id, hit: true, source: neo4jEnabled() ? "neo4j" : "local_graph" },
          };
        }
      }
    } catch {
      // ignore
    }
  }

  if (!analysis || typeof analysis !== "object") {
    return res.status(400).json({ ok: false, error: "Missing analysis. Run Agent/Analyze first." });
  }

  // Related protocols from DB (best-effort).
  let related = null;
  try {
    if (neo4jEnabled()) {
      const pid =
        analysis?.neo4j?.protocolId ||
        analysis?.localGraph?.protocolId ||
        analysis?.cache?.protocolKey ||
        null;
      if (pid) {
        const r = await getRelatedProtocolsNeo4j({ id: pid, hops: 4 }).catch(() => null);
        related = r?.graph || null;
      }
    }
  } catch {
    // ignore
  }

  const artifacts = buildAgentGraphArtifacts({ analysis, relatedGraph: related });
  const svg = buildMonotoneRelationshipSvg({ analysis, relatedGraph: related || { nodes: [] } });

  // Risk score 1–10 (1 low risk, 10 high risk) derived from rubric overallTotal (0–1, higher safer).
  let risk10 = null;
  try {
    const overall = typeof riskAssessment?.overallTotal === "number" ? riskAssessment.overallTotal : null;
    if (typeof overall === "number") {
      risk10 = Math.max(1, Math.min(10, Math.round((1 - overall) * 9 + 1)));
    }
  } catch {}

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(analysis?.protocol?.name || "Protocol")} • Agent Report</title>
      <style>
        body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#020617;color:#e5e7eb}
        .wrap{max-width:980px;margin:0 auto;padding:22px}
        .card{background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.25);border-radius:16px;padding:16px;margin-top:14px}
        h1{margin:0 0 6px;font-size:22px}
        h2{margin:0 0 8px;font-size:14px;color:#e2e8f0}
        .muted{color:#94a3b8;font-size:12px;line-height:1.5}
        pre{white-space:pre-wrap;background:#0b1220;border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:12px;overflow:auto;color:#cbd5e1}
        .kpi{display:flex;gap:12px;flex-wrap:wrap}
        .pill{border:1px solid rgba(148,163,184,.35);background:rgba(2,6,23,.25);border-radius:999px;padding:6px 10px;font-size:12px}
        a{color:#93c5fd}
      </style>
    </head>
    <body>
      <div class="wrap">
        <h1>${escapeHtml(analysis?.protocol?.name || "Protocol")} — Agent report</h1>
        <div class="muted">URL: ${escapeHtml(analysis?.protocol?.url || analysis?.origin || "Unknown")}</div>
        <div class="kpi" style="margin-top:10px;">
          <div class="pill">Risk score (1–10): <strong>${risk10 == null ? "Unknown" : String(risk10)}</strong></div>
          <div class="pill">Auditors: <strong>${escapeHtml((analysis?.protocol?.auditsVerified?.firms || []).join(", ") || "Unknown")}</strong></div>
          <div class="pill">TVL: <strong>${analysis?.tvl?.valueUsd ? `$${Number(analysis.tvl.valueUsd).toFixed(0)}` : "Unknown"}</strong></div>
        </div>

        <div class="card">
          <h2>Description</h2>
          <div class="muted">${escapeHtml(analysis?.protocol?.description || "Unknown")}</div>
        </div>

        <div class="card">
          <h2>Relationship diagram</h2>
          ${svg}
        </div>

        <div class="card">
          <h2>Relationship CSV</h2>
          <pre>${escapeHtml(artifacts.csv)}</pre>
        </div>

        <div class="card">
          <h2>Relationship JSON</h2>
          <pre>${escapeHtml(JSON.stringify(artifacts.json, null, 2))}</pre>
        </div>

        <div class="card">
          <h2>Full analysis JSON (raw)</h2>
          <pre>${escapeHtml(JSON.stringify(analysis, null, 2))}</pre>
        </div>
      </div>
    </body>
  </html>`;

  const filename = `${safePdfFilename(analysis?.protocol?.name || "protocol")}-agent-report.html`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(html);
});

app.post("/api/risk-assessment", async (req, res) => {
  const { protocolName, url, analysis: analysisIn, protocolKey } = req.body || {};

  if (!url && !protocolName) {
    return res
      .status(400)
      .json({ error: "Provide at least 'url' or 'protocolName' in the request body." });
  }

  try {
    const hasPostgres = Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
    let analysis = analysisIn;

    // If client doesn't send analysis (preferred), load latest cached snapshot.
    if ((!analysis || typeof analysis !== "object") && (protocolKey || url)) {
      let key = protocolKey || null;
      if (!key && url) {
        const origin = normalizeUrl(url);
        const defillama = await getDefiLlamaProtocolByUrlFromModule(origin).catch(() => null);
        key = protocolKeyFrom({ defillama, origin })?.protocolKey || null;
        if (!key) {
          try {
            const u = new URL(origin);
            key = `origin:${u.host.toLowerCase()}`;
          } catch {
            key = null;
          }
        }
      }

      // DB cache (Vercel)
      if (!analysis && hasPostgres && key) {
        await protocolCacheInit().catch(() => {});
        const cached = await protocolCacheGetLatest({ protocolKey: key }).catch(() => null);
        if (cached?.analysis_json) analysis = cached.analysis_json;
      }

      // Local/dev in-memory cache
      if (!analysis && key) {
        const cachedMem = inMemoryProtocolSnapshotCache.get(key);
        if (cachedMem?.analysis) analysis = cachedMem.analysis;
      }
      if (!analysis && url) {
        try {
          const origin = normalizeUrl(url);
          const u = new URL(origin);
          const h = u.host.toLowerCase();
          const candidates = [`origin:${h}`, `host:${h}`, `url:${origin}`];
          for (const c of candidates) {
            const cachedMem = inMemoryProtocolSnapshotCache.get(c);
            if (cachedMem?.analysis) {
              analysis = cachedMem.analysis;
              break;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // Default: avoid crashing local models with oversized prompts.
    // Enable full LLM rubric scoring explicitly by setting ENABLE_LLM_RISK=1.
    const enableLlmRisk = String(process.env.ENABLE_LLM_RISK || "") === "1";

    const schemaPath = path.join(__dirname, "risk_schema.json");
    const schemaRaw = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(schemaRaw);

    if (!enableLlmRisk) {
      const fallback = buildHeuristicRiskAssessmentFromModule({
        protocolName: protocolName || analysis?.protocol?.name || null,
        url: url || analysis?.protocol?.url || null,
        analysis,
      });
      return res.json(fallback);
    }

    // LLM mode (safe): score section-by-section so prompts fit in small local contexts.
    const assessment = await runRiskAssessmentSectionWiseWithGpt4All({
      schema,
      protocolName: protocolName || analysis?.protocol?.name || null,
      url: url || analysis?.protocol?.url || null,
      analysis,
    });
    if (assessment) return res.json(assessment);

    // If the model still fails, fall back to deterministic assessment.
    const fallback = buildHeuristicRiskAssessmentFromModule({
      protocolName: protocolName || analysis?.protocol?.name || null,
      url: url || analysis?.protocol?.url || null,
      analysis,
    });
    return res.json(fallback);
  } catch (err) {
    console.error("Error in /api/risk-assessment:", err);
    res.status(500).json({ error: "Failed to prepare risk assessment prompt." });
  }
});

function safePdfFilename(name) {
  return String(name || "protocol")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtUsd(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function isLikelyAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || "").trim());
}

function buildArchitectureDiagramSvg({ protocolLabel, protocolAddress, tokenNodes, vaultNodes }) {
  // Spider-web layout with router/protocol in the middle.
  const tokens = Array.isArray(tokenNodes) ? tokenNodes : [];
  const vaults = Array.isArray(vaultNodes) ? vaultNodes : [];

  const width = 980;
  const height = 760;
  const padding = 18;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const nodeW = 210;
  const nodeH = 44;
  const outerR = 300;

  const rect = (x, y, w, h, fill, stroke) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" />`;
  const label = (x, y, text, size = 11, color = "#0f172a", anchor = "start") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
  const mono = (x, y, text, size = 9, color = "#475569", anchor = "start") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
  const line = (x1, y1, x2, y2, stroke = "#94a3b8") =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1.2" />`;

  const bg = `<rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="#f8fafc" stroke="#dbe3ee" />`;
  const ring = `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="#e2e8f0" stroke-dasharray="4 4" />`;

  const centerW = 280;
  const centerH = 64;
  const centerX = cx - Math.round(centerW / 2);
  const centerY = cy - Math.round(centerH / 2);
  const routerBlock =
    rect(centerX, centerY, centerW, centerH, "#eff6ff", "#93c5fd") +
    label(cx, centerY + 24, protocolLabel || "Protocol / Router", 12, "#1d4ed8", "middle") +
    (protocolAddress ? mono(cx, centerY + 44, protocolAddress, 9, "#1d4ed8", "middle") : "");

  const nodes = [
    ...tokens.map((n) => ({ ...n, kind: "token" })),
    ...vaults.map((n) => ({ ...n, kind: "vault" })),
  ];
  const count = nodes.length;
  const placed = count
    ? nodes.map((n, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        const x = cx + Math.cos(angle) * outerR;
        const y = cy + Math.sin(angle) * outerR;
        return { ...n, x, y };
      })
    : [];

  const spokes = placed
    .map((n) => line(cx, cy, n.x, n.y, n.kind === "token" ? "#60a5fa" : "#a78bfa"))
    .join("");

  const nodeBlocks = placed
    .map((n) => {
      const x = Math.max(padding, Math.min(width - padding - nodeW, Math.round(n.x - nodeW / 2)));
      const y = Math.max(padding + 24, Math.min(height - padding - nodeH - 20, Math.round(n.y - nodeH / 2)));
      const fill = n.kind === "token" ? "#f0f9ff" : "#faf5ff";
      const stroke = n.kind === "token" ? "#93c5fd" : "#c4b5fd";
      const name = n?.name || (n.kind === "token" ? "Token" : "Vault/Pool");
      const addr = n?.address || "";
      return (
        rect(x, y, nodeW, nodeH, fill, stroke) +
        label(x + 8, y + 17, name.slice(0, 24), 10, "#0b1324") +
        (addr ? mono(x + 8, y + 34, addr.slice(0, 18) + "..." + addr.slice(-6), 8, "#475569") : "")
      );
    })
    .join("");

  const legend =
    rect(padding, padding, 250, 54, "#ffffff", "#dbe3ee") +
    label(padding + 10, padding + 16, "Router-Centered Spider Web", 11, "#334155") +
    line(padding + 10, padding + 28, padding + 36, padding + 28, "#60a5fa") +
    label(padding + 40, padding + 31, "Token contract", 10, "#475569") +
    line(padding + 132, padding + 28, padding + 158, padding + 28, "#a78bfa") +
    label(padding + 162, padding + 31, "Vault / pool", 10, "#475569");

  const note = label(
    width - padding,
    height - 10,
    "Best‑effort diagram from detected addresses (may be incomplete).",
    9,
    "#64748b",
    "end"
  );

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${bg}
    ${ring}
    ${spokes}
    ${nodeBlocks}
    ${routerBlock}
    ${legend}
    ${note}
  </svg>`;
}

function buildArchitectureSpiderSvg({ protocolLabel, protocolAddress, tokenNodes, vaultNodes, routerNodes, edges }) {
  const tokens = Array.isArray(tokenNodes) ? tokenNodes : [];
  const vaults = Array.isArray(vaultNodes) ? vaultNodes : [];
  const routers = Array.isArray(routerNodes) ? routerNodes : [];
  const relEdges = Array.isArray(edges) ? edges : [];
  const width = 980;
  const height = 760;
  const padding = 18;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const nodeW = 210;
  const nodeH = 44;
  const outerR = 300;

  const rect = (x, y, w, h, fill, stroke) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" />`;
  const label = (x, y, text, size = 11, color = "#0f172a", anchor = "start") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
  const mono = (x, y, text, size = 9, color = "#475569", anchor = "start") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
  const line = (x1, y1, x2, y2, stroke = "#94a3b8", dash = null, widthPx = 1.2, opacity = 1) => {
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    const opAttr = opacity !== 1 ? ` opacity="${opacity}"` : "";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${widthPx}"${dashAttr}${opAttr} />`;
  };

  const bg = `<rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="#f8fafc" stroke="#dbe3ee" />`;
  const ring = `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="#e2e8f0" stroke-dasharray="4 4" />`;

  const centerW = 280;
  const centerH = 64;
  const centerX = cx - Math.round(centerW / 2);
  const centerY = cy - Math.round(centerH / 2);
  const routerBlock =
    rect(centerX, centerY, centerW, centerH, "#eff6ff", "#93c5fd") +
    label(cx, centerY + 24, protocolLabel || "Protocol / Router", 12, "#1d4ed8", "middle") +
    (protocolAddress ? mono(cx, centerY + 44, protocolAddress, 9, "#1d4ed8", "middle") : "");

  const nodes = [
    ...tokens.map((n) => ({ ...n, kind: "token" })),
    ...vaults.map((n) => ({ ...n, kind: "vault" })),
    ...routers.map((n) => ({ ...n, kind: "router2" })),
  ];
  const count = nodes.length;
  const placed = count
    ? nodes.map((n, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        const x = cx + Math.cos(angle) * outerR;
        const y = cy + Math.sin(angle) * outerR;
        return { ...n, x, y };
      })
    : [];

  const spokeColor = (k) => {
    if (k === "token") return "#60a5fa";
    if (k === "router2") return "#34d399";
    return "#a78bfa";
  };

  // If we have explicit relationship edges, avoid implying everything connects to the center.
  // In that case, only draw center spokes for vault/pool/market-like nodes; tokens/eco-routers connect via relEdges.
  const hasExplicitEdges = relEdges.length > 0;
  const spokes = placed
    .filter((n) => {
      if (!hasExplicitEdges) return true;
      return n.kind === "vault";
    })
    .map((n) => line(cx, cy, n.x, n.y, spokeColor(n.kind), null, 1.2, 0.9))
    .join("");

  // Additional relationship edges between outer nodes (e.g. Vault->Token, Token->Ecosystem router).
  const posByAddr = new Map(
    placed
      .filter((n) => n && n.address)
      .map((n) => [String(n.address).toLowerCase(), { x: n.x, y: n.y, kind: n.kind }])
  );
  const relColor = (rel) => {
    const r = String(rel || "").toLowerCase();
    if (r.includes("underlying")) return "#7c3aed"; // purple
    if (r.includes("router")) return "#10b981"; // green
    return "#94a3b8";
  };
  const relDash = (rel) => {
    const r = String(rel || "").toLowerCase();
    if (r.includes("router")) return "4 3";
    return "3 3";
  };
  const relationshipLines = relEdges
    .slice(0, 80)
    .map((e) => {
      const from = posByAddr.get(String(e?.from || "").toLowerCase());
      const to = posByAddr.get(String(e?.to || "").toLowerCase());
      if (!from || !to) return "";
      return line(from.x, from.y, to.x, to.y, relColor(e?.relation), relDash(e?.relation), 1.6, 0.85);
    })
    .join("");

  const nodeBlocks = placed
    .map((n) => {
      const x = Math.max(padding, Math.min(width - padding - nodeW, Math.round(n.x - nodeW / 2)));
      const y = Math.max(padding + 24, Math.min(height - padding - nodeH - 20, Math.round(n.y - nodeH / 2)));
      const fill = n.kind === "token" ? "#f0f9ff" : (n.kind === "router2" ? "#ecfdf5" : "#faf5ff");
      const stroke = n.kind === "token" ? "#93c5fd" : (n.kind === "router2" ? "#6ee7b7" : "#c4b5fd");
      const name =
        n?.name ||
        (n.kind === "token" ? "Token" : (n.kind === "router2" ? "Router" : "Vault/Pool"));
      const addr = n?.address || "";
      return (
        rect(x, y, nodeW, nodeH, fill, stroke) +
        label(x + 8, y + 17, name.slice(0, 24), 10, "#0b1324") +
        (addr ? mono(x + 8, y + 34, addr.slice(0, 18) + "..." + addr.slice(-6), 8, "#475569") : "")
      );
    })
    .join("");

  const legend =
    rect(padding, padding, 250, 54, "#ffffff", "#dbe3ee") +
    label(padding + 10, padding + 16, "Router-Centered Spider Web", 11, "#334155") +
    line(padding + 10, padding + 28, padding + 36, padding + 28, "#60a5fa") +
    label(padding + 40, padding + 31, "Token contract", 10, "#475569") +
    line(padding + 132, padding + 28, padding + 158, padding + 28, "#a78bfa") +
    label(padding + 162, padding + 31, "Vault / pool", 10, "#475569") +
    line(padding + 10, padding + 44, padding + 36, padding + 44, "#34d399") +
    label(padding + 40, padding + 47, "Ecosystem router", 10, "#475569");

  const note = label(
    width - padding,
    height - 10,
    "Best-effort diagram from detected addresses (may be incomplete).",
    9,
    "#64748b",
    "end"
  );

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${bg}
    ${ring}
    ${spokes}
    ${relationshipLines}
    ${nodeBlocks}
    ${routerBlock}
    ${legend}
    ${note}
  </svg>`;
}

function buildEcosystemHopSvg({ subjectId, nodes, edges, hopDist }) {
  const width = 980;
  const height = 720;
  const padding = 18;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const nodeW = 200;
  const nodeH = 44;
  const r1 = 210;
  const r2 = 315;

  const safeId = (v) => String(v || "").trim().toLowerCase();
  const safeLabel = (n) => String(n?.label || n?.name || n?.symbol || n?.address || n?.id || "—").trim();
  const safeKind = (n) => String(n?.kind || n?.type || "node").toLowerCase();

  const rect = (x, y, w, h, fill, stroke) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" />`;
  const text = (x, y, t, size = 10, color = "#0f172a", anchor = "start", family = "system") => {
    const font =
      family === "mono"
        ? `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace`
        : `-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="${font}" text-anchor="${anchor}">${escapeHtml(
      t
    )}</text>`;
  };
  const line = (x1, y1, x2, y2, stroke = "#94a3b8", widthPx = 1.3, opacity = 0.85) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${widthPx}" opacity="${opacity}" />`;

  const bg = `<rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="#ffffff" stroke="#dbe3ee" />`;
  const ring0 = `<circle cx="${cx}" cy="${cy}" r="3" fill="#1d4ed8" />`;
  const ring1 = `<circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="#e2e8f0" stroke-dasharray="4 4" />`;
  const ring2 = `<circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="#e2e8f0" stroke-dasharray="4 4" />`;

  const all = Array.isArray(nodes) ? nodes : [];
  const start = safeId(subjectId);
  const hop0 = all.filter((n) => safeId(n?.id || n?.address) === start);
  const hop1 = all.filter((n) => hopDist.get(safeId(n?.id || n?.address)) === 1);
  const hop2 = all.filter((n) => hopDist.get(safeId(n?.id || n?.address)) === 2);

  const placeRing = (ringNodes, radius) => {
    const count = ringNodes.length;
    return count
      ? ringNodes.map((n, i) => {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
          return { n, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
        })
      : [];
  };

  const placed = [
    ...hop0.map((n) => ({ n, x: cx, y: cy })),
    ...placeRing(hop1, r1),
    ...placeRing(hop2, r2),
  ];

  const pos = new Map(placed.map((p) => [safeId(p.n?.id || p.n?.address), { x: p.x, y: p.y, n: p.n }]));
  const relEdges = Array.isArray(edges) ? edges : [];

  const edgeColor = (rel) => {
    const r = String(rel || "").toLowerCase();
    if (r.includes("issued") || r.includes("wrapped") || r.includes("staking")) return "#7c3aed";
    if (r.includes("integrat") || r.includes("oracle")) return "#10b981";
    return "#94a3b8";
  };

  const edgeLines = relEdges
    .slice(0, 160)
    .map((e) => {
      const from = pos.get(safeId(e?.from));
      const to = pos.get(safeId(e?.to));
      if (!from || !to) return "";
      return line(from.x, from.y, to.x, to.y, edgeColor(e?.relation));
    })
    .join("");

  const nodeFill = (k) => {
    if (k === "protocol") return { fill: "#eff6ff", stroke: "#93c5fd", title: "#1d4ed8" };
    if (k === "token") return { fill: "#f0f9ff", stroke: "#93c5fd", title: "#0f172a" };
    if (k.includes("router")) return { fill: "#ecfdf5", stroke: "#6ee7b7", title: "#065f46" };
    if (k === "contract") return { fill: "#faf5ff", stroke: "#c4b5fd", title: "#0f172a" };
    return { fill: "#f8fafc", stroke: "#dbe3ee", title: "#0f172a" };
  };

  const nodeBlocks = placed
    .slice(0, 44) // keep diagram readable in PDF
    .map((p) => {
      const n = p.n;
      const id = safeId(n?.id || n?.address);
      const hop = hopDist.get(id) ?? (id === start ? 0 : "");
      const kind = safeKind(n);
      const theme = nodeFill(kind);
      const labelStr = safeLabel(n).slice(0, 26);
      const idStr =
        id && id.startsWith("0x") ? `${id.slice(0, 10)}...${id.slice(-6)}` : id.slice(0, 26);
      const x = Math.max(padding, Math.min(width - padding - nodeW, Math.round(p.x - nodeW / 2)));
      const y = Math.max(padding + 24, Math.min(height - padding - nodeH - 18, Math.round(p.y - nodeH / 2)));
      return (
        rect(x, y, nodeW, nodeH, theme.fill, theme.stroke) +
        text(x + 8, y + 16, `${hop !== "" ? `hop ${hop} · ` : ""}${kind}`.slice(0, 22), 9, "#475569") +
        text(x + 8, y + 30, labelStr, 10, theme.title) +
        (idStr ? text(x + 8, y + 41, idStr, 8, "#475569", "start", "mono") : "")
      );
    })
    .join("");

  const legend =
    rect(padding, padding, 300, 56, "#ffffff", "#dbe3ee") +
    text(padding + 10, padding + 18, "Ecosystem Graph (2‑hop)", 11, "#334155") +
    text(padding + 10, padding + 34, "Center = subject protocol · Ring1 = hop1 · Ring2 = hop2", 9, "#475569") +
    text(padding + 10, padding + 48, "Lines show edges between these nodes (subset).", 9, "#475569");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${bg}
    ${ring1}
    ${ring2}
    ${edgeLines}
    ${nodeBlocks}
    ${ring0}
    ${legend}
  </svg>`;
}

function buildPdfReportHtml({ analysis, riskAssessment, generatedAt }) {
  const a = analysis || {};
  const p = a.protocol || {};
  const urlAnalysis = a.urlAnalysis || {};
  const tvlUsd = a?.tvl?.valueUsd;
  const chains = Array.isArray(a?.chainsSupported)
    ? a.chainsSupported
    : (Array.isArray(p?.chains) ? p.chains : []);
  const totalRaisedUsd = typeof p?.totalRaisedUsd === "number" ? p.totalRaisedUsd : null;
  const contracts = Array.isArray(a?.contracts) ? a.contracts : [];
  const tokens = Array.isArray(a?.tokenLiquidity) ? a.tokenLiquidity : [];
  const allocations = Array.isArray(a?.allocations) ? a.allocations : [];

  const auditsCount = Number.isFinite(p?.auditsVerified?.count)
    ? p.auditsVerified.count
    : (Number.isFinite(p?.audits) ? p.audits : null);
  const vol24h = a?.txsPerDay?.value;
  const generatedTs = generatedAt || new Date().toISOString();

  const overall = riskAssessment?.overallTotal;
  const sectionTotals = Array.isArray(riskAssessment?.sectionTotals) ? riskAssessment.sectionTotals : [];

  const tokenRows = tokens
    .map((t) => {
      const tokenName = t?.token || t?.asset || t?.symbol || "—";
      const tokenContract =
        t?.contractAddress ||
        t?.tokenAddress ||
        t?.address ||
        "—";
      const liquidityText =
        typeof t?.liquidityUsd === "number"
          ? fmtUsd(t.liquidityUsd)
          : (t?.liquidityLabel || "—");
      return { tokenName, tokenContract, liquidityText };
    })
    .slice(0, 120);

  const protocolAddress =
    (contracts.find((c) => isLikelyAddress(c?.address))?.address) ||
    (isLikelyAddress(urlAnalysis?.poolAddress) ? urlAnalysis.poolAddress : "") ||
    "";

  const archFromAi = p?.architecture && typeof p.architecture === "object" ? p.architecture : null;
  const aiNodes = Array.isArray(archFromAi?.nodes) ? archFromAi.nodes : [];
  const conn = a?.connections && typeof a.connections === "object" ? a.connections : null;
  const connNodes = Array.isArray(conn?.nodes) ? conn.nodes : [];
  const connEdgesAll = Array.isArray(conn?.edges) ? conn.edges : [];

  // Multi-hop ecosystem (protocol + token) view for reports:
  // Prefer showing 2 hops from subject if possible.
  const subjectGuess =
    connNodes.find((n) => n && (n.kind === "protocol" || n.type === "protocol") && String(n.id || "").startsWith("protocol:") && String(n.label || n.name || "").toLowerCase().includes(String(p?.name || "").toLowerCase())) ||
    connNodes.find((n) => n && (n.kind === "protocol" || n.type === "protocol") && String(n.id || "").startsWith("protocol:")) ||
    null;
  const subjectProtocolId = String(subjectGuess?.id || "").trim();

  const connIdOf = (n) => String(n?.id || n?.address || "").trim().toLowerCase();
  const connLabelOf = (n) => String(n?.label || n?.name || n?.symbol || n?.address || n?.id || "—").trim();
  const adjacency = (() => {
    const m = new Map(); // id -> Set(ids)
    for (const e of connEdgesAll) {
      if (!e) continue;
      const f = String(e.from || "").trim().toLowerCase();
      const t = String(e.to || "").trim().toLowerCase();
      if (!f || !t) continue;
      if (!m.has(f)) m.set(f, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(f).add(t);
      m.get(t).add(f);
    }
    return m;
  })();

  const bfsWithinHops = (startId, maxHops) => {
    if (!startId) return new Map();
    const dist = new Map([[startId.toLowerCase(), 0]]);
    const q = [startId.toLowerCase()];
    while (q.length) {
      const cur = q.shift();
      const d = dist.get(cur);
      if (d == null || d >= maxHops) continue;
      const neigh = adjacency.get(cur);
      if (!neigh) continue;
      for (const nx of neigh) {
        if (dist.has(nx)) continue;
        dist.set(nx, d + 1);
        q.push(nx);
      }
    }
    return dist;
  };

  const hopDist = bfsWithinHops(subjectProtocolId, 2);
  const connNodesById = new Map(connNodes.map((n) => [connIdOf(n), n]).filter(([id]) => id));
  const multiHopNodes = subjectProtocolId ? Array.from(hopDist.keys()).map((id) => connNodesById.get(id)).filter(Boolean) : [];
  const multiHopEdges = subjectProtocolId
    ? connEdgesAll
        .filter((e) => e && hopDist.has(String(e.from || "").toLowerCase()) && hopDist.has(String(e.to || "").toLowerCase()))
        .slice(0, 120)
    : [];
  const ecosystemSvg =
    subjectProtocolId && multiHopNodes.length
      ? buildEcosystemHopSvg({ subjectId: subjectProtocolId, nodes: multiHopNodes, edges: multiHopEdges, hopDist })
      : "";

  const aiTokens = aiNodes
    .filter((n) => n && n.type === "token" && isLikelyAddress(n.address))
    .map((n) => ({ name: n.label || "Token", address: n.address }));

  const aiVaults = aiNodes
    .filter((n) => n && ["vault", "pool", "market"].includes(n.type) && isLikelyAddress(n.address))
    .map((n) => ({ name: n.label || "Vault/Pool", address: n.address }));

  const aiRouter = aiNodes.find((n) => n && ["router", "amm"].includes(n.type) && isLikelyAddress(n.address));

  const connTokens = connNodes
    .filter((n) => n && n.type === "token" && isLikelyAddress(n.address))
    .slice(0, 60)
    .map((n) => ({ name: n.label || "Token", address: n.address }));

  const connRouters = connNodes
    .filter((n) => n && (n.type === "protocol_router" || n.type === "router") && isLikelyAddress(n.address))
    .slice(0, 30)
    .map((n) => ({ name: n.label || "Router", address: n.address }));

  const connEdges = Array.isArray(conn?.edges) ? conn.edges : [];
  const diagramEdges = connEdges
    .filter((e) => e && isLikelyAddress(e.from) && isLikelyAddress(e.to))
    .filter((e) => {
      const r = String(e.relation || "").toLowerCase();
      return (
        r.includes("underlying") ||
        r.includes("router") ||
        r.includes("staking") ||
        r.includes("pool") ||
        r === "connected"
      );
    })
    .slice(0, 80);

  const heurTokens = tokenRows
    .filter((r) => isLikelyAddress(r.tokenContract))
    .map((r) => ({ name: r.tokenName, address: r.tokenContract }));

  const vaultLabelHints = ["vault", "pool", "market", "lp", "staking", "gauge", "router"];
  const heurVaults = [
    ...(isLikelyAddress(urlAnalysis?.poolAddress)
      ? [{ name: urlAnalysis?.pageType ? String(urlAnalysis.pageType) : "Vault/Pool", address: urlAnalysis.poolAddress }]
      : []),
    ...contracts
      .filter((c) => isLikelyAddress(c?.address))
      .filter((c) => {
        const lbl = String(c?.label || "").toLowerCase();
        return vaultLabelHints.some((h) => lbl.includes(h));
      })
      .slice(0, 40)
      .map((c) => ({ name: c.label || "Vault/Pool", address: c.address })),
  ];

  const archTokens = connTokens.length ? connTokens : (aiTokens.length ? aiTokens : heurTokens);
  const archVaults = aiVaults.length ? aiVaults : heurVaults;

  const maxTokensPerDiagram = 18;
  const tokenChunks =
    archTokens.length > 0 ? chunkArray(archTokens, maxTokensPerDiagram) : [[]];
  const archSvgs = tokenChunks
    .map((chunk, idx) => {
      const title = tokenChunks.length > 1 ? `${p?.name || "Protocol"} (tokens ${idx * maxTokensPerDiagram + 1}–${Math.min((idx + 1) * maxTokensPerDiagram, archTokens.length)})` : (p?.name || "Protocol");
      return buildArchitectureSpiderSvg({
        protocolLabel: `${title} / Router`,
        protocolAddress: (aiRouter?.address || protocolAddress || ""),
        tokenNodes: chunk,
        vaultNodes: archVaults.slice(0, 12),
        routerNodes: connRouters.slice(0, 10),
        edges: diagramEdges,
      });
    })
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        --text:#0f172a;
        --muted:#475569;
        --line:#dbe3ee;
        --title:#0b1324;
        --accent:#1d4ed8;
      }
      * { box-sizing:border-box; }
      body {
        margin:0;
        font-family: -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        color: var(--text);
        background: #fff;
      }
      .wrap { padding: 20px; }
      .header { border-bottom: 2px solid var(--line); padding-bottom: 12px; margin-bottom: 14px; }
      .title { margin: 0; font-size: 24px; color: var(--title); }
      .sub { margin-top: 6px; font-size: 12px; color: var(--muted); }
      .section { margin-top: 14px; }
      .section h2 {
        margin: 0 0 8px;
        font-size: 15px;
        color: var(--title);
        border-left: 4px solid var(--accent);
        padding-left: 8px;
      }
      .summary {
        font-size: 12px;
        line-height: 1.45;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
      }
      table { width:100%; border-collapse: collapse; border:1px solid var(--line); }
      th, td { text-align:left; padding: 7px 8px; border-bottom:1px solid var(--line); font-size: 11px; vertical-align: top; }
      th { background:#f8fafc; color:#334155; font-weight:700; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 10px; }
      .muted { color: var(--muted); font-size: 11px; }
      .kpi-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .kpi {
        border:1px solid var(--line);
        border-radius:8px;
        padding:8px;
      }
      .kpi .label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
      .kpi .value { margin-top:4px; font-size:16px; font-weight:700; color:var(--title); }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .small { font-size:10px; color: var(--muted); }
      .page-break { page-break-before: always; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <h1 class="title">${escapeHtml(p?.name || "Protocol")} Risk & Liquidity Report</h1>
        <div class="sub">Generated: ${escapeHtml(generatedTs)}</div>
        <div class="sub">Protocol URL: <span class="mono">${escapeHtml(p?.url || a?.origin || "—")}</span></div>
        <div class="sub">Chains: ${escapeHtml(chains.length ? chains.join(", ") : "—")}</div>
      </div>

      <section class="section">
        <h2>Protocol Summary</h2>
        <div class="summary">
          ${escapeHtml(p?.description || "No protocol description available.")}
          <div style="margin-top:8px;" class="muted">
            DefiLlama audits: ${escapeHtml(auditsCount != null ? String(auditsCount) : "—")}<br />
            Page type: ${escapeHtml(urlAnalysis.pageType || a.pageType || "—")}<br />
            URL chain: ${escapeHtml(urlAnalysis.chain || "—")}<br />
            URL pool/contract: <span class="mono">${escapeHtml(urlAnalysis.poolAddress || "—")}</span>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>Liquidity & Volume Metrics</h2>
        <div class="kpi-grid">
          <div class="kpi">
            <div class="label">Total Value Locked (TVL)</div>
            <div class="value">${escapeHtml(fmtUsd(tvlUsd))}</div>
          </div>
          <div class="kpi">
            <div class="label">Native Token Volume (24h)</div>
            <div class="value">${escapeHtml(fmtUsd(typeof vol24h === "number" ? vol24h : NaN))}</div>
          </div>
          <div class="kpi">
            <div class="label">Total Raised</div>
            <div class="value">${escapeHtml(fmtUsd(typeof totalRaisedUsd === "number" ? totalRaisedUsd : NaN))}</div>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>Architecture Diagram</h2>
        <div class="summary">
          ${archSvgs}
        </div>
      </section>

      <section class="section page-break">
        <h2>Token Liquidity Table</h2>
        ${
          tokenRows.length
            ? `<table>
                <thead>
                  <tr>
                    <th>Token Name</th>
                    <th>Token Contract</th>
                    <th>Liquidity</th>
                  </tr>
                </thead>
                <tbody>
                  ${tokenRows
                    .map(
                      (r) => `<tr>
                        <td>${escapeHtml(r.tokenName)}</td>
                        <td class="mono">${escapeHtml(r.tokenContract)}</td>
                        <td>${escapeHtml(r.liquidityText)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted">No token liquidity entries were detected for this protocol page.</div>`
        }
      </section>

      <section class="section">
        <h2>Smart Contracts</h2>
        ${
          contracts.length
            ? `<table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Network</th>
                    <th>Address</th>
                  </tr>
                </thead>
                <tbody>
                  ${contracts
                    .slice(0, 80)
                    .map(
                      (c) => `<tr>
                        <td>${escapeHtml(c.label || "Contract")}</td>
                        <td>${escapeHtml(c.network || "Unknown")}</td>
                        <td class="mono">${escapeHtml(c.address || "—")}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted">No smart contract addresses were detected.</div>`
        }
      </section>

      <section class="section">
        <h2>Ecosystem Connections (Multi‑hop)</h2>
        ${
          subjectProtocolId && multiHopNodes.length
            ? `<div class="summary">
                <div class="muted">Showing up to <strong>2 hops</strong> from <span class="mono">${escapeHtml(subjectProtocolId)}</span>.</div>
                <div class="muted" style="margin-top:6px;">Nodes: ${escapeHtml(String(multiHopNodes.length))}, edges: ${escapeHtml(String(multiHopEdges.length))}.</div>
              </div>
              <div class="summary" style="margin-top:10px;">
                ${ecosystemSvg}
              </div>
              <table style="margin-top:8px;">
                <thead>
                  <tr><th>Hop</th><th>Kind</th><th>Name / Label</th><th>ID / Address</th></tr>
                </thead>
                <tbody>
                  ${multiHopNodes
                    .slice(0, 120)
                    .map((n) => {
                      const id = connIdOf(n);
                      const hop = hopDist.get(id) ?? "—";
                      const kind = String(n?.kind || n?.type || "node");
                      const label = connLabelOf(n);
                      return `<tr>
                        <td>${escapeHtml(String(hop))}</td>
                        <td>${escapeHtml(kind)}</td>
                        <td>${escapeHtml(label)}</td>
                        <td class="mono">${escapeHtml(id || "—")}</td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
              ${
                multiHopEdges.length
                  ? `<table style="margin-top:10px;">
                      <thead>
                        <tr><th>From</th><th>Relation</th><th>To</th><th>Evidence</th></tr>
                      </thead>
                      <tbody>
                        ${multiHopEdges
                          .slice(0, 120)
                          .map((e) => {
                            const from = String(e.from || "");
                            const to = String(e.to || "");
                            const rel = String(e.relation || "connected");
                            const ev = Array.isArray(e.evidence) ? e.evidence.join(" | ") : String(e.evidence || "");
                            return `<tr>
                              <td class="mono">${escapeHtml(from)}</td>
                              <td>${escapeHtml(rel)}</td>
                              <td class="mono">${escapeHtml(to)}</td>
                              <td>${escapeHtml(ev.slice(0, 240))}</td>
                            </tr>`;
                          })
                          .join("")}
                      </tbody>
                    </table>`
                  : ""
              }`
            : `<div class="muted">No multi-hop ecosystem graph was attached to this analysis yet. Enable hosted enrichment and ensure the connections graph includes protocol/token nodes.</div>`
        }
      </section>

      <section class="section">
        <h2>Wallet Allocations (Optional)</h2>
        ${
          allocations.length
            ? `<table>
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Token</th>
                    <th>Share</th>
                    <th>Value / Note</th>
                  </tr>
                </thead>
                <tbody>
                  ${allocations
                    .slice(0, 80)
                    .map(
                      (x) => `<tr>
                        <td>${escapeHtml(x.target || "—")}</td>
                        <td>${escapeHtml(x.token || "—")}</td>
                        <td>${escapeHtml(typeof x.sharePercent === "number" ? `${x.sharePercent.toFixed(1)}%` : (x.share || "—"))}</td>
                        <td>${escapeHtml(x.tvlLabel || (typeof x.tvlUsd === "number" ? fmtUsd(x.tvlUsd) : "—"))}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted">No wallet allocations were attached to this report.</div>`
        }
      </section>

      <section class="section">
        <h2>Risk Summary</h2>
        <div class="summary">
          Overall score: <strong>${escapeHtml(typeof overall === "number" ? overall.toFixed(2) : "—")}</strong>
        </div>
        ${
          sectionTotals.length
            ? `<table style="margin-top:8px;">
                <thead>
                  <tr><th>Risk Section</th><th>Score</th></tr>
                </thead>
                <tbody>
                  ${sectionTotals
                    .slice(0, 20)
                    .map(
                      (s) => `<tr>
                        <td>${escapeHtml(s.sectionId || "Section")}</td>
                        <td>${escapeHtml(typeof s.score === "number" ? s.score.toFixed(2) : "—")}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted" style="margin-top:8px;">Risk section breakdown is unavailable for this report.</div>`
        }
      </section>
    </div>
  </body>
</html>`;
}

function buildCompactProtocolContext(analysis) {
  const a = analysis || {};
  const tvl = a?.tvl?.valueUsd;
  const tokenLiquidity = Array.isArray(a?.tokenLiquidity) ? a.tokenLiquidity : [];
  const topTokens = tokenLiquidity
    .filter((t) => typeof t?.liquidityUsd === "number")
    .sort((x, y) => (y.liquidityUsd || 0) - (x.liquidityUsd || 0))
    .slice(0, 12)
    .map((t) => ({ token: t.token, liquidityUsd: t.liquidityUsd }));

  const totalRaisedUsd =
    typeof a?.protocol?.totalRaisedUsd === "number" ? a.protocol.totalRaisedUsd : null;

  const contracts = Array.isArray(a?.contracts) ? a.contracts.slice(0, 8) : [];

  return {
    protocolName: a?.protocol?.name || null,
    protocolUrl: a?.protocol?.url || null,
    listedAt: a?.protocol?.listedAt || null,
    tvlUsd: typeof tvl === "number" ? Math.round(tvl) : null,
    topTokenLiquidityUsd: topTokens.map((t) => [t.token, Math.round(t.liquidityUsd)]),
    totalRaisedUsd: typeof totalRaisedUsd === "number" ? Math.round(totalRaisedUsd) : null,
    contracts: contracts.map((c) => [c.label || null, c.network || null, c.address || null]),
  };
}

function buildRubricSectionLite(section) {
  const criteria = Array.isArray(section?.criteria) ? section.criteria : [];
  return {
    id: section?.id || "section",
    label: section?.label || section?.id || "Section",
    criteria: criteria.slice(0, 12).map((c) => ({
      id: c?.id || null,
      label: c?.label || null,
      weight: typeof c?.weight === "number" ? c.weight : null,
      subcriteria: Array.isArray(c?.subcriteria)
        ? c.subcriteria.slice(0, 10).map((s) => ({
            id: s?.id || null,
            label: s?.label || null,
            type: s?.type || null,
          }))
        : [],
    })),
  };
}

function estimateTokens(prompt) {
  // Very rough: 1 token ~= 4 chars in English-ish text.
  return Math.ceil(String(prompt || "").length / 4);
}

function clampPrompt(prompt, { maxTokens = 1500, maxChars = 6000 } = {}) {
  const p = String(prompt || "");
  // Keep both char and token budgets conservative to avoid GPT4All crashes.
  const hard = p.slice(0, Math.max(0, maxChars));
  if (estimateTokens(hard) <= maxTokens) return hard;
  // If still too large, shrink further.
  const targetChars = Math.max(800, Math.floor(maxTokens * 4));
  return hard.slice(0, targetChars);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runRiskAssessmentSectionWiseWithGpt4All({ schema, protocolName, url, analysis }) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;
    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const context = buildCompactProtocolContext(analysis);
    const sectionTotals = [];
    const allCriteria = [];

    const sections = Array.isArray(schema?.sections) ? schema.sections : [];
    for (const section of sections) {
      const sectionId = section?.id || "section";
      const sectionLabel = section?.label || sectionId;
      const lite = buildRubricSectionLite(section);
      const criteriaChunks = chunkArray(lite.criteria, 4);

      const chunkTotals = [];
      for (const chunk of criteriaChunks) {
        const chunkPayload = { ...lite, criteria: chunk };

        const prompt = `
You are a DeFi protocol risk analyst.

Only use the provided facts. Do NOT browse the web.
Do NOT invent audits, exploits, investors, or dates.

Return JSON only:
{
  "sectionId": string,
  "criteria": [
    {
      "criterionId": string,
      "subcriterionId": string | null,
      "score": number,
      "weight": number | null,
      "weightedScore": number | null,
      "evidence": string[],
      "reasoning": string
    }
  ],
  "sectionTotal": number
}

Protocol: ${protocolName || context.protocolName || "null"} (${url || context.protocolUrl || "null"})
Facts: ${JSON.stringify(context)}
Rubric: ${JSON.stringify(chunkPayload)}
`.trim();

        if (estimateTokens(prompt) > 1700) {
          // Too large even after compression; skip LLM for this chunk.
          continue;
        }

        const completion = await createCompletion(model, prompt);
        const message = completion.choices?.[0]?.message;
        const text = typeof message === "string" ? message : message?.content ?? "";
        if (!text) continue;

        const parsed = parseLikelyJson(text);
        if (!parsed || parsed.sectionId !== sectionId) continue;

        if (Array.isArray(parsed.criteria)) {
          parsed.criteria.forEach((c) => {
            allCriteria.push({
              sectionId,
              criterionId: c.criterionId,
              subcriterionId: c.subcriterionId ?? null,
              score: c.score,
              weight: c.weight ?? null,
              weightedScore: c.weightedScore ?? null,
              evidence: Array.isArray(c.evidence) ? c.evidence : [],
              reasoning: c.reasoning || "",
            });
          });
        }

        if (typeof parsed.sectionTotal === "number" && isFinite(parsed.sectionTotal)) {
          chunkTotals.push(clamp01(parsed.sectionTotal));
        }
      }

      if (chunkTotals.length) {
        const sectionTotal = chunkTotals.reduce((a, b) => a + b, 0) / chunkTotals.length;
        sectionTotals.push({ sectionId, score: clamp01(sectionTotal) });
      }
    }

    if (typeof model.dispose === "function") model.dispose();

    if (!sectionTotals.length) return null;

    const overallTotal =
      sectionTotals.reduce((acc, s) => acc + (typeof s.score === "number" ? s.score : 0), 0) /
      sectionTotals.length;

    return {
      protocol: { name: protocolName || null, url: url || null },
      criteria: allCriteria,
      sectionTotals,
      overallTotal: clamp01(overallTotal),
      evidence: ["LLM section-wise scoring (compact prompts)."],
    };
  } catch (err) {
    console.error("runRiskAssessmentSectionWiseWithGpt4All error:", err);
    return null;
  }
}

function buildHeuristicRiskAssessment({ protocolName, url, analysis }) {
  const a = analysis || {};
  const tvl = a?.tvl?.valueUsd;
  const listedAt = a?.protocol?.listedAt;
  const audits = a?.protocol?.audits;
  const auditLinks = Array.isArray(a?.protocol?.auditLinks) ? a.protocol.auditLinks : [];
  const totalRaisedUsd = typeof a?.protocol?.totalRaisedUsd === "number" ? a.protocol.totalRaisedUsd : null;

  const liquidityScore = heuristicLiquidityScore(tvl);
  const raisedScore = heuristicRaisedScore(totalRaisedUsd);
  const longevityScore = heuristicLongevityScore(listedAt);
  const auditCount = Number.isFinite(audits) ? audits : auditLinks.length ? auditLinks.length : null;
  const auditScore = heuristicAuditScore(auditCount);

  // Overall: average available scores (simple + explainable).
  const scores = [liquidityScore, raisedScore, longevityScore, auditScore].filter((x) => typeof x === "number");
  const overallTotal = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0.5;

  return {
    protocol: { name: protocolName || null, url: url || null },
    criteria: [],
    sectionTotals: [
      { sectionId: "liquidity", score: liquidityScore ?? 0 },
      { sectionId: "investment_reputation", score: raisedScore ?? 0 },
      { sectionId: "longevity", score: longevityScore ?? 0 },
      { sectionId: "audits", score: auditScore ?? 0 },
    ],
    overallTotal,
    evidence: [
      "Heuristic fallback: structured LLM rubric scoring was not available for this run.",
      typeof tvl === "number" ? `Liquidity/TVL observed: ${tvl}` : "Liquidity/TVL not available.",
      typeof totalRaisedUsd === "number" ? `Total raised: ${totalRaisedUsd}` : "Total raised unknown.",
      typeof listedAt === "number" ? `DefiLlama listedAt: ${listedAt}` : "DefiLlama listedAt unknown.",
      auditCount != null ? `DefiLlama audits detected: ${auditCount}` : "DefiLlama audit info unknown.",
    ],
  };
}

function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function heuristicLiquidityScore(tvl) {
  if (typeof tvl !== "number" || !isFinite(tvl) || tvl <= 0) return null;
  if (tvl >= 1_000_000_000) return 1.0;
  if (tvl >= 100_000_000) return 0.85;
  if (tvl >= 10_000_000) return 0.7;
  if (tvl >= 1_000_000) return 0.55;
  if (tvl >= 100_000) return 0.4;
  return 0.25;
}

function heuristicRaisedScore(totalRaisedUsd) {
  if (typeof totalRaisedUsd !== "number" || !isFinite(totalRaisedUsd) || totalRaisedUsd <= 0) return null;
  // Higher raised => safer fundraising/reputation.
  if (totalRaisedUsd >= 100_000_000) return 0.95;
  if (totalRaisedUsd >= 50_000_000) return 0.9;
  if (totalRaisedUsd >= 10_000_000) return 0.8;
  if (totalRaisedUsd >= 1_000_000) return 0.65;
  return 0.4;
}

function heuristicLongevityScore(listedAt) {
  if (typeof listedAt !== "number" || !isFinite(listedAt) || listedAt <= 0) return null;
  const ageDays = (Date.now() / 1000 - listedAt) / 86400;
  if (!isFinite(ageDays) || ageDays <= 0) return null;
  // 4 years -> 1.0
  return clamp01(ageDays / (365 * 4));
}

function heuristicAuditScore(auditCount) {
  if (!Number.isFinite(auditCount)) return null;
  if (auditCount >= 3) return 0.95;
  if (auditCount === 2) return 0.9;
  if (auditCount === 1) return 0.75;
  if (auditCount === 0) return 0.4;
  return null;
}

async function runRiskAssessmentWithGpt4All(prompt) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;

    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const completion = await createCompletion(model, prompt);
    const message = completion.choices?.[0]?.message;
    const text = typeof message === "string" ? message : message?.content ?? "";

    if (typeof model.dispose === "function") {
      model.dispose();
    }

    if (!text) {
      throw new Error("GPT4All returned empty response.");
    }

    const parsed = parseLikelyJson(text);
    return parsed;
  } catch (err) {
    console.error("runRiskAssessmentWithGpt4All error:", err);
    return null;
  }
}

function parseLikelyJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("No JSON object found in GPT4All output.");
  }
}

async function fetchTextFast(url, { timeoutMs = 12000 } = {}) {
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
    const msg = err?.message ? String(err.message) : String(err);
    return { ok: false, status: 0, text: "", error: msg };
  } finally {
    clearTimeout(t);
  }
}

function extractAuditClaimsFromText(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  if (!t || !lower.includes("audit")) return { firms: [], snippets: [] };

  const lines = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const snippets = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/audit/i.test(l)) continue;
    const win = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join(" ");
    snippets.push(win.slice(0, 280));
    if (snippets.length >= 18) break;
  }

  // Common auditor names to catch without an LLM (expandable).
  const known = [
    "Trail of Bits",
    "OpenZeppelin",
    "Quantstamp",
    "CertiK",
    "PeckShield",
    "Halborn",
    "Sigma Prime",
    "ChainSecurity",
    "ConsenSys Diligence",
    "Dedaub",
    "OtterSec",
    "Spearbit",
    "Code4rena",
    "Sherlock",
  ];
  const firms = [];
  for (const name of known) {
    if (lower.includes(name.toLowerCase())) firms.push(name);
  }

  return { firms: Array.from(new Set(firms)), snippets };
}

async function verifyAuditsFromProtocolDocs({ origin, protocolName }) {
  const base = normalizeUrl(origin);
  let u;
  try {
    u = new URL(base);
  } catch {
    return { count: null, firms: [], evidence: ["Audit verification skipped: invalid URL."] };
  }

  const candidates = [
    base,
    `${u.origin}/security`,
    `${u.origin}/audits`,
    `${u.origin}/docs`,
    `${u.origin}/docs/security`,
    `${u.origin}/docs/audits`,
    `${u.origin}/documentation`,
    `${u.origin}/documentation/security`,
    `${u.origin}/documentation/audits`,
  ];

  const evidence = [];
  const allSnippets = [];
  const firmSet = new Set();

  for (const url of candidates) {
    const r = await fetchTextFast(url, { timeoutMs: 10_000 });
    if (!r.ok) continue;
    evidence.push(`Checked: ${url}`);
    const { firms, snippets } = extractAuditClaimsFromText(r.text);
    firms.forEach((f) => firmSet.add(f));
    snippets.forEach((s) => allSnippets.push(s));
    if (allSnippets.length >= 18) break;
  }

  // Optional AI normalization: Cursor Cloud Agents when ENABLE_HOSTED_ENRICH=1, else local GPT4All.
  const enableHostedEnrich = String(process.env.ENABLE_HOSTED_ENRICH || "0") === "1";
  const enableWebsiteLlm = String(process.env.ENABLE_WEBSITE_LLM || "1").toLowerCase() === "1";
  if (enableHostedEnrich && allSnippets.length) {
    const auditorsTimeoutMs = Number(
      process.env.HOSTED_AUDITORS_TIMEOUT_MS ||
        process.env.CURSOR_CLOUD_AGENTS_AUDITORS_TIMEOUT_MS ||
        120_000
    );
    const auditorsRes = await withTimeout(
      extractAuditorsWithHostedLlm({
        protocolName: protocolName || null,
        origin: base,
        docs: {
          lines: allSnippets.slice(0, 55),
          evidence: ["verifyAuditsFromProtocolDocs (hosted)", ...evidence.slice(0, 3)],
        },
      }),
      auditorsTimeoutMs,
      "auditors"
    ).catch(() => null);
    for (const a of auditorsRes?.auditors || []) {
      const n = String(a?.name || "").trim();
      if (n) firmSet.add(n);
    }
  } else if (enableWebsiteLlm && allSnippets.length) {
    const prompt = `
Extract security audit firms from protocol docs text.
Return JSON only: {"auditors":[{"name":string}]}.
If none are clearly stated, return {"auditors":[]}.

Protocol: ${protocolName || "unknown"}
URL: ${base}

Snippets:
${allSnippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}
`.trim();
    const parsed = await runJsonPromptWithGpt4All(prompt).catch(() => null);
    const auditors = Array.isArray(parsed?.auditors) ? parsed.auditors : [];
    auditors
      .map((x) => String(x?.name || "").trim())
      .filter(Boolean)
      .forEach((n) => firmSet.add(n));
  }

  const firms = Array.from(firmSet);
  const count = firms.length ? firms.length : null;
  if (!evidence.length) evidence.push("No protocol docs pages reachable for audit verification.");

  return {
    count,
    firms,
    evidence: [
      "Audits verified from protocol documentation (best‑effort).",
      ...evidence.slice(0, 6),
      ...(firms.length ? [`Auditors found: ${firms.join(", ")}`] : ["Auditors not found in checked pages."]),
    ],
  };
}

function extractTvlFromHtml(html) {
  if (!html) return null;
  const text = htmlToVisibleText(html);
  const lower = text.toLowerCase();
  const idx = lower.search(/\b(tvl|total value locked|liquidity)\b/);
  if (idx === -1) return null;

  const windowSize = 200;
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + windowSize);
  const snippet = text.slice(start, end);

  // Match patterns like $28B, $1.2M, 28B, 1.2M, 100,000,000 etc near TVL/liquidity.
  const tvlRegex =
    /(?:\$?\s*([\d.,]+)\s*(k|m|b|bn)?)(?:\s*(?:tvl|total value locked|liquidity))/i;
  const reversedRegex =
    /(?:tvl|total value locked|liquidity)[^$0-9]{0,60}\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;

  let m = tvlRegex.exec(snippet) || reversedRegex.exec(snippet);
  if (!m) return null;

  const raw = m[1];
  const suffix = (m[2] || "").toLowerCase();
  let value = parseFloat(raw.replace(/,/g, ""));
  if (!isFinite(value)) return null;

  if (suffix === "k") value *= 1e3;
  else if (suffix === "m") value *= 1e6;
  else if (suffix === "b" || suffix === "bn") value *= 1e9;

  return {
    valueUsd: value,
    text: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
  };
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

function inferNameFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (!parts.length) return null;

    // Skip common non-brand subdomains like "app", "www", "beta", etc.
    const skip = new Set(["app", "www", "beta", "alpha", "staging", "test"]);
    let candidate = parts[0];
    if (skip.has(candidate.toLowerCase()) && parts.length >= 2) {
      candidate = parts[1];
    }

    // If still something generic, fall back to the registrable domain label.
    if (skip.has(String(candidate).toLowerCase()) && parts.length >= 2) {
      candidate = parts[parts.length - 2];
    }

    if (!candidate) return null;
    const pretty = candidate
      .replace(/[-_]+/g, " ")
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ")
      .trim();
    return pretty || null;
  } catch {
    return null;
  }
}

function parseMoneyToUsd(raw, suffix) {
  let value = parseFloat(String(raw).replace(/,/g, ""));
  if (!isFinite(value)) return null;
  const s = String(suffix || "").toLowerCase();
  if (s === "k") value *= 1e3;
  else if (s === "m") value *= 1e6;
  else if (s === "b" || s === "bn") value *= 1e9;
  return value;
}

function extractTokenLiquidityFromHtml(html) {
  const text = htmlToVisibleText(html);
  if (!text) return [];

  // Normalize to line-ish chunks; many UIs render tables where each row becomes a few adjacent tokens.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const results = [];
  const seen = new Set();

  // Look for patterns that appear in dashboards:
  // TOKEN ... Total Liquidity ... $43.39M  or  TOKEN ... $43.39M ... Total Liquidity
  const moneyRe = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;
  const tokenRe = /^[A-Z][A-Z0-9.-]{1,10}$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (!lower.includes("liquidity")) continue;

    // Search a local window around the "liquidity" line for a likely token label and a money value.
    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4));

    let money = null;
    let token = null;

    for (const w of window) {
      const m = moneyRe.exec(w);
      if (m && !money) {
        const matched = String(m[0] || "");
        const hasDollar = matched.includes("$");
        const hasSuffix = Boolean(m[2]);
        const hasComma = String(m[1] || "").includes(",");
        const digitsOnly = String(m[1] || "").replace(/[.,]/g, "");
        const enoughDigits = digitsOnly.length >= 4;
        if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;

        const usd = parseMoneyToUsd(m[1], m[2]);
        if (usd != null) money = { usd, label: (m[0] || "").trim() };
      }
      if (!token && tokenRe.test(w) && w.toLowerCase() !== "tvl") {
        token = w;
      }
    }

    if (token && money) {
      const key = `${token}:${money.usd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        token,
        liquidityUsd: money.usd,
        liquidityLabel: money.label,
        evidence: [`Found near "liquidity" in page text${html.includes("data-state") ? "" : ""}.`],
      });
      if (results.length >= 25) break;
    }
  }

  // If we didn't find "liquidity"-anchored rows, fall back to a generic table-like scan:
  // TOKEN then nearby money value.
  if (results.length === 0) {
    for (let i = 0; i < lines.length - 1; i++) {
      const tokenCandidate = lines[i];
      if (!tokenRe.test(tokenCandidate)) continue;

      const lookahead = lines.slice(i + 1, Math.min(lines.length, i + 6)).join(" ");
      const m = moneyRe.exec(lookahead);
      if (!m) continue;
      const matched = String(m[0] || "");
      const hasDollar = matched.includes("$");
      const hasSuffix = Boolean(m[2]);
      const hasComma = String(m[1] || "").includes(",");
      const digitsOnly = String(m[1] || "").replace(/[.,]/g, "");
      const enoughDigits = digitsOnly.length >= 4;
      if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;
      const usd = parseMoneyToUsd(m[1], m[2]);
      if (usd == null) continue;

      const key = `${tokenCandidate}:${usd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        token: tokenCandidate,
        liquidityUsd: usd,
        liquidityLabel: (m[0] || "").trim(),
        evidence: ["Token and nearby USD value found in rendered page text."],
      });
      if (results.length >= 25) break;
    }
  }

  return results;
}

async function fetchHtmlWithOptionalRender(url) {
  const headers = {
    "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)",
  };

  const isVercel = String(process.env.VERCEL || "") !== "";
  const fetchTimeoutMs = Number(
    process.env.HTML_FETCH_TIMEOUT_MS || (isVercel ? 30_000 : 15_000)
  );
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), fetchTimeoutMs);

  const fetchOnce = () => fetch(url, { headers, signal: controller.signal });
  let resp;
  try {
    // Small retry for transient DNS issues (EAI_AGAIN/ENOTFOUND happens on some networks).
    try {
      resp = await fetchOnce();
    } catch (e1) {
      const m = String(e1?.message || e1 || "");
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
        await new Promise((r) => setTimeout(r, 650));
        resp = await fetchOnce();
      } else {
        throw e1;
      }
    }
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);
    // Network timeouts are common when rendering JS-heavy pages.
    return {
      ok: false,
      status: 504,
      html: "",
      rendered: false,
      renderError: `Fetch timed out/failed: ${msg}`,
    };
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) {
    return { ok: false, status: resp.status, html: "", rendered: false };
  }

  const html = await resp.text();
  const force = String(process.env.FORCE_RENDER || "").toLowerCase() === "1";
  const should = force || shouldRenderHtml({ html, url });
  if (!should) {
    return { ok: true, status: resp.status, html, rendered: false };
  }

  // Safety valve for local debugging: some JS-heavy pages can make Playwright slow.
  if (String(process.env.SKIP_PLAYWRIGHT_RENDER || "").toLowerCase() === "1") {
    return { ok: true, status: resp.status, html, rendered: false, extracted: null };
  }

  let renderError = null;
  // Some SPAs (e.g. app subdomains) can hang or take very long to fully render.
  // Use a shorter default timeout for those so we fall back quickly.
  let defaultRenderTimeoutMs = 45_000;
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    if (host.startsWith("app.") || host.includes("pendle.finance")) {
      defaultRenderTimeoutMs = 25_000;
    }
  } catch {
    // ignore
  }
  const renderTimeoutMs = Number(process.env.PLAYWRIGHT_RENDER_TIMEOUT_MS || defaultRenderTimeoutMs);
  const rendered = await renderHtmlWithPlaywright(url, { timeoutMs: renderTimeoutMs }).catch((err) => {
    renderError = err?.message ? String(err.message) : String(err);
    console.warn("Playwright render failed, using raw HTML:", renderError);
    return null;
  });

  if (rendered?.html) {
    return {
      ok: true,
      status: resp.status,
      html: rendered.html,
      rendered: true,
      extracted: rendered.extracted || null,
    };
  }

  return {
    ok: true,
    status: resp.status,
    html,
    rendered: false,
    extracted: null,
    renderError,
  };
}

function shouldRenderHtml({ html, url }) {
  if (!html) return true;
  const lower = String(html).toLowerCase();

  // URL-based hints: many protocol pages are JS-heavy SPAs where important tables
  // (tokens/contracts/markets) appear only after rendering.
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isAppSubdomain = host.startsWith("app.") || host.startsWith("trade.") || host.startsWith("vault.") || host.startsWith("markets.");
    const isKnownAppPath =
      path.includes("market") ||
      path.includes("markets") ||
      path.includes("vault") ||
      path.includes("pools") ||
      path.includes("pool") ||
      path.includes("swap") ||
      path.includes("stake") ||
      path.includes("dashboard");
    if (isAppSubdomain || isKnownAppPath) return true;
  } catch {
    // ignore
  }

  // Common SPA shells / error states.
  if (lower.includes("failed to load app")) return true;
  if (lower.includes("you need to enable javascript")) return true;

  // If there's very little meaningful text, it's likely JS-rendered.
  const text = lower
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 400) return true;

  // Heuristic: SPA root + lots of scripts, little body content.
  const hasRoot =
    lower.includes('id="root"') ||
    lower.includes('id="app"') ||
    lower.includes('data-reactroot');
  const scriptCount = (lower.match(/<script\b/g) || []).length;
  if (hasRoot && scriptCount >= 5) return true;

  // Next.js/SPA hint: Next data + script-heavy documents.
  if (lower.includes("__next_data__") && scriptCount >= 8) return true;

  return false;
}

async function renderHtmlWithPlaywright(url, { timeoutMs } = {}) {
  // Serverless (Vercel) often needs these flags. Locally, apply default
  // Chromium settings to avoid hangs/regressions.
  const isVercel = String(process.env.VERCEL || "") !== "";
  const browser = await chromium.launch({
    headless: true,
    args: isVercel ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  try {
    const hardTimeoutMs = Number(timeoutMs || process.env.PLAYWRIGHT_RENDER_TIMEOUT_MS || (isVercel ? 60_000 : 30_000));
    let hardTimer = null;
    const hardTimeout = new Promise((_, reject) => {
      hardTimer = setTimeout(async () => {
        try {
          await browser.close();
        } catch {}
        reject(new Error(`Playwright render timed out after ${hardTimeoutMs}ms`));
      }, hardTimeoutMs);
    });

    const work = (async () => {
    const context = await browser.newContext({
      userAgent: "ProtocolInspector/1.0 (+https://github.com/)",
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Speed up SPAs: skip heavy resources that don't affect text extraction.
    // This helps prevent timeouts on apps like Pendle/Morpho.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return route.abort();
      }
      return route.continue();
    });

    // Don’t hang forever on slow/non-responsive pages.
    const navTimeoutMs = Number(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS || (isVercel ? 60_000 : 25_000));
    const opTimeoutMs = Number(process.env.PLAYWRIGHT_OP_TIMEOUT_MS || (isVercel ? 60_000 : 25_000));
    page.setDefaultNavigationTimeout(navTimeoutMs);
    page.setDefaultTimeout(opTimeoutMs);

    let lastErr = null;
    try {
      // SPA apps often never reach `networkidle` due to polling/WebSockets.
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      lastErr = err;
      console.warn("Playwright goto failed; extracting partial content:", err.message);
    }

    // Give the app time to paint real UI text (generic signal: "liquidity" + "$").
    // Works for many dashboards and avoids needing site-specific selectors.
    try {
      await page.waitForFunction(
        () => {
          const t = (document.body && (document.body.innerText || document.body.textContent)) || "";
          return /liquidity/i.test(t) && /\$[\d]/.test(t);
        },
        {
          timeout: Number(
            process.env.PLAYWRIGHT_WAIT_FOR_TEXT_TIMEOUT_MS ||
              (isVercel ? 20_000 : 8_000)
          ),
        }
      );
    } catch {
      // If it never appears, continue with whatever we have.
    }
    try {
      await page.waitForTimeout(500);
    } catch {
      // ignore
    }

    let html = await page.content();
    let extracted = await extractFromRenderedDom(page).catch(() => null);

    // If the page still looks like an empty shell, wait a bit longer and try again.
    const visible = htmlToVisibleText(html);
    if (visible.length < 300 || (extracted && Array.isArray(extracted.tokenLiquidity) && extracted.tokenLiquidity.length === 0)) {
      try {
        await page.waitForTimeout(2500);
      } catch {
        // ignore
      }
      html = await page.content();
      extracted = await extractFromRenderedDom(page).catch(() => extracted);
    }

    await context.close();
    return { html, extracted, lastErr: lastErr ? String(lastErr.message || lastErr) : null };
    })();

    const result = await Promise.race([work, hardTimeout]);
    if (hardTimer) clearTimeout(hardTimer);
    return result;
  } finally {
    await browser.close();
  }
}

async function extractFromRenderedDom(page) {
  const data = await page.evaluate(() => {
    const moneyRe = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;

    function parseMoney(str) {
      const m = moneyRe.exec(str || "");
      if (!m) return null;
      const raw = m[1];
      const suffix = (m[2] || "").toLowerCase();
      const matched = String(m[0] || "");
      // Guardrails: avoid interpreting "24h" / column labels as money.
      const hasDollar = matched.includes("$");
      const hasSuffix = Boolean(suffix);
      const hasComma = raw.includes(",");
      const digitsOnly = raw.replace(/[.,]/g, "");
      const enoughDigits = digitsOnly.length >= 4; // e.g. 1000+
      if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) return null;

      let v = parseFloat(String(raw).replace(/,/g, ""));
      if (!isFinite(v)) return null;
      if (suffix === "k") v *= 1e3;
      else if (suffix === "m") v *= 1e6;
      else if (suffix === "b" || suffix === "bn") v *= 1e9;
      return { usd: v, label: m[0].trim() };
    }

    function parseAllMoney(str) {
      const s = String(str || "");
      const matches = [];
      const re = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/gi;
      let m;
      while ((m = re.exec(s)) !== null) {
        const raw = m[1];
        const suffix = (m[2] || "").toLowerCase();
        const matched = String(m[0] || "");
        const hasDollar = matched.includes("$");
        const hasSuffix = Boolean(suffix);
        const hasComma = String(raw).includes(",");
        const digitsOnly = String(raw).replace(/[.,]/g, "");
        const enoughDigits = digitsOnly.length >= 4;
        if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;
        let v = parseFloat(String(raw).replace(/,/g, ""));
        if (!isFinite(v)) continue;
        if (suffix === "k") v *= 1e3;
        else if (suffix === "m") v *= 1e6;
        else if (suffix === "b" || suffix === "bn") v *= 1e9;
        matches.push({ usd: v, label: matched.trim() });
      }
      return matches;
    }

    function textOf(el) {
      return (el && (el.innerText || el.textContent) ? String(el.innerText || el.textContent) : "")
        .replace(/\s+/g, " ")
        .trim();
    }

    // 1) Metric extraction: find a label like "Total Liquidity" and the nearest money value in its container.
    const metricLabels = ["total liquidity", "liquidity", "tvl", "total value locked"];
    const metricCandidates = [];
    // Keep evaluation cheap; scanning huge DOMs can time out on SPAs.
    const all = Array.from(document.querySelectorAll("body *")).slice(0, 2500);
    for (const el of all) {
      const t = textOf(el);
      if (!t || t.length > 80) continue;
      const lower = t.toLowerCase();
      if (!metricLabels.some((k) => lower.includes(k))) continue;
      const container = el.closest("section,article,div,li,td,th") || el.parentElement || el;
      const containerText = textOf(container);
      const monies = parseAllMoney(containerText);
      const money = monies.sort((a, b) => b.usd - a.usd)[0] || null;
      if (money && money.usd != null) {
        metricCandidates.push({
          label: t,
          containerText: containerText.slice(0, 240),
          usd: money.usd,
          moneyLabel: money.label,
        });
      }
      if (metricCandidates.length >= 30) break;
    }

    // Prefer "Total Liquidity" over generic "Liquidity" over "TVL".
    function pickBestMetric() {
      const ranked = metricCandidates
        .map((m) => {
          const l = m.label.toLowerCase();
          let score = 0;
          if (l.includes("total liquidity")) score += 30;
          if (l.includes("total value locked")) score += 25;
          if (l === "tvl" || l.includes(" tvl")) score += 20;
          if (l.includes("liquidity")) score += 10;
          // Larger numbers usually are the main TVL/liquidity, de-prioritize tiny ones.
          score += Math.min(20, Math.log10(Math.max(1, m.usd)) * 3);
          return { score, m };
        })
        .sort((a, b) => b.score - a.score);
      return ranked.length ? ranked[0].m : null;
    }

    const bestMetric = pickBestMetric();

    // 2) Token liquidity table extraction: find a header row with a liquidity column and parse rows.
    function getCells(row) {
      const cells = Array.from(row.querySelectorAll("th,td,[role='cell'],[role='gridcell']"));
      return cells.length ? cells : Array.from(row.children || []);
    }

    function normalizeHeader(s) {
      return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    }

    const rows = [
      ...Array.from(document.querySelectorAll("tr")),
      ...Array.from(document.querySelectorAll("[role='row']")),
    ];

    let header = null;
    let liquidityCol = -1;
    for (const r of rows) {
      const cells = getCells(r).map((c) => normalizeHeader(textOf(c)));
      const joined = cells.join(" | ");
      if (!cells.length) continue;
      if (joined.includes("liquidity") || joined.includes("total liquidity") || joined.includes("tvl")) {
        const idx = cells.findIndex((c) => c.includes("total liquidity") || c === "liquidity" || c.includes("liquidity"));
        if (idx >= 0) {
          header = r;
          liquidityCol = idx;
          break;
        }
      }
    }

    const tokenLiquidity = [];
    if (header && liquidityCol >= 0) {
      const headerIndex = rows.indexOf(header);
      for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 120); i++) {
        const r = rows[i];
        // stop if we hit another header-ish row
        const cells = getCells(r);
        if (!cells.length) continue;
        const cellTexts = cells.map((c) => textOf(c));
        const headerish = cellTexts.some((t) => /total\s+liquidity|liquidity|tvl/i.test(t)) && cellTexts.every((t) => t.length < 30);
        if (headerish) break;

        const tokenText = (cellTexts[0] || "").trim();
        if (!tokenText) continue;
        const liqCell = cells[liquidityCol] || null;
        const liqText = textOf(liqCell);
        const money = parseMoney(liqText);
        if (!money) continue;

        tokenLiquidity.push({
          token: tokenText.split(/\s+/)[0],
          liquidityUsd: money.usd,
          liquidityLabel: money.label,
          evidence: ["Extracted from rendered table row."],
        });
        if (tokenLiquidity.length >= 50) break;
      }
    }

    // 3) Contract links: capture explorer address links and visible anchor text.
    const contractLinks = [];
    const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 6000);
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/address\/(0x[a-fA-F0-9]{40})/);
      if (!m) continue;
      const address = m[1];
      const label = textOf(a) || a.getAttribute("aria-label") || "Explorer link";
      contractLinks.push({ address, label, href });
      if (contractLinks.length >= 60) break;
    }

    // 3b) Generic address discovery in hrefs (pool links, internal routes, etc).
    // This is safe (doesn't read bundled scripts), and works for apps that encode
    // pool/market addresses in the URL (e.g. /pools/0x...).
    const hrefAddresses = [];
    const addrRe = /(0x[a-fA-F0-9]{40})/g;
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (!href.includes("0x")) continue;
      let mm;
      while ((mm = addrRe.exec(href)) !== null) {
        const address = mm[1];
        const labelText = textOf(a) || a.getAttribute("aria-label") || "";
        const pathHint = href.toLowerCase();
        let kind = "Address link";
        if (pathHint.includes("pool")) kind = "Pool";
        else if (pathHint.includes("market")) kind = "Market";
        else if (pathHint.includes("router")) kind = "Router";
        else if (pathHint.includes("vault")) kind = "Vault";
        else if (pathHint.includes("token")) kind = "Token";
        hrefAddresses.push({
          address,
          href,
          label: labelText ? `${kind}: ${labelText}` : `${kind} address`,
        });
        if (hrefAddresses.length >= 120) break;
      }
      if (hrefAddresses.length >= 120) break;
    }

    // 4) Address contexts: if addresses appear in text, capture nearby container text
    // to help label what the contract likely is.
    const addressRe = /0x[a-fA-F0-9]{40}/g;
    const addressContexts = [];
    const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || "";
    const addrSet = new Set((bodyText.match(addressRe) || []).slice(0, 200).map((a) => a.toLowerCase()));

    // Try to find a DOM element that contains each address.
    const allTextNodes = Array.from(document.querySelectorAll("body *")).slice(0, 12000);
    for (const addr of addrSet) {
      let el = null;
      for (const node of allTextNodes) {
        const t = textOf(node);
        if (t && t.toLowerCase().includes(addr)) {
          el = node;
          break;
        }
      }
      if (!el) continue;
      const container = el.closest("tr,[role='row'],section,article,li,div") || el.parentElement || el;
      const ctx = textOf(container);
      addressContexts.push({
        address: addr,
        context: ctx.slice(0, 260),
      });
      if (addressContexts.length >= 80) break;
    }

    return {
      bestMetric,
      tokenLiquidity,
      contractLinks,
      addressContexts,
      hrefAddresses,
    };
  });

  return data;
}

function extractInvestorsFromHtml(html, opts = {}) {
  if (!html) return [];
  const results = new Set();
  const knownTokens = Array.isArray(opts.knownTokens) ? opts.knownTokens : [];
  const knownTokenSet = new Set(knownTokens.map((t) => String(t || "").toUpperCase()).filter(Boolean));

  // 1) Visible text heuristics (works for rendered SPAs)
  const text = htmlToVisibleText(html);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const anchors = [
    "investors",
    "backers",
    "backed by",
    "funding",
    "seed",
    "series a",
    "series b",
    "strategic",
    "raised",
  ];

  const stopWords = new Set([
    "investors",
    "backers",
    "partners",
    "funding",
    "seed",
    "series",
    "round",
    "raised",
    "our",
    "the",
    "and",
  ]);

  const tokenLike = /^[A-Z][A-Z0-9.-]{1,10}$/;
  const marketTableAnchors = ["asset", "liquidity", "apy", "tvl", "volume", "leverage"];

  function addCandidate(name) {
    const n = String(name || "").replace(/\s+/g, " ").trim();
    if (!n) return;
    if (n.length < 3 || n.length > 60) return;
    if (/^\$|%|^\d/.test(n)) return;
    // Exclude any known token symbols from being misclassified as investors.
    // This fixes cases where tokens like USDe / NUSD appear near investor/funding text.
    if (knownTokenSet.has(n.toUpperCase())) return;
    if (tokenLike.test(n)) return; // avoid tokens like USDC, NUSD, etc.
    if (stopWords.has(n.toLowerCase())) return;
    // require at least one letter
    if (!/[a-z]/i.test(n)) return;
    // Require org-ish structure (at least 2 words) or common org suffix.
    const orgish =
      n.includes(" ") ||
      /(capital|ventures|labs|foundation|partners|dao|research|fund|holdings|group)/i.test(n);
    if (!orgish) return;
    results.add(n);
  }

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (!anchors.some((a) => lower.includes(a))) continue;

    // Take a small window after the anchor and extract likely org names.
    const window = lines.slice(i, Math.min(lines.length, i + 8)).join(" • ");
    // Avoid parsing market tables as investor lists.
    const windowLower = window.toLowerCase();
    if (marketTableAnchors.filter((a) => windowLower.includes(a)).length >= 3) continue;
    // Split on common separators and filter plausible org-ish tokens.
    window
      .split(/[,•|·]/)
      .map((s) => s.trim())
      .forEach((piece) => {
        if (!piece) return;
        if (anchors.some((a) => piece.toLowerCase() === a)) return;
        // Skip obvious boilerplate.
        if (/learn more|read more|privacy|terms|discord|twitter|telegram/i.test(piece)) return;
        // Heuristic: organizations often have capitals or known suffixes, or multiple words.
        const looksOrg =
          /[A-Z]/.test(piece[0]) ||
          piece.includes(" ") ||
          /(capital|ventures|labs|foundation|partners|dao|research|fund)/i.test(piece);
        if (!looksOrg) return;
        // Remove trailing words like "investor(s)".
        const cleaned = piece.replace(/\b(investors?|backers?|partners?)\b/gi, "").trim();
        addCandidate(cleaned);
      });

    if (results.size >= 25) break;
  }

  // 2) Alt-text/logo scan (many sites list investors as logos)
  const altMatches = String(html)
    .match(/alt="([^"]{2,80})"/gi) || [];
  for (const a of altMatches) {
    const m = a.match(/alt="([^"]+)"/i);
    const alt = m?.[1] || "";
    if (!alt) continue;
    if (/logo|icon|image|app|download|asset|liquidity|apy|tvl/i.test(alt.toLowerCase())) continue;
    if (alt.length > 60) continue;
    // Only keep plausible brand names
    if (!/[a-z]/i.test(alt)) continue;
    if (tokenLike.test(alt.trim())) continue;
    if (knownTokenSet.has(alt.trim().toUpperCase())) continue;
    addCandidate(alt);
    if (results.size >= 25) break;
  }

  return Array.from(results).slice(0, 25);
}

async function getWalletAllocationsFromEtherscan({ walletAddress, contracts }) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return {
      allocations: [],
      evidence: ["ETHERSCAN_API_KEY not configured; cannot query wallet allocations."],
    };
  }

  const wallet = String(walletAddress).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { allocations: [], evidence: ["Invalid wallet address format."] };
  }

  const contractSet = new Set(
    (contracts || [])
      .map((c) => String(c.address || "").toLowerCase())
      .filter((a) => /^0x[a-f0-9]{40}$/.test(a))
  );
  if (contractSet.size === 0) {
    return { allocations: [], evidence: ["No protocol contracts detected to match against."] };
  }

  const url =
    "https://api.etherscan.io/api?module=account&action=tokentx" +
    `&address=${encodeURIComponent(wallet)}` +
    "&page=1&offset=200&sort=desc" +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Etherscan tokentx failed: ${resp.status}`);
  const json = await resp.json();
  const txs = Array.isArray(json?.result) ? json.result : [];

  // Summarize net flows per token where counterparty is one of the protocol contracts.
  const byToken = new Map();
  for (const t of txs) {
    const from = String(t.from || "").toLowerCase();
    const to = String(t.to || "").toLowerCase();
    const counterparty = from === wallet ? to : from;
    if (!contractSet.has(counterparty)) continue;

    const symbol = t.tokenSymbol || "TOKEN";
    const decimals = Number(t.tokenDecimal || 0);
    const raw = BigInt(String(t.value || "0"));
    const signed = from === wallet ? raw : -raw; // outgoing positive "deposit", incoming negative "withdraw"

    const key = `${symbol}:${t.contractAddress || ""}`.toLowerCase();
    const prev = byToken.get(key) || {
      token: symbol,
      tokenAddress: t.contractAddress || null,
      decimals,
      netRaw: 0n,
      counterparties: new Set(),
      evidence: [],
    };
    prev.netRaw += signed;
    prev.counterparties.add(counterparty);
    if (prev.evidence.length < 3) {
      prev.evidence.push(`tx ${t.hash} (${from === wallet ? "to" : "from"} ${counterparty})`);
    }
    byToken.set(key, prev);
  }

  const allocations = Array.from(byToken.values())
    .filter((x) => x.netRaw !== 0n)
    .map((x) => {
      const scale = x.decimals > 0 ? 10n ** BigInt(x.decimals) : 1n;
      const abs = x.netRaw < 0n ? -x.netRaw : x.netRaw;
      const whole = abs / scale;
      const frac = x.decimals > 0 ? (abs % scale).toString().padStart(x.decimals, "0").slice(0, 6) : "0";
      const amount = `${whole.toString()}${x.decimals > 0 ? "." + frac : ""}`;
      const direction = x.netRaw > 0n ? "net_deposit" : "net_withdraw";
      return {
        target: "Protocol contracts (matched on Etherscan)",
        token: x.token,
        netDirection: direction,
        netAmount: amount,
        tvlLabel: `${direction === "net_deposit" ? "+" : "-"}${amount} ${x.token}`,
        evidence: x.evidence,
      };
    })
    .slice(0, 50);

  return {
    allocations,
    evidence: [
      "Source: Etherscan account tokentx API (latest 200 ERC-20 transfers).",
      "Allocations represent net token flow between your wallet and detected protocol contracts.",
    ],
  };
}

async function getWalletHoldingsFromEtherscan({ walletAddress }) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return { allocations: [], evidence: ["ETHERSCAN_API_KEY not configured; cannot query wallet holdings."] };
  }

  const wallet = String(walletAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { allocations: [], evidence: ["Invalid wallet address format for Etherscan holdings."] };
  }

  const url =
    "https://api.etherscan.io/v2/api?chainid=1&module=account&action=addresstokenbalance" +
    `&address=${encodeURIComponent(wallet)}` +
    "&page=1&offset=200" +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const allocations = [];
  const toFiniteNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const parseUnitsToFloat = (raw, decimals) => {
    const cleaned = String(raw || "0").trim();
    if (!/^\d+$/.test(cleaned)) return null;
    let bi;
    try {
      bi = BigInt(cleaned);
    } catch {
      return null;
    }
    if (bi <= 0n) return 0;
    const d = Math.max(0, Math.min(30, Number.isFinite(Number(decimals)) ? Number(decimals) : 0));
    const base = 10n ** BigInt(d);
    const whole = bi / base;
    const frac = bi % base;
    if (d === 0) {
      const n = toFiniteNumber(whole.toString());
      return n == null ? null : n;
    }
    const fracStr = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/, "");
    const asStr = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    return toFiniteNumber(asStr);
  };

  // Include native ETH balance so wallets without ERC20 holdings still show something.
  const nativeUrl =
    "https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance" +
    `&address=${encodeURIComponent(wallet)}` +
    "&tag=latest" +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const nativeResp = await fetch(nativeUrl).catch(() => null);
  if (nativeResp && nativeResp.ok) {
    const nativeJson = await nativeResp.json().catch(() => null);
    const weiRaw = String(nativeJson?.result || "0");
    const eth = parseUnitsToFloat(weiRaw, 18);
    if (eth != null && eth > 0) {
      allocations.push({
        target: "ETH (wallet balance)",
        share: "—",
        tvlLabel: `${eth.toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`,
        riskLevel: "unknown",
        evidence: ["Source: Etherscan account balance (Ethereum)"],
      });
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Etherscan addresstokenbalance failed: ${resp.status}`);
  const json = await resp.json().catch(() => null);
  const result = Array.isArray(json?.result) ? json.result : [];

  const tokenAllocations = result
    .map((t) => {
      const symbol = t?.TokenSymbol || t?.tokenSymbol || t?.symbol || "TOKEN";
      const decimalsRaw = t?.TokenDivisor ?? t?.tokenDecimal ?? t?.decimals ?? 0;
      const decimals = Number(decimalsRaw);
      const balanceRaw = String(t?.TokenQuantity ?? t?.tokenQuantity ?? t?.balance ?? t?.value ?? "0");
      const amount = parseUnitsToFloat(balanceRaw, decimals);
      if (amount == null || amount <= 0) return null;
      const price = toFiniteNumber(t?.TokenPriceUSD ?? t?.tokenPriceUSD ?? t?.token_price_usd ?? 0) || 0;
      const usd = price > 0 ? amount * price : null;
      const sortValue = usd != null ? usd : amount;

      return {
        target: `${symbol} (wallet holding)`,
        share: "—",
        tvlLabel:
          usd != null
            ? `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`,
        riskLevel: "unknown",
        evidence: ["Source: Etherscan addresstokenbalance (Ethereum)"],
        __sortValue: sortValue,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      return (b.__sortValue || 0) - (a.__sortValue || 0);
    })
    .map(({ __sortValue, ...rest }) => rest)
    .slice(0, 100);

  allocations.push(...tokenAllocations);

  return {
    allocations: allocations.slice(0, 100),
    evidence: allocations.length
      ? ["Source: Etherscan wallet token holdings (Ethereum)."]
      : ["Etherscan returned no wallet token holdings (Ethereum)."],
  };
}

async function getWalletProtocolsFromDebank({ walletAddress }) {
  const accessKey = process.env.DEBANK_ACCESS_KEY;
  if (!accessKey) {
    return {
      allocations: [],
      evidence: ["DEBANK_ACCESS_KEY not configured; skipping Debank wallet protocols."],
    };
  }

  const wallet = String(walletAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { allocations: [], evidence: ["Invalid wallet address format for Debank."] };
  }

  const endpoints = [
    `https://pro-openapi.debank.com/v1/user/all_simple_protocol_list?id=${encodeURIComponent(wallet)}`,
    `https://pro-openapi.debank.com/v1/user/simple_protocol_list?id=${encodeURIComponent(wallet)}`,
  ];

  let list = null;
  for (const endpoint of endpoints) {
    const resp = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        AccessKey: accessKey,
      },
    }).catch(() => null);
    if (!resp || !resp.ok) continue;
    const json = await resp.json().catch(() => null);
    if (Array.isArray(json)) {
      list = json;
      break;
    }
  }

  if (!Array.isArray(list)) {
    return {
      allocations: [],
      evidence: ["Debank protocol list unavailable for this wallet/API key."],
    };
  }

  const allocations = list
    .map((p) => {
      const name = p?.name || p?.id || "Protocol";
      const chain = p?.chain || p?.chain_id || null;
      const usd =
        Number.isFinite(Number(p?.net_usd_value))
          ? Number(p.net_usd_value)
          : Number.isFinite(Number(p?.usd_value))
            ? Number(p.usd_value)
            : null;
      return {
        target: name,
        share: "—",
        tvlLabel: usd != null ? `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—",
        riskLevel: "unknown",
        evidence: [
          "Source: Debank user protocol list",
          ...(chain ? [`Chain: ${chain}`] : []),
        ],
      };
    })
    .slice(0, 100);

  return {
    allocations,
    evidence: ["Source: Debank wallet protocol positions."],
  };
}

async function getWalletAllocationsFromCovalent({ walletAddress }) {
  const wallet = String(walletAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { allocations: [], evidence: ["Invalid wallet address format for Covalent."] };
  }

  // Covalent has a public/demo key for basic testing; override with your own key for production.
  const apiKey = process.env.COVALENT_API_KEY || "ckey_demo";
  const chains = [
    { name: "Ethereum", id: 1 },
    { name: "Base", id: 8453 },
    { name: "Arbitrum", id: 42161 },
    { name: "Optimism", id: 10 },
    { name: "Polygon", id: 137 },
    { name: "BSC", id: 56 },
  ];

  const allocations = [];
  const evidence = [];

  for (const chain of chains) {
    const url =
      `https://api.covalenthq.com/v1/${chain.id}/address/${encodeURIComponent(wallet)}` +
      `/balances_v2/?nft=false&no-nft-fetch=true&key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url).catch(() => null);
    if (!resp || !resp.ok) continue;
    const json = await resp.json().catch(() => null);
    const items = Array.isArray(json?.data?.items) ? json.data.items : [];
    if (!items.length) continue;

    items.forEach((item) => {
      const q = Number(item?.quote || 0);
      if (!Number.isFinite(q) || q <= 0) return;
      allocations.push({
        target: `${item.contract_ticker_symbol || item.contract_name || "Token"} (${chain.name})`,
        share: "—",
        tvlLabel: `$${q.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        riskLevel: "unknown",
        evidence: [
          "Source: Covalent balances_v2",
          `Chain: ${chain.name}`,
        ],
      });
    });
    evidence.push(`Covalent balances fetched for ${chain.name}.`);
  }

  // Keep the section concise.
  allocations.sort((a, b) => {
    const av = Number(String(a.tvlLabel || "").replace(/[$,]/g, "")) || 0;
    const bv = Number(String(b.tvlLabel || "").replace(/[$,]/g, "")) || 0;
    return bv - av;
  });

  return {
    allocations: allocations.slice(0, 100),
    evidence: evidence.length ? evidence : ["Covalent returned no balances for supported chains."],
  };
}

async function runWebsiteAnalysisWithGpt4All(url, htmlSnippet) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;

    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const prompt = `
You are a DeFi protocol analyst.

Your task is to analyze the given protocol WEBSITE HTML and extract on-chain and risk information
without fabricating details that are not clearly implied by the text.

INPUT:
- Protocol URL: ${url}
- Main page HTML (possibly truncated):
${htmlSnippet}

TASKS:
1. Extract any smart contract addresses you can find in the HTML (or clearly linked pages if they are included in the HTML text),
   and, if possible, infer their roles (e.g. core protocol, pool, token).
2. Infer rough TVL, investors, and daily activity ONLY if the HTML explicitly hints at them (do not guess from prior knowledge).
3. Produce a short qualitative risk summary across these dimensions: security, technical, financial, operational, documentation,
   community, investment/reputation. Base this ONLY on what you see in the HTML (or clearly linked text if present).

Return ONLY JSON in exactly this shape (no extra keys, no extra text):
{
  "protocol": {
    "url": string,
    "name": string | null
  },
  "contracts": [
    {
      "label": string,
      "network": string | null,
      "address": string
    }
  ],
  "tvl": {
    "valueUsd": number | null,
    "evidence": string[]
  },
  "investors": [
    {
      "name": string,
      "role": string | null,
      "evidence": string[]
    }
  ],
  "txsPerDay": {
    "value": number | null,
    "evidence": string[]
  },
  "risk": {
    "level": "low" | "medium" | "high" | "unknown",
    "summary": string
  }
}

IMPORTANT:
- If you cannot find a field from the HTML, set its value to null (for numbers/strings) or [] (for arrays) and mention that
  limitation in the evidence/summary. Do NOT invent contract addresses or TVL from prior knowledge.
`.trim();

    const safePrompt = clampPrompt(prompt, { maxTokens: 1500, maxChars: 6500 });
    if (estimateTokens(safePrompt) > 1700) {
      // Safety valve: never send oversized prompts into GPT4All.
      return null;
    }

    const completion = await createCompletion(model, safePrompt);
    const message = completion.choices?.[0]?.message;
    const text = typeof message === "string" ? message : message?.content ?? "";

    if (typeof model.dispose === "function") {
      model.dispose();
    }

    if (!text) {
      throw new Error("GPT4All returned empty response for website analysis.");
    }

    const parsed = parseLikelyJson(text);
    return parsed;
  } catch (err) {
    console.error("runWebsiteAnalysisWithGpt4All error:", err);
    return null;
  }
}

async function runJsonPromptWithGpt4All(prompt) {
  // Minimal wrapper for JSON-only tasks (audits/architecture) to avoid nesting a
  // large prompt inside the website-analysis template.
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;

    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";
    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const safePrompt = clampPrompt(prompt, { maxTokens: 1400, maxChars: 6000 });
    if (estimateTokens(safePrompt) > 1700) return null;

    const completion = await createCompletion(model, safePrompt);
    const message = completion.choices?.[0]?.message;
    const text = typeof message === "string" ? message : message?.content ?? "";

    if (typeof model.dispose === "function") model.dispose();
    if (!text) return null;
    return parseLikelyJson(text);
  } catch (err) {
    console.error("runJsonPromptWithGpt4All error:", err);
    return null;
  }
}

async function inferArchitectureWithGpt4All({ protocolName, origin, tokens, contracts, urlAnalysis, visibleText }) {
  const enable = String(process.env.ENABLE_WEBSITE_LLM || "1").toLowerCase() === "1";
  if (!enable) return null;

  const tokenLite = (Array.isArray(tokens) ? tokens : [])
    .slice(0, 200)
    .map((t) => ({
      name: t?.token || t?.asset || t?.symbol || null,
      address: t?.contractAddress || t?.tokenAddress || t?.address || null,
      liquidityUsd: typeof t?.liquidityUsd === "number" ? t.liquidityUsd : null,
      liquidityLabel: t?.liquidityLabel || null,
    }));

  const contractLite = (Array.isArray(contracts) ? contracts : [])
    .slice(0, 200)
    .map((c) => ({
      label: c?.label || null,
      network: c?.network || null,
      address: c?.address || null,
      evidence: c?.evidence || null,
    }));

  const textSnippet = String(visibleText || "").slice(0, 1800);
  const prompt = `
You are mapping a DeFi protocol on-chain architecture from provided facts only.
Do NOT browse the web. Do NOT invent addresses.

Protocol: ${protocolName || "unknown"}
Origin: ${origin}

URL analysis:
${JSON.stringify(urlAnalysis || {}, null, 2)}

Detected token contracts (may be incomplete):
${JSON.stringify(tokenLite, null, 2)}

Detected protocol-related contracts (may be incomplete):
${JSON.stringify(contractLite, null, 2)}

Visible text snippet (may help label roles like router/amm/vault/market):
${textSnippet}

Return JSON only:
{
  "nodes": [{"id": string, "label": string, "type": "token"|"router"|"amm"|"vault"|"pool"|"market"|"contract"|"unknown", "address": string|null}],
  "edges": [{"from": string, "to": string, "label": string}]
}
Use addresses only if present above. If unsure, type="unknown" and omit edges.
`.trim();

  const parsed = await runJsonPromptWithGpt4All(prompt).catch(() => null);
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
  return parsed;
}

function extractContractsFromHtml(html, opts = {}) {
  const results = [];
  const seen = new Set();
  const visibleText = htmlToVisibleText(html);
  const visibleLower = visibleText.toLowerCase();

  const visibleTextOnly = Boolean(opts.visibleTextOnly);

  const etherscanRegex =
    /https?:\/\/([a-z0-9-]*scan)\.io\/address\/(0x[a-fA-F0-9]{40})/g;
  let m;
  while ((m = etherscanRegex.exec(html)) !== null) {
    const host = m[1];
    const address = m[2];
    if (seen.has(address)) continue;
    seen.add(address);
    const network = mapScanHostToNetwork(host);
    const ctx = extractContextAround(html, m.index, 220);
    const inferred = inferContractLabelFromText(ctx.visibleText) || "Contract (explorer link)";
    results.push({
      label: inferred,
      network,
      address,
      evidence: ctx.visibleText ? ctx.visibleText.slice(0, 220) : undefined,
      source: "explorer_link",
    });
  }

  const bareAddressRegex = /0x[a-fA-F0-9]{40}/g;
  const addressSourceText = visibleTextOnly ? visibleText : html;
  while ((m = bareAddressRegex.exec(addressSourceText)) !== null) {
    const address = m[0];
    if (seen.has(address)) continue;
    seen.add(address);

    // Prefer context from visible text (less noisy than raw HTML).
    const idx = visibleLower.indexOf(address.toLowerCase());
    const snippet = idx >= 0 ? extractTextWindow(visibleText, idx, 240) : "";
    const inferred = inferContractLabelFromText(snippet) || "Contract (detected on page)";
    results.push({
      label: inferred,
      network: "Unknown",
      address,
      evidence: snippet || undefined,
      source: "visible_text",
    });
    if (results.length >= 10) break;
  }

  return results;
}

function extractTextWindow(text, index, windowSize) {
  const start = Math.max(0, index - Math.floor(windowSize / 2));
  const end = Math.min(text.length, index + Math.floor(windowSize / 2));
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractContextAround(html, index, windowSize) {
  const start = Math.max(0, index - Math.floor(windowSize / 2));
  const end = Math.min(html.length, index + Math.floor(windowSize / 2));
  const raw = html.slice(start, end);
  return { raw, visibleText: htmlToVisibleText(raw) };
}

function inferContractLabelFromText(context) {
  const t = String(context || "").toLowerCase();
  if (!t) return null;

  // Order matters: prefer more specific matches first.
  const rules = [
    ["router", "Router contract"],
    ["factory", "Factory contract"],
    ["vault", "Vault contract"],
    ["pool", "Pool contract"],
    ["market", "Market contract"],
    ["pair", "Pair contract"],
    ["staking", "Staking contract"],
    ["gauge", "Gauge contract"],
    ["oracle", "Oracle contract"],
    ["aggregator", "Aggregator contract"],
    ["bridge", "Bridge contract"],
    ["token", "Token contract"],
    ["erc20", "Token (ERC‑20) contract"],
    ["governance", "Governance contract"],
    ["treasury", "Treasury contract"],
    ["proxy", "Proxy contract"],
    ["implementation", "Implementation contract"],
    ["multisig", "Multisig contract"],
    ["timelock", "Timelock contract"],
    ["admin", "Admin contract"],
  ];

  for (const [needle, label] of rules) {
    if (t.includes(needle)) return label;
  }

  // If context mentions chain explorers, label generically.
  if (t.includes("etherscan") || t.includes("arbiscan") || t.includes("polygonscan")) {
    return "Contract address (explorer)";
  }

  return null;
}

function enrichContractsFromKnownSources({ enriched, origin }) {
  if (!enriched || typeof enriched !== "object") return;
  const existing = Array.isArray(enriched.contracts) ? enriched.contracts : [];
  const byAddr = new Map();
  for (const c of existing) {
    const a = String(c?.address || "").toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(a)) byAddr.set(a, c);
  }
  const add = ({ label, network, address, evidence }) => {
    const a = String(address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(a)) return;
    if (byAddr.has(a)) return;
    const row = {
      label: label || "Contract",
      network: network || inferNetworkFromUrl(origin) || "Unknown",
      address: address,
      evidence: evidence || undefined,
    };
    byAddr.set(a, row);
    existing.push(row);
  };

  // 1) Router fallback (protocol-specific known router map, easy to expand).
  const pname = String(enriched?.protocol?.name || "").toLowerCase();
  if (pname.includes("pendle")) {
    add({
      label: "Router contract",
      network: "Ethereum",
      address: "0x00000000005BBB0EF59571E58418F9a4357B68A0",
      evidence: "Known Pendle Router V3",
    });
  }

  // 2) Token contracts from token liquidity list (DefiLlama yields / extraction).
  const toks = Array.isArray(enriched?.tokenLiquidity) ? enriched.tokenLiquidity : [];
  for (const t of toks) {
    const addr = t?.tokenAddress || t?.contractAddress || t?.address || null;
    const sym = t?.token || t?.asset || t?.symbol || "Token";
    if (!addr) continue;
    add({
      label: `${sym} token contract`,
      network: inferNetworkFromUrl(origin) || "Unknown",
      address: addr,
      evidence: "Derived from token liquidity data",
    });
  }

  // 3) Pool/vault contracts from pools data.
  const pools = Array.isArray(enriched?.pools) ? enriched.pools : [];
  for (const p of pools) {
    const addr = p?.poolContract || p?.address || null;
    if (!addr) continue;
    add({
      label: "Pool/Vault contract",
      network: p?.network || inferNetworkFromUrl(origin) || "Unknown",
      address: addr,
      evidence: Array.isArray(p?.evidence) ? p.evidence[0] : "Derived from pools data",
    });
  }

  // 4) AI architecture nodes (router/vault/pool/market/token).
  const archNodes = Array.isArray(enriched?.protocol?.architecture?.nodes)
    ? enriched.protocol.architecture.nodes
    : [];
  for (const n of archNodes) {
    const addr = n?.address || null;
    if (!addr) continue;
    const t = String(n?.type || "contract").toLowerCase();
    const typeLabel =
      t === "router" ? "Router contract"
        : t === "vault" ? "Vault contract"
        : t === "pool" ? "Pool contract"
        : t === "market" ? "Market contract"
        : t === "token" ? "Token contract"
        : "Contract";
    add({
      label: n?.label ? `${n.label}` : typeLabel,
      network: inferNetworkFromUrl(origin) || "Unknown",
      address: addr,
      evidence: "Derived from AI architecture map",
    });
  }

  enriched.contracts = existing;
}

function mapScanHostToNetwork(host) {
  if (host === "etherscan") return "Ethereum";
  if (host === "arbiscan") return "Arbitrum";
  if (host === "polygonscan") return "Polygon";
  if (host === "bscscan") return "BNB Chain";
  if (host === "optimistic" || host === "optimism") return "Optimism";
  if (host === "basescan") return "Base";
  return "Unknown";
}

// In Vercel Serverless Functions we shouldn't bind to a port.
// When running locally (or outside Vercel), start the HTTP server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(
      "Enabled routes: GET /api/health, GET /api/analyze, POST /api/llm-analyze, GET /api/risk-schema, POST /api/risk-assessment"
    );
  });
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    // Prefer https for public sites (prevents mixed-content issues and avoids some DNS/proxy oddities on http).
    const host = u.hostname.toLowerCase();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost");
    if (!isLocal && u.protocol === "http:") {
      u.protocol = "https:";
    }
    return u.origin;
  } catch {
    return rawUrl.trim();
  }
}

async function getDefiLlamaTvl(origin) {
  console.log("[DefiLlama] Fetching TVL for origin:", origin);

  const protocolSlug = "uniswap";

  const url = `https://api.llama.fi/tvl/${protocolSlug}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`DefiLlama TVL request failed with status ${resp.status}`);
  }

  const data = await resp.json();

  return {
    usd: typeof data === "number" ? data : data?.tvl ?? null,
    source: "defillama",
    raw: data,
  };
}

async function getDefiLlamaProtocolByUrl(origin) {
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

  if (!match) return null;

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

async function getCryptoRankInvestors(protocolName) {
  const CRYPTORANK_API_KEY = process.env.CRYPTORANK_API_KEY;
  if (!CRYPTORANK_API_KEY) {
    return {
      investors: [],
      evidence: ["CryptoRank API key not configured (set CRYPTORANK_API_KEY)."],
    };
  }

  if (!protocolName) {
    return { investors: [], evidence: ["No protocol name available to query CryptoRank."] };
  }

  // 1) Search currency/project by name
  const searchUrl =
    "https://api.cryptorank.io/v2/currencies/search?query=" + encodeURIComponent(protocolName);
  const searchResp = await fetch(searchUrl, {
    headers: { "X-Api-Key": CRYPTORANK_API_KEY },
  });
  if (!searchResp.ok) throw new Error(`CryptoRank search failed: ${searchResp.status}`);
  const searchJson = await searchResp.json();

  const first = Array.isArray(searchJson?.data) ? searchJson.data[0] : null;
  const id = first?.id;
  if (!id) {
    return {
      investors: [],
      evidence: [`CryptoRank search returned no project for "${protocolName}".`],
    };
  }

  // 2) Funding rounds by currency id
  const roundsUrl = `https://api.cryptorank.io/v2/currencies/${id}/funding-rounds`;
  const roundsResp = await fetch(roundsUrl, {
    headers: { "X-Api-Key": CRYPTORANK_API_KEY },
  });
  if (!roundsResp.ok) throw new Error(`CryptoRank funding rounds failed: ${roundsResp.status}`);
  const roundsJson = await roundsResp.json();

  const rounds = Array.isArray(roundsJson?.data) ? roundsJson.data : [];
  const investorNames = new Set();

  for (const r of rounds) {
    const investors = Array.isArray(r?.investors) ? r.investors : [];
    for (const inv of investors) {
      if (typeof inv?.name === "string" && inv.name.trim()) investorNames.add(inv.name.trim());
    }
  }

  return {
    investors: Array.from(investorNames).slice(0, 25),
    evidence: [
      `CryptoRank API funding rounds for "${first?.name || protocolName}" (id=${id})`,
      "Source: https://cryptorank.io/",
    ],
  };
}

async function getEtherscanContracts(origin) {
  console.log("[Contracts] Discovering contracts for origin:", origin);

  const url = new URL(origin);
  const host = url.hostname;

  // 1) Optional override via local mapping file (you can curate this yourself).
  try {
    const contractsPath = path.join(__dirname, "protocol_contracts.json");
    if (fs.existsSync(contractsPath)) {
      const raw = fs.readFileSync(contractsPath, "utf8");
      const mapping = JSON.parse(raw);
      const match = mapping[host] || mapping[origin];
      if (Array.isArray(match) && match.length > 0) {
        console.log("[Contracts] Using local protocol_contracts.json mapping for", host);
        return match;
      }
    }
  } catch (e) {
    console.warn("[Contracts] Failed to read protocol_contracts.json:", e.message);
  }

  // 2) Automatic discovery from the protocol website HTML.
  try {
    const resp = await fetch(origin, {
      headers: {
        "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)",
      },
    });

    if (!resp.ok) {
      console.warn("[Contracts] Failed to fetch HTML:", resp.status);
    } else {
      const html = await resp.text();
      const discovered = extractContractsFromHtml(html);
      if (discovered.length > 0) {
        console.log(
          `[Contracts] Discovered ${discovered.length} contract address(es) directly from HTML.`
        );
        return discovered;
      }
    }
  } catch (e) {
    console.warn("[Contracts] Error while fetching/parsing HTML:", e.message);
  }

  console.warn(
    "[Contracts] No contracts discovered automatically. Consider adding protocol_contracts.json overrides."
  );
  return [];
}

async function getTransactionsPerDay(origin) {
  console.log("[Txs] Fetching txs/day for origin:", origin);

  // TODO: plug in your analytics/indexer here (Covalent, Alchemy, Dune, custom indexer, etc.).
  // For now, return null so the frontend shows 'No tx data yet.' instead of crashing.
  return null;
}

async function getDefiLlamaVolume24h(slug) {
  if (!slug) return null;

  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const resp = await fetch(protoUrl, {
    headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
  });
  if (!resp.ok) throw new Error(`DefiLlama protocol page failed: ${resp.status}`);
  const html = await resp.text();
  const text = htmlToVisibleText(html);

  function parseCompactMoney(raw, suffix) {
    let v = parseFloat(String(raw || "").replace(/,/g, ""));
    if (!isFinite(v)) return null;
    const s = String(suffix || "").toLowerCase();
    if (s === "k") v *= 1e3;
    else if (s === "m") v *= 1e6;
    else if (s === "b") v *= 1e9;
    return v;
  }

  const dexRe = /DEX\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const tokenRe = /\$([A-Z][A-Z0-9]{1,12})\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/gi;
  let match;
  const values = [];
  while ((match = tokenRe.exec(text)) !== null) {
    const v = parseCompactMoney(match[2], match[3]);
    if (v == null) continue;
    values.push({ symbol: match[1], value: v });
  }

  // Prefer native token volume first.
  if (values.length) {
    const chosen = values[0];
    return {
      value: chosen.value,
      evidence: [`$${chosen.symbol} Volume 24h (native token, DefiLlama protocol page)`, protoUrl],
      raw: { chosen, source: "native_token_volume_24h" },
    };
  }

  // Fallback: DEX Volume 24h row.
  const dexM = dexRe.exec(text);
  if (!dexM) return { value: null, evidence: ["No 24h volume found on protocol page."], raw: null };

  const v = parseCompactMoney(dexM[1], dexM[2]);
  if (v == null) return { value: null, evidence: ["24h volume parse failed."], raw: null };

  return {
    value: v,
    evidence: ["DEX Volume 24h (DefiLlama protocol page)", protoUrl],
    raw: { matched: dexM[0], source: "dex_volume_24h" },
  };
}

async function getDefiLlamaTotalRaisedUsd(slug) {
  if (!slug) return null;
  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const resp = await fetch(protoUrl, {
    headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
  });
  if (!resp.ok) throw new Error(`DefiLlama totalRaised request failed: ${resp.status}`);
  const html = await resp.text();
  const text = htmlToVisibleText(html);

  // Example: "Total Raised$3.7m"
  const re = /Total Raised\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const m = re.exec(text);
  if (!m) return { value: null, evidence: ["Total raised not found on DefiLlama protocol page."], raw: text.slice(0, 2000) };

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

async function getInvestorsStub(origin) {
  console.log("[Investors] Returning stubbed investors for origin:", origin);

  return [
    { name: "Placeholder Capital", stake: "3.5%" },
    { name: "Demo Ventures", stake: "2.1%" },
    { name: "Sample Labs", stake: "1.2%" },
  ];
}

