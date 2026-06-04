/**
 * Structured activity log for pool / protocol intelligence runs (UI "thinking" panel).
 */

function truncate(s, max = 1200) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}… [${t.length - max} more chars]`;
}

export function createIntelligenceTrace({ kind = "unknown", query = "", label = "" } = {}) {
  const id = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const entries = [];
  const startedAt = new Date().toISOString();

  const trace = {
    id,
    kind: String(kind || "unknown"),
    query: String(query || ""),
    label: String(label || query || ""),
    startedAt,
    endedAt: null,
    entries,
    push(entry) {
      entries.push({
        ts: new Date().toISOString(),
        phase: entry.phase || "step",
        kind: entry.kind || "info",
        title: String(entry.title || ""),
        detail: entry.detail != null ? String(entry.detail) : "",
        sources: Array.isArray(entry.sources) ? entry.sources : [],
        llm: entry.llm && typeof entry.llm === "object" ? entry.llm : null,
      });
    },
    step(title, opts = {}) {
      trace.push({
        phase: opts.phase || "step",
        kind: opts.kind || "info",
        title,
        detail: opts.detail || "",
        sources: opts.sources || [],
        llm: opts.llm || null,
      });
    },
    llmRequest(step, { system, user, provider } = {}) {
      trace.push({
        phase: "llm_request",
        kind: "llm",
        title: `LLM request: ${step}`,
        detail: truncate(user, 2000),
        llm: {
          step,
          provider: provider || null,
          systemPreview: truncate(system, 400),
        },
      });
    },
    llmResponse(step, { json, rawText, meta, error } = {}) {
      const preview = error
        ? String(error)
        : json != null
          ? truncate(JSON.stringify(json), 1500)
          : truncate(rawText, 1500);
      trace.push({
        phase: error ? "llm_error" : "llm_response",
        kind: error ? "error" : "llm",
        title: error ? `LLM failed: ${step}` : `LLM response: ${step}`,
        detail: preview,
        llm: {
          step,
          meta: meta || null,
          keys: json && typeof json === "object" ? Object.keys(json).slice(0, 12) : null,
        },
      });
    },
    finish() {
      trace.endedAt = new Date().toISOString();
    },
    toJSON() {
      return {
        id: trace.id,
        kind: trace.kind,
        query: trace.query,
        label: trace.label,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt || new Date().toISOString(),
        entries: trace.entries,
      };
    },
  };

  return trace;
}

/** Rebuild chat entries from a completed pool intelligence payload (fallback). */
export function traceFromPoolIntel(data) {
  const trace = createIntelligenceTrace({
    kind: "pool",
    query: data?.label || data?.poolRef || "",
    label: data?.label || "Pool",
  });
  trace.step("Pool intelligence complete", { kind: "success", phase: "done" });
  if (data?.source) {
    trace.step("Discovery source", { detail: String(data.source) });
  }
  const primary = data?.risk?.pool?.primaryPool;
  if (primary) {
    trace.step("Scored pool (DefiLlama)", {
      detail: `${primary.project || ""} · ${primary.symbol || ""} · TVL $${primary.tvlUsd ? Math.round(primary.tvlUsd).toLocaleString() : "—"}`,
      sources: [{ label: "DefiLlama yields", url: primary.project ? `https://defillama.com/protocol/${primary.project}` : null }],
    });
  }
  const wr = data?.webResearch;
  if (wr?.enabled) {
    const providers = (wr.providers || []).join(" + ") || "web";
    const pages = wr.crawl?.pages?.length || 0;
    trace.step("Web research", {
      detail: `${providers}${pages ? ` · ${pages} page(s) crawled` : ""}`,
      kind: "source",
      sources: (wr.searches || []).slice(0, 6).map((s) => ({
        label: s.query || s.provider || "search",
        url: s.hits?.[0]?.url || null,
      })),
    });
  }
  for (const n of (data?.sourceNotes || []).slice(0, 14)) {
    trace.step(n.label || n.source || "Data source", {
      kind: "source",
      detail: n.detail || "",
      sources: [{ label: n.label || n.source, url: n.url || null }],
    });
  }
  if (data?.risk?.pool) {
    trace.step("Pool risk score computed", {
      detail: `${data.risk.pool.poolScore ?? "—"}/100 · ${data.risk.pool.poolType || "pool"}`,
      kind: "success",
    });
    for (const c of data.risk.pool.criteria || []) {
      if (c.confidenceReason) {
        trace.step(`${c.id} ${c.name}`, {
          detail: `Score ${c.na ? "N/A" : c.score != null ? Math.round(c.score * 100) : "—"} · confidence ${c.confidence || "—"} — ${c.confidenceReason}`,
          kind: "info",
          sources: (c.sources || []).map((s) => ({ label: s.label, url: s.url })),
        });
      }
    }
  }
  const integrators = (data?.integrators || []).filter((p) => p.tier === "integrator");
  if (integrators.length) {
    trace.step("Integrators discovered", {
      detail: integrators
        .slice(0, 8)
        .map((p) => `${p.name} (${p.confidence || "medium"})`)
        .join(", "),
    });
  }
  trace.finish();
  return trace.toJSON();
}

/** Rebuild from protocol /api/llm-analyze response. */
export function traceFromProtocolAnalysis(data, { url } = {}) {
  const trace = createIntelligenceTrace({
    kind: "protocol",
    query: url || data?.protocol?.url || data?.origin || "",
    label: data?.protocol?.name || "Protocol",
  });
  trace.step("Protocol intelligence complete", { kind: "success", phase: "done" });
  if (data?.defillama?.slug) {
    trace.step("DefiLlama match", {
      detail: `${data.defillama.name || data.defillama.slug} (${data.defillama.slug})`,
      sources: [{ label: "DefiLlama", url: `https://defillama.com/protocol/${data.defillama.slug}` }],
      kind: "source",
    });
  }
  const le = data?.llmEnrich || {};
  if (le.enabled) {
    trace.step("Hosted LLM enrichment", {
      detail: [
        le.docsFetched ? "docs fetched" : null,
        le.hostedPipelineRan ? "pipeline ran" : le.hostedPipelineSkipped || null,
        le.auditors != null ? `auditors: ${le.auditors}` : null,
        le.graphNodes != null ? `graph nodes: ${le.graphNodes}` : null,
        le.architecture ? "architecture inferred" : null,
        le.effectiveProvider ? `provider: ${le.effectiveProvider}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      kind: "llm",
    });
    for (const err of le.llmStepErrors || []) {
      trace.step(`LLM step error: ${err.step}`, { detail: err.message, kind: "error" });
    }
    if (le.error) trace.step("LLM enrichment error", { detail: le.error, kind: "error" });
  }
  for (const n of (data?.evidenceNotes || []).slice(0, 12)) {
    const title = typeof n === "string" ? n : n?.title || n?.label || "Evidence";
    const detail = typeof n === "string" ? "" : n?.detail || n?.text || "";
    trace.step(title, { detail, kind: "source" });
  }
  trace.finish();
  return trace.toJSON();
}
