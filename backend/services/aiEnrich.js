import { createLlmProvider } from "../llm/provider.js";

function okAddr(a) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(a || "").trim());
}

function dedupeByAddress(nodes) {
  const out = [];
  const seen = new Set();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const a = String(n?.address || "").trim();
    if (!okAddr(a)) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      address: a,
      label: String(n?.label || "Contract").slice(0, 80),
      type: String(n?.type || "contract").toLowerCase(),
      network: "Ethereum",
    });
  }
  return out;
}

function dedupeEdges(edges) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(edges) ? edges : []) {
    const f = String(e?.from || "").trim();
    const t = String(e?.to || "").trim();
    if (!okAddr(f) || !okAddr(t)) continue;
    const rel = String(e?.relation || "connected").slice(0, 48);
    const k = `${f.toLowerCase()}-${t.toLowerCase()}-${rel.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ from: f, to: t, relation: rel, evidence: ["cursor_llm"] });
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

export async function extractAuditorsWithHostedLlm({ protocolName, origin, docs } = {}) {
  const provider = await createLlmProvider();
  const system = `You extract auditor firm names from protocol documentation snippets. Return JSON only.`;
  const user = `
Return JSON only:
{ "auditors": [ { "name": string } ] }

Protocol: ${protocolName || "unknown"}
Origin: ${origin || ""}

Lines:
${(docs?.lines || []).map((l, i) => `${i + 1}. ${l}`).join("\n")}
`.trim();
  const r = await provider.runJson({ system, user });
  const auditors = dedupeAuditors(r?.json?.auditors || []);
  return { auditors, evidence: ["cursor_llm", ...(docs?.evidence || [])] };
}

export async function inferContractGraphWithHostedLlm({ protocolName, origin, docs, knownTokens, knownContracts } = {}) {
  const provider = await createLlmProvider();
  const system =
    `You infer an Ethereum contract connection graph from snippets. Output JSON only; only include valid addresses.`;
  const user = `
Return JSON only:
{
  "nodes":[{"address":"0x...","label":"string","type":"token|vault|router|protocol_router|pool|market|staking|contract"}],
  "edges":[{"from":"0x...","to":"0x...","relation":"underlying_token|token_protocol_router|token_pool|token_staking|connected"}]
}

Protocol: ${protocolName || "unknown"}
Origin: ${origin || ""}

KnownTokens:
${(Array.isArray(knownTokens) ? knownTokens : [])
  .slice(0, 80)
  .map((t) => `- ${(t?.token || t?.symbol || "Token")} ${(t?.tokenAddress || t?.address || "")}`.trim())
  .join("\n")}

KnownContracts:
${(Array.isArray(knownContracts) ? knownContracts : [])
  .slice(0, 120)
  .map((c) => `- ${(c?.label || "Contract")}: ${c?.address || ""}`.trim())
  .join("\n")}

DocsAddressContexts:
${(docs?.addressContexts || []).slice(0, 25).map((x, i) => `${i + 1}. ${x.address} :: ${x.context}`).join("\n")}

Lines:
${(docs?.lines || []).slice(0, 25).map((l, i) => `${i + 1}. ${l}`).join("\n")}
`.trim();
  const r = await provider.runJson({ system, user });
  const nodes = dedupeByAddress(r?.json?.nodes || []);
  const edges = dedupeEdges(r?.json?.edges || []);
  return { nodes, edges, evidence: ["cursor_llm", ...(docs?.evidence || [])] };
}

export async function inferArchitectureWithHostedLlm({ protocolName, origin, docs, knownTokens, knownContracts } = {}) {
  const provider = await createLlmProvider();
  const system = `You infer high-level protocol architecture. Return JSON only.`;
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
  const r = await provider.runJson({ system, user });
  const nodes = dedupeByAddress(r?.json?.nodes || []);
  const edges = dedupeEdges((r?.json?.edges || []).map((e) => ({ ...e, relation: e.relation || "connected" })));
  const routerAddress = okAddr(r?.json?.routerAddress) ? String(r.json.routerAddress).trim() : null;
  return { architecture: { nodes, edges, routerAddress }, evidence: ["cursor_llm", ...(docs?.evidence || [])] };
}

