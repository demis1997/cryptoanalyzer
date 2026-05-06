export class LlmProviderError extends Error {
  constructor(message, { code = "llm_error", cause = null } = {}) {
    super(message);
    this.name = "LlmProviderError";
    this.code = code;
    this.cause = cause;
  }
}

function truthyEnv(name) {
  const v = String(process.env[name] || "").trim();
  return /^(1|true|yes|on)$/i.test(v);
}

function truncateForLog(s, max = 6000) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[truncated:${t.length - max} chars]`;
}

function logHostedLlm({ phase, providerKind, step, system, user, model, meta, rawText, json, error }) {
  if (!truthyEnv("DEBUG_LLM")) return;
  const header = `[llm][${providerKind || "unknown"}] ${phase}${step ? ` step=${step}` : ""}`;
  try {
    if (phase === "request") {
      console.log(header, {
        model: model || null,
        system: truncateForLog(system, 8000),
        user: truncateForLog(user, 16000),
      });
      return;
    }
    if (phase === "response") {
      console.log(header, {
        meta: meta || null,
        rawText: truncateForLog(rawText, 20000),
        json: json ?? null,
      });
      return;
    }
    if (phase === "error") {
      console.warn(header, {
        error: String(error?.message || error || ""),
        meta: meta || null,
      });
    }
  } catch {
    // ignore log failures
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

/** After Cloud Agents hits "storage mode disabled", reuse composer API for later steps in the same request. */
let skipCloudAgentsThisSession = false;

/** Call once at the start of each /api/llm-analyze hosted enrich block. */
export function resetHostedLlmRoute() {
  skipCloudAgentsThisSession = false;
}

/**
 * Run JSON LLM task using LLM_PROVIDER. If Cloud Agents is blocked (storage off), fall back to
 * hostedCursor (set CURSOR_API_ENDPOINT). Retries Cloud Agents only once per request.
 */
export async function runHostedLlmJson(opts) {
  const primaryKind = String(process.env.LLM_PROVIDER || "cursor").toLowerCase();
  const disableFb = String(process.env.DISABLE_COMPOSER_FALLBACK || "0") === "1";
  const endpoint = String(process.env.CURSOR_API_ENDPOINT || "").trim();
  const step = opts && typeof opts === "object" ? String(opts.step || "") : "";

  const runComposer = async () => {
    if (!endpoint) {
      throw new LlmProviderError(
        "CURSOR_API_ENDPOINT is not set — needed when Cloud Agents are unavailable (e.g. storage mode off).",
        { code: "missing_env" }
      );
    }
    const mod = await import("./hostedCursor.js");
    const fallback = mod.createCursorProvider();
    logHostedLlm({
      phase: "request",
      providerKind: "cursor",
      step,
      system: opts?.system,
      user: opts?.user,
      model: opts?.model,
    });
    const r = await fallback.runJson(opts);
    logHostedLlm({
      phase: "response",
      providerKind: "cursor",
      step,
      meta: r?.meta,
      rawText: r?.rawText,
      json: r?.json,
    });
    return {
      ...r,
      meta: { ...(r.meta || {}), kind: "cursor", usedComposerFallback: true },
    };
  };

  if (primaryKind === "cursor_cloud_agents" && skipCloudAgentsThisSession && !disableFb) {
    return runComposer();
  }

  const provider = await createLlmProvider();
  try {
    logHostedLlm({
      phase: "request",
      providerKind: provider?.kind,
      step,
      system: opts?.system,
      user: opts?.user,
      model: opts?.model,
    });
    const r = await provider.runJson(opts);
    logHostedLlm({
      phase: "response",
      providerKind: provider?.kind,
      step,
      meta: r?.meta,
      rawText: r?.rawText,
      json: r?.json,
    });
    return {
      ...r,
      meta: { ...(r.meta || {}), kind: provider.kind, usedComposerFallback: false },
    };
  } catch (err) {
    logHostedLlm({ phase: "error", providerKind: provider?.kind, step, error: err });
    const msg = String(err?.message || err || "");
    const storageOff = /storage mode is disabled/i.test(msg);
    if (primaryKind === "cursor_cloud_agents" && storageOff && !endpoint) {
      throw new LlmProviderError(
        "Cloud Agents need storage enabled in Cursor, or set CURSOR_API_ENDPOINT (same key) for composer-style completions.",
        { code: "cloud_agents_storage", cause: msg }
      );
    }
    const canFallback =
      primaryKind === "cursor_cloud_agents" && !disableFb && storageOff && Boolean(endpoint);
    if (!canFallback) throw err;
    console.warn(
      "[llm] Cloud Agents blocked (storage off); using CURSOR_API_ENDPOINT composer API for this analyze request."
    );
    skipCloudAgentsThisSession = true;
    return runComposer();
  }
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

