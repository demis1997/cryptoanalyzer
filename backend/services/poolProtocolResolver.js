/**
 * Protocol-agnostic pool resolution from parsed URL targets and API plugins.
 */
import { fullYieldsPoolRow } from "./yieldsPoolRow.js";
import { findBestYieldsPool } from "./yieldsPoolMatch.js";
import { applyVaultScoringMetaToRow } from "./scoringAudit.js";
import { buildSyntheticYieldsRow } from "./syntheticYieldsRow.js";
import { fetchMorphoVaultByAddress, matchYieldsRowForMorphoVault } from "./morphoVault.js";
import { fetchMorphoMarketById } from "./morphoMarket.js";
import { fetchAaveReserve } from "./aaveReserve.js";
import { fetchSparkReserve } from "./sparkReserve.js";
import { fetchMaplePool } from "./maplePool.js";
import { fetchKaminoVault } from "./kaminoVault.js";
import { fetchCompoundMarket } from "./compoundMarket.js";
import { findPendleMarket, pendleMetaForVault, syntheticYieldsRowFromPendle } from "./pendleMarket.js";
import { fetchFluidLendingToken } from "./fluidLending.js";
import { fetchHyperliquidVault } from "./hyperliquidVault.js";

const API_FIRST_SOURCES = new Set([
  "aave_api",
  "morpho_api",
  "compound_on_chain",
  "fluid_api",
  "hyperliquid_api",
  "pendle_api",
  "spark_on_chain",
  "maple_api",
  "kamino_api",
]);

function mergeDlOrSynthetic({ apiMeta, allPools, rowOpts, trace, label }) {
  if (!apiMeta) return null;
  const scoring = apiMeta.scoring || apiMeta;
  const hasApiMetrics =
    scoring?.totalAssetsUsd != null ||
    scoring?.utilization != null ||
    scoring?.lltvPct != null ||
    scoring?.pendleAmmLiquidityUsd != null;
  const preferApi = API_FIRST_SOURCES.has(apiMeta.source) && hasApiMetrics;

  const dlRow = findBestYieldsPool(allPools, {
    symbol: apiMeta.symbol,
    chain: apiMeta.chain,
    issuerSlug: apiMeta.project,
    nameHint: rowOpts.nameHint || apiMeta.name,
    vaultAddress: apiMeta.vaultAddress || rowOpts.vaultAddress,
  });

  const dlProject = String(dlRow?.project || "").toLowerCase();
  const apiProject = String(apiMeta.project || "").toLowerCase();
  const dlMatchesIssuer =
    dlRow &&
    (dlProject === apiProject ||
      dlProject.includes(apiProject.split("-")[0]) ||
      apiProject.includes(dlProject.replace(/-v\d$/, "")));

  const base =
    dlRow && !preferApi && dlMatchesIssuer
    ? fullYieldsPoolRow(dlRow)
    : buildSyntheticYieldsRow({
        symbol: apiMeta.symbol,
        name: apiMeta.name,
        project: apiMeta.project,
        chain: apiMeta.chain,
        vaultAddress: apiMeta.vaultAddress,
        marketId: apiMeta.marketId,
        poolMeta: apiMeta.name,
        meta: apiMeta,
      });

  const row = applyVaultScoringMetaToRow(
    {
      ...base,
      symbol: apiMeta.symbol || base.symbol,
      chain: apiMeta.chain || base.chain,
      project: apiMeta.project || base.project,
      vaultAddress: apiMeta.vaultAddress || base.vaultAddress || rowOpts.vaultAddress,
      marketId: apiMeta.marketId || base.marketId,
      issuerSlug: apiMeta.project,
      underlyingTokens: apiMeta.underlyingTokens || base.underlyingTokens,
      poolMeta: apiMeta.name || base.poolMeta,
      tvlSource: apiMeta.tvlSource || base.tvlSource,
    },
    scoring
  );
  if (apiMeta.tvlSource && row.tvlUsd != null) row.tvlSource = apiMeta.tvlSource;

  trace?.step?.(label, {
    kind: "source",
    detail: [
      apiMeta.symbol,
      apiMeta.chain,
      row.tvlUsd != null ? `TVL $${Math.round(row.tvlUsd).toLocaleString()}` : null,
      row.utilization != null ? `util ${(row.utilization * 100).toFixed(1)}%` : null,
      row.lltv != null ? `LLTV ${Number(row.lltv).toFixed(1)}%` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    sources: [{ label: apiMeta.source || label, url: null }],
  });

  return { yieldsRows: [row], vaultMeta: { ...apiMeta, scoring } };
}

/**
 * Resolve pool from protocol-specific URL fields (marketId, underlyingAsset, protocolKind).
 */
export async function resolvePoolFromProtocolTarget(ctx, allPools, trace = null) {
  const kind = ctx?.protocolKind;
  const rowOpts = {
    vaultAddress: ctx?.vaultAddress,
    chain: ctx?.chain,
    nameHint: ctx?.nameHint,
  };

  if (!kind || kind === "generic") {
    // Still try Pendle by URL/address without explicit kind
    if (ctx?.issuerSlug === "pendle" || /pendle/i.test(ctx?.url || "")) {
      return resolvePendle(ctx, allPools, trace);
    }
    return null;
  }

  switch (kind) {
    case "aave_reserve": {
      const meta = await fetchAaveReserve({
        chain: ctx.chain,
        underlyingAsset: ctx.underlyingAsset || ctx.vaultAddress,
      });
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Aave reserve API" });
    }
    case "spark_reserve": {
      const meta = await fetchSparkReserve({
        chain: ctx.chain,
        underlyingAsset: ctx.underlyingAsset || ctx.vaultAddress,
      });
      const spark = mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Spark reserve" });
      return spark;
    }
    case "morpho_market": {
      const meta = await fetchMorphoMarketById(ctx.marketId, ctx.chain);
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Morpho market API" });
    }
    case "morpho_vault": {
      const morpho = await fetchMorphoVaultByAddress(ctx.vaultAddress, ctx.chain);
      if (!morpho) return null;
      const matched = matchYieldsRowForMorphoVault(morpho, allPools, rowOpts);
      const base = matched
        ? fullYieldsPoolRow(matched)
        : buildSyntheticYieldsRow({
            symbol: morpho.symbol,
            name: morpho.name,
            project: "morpho-blue",
            chain: morpho.chain,
            vaultAddress: ctx.vaultAddress,
            meta: morpho,
          });
      const row = applyVaultScoringMetaToRow(
        { ...base, vaultAddress: ctx.vaultAddress, curator: morpho.curator },
        morpho.scoring || morpho
      );
      trace?.step?.("Morpho vault API", { kind: "source", detail: morpho.symbol || morpho.name });
      return { yieldsRows: [row], vaultMeta: morpho };
    }
    case "pendle_market":
      return resolvePendle(ctx, allPools, trace);
    case "compound_market": {
      const meta = await fetchCompoundMarket({ marketSlug: ctx.marketSlug, chain: ctx.chain });
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Compound Comet" });
    }
    case "fluid_lending": {
      const meta = await fetchFluidLendingToken({ chain: ctx.chain, nameHint: ctx.nameHint });
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Fluid lending API" });
    }
    case "hyperliquid_vault": {
      const meta = await fetchHyperliquidVault(ctx.vaultAddress);
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Hyperliquid vault API" });
    }
    case "maple_pool": {
      const meta = await fetchMaplePool({ nameHint: ctx.nameHint });
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Maple GraphQL API" });
    }
    case "kamino_vault": {
      const meta = await fetchKaminoVault({
        nameHint: ctx.nameHint,
        solanaAddress: ctx.solanaAddress,
      });
      if (!meta) {
        trace?.step?.("Kamino vault API", {
          kind: "info",
          detail: "Could not resolve Kamino vault pubkey from slug — check vault URL or Solana address",
        });
        return null;
      }
      return mergeDlOrSynthetic({ apiMeta: meta, allPools, rowOpts, trace, label: "Kamino vault API" });
    }
    default:
      return null;
  }
}

async function resolvePendle(ctx, allPools, trace) {
  const found = await findPendleMarket({
    address: ctx.vaultAddress,
    chain: ctx.chain,
    nameHint: ctx.nameHint,
    poolUrl: ctx.url,
  });
  if (!found?.market) return null;
  const vaultMeta = pendleMetaForVault(found.market);
  const addr = vaultMeta?.marketAddress || ctx.vaultAddress;
  const dlRow = findBestYieldsPool(allPools, {
    symbol: found.market.name,
    chain: ctx.chain,
    issuerSlug: "pendle",
    nameHint: found.market.name,
    vaultAddress: addr,
  });
  const yieldsRow = dlRow ? fullYieldsPoolRow(dlRow) : syntheticYieldsRowFromPendle(found.market, ctx.chain, addr);
  const row = applyVaultScoringMetaToRow(
    { ...yieldsRow, vaultAddress: addr, issuerSlug: "pendle" },
    vaultMeta.scoring || vaultMeta
  );
  trace?.step?.("Pendle market API", { kind: "source", detail: found.market.name });
  return { yieldsRows: [row], vaultMeta };
}
