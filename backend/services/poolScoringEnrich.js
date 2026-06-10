/**
 * Shared scoring enrichment pipeline (discover + full intelligence).
 */
import { fetchYieldsPoolsCached } from "./yieldsDiscover.js";
import { fullYieldsPoolRow, hydrateYieldsRows } from "./yieldsPoolRow.js";
import { selectPrimaryYieldsRow } from "./poolAddress.js";
import {
  gatherPoolExternalData,
  applyExternalDataToYieldsRows,
} from "./poolDataSources.js";
import { resolveVaultToYields } from "./poolResolver.js";
import { resolvePoolFromProtocolTarget } from "./poolProtocolResolver.js";
import { enrichPoolMetadataWithLlm, applyMetadataHintsToRow } from "./poolEnrich.js";
import { gatherScoringWebResearch, mergeResearchBlobs } from "./scoringResearch.js";
import { applyVaultScoringMetaToRow } from "./scoringAudit.js";
import { resolvePoolMetrics } from "./poolMetricsResolver.js";

function rowOptsFromCtx(ctx) {
  return {
    vaultAddress: ctx?.vaultAddress,
    chain: ctx?.chain,
    nameHint: ctx?.nameHint,
  };
}

export async function resolveYieldsRowsUniversal(ctx, allPools, trace) {
  let rows = hydrateYieldsRows(ctx.yieldsRows, allPools);

  const protocolResolved = await resolvePoolFromProtocolTarget(ctx, allPools, trace).catch(() => null);
  if (protocolResolved?.yieldsRows?.length) {
    if (protocolResolved.vaultMeta) ctx.vaultMeta = { ...ctx.vaultMeta, ...protocolResolved.vaultMeta };
    if (protocolResolved.vaultMeta?.vaultAddress && !ctx.vaultAddress) {
      ctx.vaultAddress = protocolResolved.vaultMeta.vaultAddress;
    }
    return protocolResolved.yieldsRows;
  }

  const vault = ctx.vaultAddress;
  const marketId = ctx.marketId;
  if (marketId && !protocolResolved) return rows;

  if (!vault || !/^0x[a-f0-9]{40}$/.test(String(vault).toLowerCase())) return rows;

  const resolved = await resolveVaultToYields({
    vaultAddress: vault,
    chain: ctx.chain,
    issuerSlug: ctx.issuerSlug,
    nameHint: ctx.nameHint,
    poolUrl: ctx.url,
    allPools,
    trace,
  });

  if (resolved.vaultMeta) ctx.vaultMeta = { ...ctx.vaultMeta, ...resolved.vaultMeta };
  if (resolved.yieldsRows?.length) {
    return resolved.yieldsRows.map((r) =>
      applyVaultScoringMetaToRow(r, resolved.vaultMeta?.scoring || resolved.vaultMeta)
    );
  }
  return rows;
}

export async function enrichYieldsForScoring(ctx, { trace = null, webResearchIn = null } = {}) {
  const allPools = await fetchYieldsPoolsCached();
  const rowOpts = rowOptsFromCtx(ctx);
  let yieldsRows = await resolveYieldsRowsUniversal({ ...ctx, yieldsRows: ctx.yieldsRows }, allPools, trace);

  const primaryForResearch = selectPrimaryYieldsRow(yieldsRows, rowOpts);
  const scoringResearch = await gatherScoringWebResearch({
    poolLabel: ctx.label,
    poolUrl: ctx.url,
    issuerSlug: ctx.issuerSlug,
    symbol: primaryForResearch?.symbol,
    chain: primaryForResearch?.chain || ctx.chain,
  }).catch(() => null);

  const mergedWebResearch = {
    ...(webResearchIn || ctx.webResearch || {}),
    formatted: mergeResearchBlobs(webResearchIn || ctx.webResearch, scoringResearch),
    scoringResearch,
  };

  if (scoringResearch?.formatted && trace) {
    trace.step("Scoring-focused web research", {
      kind: "source",
      detail: `${scoringResearch.searches?.length || 0} query(s) · pool TVL / oracle / LLTV / utilization / Pendle maturity`,
      sources: (scoringResearch.searches || []).slice(0, 5).map((s) => ({
        label: s.query?.slice(0, 52) || "search",
        url: s.hits?.[0]?.url || null,
      })),
    });
  }

  const metricsResolution = await resolvePoolMetrics(
    { ...ctx, yieldsRows },
    { webResearch: mergedWebResearch, yieldsRow: primaryForResearch, trace }
  ).catch(() => ({ scoringHints: {}, poolIdentity: null, sources: [] }));

  if (metricsResolution?.poolIdentity) {
    ctx.poolIdentity = metricsResolution.poolIdentity;
    if (metricsResolution.poolIdentity.address && !ctx.vaultAddress) {
      ctx.vaultAddress = metricsResolution.poolIdentity.address;
    }
  }

  const externalData = await gatherPoolExternalData(
    { ...ctx, yieldsRows, metricsResolution },
    { webResearch: mergedWebResearch, trace }
  ).catch((e) => ({
    enabled: false,
    error: String(e?.message || e),
    sources: [],
    scoringHints: {},
  }));

  if (metricsResolution?.scoringHints) {
    externalData.scoringHints = {
      ...(externalData.scoringHints || {}),
      ...metricsResolution.scoringHints,
    };
    if (metricsResolution.sources?.length) {
      externalData.sources = [...(externalData.sources || []), ...metricsResolution.sources];
    }
  }

  yieldsRows = applyExternalDataToYieldsRows(yieldsRows, externalData, rowOpts);

  const primary = selectPrimaryYieldsRow(yieldsRows, rowOpts);
  const poolMeta = await enrichPoolMetadataWithLlm({
    poolLabel: ctx.label,
    poolUrl: ctx.url,
    issuerSlug: ctx.issuerSlug,
    yieldsRow: primary,
    webResearch: mergedWebResearch,
    poolIdentity: metricsResolution?.poolIdentity || ctx.poolIdentity,
    trace,
  });

  if (primary) {
    const idx = yieldsRows.findIndex((r) => r?.pool && r.pool === primary.pool);
    const at = idx >= 0 ? idx : 0;
    yieldsRows[at] = applyMetadataHintsToRow(yieldsRows[at], poolMeta);
    if (ctx.vaultMeta) {
      yieldsRows[at] = applyVaultScoringMetaToRow(yieldsRows[at], ctx.vaultMeta.scoring || ctx.vaultMeta);
    }
    if (ctx.vaultMeta?.curator && !yieldsRows[at].curator) {
      yieldsRows[at].curator = ctx.vaultMeta.curator;
      yieldsRows[at].curatorEvidence =
        ctx.vaultMeta.curatorEvidence ||
        `Protocol API curator ${ctx.vaultMeta.curatorAddress || ctx.vaultMeta.curator}`;
    }
  }

  const scoredRow = selectPrimaryYieldsRow(yieldsRows, rowOpts);
  if (trace) {
    trace.step("Scoring fields ready", {
      kind: "info",
      detail: [
        scoredRow?.symbol ? `${scoredRow.symbol} · ${scoredRow.project} · ${scoredRow.chain || ""}` : null,
        scoredRow?.pool ? `pool id ${String(scoredRow.pool).slice(0, 8)}…` : null,
        scoredRow?.tvlUsd != null
          ? `TVL $${Math.round(scoredRow.tvlUsd).toLocaleString()} (${scoredRow.tvlSource || "?"})`
          : scoredRow?.tvlUncertain
            ? "TVL rejected (symbol-only DefiLlama)"
            : "TVL missing — need pool page",
        scoredRow?.apyBase != null
          ? `apyBase ${Number(scoredRow.apyBase).toFixed(2)}% (${scoredRow.apySource || "?"})`
          : scoredRow?.apy != null
            ? `apy ${Number(scoredRow.apy).toFixed(2)}% (${scoredRow.apySource || "?"})`
            : "APY missing — need pool page",
        scoredRow?.utilization != null
          ? `util ${((scoredRow.utilization > 1 ? scoredRow.utilization : scoredRow.utilization * 100)).toFixed(1)}%`
          : null,
        scoredRow?.lltv != null ? `LLTV ${scoredRow.lltv}%` : null,
        scoredRow?.oracleType ? `oracle: ${scoredRow.oracleType}` : "oracle: not resolved",
        scoredRow?.curator ? `curator: ${scoredRow.curator}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      sources: ctx?.url
        ? [{ label: "Pool page", url: ctx.url }]
        : scoredRow?.apySource === "protocol_api"
          ? [{ label: "Protocol API", url: ctx?.url || null }]
          : [{ label: "Web research", url: null }],
    });
  }

  const underlyingTokens =
    externalData?.resolvedUnderlyingTokens?.length
      ? externalData.resolvedUnderlyingTokens
      : ctx.underlyingTokens;

  return {
    yieldsRows,
    underlyingTokens,
    webResearch: mergedWebResearch,
    externalData,
    poolMetadata: poolMeta,
    primaryRow: scoredRow,
    poolIdentity: ctx.poolIdentity || metricsResolution?.poolIdentity || null,
    metricsResolution,
  };
}
