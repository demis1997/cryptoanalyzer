import { fullYieldsPoolRow } from "./yieldsPoolRow.js";
import {
  filterYieldsRowsByVault,
  normalizePoolChain,
} from "./poolAddress.js";
import { readErc20Metadata, readErc4626Underlying } from "./onChainToken.js";
import { fetchMorphoVaultByAddress, matchYieldsRowForMorphoVault } from "./morphoVault.js";
import { applyVaultScoringMetaToRow } from "./scoringAudit.js";
import { defillamaSlugFromWebsite } from "./yieldsDiscover.js";
import { findBestYieldsPool } from "./yieldsPoolMatch.js";
import { findPendleMarket, pendleMetaForVault, syntheticYieldsRowFromPendle } from "./pendleMarket.js";
import { buildSyntheticYieldsRow } from "./syntheticYieldsRow.js";

/** Pendle: match market/PT/YT/SY address → API scoring + optional DefiLlama row. */
async function resolveViaPendle(address, chain, allPools, trace, { nameHint = null, poolUrl = null } = {}) {
  const addr = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  try {
    const found = await findPendleMarket({ address: addr, chain, nameHint, poolUrl });
    if (!found?.market) return null;
    const hit = found.market;
    const name = String(hit.name || hit.symbol || "").trim();
    const vaultMeta = pendleMetaForVault(hit);
    trace?.step?.("Pendle market API", {
      kind: "source",
      detail: [
        name,
        vaultMeta?.tvlUsd != null ? `TVL $${Math.round(vaultMeta.tvlUsd).toLocaleString()}` : null,
        vaultMeta?.pendleDaysToMaturity != null ? `${vaultMeta.pendleDaysToMaturity}d to maturity` : null,
        vaultMeta?.pendleAmmLiquidityUsd != null
          ? `AMM liq $${Math.round(vaultMeta.pendleAmmLiquidityUsd).toLocaleString()}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      sources: [{ label: "Pendle API", url: "https://api-v2.pendle.finance" }],
    });
    const dlRow = findBestYieldsPool(allPools, {
      symbol: name,
      chain,
      issuerSlug: "pendle",
      nameHint: name,
      vaultAddress: address,
    });
    const yieldsRow = dlRow
      ? fullYieldsPoolRow(dlRow)
      : syntheticYieldsRowFromPendle(hit, chain, addr);
    return { yieldsRow, vaultMeta };
  } catch {
    return null;
  }
}

/** Resolve Pendle market by name or pool URL (no vault address). */
export async function resolvePendleByHint({ nameHint, poolUrl, chain, allPools, trace } = {}) {
  const found = await findPendleMarket({ nameHint, poolUrl, chain });
  if (!found?.market) return null;
  const hit = found.market;
  const vaultMeta = pendleMetaForVault(hit);
  const addr = vaultMeta?.marketAddress;
  trace?.step?.("Pendle market API (by name/URL)", {
    kind: "source",
    detail: vaultMeta?.name || nameHint,
  });
  const dlRow = findBestYieldsPool(allPools, {
    symbol: hit.name,
    chain: chain || "ethereum",
    issuerSlug: "pendle",
    nameHint: hit.name,
    vaultAddress: addr,
  });
  const yieldsRow = dlRow
    ? fullYieldsPoolRow(dlRow)
    : syntheticYieldsRowFromPendle(hit, chain, addr);
  return {
    yieldsRows: [{ ...yieldsRow, vaultAddress: addr, issuerSlug: "pendle" }],
    vaultMeta,
  };
}

/**
 * Universal vault/pool contract → DefiLlama yields row (all protocols).
 */
export async function resolveVaultToYields({
  vaultAddress,
  chain,
  issuerSlug = null,
  nameHint = null,
  poolUrl = null,
  allPools,
  trace = null,
} = {}) {
  const addr = String(vaultAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr) || !Array.isArray(allPools)) {
    return { yieldsRows: [], vaultMeta: null };
  }

  const chainNorm = normalizePoolChain(chain);
  let vaultMeta = null;

  // 1) DefiLlama direct vault / meta match
  let hits = filterYieldsRowsByVault(allPools, addr, chainNorm).map((r) => fullYieldsPoolRow(r));
  if (!hits.length) hits = filterYieldsRowsByVault(allPools, addr, null).map((r) => fullYieldsPoolRow(r));
  if (hits.length) {
    trace?.step?.("DefiLlama vault match", {
      kind: "source",
      detail: `${hits[0].symbol} · ${hits[0].chain} · TVL $${Math.round(hits[0].tvlUsd || 0).toLocaleString()}`,
    });
    return { yieldsRows: hits, vaultMeta: { source: "defillama_vault" } };
  }

  // 2) Morpho API (one plugin)
  const morpho = await fetchMorphoVaultByAddress(addr, chainNorm);
  if (morpho) {
    vaultMeta = { ...morpho, source: morpho.source || "morpho_api" };
    trace?.step?.("Protocol API (Morpho)", {
      kind: "source",
      detail: `${morpho.symbol || morpho.name} · curator: ${morpho.curator || "—"}`,
      sources: [{ label: "Morpho GraphQL", url: poolUrl || `https://defillama.com/protocol/morpho-blue` }],
    });
    const matched = matchYieldsRowForMorphoVault(morpho, allPools, { nameHint });
    const baseRow = matched
      ? fullYieldsPoolRow(matched)
      : buildSyntheticYieldsRow({
          symbol: morpho.symbol,
          name: morpho.name,
          project: "morpho-blue",
          chain: morpho.chain,
          vaultAddress: addr,
          meta: morpho,
        });
    let row = applyVaultScoringMetaToRow(baseRow, morpho.scoring || morpho);
    trace?.step?.("Morpho scoring fields", {
      kind: "source",
      detail: [
        row.tvlUsd != null ? `TVL $${Math.round(row.tvlUsd).toLocaleString()}` : null,
        row.lltv != null ? `LLTV ${Number(row.lltv).toFixed(1)}%` : null,
        row.utilization != null ? `util ${(row.utilization * 100).toFixed(1)}%` : null,
        row.oracleType ? `oracle ${row.oracleType}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "curator/symbol only",
    });
    return {
      yieldsRows: [
        {
          ...row,
          vaultAddress: addr,
          curator: morpho.curator,
          curatorEvidence: morpho.curator
            ? `Morpho API curator ${morpho.curatorAddress || morpho.curator}`
            : null,
        },
      ],
      vaultMeta,
    };
  }

  // 3) Pendle API
  const pendle = await resolveViaPendle(addr, chainNorm, allPools, trace, { nameHint, poolUrl });
  if (pendle?.yieldsRow) {
    let row = applyVaultScoringMetaToRow({ ...pendle.yieldsRow, vaultAddress: addr }, pendle.vaultMeta?.scoring || pendle.vaultMeta);
    return {
      yieldsRows: [row],
      vaultMeta: pendle.vaultMeta,
    };
  }

  // 4) On-chain ERC-20 / ERC-4626 → symbol match DefiLlama
  const erc20 = await readErc20Metadata(addr, chainNorm);
  if (erc20?.symbol) {
    vaultMeta = { ...erc20, source: "on_chain_erc20" };
    trace?.step?.("On-chain token metadata", {
      kind: "source",
      detail: `${erc20.symbol}${erc20.name ? ` · ${erc20.name}` : ""}`,
    });

    let symbolForMatch = erc20.symbol;
    const erc4626 = await readErc4626Underlying(addr, chainNorm);
    if (erc4626?.assetMeta?.symbol) {
      vaultMeta.underlyingSymbol = erc4626.assetMeta.symbol;
      vaultMeta.underlyingAddress = erc4626.assetAddress;
    }

    const slug = issuerSlug || (poolUrl ? await defillamaSlugFromWebsite(poolUrl) : null);

    const row = findBestYieldsPool(allPools, {
      symbol: symbolForMatch,
      chain: chainNorm,
      issuerSlug: slug,
      nameHint: nameHint || erc20.name,
      vaultAddress: addr,
    });

    if (row) {
      trace?.step?.("DefiLlama match via on-chain symbol", {
        kind: "source",
        detail: `${row.symbol} · ${row.project} · TVL $${Math.round(row.tvlUsd || 0).toLocaleString()}`,
        sources: [
          {
            label: "DefiLlama yields",
            url: `https://defillama.com/protocol/${encodeURIComponent(row.project || "yields")}`,
          },
        ],
      });
      return {
        yieldsRows: [
          {
            ...row,
            vaultAddress: addr,
            vaultTokenSymbol: erc20.symbol,
            vaultTokenName: erc20.name,
            ...(vaultMeta.underlyingSymbol
              ? { underlyingTokens: [erc4626?.assetAddress || vaultMeta.underlyingAddress].filter(Boolean) }
              : {}),
          },
        ],
        vaultMeta,
      };
    }
  }

  // 5) Name-hint only within issuer slug
  if (nameHint && issuerSlug) {
    const row = findBestYieldsPool(allPools, {
      chain: chainNorm,
      issuerSlug,
      nameHint,
      vaultAddress: addr,
    });
    if (row) {
      trace?.step?.("DefiLlama match via URL name hint", {
        kind: "source",
        detail: `${row.symbol} · ${row.project}`,
      });
      return { yieldsRows: [{ ...row, vaultAddress: addr }], vaultMeta: { source: "name_hint" } };
    }
  }

  trace?.step?.("Pool resolver gap", {
    kind: "info",
    detail: `No DefiLlama row for ${chainNorm}:${addr.slice(0, 10)}… — TVL/APY criteria may be unavailable.`,
  });
  return { yieldsRows: [], vaultMeta };
}
