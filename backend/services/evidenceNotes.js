/**
 * Human-readable provenance trail for the Analyze UI "Evidence / sources" section.
 */
export function buildEvidenceNotes(enriched, { defillama = null, defillamaApi = null, origin = "" } = {}) {
  const notes = [];

  if (origin) {
    notes.push({
      label: "Analyzed URL",
      source: "User input",
      detail: String(origin),
    });
  }

  if (defillama?.slug) {
    notes.push({
      label: "DefiLlama protocol match",
      source: "DefiLlama (protocols directory API)",
      detail: `Matched listing → https://defillama.com/protocol/${encodeURIComponent(defillama.slug)}`,
    });
  } else if (defillama && defillama._matchError) {
    notes.push({
      label: "DefiLlama protocol match",
      source: "DefiLlama (protocols directory API)",
      detail: `Match request failed: ${String(defillama._matchError).slice(0, 220)}`,
    });
  } else if (defillama === null && origin) {
    notes.push({
      label: "DefiLlama protocol match",
      source: "DefiLlama",
      detail: "No protocol match by website URL (TVL / metadata may be incomplete).",
    });
  }

  if (defillamaApi?.apiUrl) {
    const bits = [];
    if (defillamaApi.category) bits.push(`category: ${defillamaApi.category}`);
    if (Array.isArray(defillamaApi.chains) && defillamaApi.chains.length)
      bits.push(`chains: ${defillamaApi.chains.slice(0, 12).join(", ")}`);
    notes.push({
      label: "DefiLlama protocol detail JSON",
      source: "DefiLlama REST API",
      detail: `${defillamaApi.apiUrl}${bits.length ? ` (${bits.join("; ")})` : ""}`,
    });
  }

  if (Array.isArray(enriched?.tvl?.evidence) && enriched.tvl.evidence.length) {
    notes.push({
      label: "TVL",
      source: "DefiLlama",
      detail: enriched.tvl.evidence.join(" · "),
    });
  }

  if (Array.isArray(enriched?.txsPerDay?.evidence) && enriched.txsPerDay.evidence.length) {
    notes.push({
      label: "Native / DEX volume (24h)",
      source: "DefiLlama protocol page (scraped visible text)",
      detail: enriched.txsPerDay.evidence.join(" · "),
    });
  }

  if (Array.isArray(enriched?.protocol?.totalRaisedEvidence) && enriched.protocol.totalRaisedEvidence.length) {
    notes.push({
      label: "Total raised",
      source: "DefiLlama protocol page (scraped visible text)",
      detail: enriched.protocol.totalRaisedEvidence.join(" · "),
    });
  }

  if (Array.isArray(enriched?.protocol?.auditsVerified?.evidence) && enriched.protocol.auditsVerified.evidence.length) {
    notes.push({
      label: "Audits / verification",
      source: "Protocol documentation (fetched) + heuristic verification",
      detail: enriched.protocol.auditsVerified.evidence.join(" · "),
    });
  }

  if (enriched?.page?.notes && Array.isArray(enriched.page.notes)) {
    notes.push({
      label: "Website HTML",
      source: "Playwright + fetch",
      detail: enriched.page.notes.join(" · "),
    });
  }

  if (Array.isArray(enriched?.tokenLiquidity)) {
    const withSrc = enriched.tokenLiquidity.filter((t) => Array.isArray(t?.evidence) && t.evidence.length);
    if (withSrc.length) {
      notes.push({
        label: "Token / liquidity rows",
        source: "Mixed (see each row)",
        detail: `${withSrc.length} row(s) cite DefiLlama yields, on-page extraction, or Pendle adapter in their evidence field.`,
      });
    }
  }

  if (enriched?.pendle && typeof enriched.pendle === "object" && Array.isArray(enriched.pendle.evidence) && enriched.pendle.evidence.length) {
    notes.push({
      label: "Pendle markets snapshot",
      source: "Pendle API",
      detail: `${enriched.pendle.evidence.slice(0, 4).join(" · ")}`,
    });
  }

  if (Array.isArray(enriched?.contracts) && enriched.contracts.length) {
    const n = enriched.contracts.filter((c) => c?.evidence).length;
    notes.push({
      label: "Contract addresses",
      source: "DOM / HTML extraction + enrichment",
      detail: `${enriched.contracts.length} contract row(s); ${n} include a per-row evidence string (source varies).`,
    });
  }

  const conn = enriched?.connections;
  if (conn && conn.enabled) {
    notes.push({
      label: "On-chain connection graph",
      source: conn.rpc === "configured" ? "Ethereum JSON-RPC (viem)" : "Skipped",
      detail: Array.isArray(conn.evidence) && conn.evidence.length ? conn.evidence.join(" · ") : "RPC reads for vault underlying + curated router map.",
    });
  }

  const le = enriched?.llmEnrich;
  if (le?.enabled) {
    const parts = [];
    if (le.docsFetched) parts.push("documentation snippets");
    if (le.usedAnalyzeHtmlFallback) parts.push("analyze-page text fallback");
    if (defillamaApi?.apiUrl) parts.push("DefiLlama API summary (fed into LLM)");
    if (le.hostedPipelineRan) {
      notes.push({
        label: "LLM ecosystem / architecture enrichment",
        source: le.effectiveProvider || le.provider || "hosted LLM",
        detail: `Steps ran on ${parts.join(", ") || "available context"}.${le.usedComposerApiFallback ? " Composer API fallback used for some calls." : ""}`,
      });
    } else if (le.hostedPipelineSkipped) {
      notes.push({
        label: "LLM enrichment",
        source: "Skipped",
        detail: String(le.hostedPipelineSkipped),
      });
    }
  }

  if (enriched?.cache?.source === "local_graph") {
    notes.push({
      label: "Response cache",
      source: "SQLite graph cache",
      detail: "Fast path: served from local graph DB without a full crawl.",
    });
  }

  return notes;
}
