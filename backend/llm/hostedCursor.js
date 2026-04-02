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

function parseJsonFromText(text) {
  const t = String(text || "");
  try {
    return JSON.parse(t);
  } catch {
    return extractFirstJsonObject(t);
  }
}

/**
 * Normalize provider payloads: bare JSON, or OpenAI-style { choices: [{ message: { content } }] }.
 */
function normalizedJsonFromProviderBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return parseJsonFromText(body);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      try {
        return extractFirstJsonObject(content);
      } catch {
        return body;
      }
    }
  }
  return body;
}

function buildAuthHeaders(apiKey) {
  const mode = env("CURSOR_API_AUTH_MODE", "bearer").toLowerCase();
  if (mode === "basic") {
    const user = apiKey;
    const pass = env("CURSOR_API_BASIC_PASSWORD", "");
    const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  const authHeader = env("CURSOR_API_AUTH_HEADER", "Authorization");
  const authPrefix = env("CURSOR_API_AUTH_PREFIX", "Bearer");
  return { [authHeader]: `${authPrefix} ${apiKey}` };
}

async function postJson(url, body, { timeoutMs = 25_000, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, text };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Cursor hosted model runner (OpenAI-compatible chat completions, or your proxy).
 *
 * Required:
 * - CURSOR_API_ENDPOINT (full URL, e.g. your OpenAI-compatible completions endpoint)
 * - CURSOR_API_KEY
 *
 * Optional:
 * - CURSOR_MODEL (default: composer-2)
 * - CURSOR_API_AUTH_MODE: bearer (default) | basic
 *   For basic: optional CURSOR_API_BASIC_PASSWORD (often empty; key is the Basic “username”)
 * - CURSOR_API_AUTH_HEADER / CURSOR_API_AUTH_PREFIX (only for bearer mode overrides)
 */
export function createCursorProvider() {
  const endpoint = required("CURSOR_API_ENDPOINT");
  const apiKey = required("CURSOR_API_KEY");
  const modelDefault = env("CURSOR_MODEL", "composer-2");

  return {
    kind: "cursor",
    async runJson({ system, user, model, timeoutMs = 35_000 } = {}) {
      const sys = clamp(system, 6_000);
      const usr = clamp(user, 30_000);

      const body = {
        model: model || modelDefault,
        messages: [
          ...(sys ? [{ role: "system", content: sys }] : []),
          { role: "user", content: usr },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      };

      const headers = buildAuthHeaders(apiKey);
      const r = await postJson(endpoint, body, { timeoutMs, headers });
      if (!r.ok) {
        throw new LlmProviderError(`Cursor LLM request failed (${r.status})`, {
          code: "http_error",
          cause: r.text?.slice(0, 600),
        });
      }

      let outer = null;
      try {
        outer = JSON.parse(r.text);
      } catch {
        outer = { _raw: r.text };
      }
      const json = normalizedJsonFromProviderBody(outer);
      return { json, rawText: r.text, meta: { status: r.status } };
    },
  };
}
