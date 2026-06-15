/**
 * Deduped web search session — one Tavily/DDG call per unique query per pool run.
 */
import { searchWeb } from "./webResearch.js";
import { traceWebSearch } from "./researchActivityLog.js";

function normalizeQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function createWebResearchSession({ trace = null } = {}) {
  const cache = new Map();
  const searches = [];

  async function runSearch(query, { maxResults = 6 } = {}) {
    const q = String(query || "").trim();
    const key = normalizeQuery(q);
    if (!key) return { provider: "none", query: "", hits: [] };
    if (cache.has(key)) return cache.get(key);

    const result = await searchWeb(q, { maxResults });
    cache.set(key, result);
    searches.push(result);
    traceWebSearch(trace, {
      provider: result.provider,
      query: result.query,
      hits: result.hits,
      answer: result.answer,
    });
    return result;
  }

  async function runQueries(queries, { maxResults = 6, maxCount } = {}) {
    const uniq = [...new Set((queries || []).map((q) => String(q || "").trim()).filter(Boolean))];
    const limit = maxCount != null ? maxCount : uniq.length;
    const out = [];
    for (const q of uniq.slice(0, limit)) {
      out.push(await runSearch(q, { maxResults }));
    }
    return out;
  }

  function seedFromPrior(prior) {
    for (const s of prior?.searches || []) {
      const key = normalizeQuery(s?.query);
      if (key && !cache.has(key)) {
        cache.set(key, s);
        searches.push(s);
      }
    }
    for (const s of prior?.scoringResearch?.searches || []) {
      const key = normalizeQuery(s?.query);
      if (key && !cache.has(key)) {
        cache.set(key, s);
        searches.push(s);
      }
    }
  }

  return {
    runSearch,
    runQueries,
    getSearches: () => searches,
    uniqueQueryCount: () => cache.size,
    seedFromPrior,
  };
}

/** Lazy session on intelligence trace (shared across gather* in one pool run). */
export function webResearchSession(trace) {
  if (!trace) return createWebResearchSession({ trace: null });
  if (!trace._webResearchSession) {
    trace._webResearchSession = createWebResearchSession({ trace });
  }
  return trace._webResearchSession;
}
