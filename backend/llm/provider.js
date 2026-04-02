export class LlmProviderError extends Error {
  constructor(message, { code = "llm_error", cause = null } = {}) {
    super(message);
    this.name = "LlmProviderError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Minimal interface:
 * - runJson({ system, user, model, timeoutMs }) -> { json, rawText, meta }
 */
export function createLlmProvider() {
  const kind = String(process.env.LLM_PROVIDER || "cursor").toLowerCase();
  if (kind === "cursor") {
    return import("./hostedCursor.js").then((m) => m.createCursorProvider());
  }
  if (kind === "cursor_cloud_agents") {
    return import("./cursorCloudAgents.js").then((m) => m.createCursorCloudAgentsProvider());
  }
  throw new LlmProviderError(`Unknown LLM_PROVIDER: ${kind}`, { code: "bad_provider" });
}

export function extractFirstJsonObject(text) {
  const t = String(text || "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = t.slice(start, end + 1);
    return JSON.parse(slice);
  }
  throw new Error("No JSON object found in output.");
}

