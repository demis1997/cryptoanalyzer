import { runHostedLlmJson } from "../llm/provider.js";

function parseTimeoutEnv(name, minMs, fallbackMs) {
  const n = parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= minMs ? n : fallbackMs;
}

/** Cloud Agents graph steps send large prompts; allow a longer poll than auditors. */
function hostedHeavyStepPollMs() {
  return parseTimeoutEnv("CURSOR_CLOUD_AGENTS_HEAVY_STEP_TIMEOUT_MS", 60_000, 600_000);
}

function okAddr(a) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(a || "").trim());
}

function slugKey(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "unknown";
}

/** Stable subject node id for ecosystem graph (must match DefiLlama augmentation + LLM prompt). */
export function subjectProtocolNodeId(defillamaSlug, protocolName) {
  return `protocol:${slugKey(defillamaSlug || protocolName || "unknown")}`;
}

function summarizeDefillamaForLlm(api) {
  if (!api || typeof api !== "object") return "none";
  try {
    return JSON.stringify({
      apiUrl: api.apiUrl,
      name: api.name,
      category: api.category,
      chains: Array.isArray(api.chains) ? api.chains.slice(0, 18) : [],
      tokenSymbol: api.tokenSymbol,
      tokenAddress: api.tokenAddress,
      parentProtocol: api.parentProtocol,
      auditLinks: Array.isArray(api.auditLinks) ? api.auditLinks.slice(0, 20) : [],
      github: api.github || null,
      geckoId: api.gecko_id || api.geckoId || null,
      oracles: Array.isArray(api.oracles) ? api.oracles.slice(0, 10) : [],
      description: api.description ? String(api.description).slice(0, 1400) : null,
      methodology: api.methodology ? String(api.methodology).slice(0, 2200) : null,
    });
  } catch {
    return "none";
  }
}

/**
 * Deterministic edges from DefiLlama REST detail: governance token, parentProtocol, oracles.
 */
export function graphAugmentationFromDefillamaApi({ defillamaApi, subjectProtocolId, subjectDisplayName }) {
  if (!defillamaApi || !subjectProtocolId) return { nodes: [], edges: [], evidence: [] };
  const apiUrl = defillamaApi.apiUrl || "";
  const nodes = [];
  const edges = [];
  const evBase = [`DefiLlama REST: ${apiUrl || "api.llama.fi/protocol/{slug}"}`];

  nodes.push({
    id: subjectProtocolId,
    kind: "protocol",
    label: String(subjectDisplayName || defillamaApi.name || subjectProtocolId).slice(0, 120),
    network: "Multi-chain",
  });

  if (defillamaApi.tokenAddress && okAddr(defillamaApi.tokenAddress)) {
    const a = String(defillamaApi.tokenAddress).toLowerCase();
    nodes.push({
      id: a,
      kind: "token",
      label: String(defillamaApi.tokenSymbol || "Protocol token").slice(0, 80),
      symbol: defillamaApi.tokenSymbol || null,
      address: a,
      network: "Ethereum",
    });
    edges.push({
      from: subjectProtocolId,
      to: a,
      relation: "governance_token_field_defillama",
      evidence: [`Listed token address on DefiLlama protocol JSON ("address" field)`, apiUrl],
    });
  }

  const pp = defillamaApi.parentProtocol;
  if (pp && (pp.slug || pp.name)) {
    const slugPart = pp.slug || pp.name;
    const pid = `protocol:${slugKey(slugPart)}`;
    nodes.push({
      id: pid,
      kind: "protocol",
      label: String(pp.name || pp.slug || slugPart).slice(0, 120),
      network: "Multi-chain",
    });
    edges.push({
      from: subjectProtocolId,
      to: pid,
      relation: "parent_or_fork_defillama",
      evidence: [`DefiLlama protocol JSON "parentProtocol"`, apiUrl],
    });
  }

  for (const oracle of (defillamaApi.oracles || []).slice(0, 6)) {
    if (!oracle) continue;
    const oid = `protocol:oracle_${slugKey(oracle)}`;
    nodes.push({
      id: oid,
      kind: "protocol",
      label: `Oracle: ${String(oracle).slice(0, 60)}`,
      network: "Multi-chain",
    });
    edges.push({
      from: subjectProtocolId,
      to: oid,
      relation: "price_oracle_defillama",
      evidence: [`DefiLlama protocol JSON "oraclesBreakdown"`, apiUrl],
    });
  }

  return { nodes, edges, evidence: evBase };
}

/** Merge RPC + LLM connection graphs; nodes keyed by `id` or lowercase address. */
export function mergeConnectionGraphs(base, extra) {
  const a = base && typeof base === "object" ? base : { nodes: [], edges: [], evidence: [] };
  const b = extra && typeof extra === "object" ? extra : { nodes: [], edges: [], evidence: [] };
  const nodeMap = new Map();

  const nodeKey = (n) => String(n?.id || n?.address || "").toLowerCase();
  const ingestNode = (n) => {
    if (!n || typeof n !== "object") return;
    const k = nodeKey(n);
    if (!k) return;
    const prev = nodeMap.get(k);
    const merged = {
      ...prev,
      ...n,
      id: String(n.id || n.address || k).toLowerCase(),
      label: String(n.label || prev?.label || k).slice(0, 120),
    };
    if (!merged.address && okAddr(merged.id)) merged.address = merged.id;
    nodeMap.set(k, merged);
  };

  for (const n of [...(a.nodes || []), ...(b.nodes || [])]) ingestNode(n);

  const edgesOut = [];
  const seenE = new Set();
  for (const e of [...(a.edges || []), ...(b.edges || [])]) {
    if (!e || typeof e !== "object") continue;
    const f = String(e.from || "").toLowerCase();
    const t = String(e.to || "").toLowerCase();
    const rel = String(e.relation || "connected").slice(0, 64);
    if (!f || !t || !nodeMap.has(f) || !nodeMap.has(t)) continue;
    const ek = `${f}|${t}|${rel.toLowerCase()}`;
    if (seenE.has(ek)) continue;
    seenE.add(ek);
    edgesOut.push({
      from: f,
      to: t,
      relation: rel,
      evidence: Array.isArray(e.evidence) ? e.evidence : [],
    });
  }

  const ev = Array.from(
    new Set([...(Array.isArray(a.evidence) ? a.evidence : []), ...(Array.isArray(b.evidence) ? b.evidence : [])])
  ).slice(0, 24);

  return { nodes: Array.from(nodeMap.values()), edges: edgesOut, evidence: ev };
}

function normalizeEcosystemNodes(raw) {
  const out = [];
  const seen = new Set();
  for (const n of Array.isArray(raw) ? raw : []) {
    if (!n || typeof n !== "object") continue;
    const kindIn = String(n.kind || "").toLowerCase();
    const addrRaw = String(n.address || "").trim();
    const addr = okAddr(addrRaw) ? addrRaw.toLowerCase() : null;
    const name = String(n.name || n.protocol || "").trim();
    let id = String(n.id || "").trim().toLowerCase();

    const isProtocol =
      kindIn === "protocol" || (!addr && Boolean(name)) || (id && id.startsWith("protocol:"));

    if (isProtocol) {
      const pname = name || id.replace(/^protocol:/, "") || String(n.label || "").trim();
      if (!pname) continue;
      id = `protocol:${slugKey(pname)}`;
    } else if (addr) {
      id = addr.toLowerCase();
    } else if (id && id.startsWith("token:")) {
      const maybe = id.replace(/^token:/, "");
      if (okAddr(maybe)) id = maybe.toLowerCase();
      else continue;
    } else if (okAddr(id)) {
      id = id.toLowerCase();
    } else {
      continue;
    }

    if (seen.has(id)) continue;
    seen.add(id);
    const label = String(n.label || n.name || n.symbol || id).slice(0, 100);
    const kind = isProtocol ? "protocol" : kindIn === "contract" ? "contract" : "token";
    const row = {
      id,
      kind,
      label,
      network: n.network || "Ethereum",
    };
    if (addr) row.address = addr;
    if (n.symbol) row.symbol = String(n.symbol).slice(0, 24);
    out.push(row);
  }
  return out;
}

function normalizeEcosystemEdges(raw, nodeIds) {
  const ids = new Set(nodeIds);
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== "object") continue;
    let f = String(e.from || "").trim().toLowerCase();
    let t = String(e.to || "").trim().toLowerCase();
    if (f.startsWith("token:") && okAddr(f.slice(6))) f = f.slice(6);
    if (t.startsWith("token:") && okAddr(t.slice(6))) t = t.slice(6);
    const rel = String(e.relation || "associated").slice(0, 64);
    if (!f || !t || !ids.has(f) || !ids.has(t)) continue;
    const k = `${f}|${t}|${rel.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ev = e.evidence ? (Array.isArray(e.evidence) ? e.evidence : [String(e.evidence)]) : ["cursor_llm"];
    out.push({ from: f, to: t, relation: rel, evidence: ev.map((x) => String(x).slice(0, 200)) });
  }
  return out;
}

function dedupeAuditors(auditors) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(auditors) ? auditors : []) {
    const name = String(a?.name || a || "").trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: name.slice(0, 80) });
  }
  return out;
}

export async function extractAuditorsWithHostedLlm({ protocolName, origin, docs, defillamaApi = null } = {}) {
  const system = `You are extracting auditor firm names for a DeFi protocol from a provided research pack.
You cannot browse the web. Only use the provided snippets / structured fields.
Return JSON only.`;
  const user = `
Return JSON only:
{ "auditors": [ { "name": string } ] }

Protocol: ${protocolName || "unknown"}
Origin: ${origin || ""}

DefiLlamaApiSummary (may include auditLinks; treat as a hint, not authoritative):
${summarizeDefillamaForLlm(defillamaApi)}

Rules:
- Prefer auditors explicitly mentioned in docs/security/audits sections.
- If an item is only a link with no firm name, you may infer the firm name ONLY when the firm is obvious from the URL host/path (e.g. "trailofbits", "openzeppelin", "quantstamp").
- Do not include generic words like "audit", "report", "security review" as auditor names.
- Output unique firms; max 12.

Lines:
${(docs?.lines || []).map((l, i) => `${i + 1}. ${l}`).join("\n")}
`.trim();
  const r = await runHostedLlmJson({ step: "auditors", system, user });
  const auditors = dedupeAuditors(r?.json?.auditors || []);
  return {
    auditors,
    evidence: ["cursor_llm", ...(docs?.evidence || [])],
    llmRoute: { usedComposerFallback: Boolean(r?.meta?.usedComposerFallback) },
  };
}

/**
 * Ecosystem graph: subject protocol ↔ tokens/markets/integrations ↔ upstream issuers or peer protocols (multi-hop).
 * Nodes may be protocols (id protocol:slug) or on-chain tokens/contracts (id = 0x address lowercase).
 */
export async function inferContractGraphWithHostedLlm({
  protocolName,
  origin,
  docs,
  knownTokens,
  knownContracts,
  subjectDefillamaSlug = null,
  defillamaApi = null,
  research = null,
} = {}) {
  const subjectName = String(protocolName || "unknown").trim();
  const subjectId = subjectProtocolNodeId(subjectDefillamaSlug, subjectName);

  const system = `You are doing protocol research from a provided research pack, then converting it into a small ecosystem graph.
You cannot browse the web. Only use the provided research pack fields.

Goal:
- Identify the subject protocol's main integrated assets/tokens and the upstream issuer protocols behind those assets (multi-hop).
- Prefer: subject → token/asset → issuer protocol (e.g. Pendle → stETH → Lido).

Hard constraints:
- Return JSON only (no markdown).
- Never invent Ethereum addresses: token/contract nodes MUST use 0x addresses that appear in KnownTokens, KnownContracts, or DocsAddressContexts.
- Protocol entities have no address: use id "protocol:slug" where slug is short and stable (lido, pendle, aave_v3).
- Every edge must include a short evidence string grounded in the provided pack. If you use general DeFi knowledge for a widely-known derivative (e.g. stETH ↔ Lido), explicitly label the evidence as "common DeFi knowledge" and keep it to canonical, low-risk associations.

When adding protocol nodes:
- Add issuer/parent/oracle protocols if DefiLlamaApiSummary or docs strongly suggest it.
- Do not add speculative "works with 40 protocols" style claims; only add concrete protocol nodes you can justify.`;

  const user = `
Return JSON only:
{
  "nodes":[
    {"kind":"protocol","id":"protocol:pendle","name":"Pendle","label":"Pendle"},
    {"kind":"token","id":"0xabc...","address":"0xabc...","symbol":"stETH","label":"Lido stETH"},
    {"kind":"protocol","id":"protocol:lido","name":"Lido","label":"Lido"}
  ],
  "edges":[
    {"from":"${subjectId}","to":"0x...","relation":"markets|lists_asset|uses_collateral|integrates|liquidity_for","evidence":"quote snippet"},
    {"from":"0x...","to":"protocol:lido","relation":"issued_by|staking_derivative|wrapped_by|native_to","evidence":"quote snippet"}
  ]
}

Rules:
- Include the subject protocol node id "${subjectId}" and connect it to tokens/assets it clearly supports, integrates, or lists.
- For each major asset token, if docs say it is issued by / wrapped by / staked with another protocol, add that issuer protocol node and an edge token -> issuer protocol.
- If a token (e.g. USDT) has no issuer protocol stated in the provided text, connect "${subjectId}" -> token and STOP (no invented downstream protocol).
- "relation" must be short snake_case or single tokens from: markets, lists_asset, integrates, liquidity_for, issued_by, staking_derivative, wrapped_by, bridge_partner, routes_through, pairs_with, unknown_link.
- Maximum 40 nodes and 60 edges; prioritize assets in KnownTokens first.

Subject:
- name: ${subjectName}
- origin: ${origin || ""}
- defillama_slug_hint: ${subjectDefillamaSlug || "none"}

Metrics (context only; do not fabricate numbers):
${research && typeof research === "object" ? JSON.stringify(research).slice(0, 1200) : "none"}

DefiLlamaApiSummary (structured facts; cross-check with docs — still no fabricated 0x):
${summarizeDefillamaForLlm(defillamaApi)}

KnownTokens (addresses are authoritative):
${(Array.isArray(knownTokens) ? knownTokens : [])
  .slice(0, 120)
  .map((t) => `- ${(t?.token || t?.symbol || "?")} ${(t?.tokenAddress || t?.address || "").toLowerCase()}`.trim())
  .join("\n")}

KnownContracts:
${(Array.isArray(knownContracts) ? knownContracts : [])
  .slice(0, 150)
  .map((c) => `- ${(c?.label || "Contract")}: ${String(c?.address || "").toLowerCase()}`.trim())
  .join("\n")}

DocsAddressContexts:
${(docs?.addressContexts || []).slice(0, 45).map((x, i) => `${i + 1}. ${x.address} :: ${x.context}`).join("\n")}

Lines:
${(docs?.lines || []).slice(0, 80).map((l, i) => `${i + 1}. ${l}`).join("\n")}
`.trim();

  const r = await runHostedLlmJson({ step: "contractGraph", system, user, timeoutMs: hostedHeavyStepPollMs() });
  const rawNodes = r?.json?.nodes || [];
  let nodes = normalizeEcosystemNodes(rawNodes);

  // Ensure subject protocol appears if missing
  if (!nodes.some((n) => n.id === subjectId)) {
    nodes = [
      { id: subjectId, kind: "protocol", label: subjectName, network: "Ethereum" },
      ...nodes,
    ];
  }

  const nodeIds = nodes.map((n) => n.id);
  const edges = normalizeEcosystemEdges(r?.json?.edges || [], nodeIds);

  return {
    nodes,
    edges,
    evidence: ["cursor_llm_ecosystem", ...(docs?.evidence || [])],
    llmRoute: { usedComposerFallback: Boolean(r?.meta?.usedComposerFallback) },
  };
}

export async function inferArchitectureWithHostedLlm({ protocolName, origin, docs, knownTokens, knownContracts } = {}) {
  const system = `You summarize on-chain routing structure (routers, pools). Return JSON only. Do not repeat the full token/ecosystem graph—focus on vault/router topology with valid 0x addresses only.`;
  const user = `
Return JSON only:
{
  "nodes":[{"address":"0x...","label":"string","type":"router|amm|vault|pool|market|token|staking|contract"}],
  "edges":[{"from":"0x...","to":"0x...","relation":"routes_to|deposits_into|wraps|stakes|connected"}],
  "routerAddress":"0x..." 
}
Use routerAddress only if clearly stated.

Protocol: ${protocolName || "unknown"}
Origin: ${origin || ""}

KnownTokens:
${(Array.isArray(knownTokens) ? knownTokens : [])
  .slice(0, 50)
  .map((t) => `- ${(t?.token || t?.symbol || "Token")} ${(t?.tokenAddress || t?.address || "")}`.trim())
  .join("\n")}

KnownContracts:
${(Array.isArray(knownContracts) ? knownContracts : [])
  .slice(0, 80)
  .map((c) => `- ${(c?.label || "Contract")}: ${c?.address || ""}`.trim())
  .join("\n")}

DocsAddressContexts:
${(docs?.addressContexts || []).slice(0, 18).map((x, i) => `${i + 1}. ${x.address} :: ${x.context}`).join("\n")}

Lines:
${(docs?.lines || []).slice(0, 18).map((l, i) => `${i + 1}. ${l}`).join("\n")}
`.trim();
  const r = await runHostedLlmJson({ step: "architecture", system, user, timeoutMs: hostedHeavyStepPollMs() });

  const addrNodes = [];
  const seen = new Set();
  for (const n of Array.isArray(r?.json?.nodes) ? r.json.nodes : []) {
    const a = String(n?.address || "").trim();
    if (!okAddr(a)) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    addrNodes.push({
      id: k,
      kind: "contract",
      address: a,
      label: String(n?.label || "Contract").slice(0, 80),
      type: String(n?.type || "contract").toLowerCase(),
      network: "Ethereum",
    });
  }

  const edges = [];
  const seenE = new Set();
  for (const e of Array.isArray(r?.json?.edges) ? r.json.edges : []) {
    const f = String(e?.from || "").trim().toLowerCase();
    const t = String(e?.to || "").trim().toLowerCase();
    if (!okAddr(f) || !okAddr(t)) continue;
    const rel = String(e?.relation || "connected").slice(0, 48);
    const k = `${f}-${t}-${rel}`;
    if (seenE.has(k)) continue;
    seenE.add(k);
    edges.push({ from: f, to: t, relation: rel, evidence: ["cursor_llm"] });
  }

  const routerAddress = okAddr(r?.json?.routerAddress) ? String(r.json.routerAddress).trim() : null;
  return {
    architecture: { nodes: addrNodes, edges, routerAddress },
    evidence: ["cursor_llm", ...(docs?.evidence || [])],
    llmRoute: { usedComposerFallback: Boolean(r?.meta?.usedComposerFallback) },
  };
}
