/** @typedef {{ label: string, value: string, delta?: string, tone?: string }} MetricProps */
/** @typedef {{ title: string, score: number|null, level: string, subtitle?: string }} RiskScoreProps */

export function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatUsd(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(2) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return "$" + (value / 1_000).toFixed(1) + "K";
  return "$" + value.toLocaleString();
}

export function severityFromScore(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 0.75) return "low";
  if (score >= 0.55) return "moderate";
  if (score >= 0.4) return "elevated";
  return "critical";
}

export function severityLabel(level) {
  const m = {
    low: "Low risk",
    moderate: "Moderate",
    elevated: "Elevated",
    critical: "Critical",
    unknown: "Unrated",
  };
  return m[level] || "Unrated";
}

export function MetricCard({ label, value, delta = "", tone = "" }) {
  return `
    <article class="metric-card ${tone ? `metric-card--${tone}` : ""}">
      <div class="metric-card__label">${escapeHtml(label)}</div>
      <div class="metric-card__value">${escapeHtml(value)}</div>
      ${delta ? `<div class="metric-card__delta">${escapeHtml(delta)}</div>` : ""}
    </article>
  `;
}

export function RiskScoreCard({ title, score, level, subtitle = "" }) {
  const pct = Number.isFinite(score) ? Math.round(score * 100) : null;
  const ring = Number.isFinite(score) ? Math.max(8, Math.round(score * 100)) : 0;
  return `
    <article class="risk-score-card severity--${escapeHtml(level)}">
      <div class="risk-score-card__ring" style="--ring:${ring}%">
        <div class="risk-score-card__inner">
          <span class="risk-score-card__pct">${pct == null ? "—" : pct}</span>
          <span class="risk-score-card__unit">/ 100</span>
        </div>
      </div>
      <div class="risk-score-card__body">
        <div class="risk-score-card__title">${escapeHtml(title)}</div>
        <div class="risk-score-card__badge">${escapeHtml(severityLabel(level))}</div>
        ${subtitle ? `<p class="risk-score-card__sub">${escapeHtml(subtitle)}</p>` : ""}
      </div>
    </article>
  `;
}

export function RiskBreakdownBar({ id, label, score, note = "" }) {
  const pct = Number.isFinite(score) ? Math.round(clamp01(score) * 100) : 0;
  const level = severityFromScore(score);
  return `
    <div class="risk-bar severity--${level}">
      <div class="risk-bar__head">
        <span class="risk-bar__label">${escapeHtml(label)}</span>
        <span class="risk-bar__score">${Number.isFinite(score) ? pct + "%" : "—"}</span>
      </div>
      <div class="risk-bar__track"><div class="risk-bar__fill" style="width:${pct}%"></div></div>
      ${note ? `<div class="risk-bar__note">${escapeHtml(note)}</div>` : ""}
    </div>
  `;
}

export function EvidenceCard({ label, source, detail = "", href = "" }) {
  const sourceHtml = href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source || href)}</a>`
    : escapeHtml(source || "—");
  return `
    <article class="evidence-card">
      <div class="evidence-card__label">${escapeHtml(label)}</div>
      <div class="evidence-card__source">${sourceHtml}</div>
      ${detail ? `<p class="evidence-card__detail">${escapeHtml(detail)}</p>` : ""}
    </article>
  `;
}

export function EmptyState({ title, body, actionHtml = "" }) {
  return `
    <div class="empty-state">
      <div class="empty-state__icon" aria-hidden="true">◇</div>
      <h3 class="empty-state__title">${escapeHtml(title)}</h3>
      <p class="empty-state__body">${escapeHtml(body)}</p>
      ${actionHtml ? `<div class="empty-state__action">${actionHtml}</div>` : ""}
    </div>
  `;
}

export function SkeletonGrid(count = 4) {
  return `<div class="skeleton-grid">${Array.from({ length: count })
    .map(() => `<div class="skeleton skeleton--card"></div>`)
    .join("")}</div>`;
}

export function SkeletonLines(n = 5) {
  return `<div class="skeleton-lines">${Array.from({ length: n })
    .map((_, i) => `<div class="skeleton skeleton--line" style="width:${88 - i * 8}%"></div>`)
    .join("")}</div>`;
}

export function ContractTableRow({ label, network, address, auditStatus = "unknown", evidence = "" }) {
  const short = address && address.length > 14 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
  const auditClass =
    auditStatus === "verified" ? "audit--ok" : auditStatus === "partial" ? "audit--warn" : "audit--muted";
  return `
    <tr>
      <td><span class="contract-name">${escapeHtml(label || "Contract")}</span></td>
      <td><span class="chip">${escapeHtml(network || "—")}</span></td>
      <td><code class="mono" title="${escapeHtml(address || "")}">${escapeHtml(short || "—")}</code></td>
      <td><span class="audit-pill ${auditClass}">${escapeHtml(auditStatus)}</span></td>
      <td class="muted">${escapeHtml(evidence ? String(evidence).slice(0, 80) : "—")}</td>
    </tr>
  `;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
