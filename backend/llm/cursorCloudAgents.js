import fetch from "node-fetch";
import { LlmProviderError, extractFirstJsonObject } from "./provider.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function required(name) {
  const v = env(name);
  if (!v) throw new LlmProviderError(`Missing ${name}`, { code: "missing_env" });
  return v;
}

function clamp(s, maxChars) {
  const t = String(s || "");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + `\n[truncated:${t.length - maxChars} chars]`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuthHeader(apiKey) {
  // Cursor docs: username=API key, empty password.
  const token = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function fetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 25_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: resp.ok, status: resp.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

function parseJsonFromAssistantText(text) {
  const t = String(text || "");
  try {
    return JSON.parse(t);
  } catch {
    return extractFirstJsonObject(t);
  }
}

function lastAssistantMessageText(conversation) {
  const msgs = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.type === "assistant_message" && typeof m?.text === "string" && m.text.trim()) return m.text;
  }
  return "";
}

/**
 * Cursor Cloud Agents provider.
 *
 * Required:
 * - CURSOR_API_KEY (crsr_...)
 * - CURSOR_CLOUD_AGENTS_REPOSITORY (https://github.com/owner/repo)
 *
 * Optional:
 * - CURSOR_CLOUD_AGENTS_REF (default: main)
 * - CURSOR_CLOUD_AGENTS_REPOSITORY_SLUG (owner/repo) if auto-detection from URL is wrong
 * - CURSOR_CLOUD_AGENTS_MODEL — omit or use id from GET /v0/models
 * - CURSOR_CLOUD_AGENTS_BASE_URL (default: https://api.cursor.com)
 */
function normalizeRepoUrl(raw) {
  const u = String(raw || "").trim().replace(/\/+$/, "");
  return u;
}

/** Strip refs/heads/ for building alternate ref forms. */
function shortRefName(r) {
  const s = String(r || "").trim();
  const m = s.match(/^refs\/heads\/(.+)$/);
  return m ? m[1] : s;
}

/** owner/repo from https://github.com/owner/repo — Cloud Agents sometimes accept only this form. */
function githubSlugFromRepository(repo) {
  const forced = env("CURSOR_CLOUD_AGENTS_REPOSITORY_SLUG", "");
  if (forced) return forced.replace(/^\/+/, "").replace(/\.git$/i, "");
  const m = String(repo).match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : "";
}

function isBranchVerifyFailure(launch) {
  return Number(launch?.status) === 400 && /verify existence of branch/i.test(String(launch?.text || ""));
}

function isInvalidAgentModelFailure(launch) {
  return Number(launch?.status) === 400 && /not available or invalid/i.test(String(launch?.text || ""));
}

function uniqueSourceAttempts(repository, ref) {
  const refShort = shortRefName(ref);
  const refsHeads = `refs/heads/${refShort}`;
  const slug = githubSlugFromRepository(repository);
  const variants = [
    { repository, ref },
    { repository, ref: refsHeads },
  ];
  if (slug) {
    variants.push({ repository: slug, ref: refShort }, { repository: slug, ref: refsHeads });
  }
  const seen = new Set();
  const out = [];
  for (const src of variants) {
    const key = `${src.repository}\0${src.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

function launchErrorDetail(status, text, json) {
  const j = json && typeof json === "object" ? json : null;
  const msg = [j?.message, j?.error, typeof j?.detail === "string" ? j.detail : null].filter(Boolean).join("; ");
  let tail = msg || String(text || "").trim().slice(0, 1500) || "empty response body";
  if (/verify existence of branch/i.test(tail)) {
    tail +=
      " — Confirm branch with: git ls-remote --heads <repo-url>; Cloud Agents still need GitHub linked in Cursor + Cursor GitHub App access to that repo (not only “public on GitHub”).";
  }
  if (/storage mode is disabled/i.test(tail)) {
    tail += " — Or set CURSOR_API_ENDPOINT (composer chat) in .env: the app will fall back automatically.";
  }
  if (/not available or invalid/i.test(tail)) {
    tail +=
      " — Unset CURSOR_CLOUD_AGENTS_MODEL or pick an id from GET /v0/models; chat/composer names are often invalid for Agents.";
  }
  return `Cursor Cloud Agent launch failed (${status}): ${tail}`;
}

export function createCursorCloudAgentsProvider() {
  const apiKey = required("CURSOR_API_KEY");
  const repository = normalizeRepoUrl(required("CURSOR_CLOUD_AGENTS_REPOSITORY"));
  const ref = env("CURSOR_CLOUD_AGENTS_REF", "main");
  // API often rejects model="default"; leave unset unless CURSOR_CLOUD_AGENTS_MODEL is a real id from GET /v0/models.
  const model = env("CURSOR_CLOUD_AGENTS_MODEL", "");
  const baseUrl = env("CURSOR_CLOUD_AGENTS_BASE_URL", "https://api.cursor.com").replace(/\/+$/, "");

  const headers = basicAuthHeader(apiKey);

  return {
    kind: "cursor_cloud_agents",
    async runJson({ system, user, timeoutMs = 120_000 } = {}) {
      const sys = clamp(system, 3_000);
      const usr = clamp(user, 18_000);

      const promptText = [
        sys ? `SYSTEM:\n${sys}` : null,
        "CRITICAL: Reply with JSON only. No markdown fences. No extra keys.",
        usr,
      ]
        .filter(Boolean)
        .join("\n\n");

      // 1) Launch agent (retry source/ref shapes; retry without model if CURSOR_CLOUD_AGENTS_MODEL is invalid for Agents)
      const runSourceLaunchLoop = async (includeModelInBody) => {
        const sourceAttempts = uniqueSourceAttempts(repository, ref);
        let launch = null;
        for (let i = 0; i < sourceAttempts.length; i++) {
          const src = sourceAttempts[i];
          const launchBody = {
            prompt: { text: promptText },
            source: src,
            target: { autoCreatePr: false },
          };
          if (includeModelInBody && model && !/^default$/i.test(model)) {
            launchBody.model = model;
          }

          launch = await fetchJson(`${baseUrl}/v0/agents`, {
            method: "POST",
            headers,
            timeoutMs: Math.min(25_000, timeoutMs),
            body: launchBody,
          });

          if (launch.ok) return launch;
          if (
            isInvalidAgentModelFailure(launch) &&
            includeModelInBody &&
            model &&
            !/^default$/i.test(model)
          ) {
            return { __stripAgentModel: true };
          }
          if (!isBranchVerifyFailure(launch) || i === sourceAttempts.length - 1) {
            console.warn("[cursor_cloud_agents] launch response:", launch.status, launch.text?.slice(0, 2000));
            throw new LlmProviderError(launchErrorDetail(launch.status, launch.text, launch.json), {
              code: "http_error",
              cause: launch.text?.slice(0, 2500),
            });
          }
          console.warn(
            `[cursor_cloud_agents] branch verify 400; retry ${i + 2}/${sourceAttempts.length} with repository=${JSON.stringify(src.repository)} ref=${JSON.stringify(src.ref)}`
          );
        }
        return launch;
      };

      let launch = await runSourceLaunchLoop(true);
      if (launch && launch.__stripAgentModel) {
        console.warn(
          "[cursor_cloud_agents] model not valid for Cloud Agents; retrying without model field (API default)."
        );
        launch = await runSourceLaunchLoop(false);
      }
      if (!launch?.ok) {
        console.warn("[cursor_cloud_agents] launch response:", launch.status, launch.text?.slice(0, 2000));
        throw new LlmProviderError(launchErrorDetail(launch.status, launch.text, launch.json), {
          code: "http_error",
          cause: launch.text?.slice(0, 2500),
        });
      }
      const agentId = launch.json?.id;
      if (!agentId) {
        throw new LlmProviderError("Cursor Cloud Agent launch returned no id", {
          code: "bad_response",
          cause: launch.text?.slice(0, 800),
        });
      }

      // 2) Poll status until finished or timeout
      const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || 120_000);
      let status = String(launch.json?.status || "").toUpperCase();
      let lastStatusJson = launch.json;
      let delay = 1_250;

      while (Date.now() < deadline) {
        if (status === "FINISHED") break;
        if (status === "FAILED" || status === "ERROR" || status === "STOPPED") {
          throw new LlmProviderError(`Cursor Cloud Agent ended with status ${status}`, {
            code: "agent_failed",
            cause: JSON.stringify(lastStatusJson || {}, null, 2).slice(0, 1200),
          });
        }

        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), 6_000);

        const st = await fetchJson(`${baseUrl}/v0/agents/${agentId}`, {
          method: "GET",
          headers,
          timeoutMs: 20_000,
        });
        if (!st.ok) {
          throw new LlmProviderError(`Cursor Cloud Agent status failed (${st.status})`, {
            code: "http_error",
            cause: st.text?.slice(0, 800),
          });
        }
        lastStatusJson = st.json;
        status = String(st.json?.status || "").toUpperCase();
      }

      if (String(status).toUpperCase() !== "FINISHED") {
        throw new LlmProviderError("Cursor Cloud Agent timed out waiting for FINISHED", {
          code: "timeout",
          cause: JSON.stringify(lastStatusJson || {}, null, 2).slice(0, 1200),
        });
      }

      // 3) Fetch conversation and parse last assistant JSON
      const conv = await fetchJson(`${baseUrl}/v0/agents/${agentId}/conversation`, {
        method: "GET",
        headers,
        timeoutMs: 25_000,
      });
      if (!conv.ok) {
        throw new LlmProviderError(`Cursor Cloud Agent conversation failed (${conv.status})`, {
          code: "http_error",
          cause: conv.text?.slice(0, 800),
        });
      }

      const assistantText = lastAssistantMessageText(conv.json);
      const json = parseJsonFromAssistantText(assistantText);
      return { json, rawText: assistantText, meta: { agentId, status: "FINISHED" } };
    },
  };
}

