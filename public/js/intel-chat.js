import { escapeHtml } from "./ui-components.js";

const KIND_CLASS = {
  info: "intel-chat__msg--info",
  source: "intel-chat__msg--source",
  llm: "intel-chat__msg--llm",
  error: "intel-chat__msg--error",
  success: "intel-chat__msg--success",
};

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function renderSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return "";
  return `<div class="intel-chat__sources">${sources
    .slice(0, 4)
    .map((s) => {
      const lbl = escapeHtml(s?.label || "source");
      return s?.url
        ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${lbl}</a>`
        : `<span>${lbl}</span>`;
    })
    .join(" · ")}</div>`;
}

function renderEntry(e) {
  const title = String(e.title || e.phase || "Step");
  const isCriterion = /^P\.\d+/i.test(title);
  const isGap = e.kind === "error" || /data gap|missing:/i.test(String(e.detail || ""));
  const kind =
    isGap && isCriterion ? "intel-chat__msg--error" : KIND_CLASS[e.kind] || KIND_CLASS.info;
  const detail = e.detail ? `<div class="intel-chat__detail">${escapeHtml(e.detail)}</div>` : "";
  const llm =
    e.llm?.step && e.phase?.startsWith("llm")
      ? `<div class="intel-chat__meta">${escapeHtml(e.llm.step)}${e.llm.keys?.length ? ` · keys: ${escapeHtml(e.llm.keys.join(", "))}` : ""}</div>`
      : "";
  return `<article class="intel-chat__msg ${kind}">
    <div class="intel-chat__head">
      <span class="intel-chat__time">${escapeHtml(formatTime(e.ts))}</span>
      <strong class="intel-chat__title">${escapeHtml(title)}</strong>
    </div>
    ${detail}
    ${llm}
    ${renderSources(e.sources)}
  </article>`;
}

export function createIntelChatPanel({ feedEl, saveBtn, downloadBtn, clearBtn, statusEl } = {}) {
  let currentTrace = null;

  function setStatus(text, tone = "") {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.dataset.tone = tone;
    statusEl.hidden = !text;
  }

  function renderFeed() {
    if (!feedEl) return;
    if (!currentTrace?.entries?.length) {
      feedEl.innerHTML = `<p class="intel-chat__empty">Run pool or protocol intelligence to see live reasoning, LLM steps, and data sources here.</p>`;
      if (saveBtn) saveBtn.disabled = true;
      if (downloadBtn) downloadBtn.disabled = true;
      return;
    }
    feedEl.innerHTML = currentTrace.entries.map(renderEntry).join("");
    feedEl.scrollTop = feedEl.scrollHeight;
    if (saveBtn) saveBtn.disabled = false;
    if (downloadBtn) downloadBtn.disabled = false;
  }

  function startRun({ kind, query, label } = {}) {
    currentTrace = {
      id: `local_${Date.now()}`,
      kind: kind || "unknown",
      query: query || "",
      label: label || query || "",
      startedAt: new Date().toISOString(),
      entries: [],
    };
    pushLocal("Starting…", { kind: "info", detail: label || query });
    setStatus("Running…");
    renderFeed();
  }

  function pushLocal(title, opts = {}) {
    if (!currentTrace) return;
    currentTrace.entries.push({
      ts: new Date().toISOString(),
      phase: "client",
      kind: opts.kind || "info",
      title,
      detail: opts.detail || "",
      sources: opts.sources || [],
    });
    renderFeed();
  }

  function applyTrace(trace) {
    if (!trace || typeof trace !== "object") return;
    currentTrace = trace;
    renderFeed();
    setStatus(`${trace.entries?.length || 0} step(s)`, "success");
  }

  function mergeTrace(trace) {
    if (!trace?.entries?.length) return;
    if (!currentTrace) {
      applyTrace(trace);
      return;
    }
    currentTrace = {
      ...currentTrace,
      ...trace,
      entries: [...(currentTrace.entries || []), ...trace.entries],
    };
    renderFeed();
    setStatus(`${currentTrace.entries.length} step(s)`, "success");
  }

  function getTrace() {
    return currentTrace;
  }

  function clear() {
    currentTrace = null;
    renderFeed();
    setStatus("");
  }

  async function saveToServer() {
    if (!currentTrace?.entries?.length) {
      throw new Error("Nothing to save — run intelligence first.");
    }
    const payload = {
      ...currentTrace,
      endedAt: currentTrace.endedAt || new Date().toISOString(),
    };
    const resp = await fetch("/api/intelligence-trace/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace: payload }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) throw new Error(data?.error || `Save failed (${resp.status})`);
    return data.saved;
  }

  function exportFilename(suffix = "export") {
    const slug = (currentTrace?.label || currentTrace?.query || "trace")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .slice(0, 40);
    return `${slug}-thinking-${suffix}.json`;
  }

  function downloadJson(filename) {
    if (!currentTrace?.entries?.length) throw new Error("Nothing to export — run intelligence first.");
    const payload = {
      ...currentTrace,
      endedAt: currentTrace.endedAt || new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || exportFilename("local");
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  if (clearBtn) clearBtn.addEventListener("click", clear);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      try {
        downloadBtn.disabled = true;
        downloadJson(exportFilename("download"));
        setStatus("Downloaded JSON", "success");
      } catch (e) {
        setStatus(String(e.message || e), "error");
      } finally {
        if (currentTrace?.entries?.length) downloadBtn.disabled = false;
      }
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        saveBtn.disabled = true;
        if (downloadBtn) downloadBtn.disabled = true;
        downloadJson(exportFilename("download"));
        try {
          const saved = await saveToServer();
          setStatus(`Downloaded · saved ${saved?.id || ""}`, "success");
        } catch (e) {
          setStatus(`Downloaded · server save failed: ${e.message || e}`, "error");
        }
      } catch (e) {
        setStatus(String(e.message || e), "error");
      } finally {
        if (currentTrace?.entries?.length) {
          saveBtn.disabled = false;
          if (downloadBtn) downloadBtn.disabled = false;
        }
      }
    });
  }

  renderFeed();

  return {
    startRun,
    pushLocal,
    applyTrace,
    mergeTrace,
    getTrace,
    clear,
    saveToServer,
    downloadJson,
  };
}
