import { fullYieldsPoolRow } from "./yieldsPoolRow.js";
import {
  filterYieldsRowsByVault,
  normalizePoolChain,
} from "./poolAddress.js";
import { readErc20Metadata, readErc4626Underlying } from "./onChainToken.js";
import { fetchMorphoVaultByAddress, matchYieldsRowForMorphoVault } from "./morphoVault.js";
import { defillamaSlugFromWebsite } from "./yieldsDiscover.js";
import { findBestYieldsPool } from "./yieldsPoolMatch.js";
import fetch from "node-fetch";

/** Pendle: match market/PT/YT/SY address → market name → DefiLlama. */
async function resolveViaPendle(address, chain, allPools, trace) {
  const chainIds = { ethereum: 1, arbitrum: 42161, optimism: 10, base: 8453, polygon: 137 };
  const chainId = chainIds[normalizePoolChain(chain)] || 1;
  const addr = address.toLowerCase();
  try {
    const markets = [];
    for (let page = 0; page < 4; page++) {
      const resp = await fetch(
        `https://api-v2.pendle.finance/core/v2/markets/all?skip=${page * 100}&limit=100`,
        { headers: { "User-Agent": "cryptoanalyzer/pool-resolver" } }
      );
      if (!resp.ok) break;
      const json = await resp.json().catch(() => ({}));
      const batch = Array.isArray(json?.results) ? json.results : [];
      markets.push(...batch.filter((m) => Number(m?.chainId) === chainId));
      if (batch.length < 100) break;
    }
    const hit = markets.find((m) => {
      const addrs = [m?.address, m?.pt, m?.yt, m?.sy, m?.underlyingAsset]
        .map((x) => String(x || "").toLowerCase().replace(/^\d+-/, ""))
        .filter((a) => /^0x[a-f0-9]{40}$/.test(a));
      return addrs.includes(addr);
    });
    if (!hit) return null;
    const name = String(hit.name || hit.symbol || "").trim();
    trace?.step?.("Pendle market API", {
      kind: "source",
      detail: name || addr.slice(0, 10),
      sources: [{ label: "Pendle API", url: "https://api-v2.pendle.finance" }],
    });
    const row = findBestYieldsPool(allPools, {
      symbol: name,
      chain,
      issuerSlug: "pendle",
      nameHint: name,
      vaultAddress: address,
    });
    return row
      ? {
          yieldsRow: row,
          vaultMeta: { symbol: name, name, source: "pendle_api", curator: null },
        }
      : null;
  } catch {
    return null;
  }
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
    if (matched) {
      const row = fullYieldsPoolRow(matched);
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
  }

  // 3) Pendle API
  const pendle = await resolveViaPendle(addr, chainNorm, allPools, trace);
  if (pendle?.yieldsRow) {
    return {
      yieldsRows: [{ ...pendle.yieldsRow, vaultAddress: addr }],
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
