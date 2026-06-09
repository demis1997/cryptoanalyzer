/** Per-criterion data audit for activity logs and transparency. */

function has(val) {
  if (val == null) return false;
  if (typeof val === "number") return isFinite(val);
  if (typeof val === "string") return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

export function parseMorphoLltv(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  if (n <= 1) return n * 100;
  if (n > 1e10) return (n / 1e18) * 100;
  return n;
}

/** Merge protocol API / resolver metadata into the yields row used for scoring. */
export function applyVaultScoringMetaToRow(row, meta) {
  if (!row || !meta || typeof meta !== "object") return row;
  const next = { ...row };

  if (meta.totalAssetsUsd != null && isFinite(Number(meta.totalAssetsUsd)) && row.tvlSource !== "pool_page") {
    next.tvlUsd = Number(meta.totalAssetsUsd);
    next.tvlSource = "protocol_api";
    next.tvlEvidence = meta.tvlEvidence || "Protocol API totalAssetsUsd";
    next.tvlUncertain = false;
  }
  if (meta.apyPct != null && isFinite(Number(meta.apyPct))) {
    next.apyBase = Number(meta.apyPct);
    next.apyEvidence = meta.apyEvidence || "Protocol API net APY";
  }
  if (meta.lltvPct != null) {
    next.lltv = Number(meta.lltvPct);
    next.lltvEvidence = meta.lltvEvidence || null;
  }
  if (meta.utilization != null) {
    next.utilization = Number(meta.utilization);
    next.utilizationEvidence = meta.utilizationEvidence || null;
  }
  if (meta.capUtilization != null) {
    next.capUtilization = Number(meta.capUtilization);
  }
  if (meta.oracleType) {
    next.oracleType = meta.oracleType;
    next.oracleEvidence = meta.oracleEvidence || null;
  }
  if (meta.curator) {
    next.curator = meta.curator;
    next.curatorEvidence = meta.curatorEvidence || null;
  }
  if (meta.poolCreatedAt) next.poolCreatedAt = meta.poolCreatedAt;

  return next;
}

const CRITERION_FIELDS = {
  assetQuality: ["symbol", "underlyingTokens", "assetRankHint"],
  liquidityExit: ["utilization", "utilizationRate", "pendleDaysToMaturity", "daysToMaturity"],
  oracleQuality: ["oracleType", "oracle"],
  parameterSafety: ["lltv", "ltv", "capUtilization", "supplyCapFill"],
  depositorConcentration: ["depositorShares", "top1DepositorPct", "depositorSharePercents"],
  poolAge: ["poolCreatedAt", "createdAt", "count"],
  poolTvl: ["tvlUsd", "tvlSource", "tvlEvidence"],
  yieldQuality: ["apyBase", "apyReward", "apy", "apyCv30d", "sigma"],
  curatorQuality: ["curator"],
};

const CRITERION_NA_TYPES = {
  oracleQuality: new Set(["staking"]),
  parameterSafety: new Set(["staking", "amm_lp"]),
  curatorQuality: new Set(["staking", "amm_lp", "pendle_pt"]),
};

export function buildScoringDataAudit(row, ctx, poolType) {
  const audit = {};
  for (const [key, fields] of Object.entries(CRITERION_FIELDS)) {
    if (CRITERION_NA_TYPES[key]?.has(poolType)) {
      audit[key] = { status: "na", checked: fields, found: [], missing: [], note: "N/A for pool type" };
      continue;
    }
    const found = [];
    const missing = [];
    for (const f of fields) {
      const val = row?.[f];
      if (has(val)) found.push(`${f}=${formatField(f, val)}`);
      else missing.push(f);
    }
    if (key === "assetQuality" && ctx?.underlyingTokens?.length) {
      const syms = ctx.underlyingTokens.map((t) => t.symbol).filter(Boolean);
      if (syms.length) found.push(`underlying=${syms.join(",")}`);
      else missing.push("underlyingSymbols");
    }
    audit[key] = {
      status: missing.length === fields.length ? "gap" : missing.length ? "partial" : "ok",
      checked: fields,
      found,
      missing,
    };
  }
  return audit;
}

function formatField(name, val) {
  if (name === "tvlUsd" && typeof val === "number") return `$${Math.round(val).toLocaleString()}`;
  if (name === "utilization" && typeof val === "number") return `${(val > 1 ? val : val * 100).toFixed(1)}%`;
  if (Array.isArray(val)) return `[${val.length}]`;
  if (typeof val === "number") return String(Math.round(val * 1000) / 1000);
  return String(val).slice(0, 40);
}

export function formatCriterionAuditLine(criterionId, criterionKey, auditEntry) {
  if (!auditEntry) return "";
  if (auditEntry.status === "na") return "N/A for pool type";
  const parts = [];
  if (auditEntry.found?.length) parts.push(`found: ${auditEntry.found.join(", ")}`);
  if (auditEntry.missing?.length) parts.push(`missing: ${auditEntry.missing.join(", ")}`);
  return parts.join(" · ");
}

export function auditTraceDetail(criterionId, criterion, auditEntry) {
  const scorePart =
    criterion.score != null
      ? `score ${Math.round(criterion.score * 100)}%`
      : criterion.unavailable
        ? "data gap"
        : criterion.na
          ? "N/A"
          : "—";
  const auditLine = formatCriterionAuditLine(criterionId, criterion.key, auditEntry);
  return [scorePart, criterion.input, criterion.calcBreakdown, auditLine, criterion.confidenceReason || criterion.evidence]
    .filter(Boolean)
    .join(" · ");
}
