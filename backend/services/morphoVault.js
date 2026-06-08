import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";

const CURATOR_ADDRESSES = {
  "0x827e86072b06674a077f592a531dce4590adecdb": "Steakhouse Financial",
};

const CHAIN_IDS = {
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  polygon: 137,
};

function chainIdFromName(chain) {
  const k = normalizePoolChain(chain);
  return CHAIN_IDS[k] ?? null;
}

async function morphoGql(query, variables) {
  const resp = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/pool-intel" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`Morpho API ${resp.status}`);
  if (json.errors?.length && !json.data) {
    throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  }
  return json.data;
}

/**
 * Resolve MetaMorpho vault metadata by contract address (Morpho GraphQL).
 */
export async function fetchMorphoVaultByAddress(address, chain) {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const chainId = chainIdFromName(chain);
  if (!chainId) return null;

  const v1Q = `
  query VaultV1($address: String!, $chainId: Int!) {
    vaultByAddress(address: $address, chainId: $chainId) {
      address symbol name listed
      state { curator fee }
      asset { symbol address }
      chain { id network }
    }
  }`;
  const v2Q = `
  query VaultV2($address: String!, $chainId: Int!) {
    vaultV2ByAddress(address: $address, chainId: $chainId) {
      address symbol name listed
      asset { symbol address }
      chain { id network }
    }
  }`;

  try {
    let v = null;
    let source = "morpho_vault_v1";
    try {
      const data = await morphoGql(v1Q, { address: addr, chainId });
      v = data?.vaultByAddress;
    } catch {
      // v1 miss — try v2
    }
    if (!v?.address) {
      source = "morpho_vault_v2";
      const data = await morphoGql(v2Q, { address: addr, chainId });
      v = data?.vaultV2ByAddress;
    }
    if (!v?.address) return null;
    const curatorAddr = String(v?.state?.curator || "").toLowerCase();
    const curatorName =
      CURATOR_ADDRESSES[curatorAddr] ||
      (() => {
        const n = String(v?.name || "");
        if (/steakhouse/i.test(n)) return "Steakhouse Financial";
        if (/gauntlet/i.test(n)) return "Gauntlet";
        if (/re7/i.test(n)) return "Re7 Labs";
        if (/mev capital|smokehouse/i.test(n)) return "MEV Capital";
        return null;
      })();
    return {
      address: String(v.address).toLowerCase(),
      symbol: v.symbol || null,
      name: v.name || null,
      listed: v.listed ?? null,
      curator: curatorName,
      curatorAddress: curatorAddr || null,
      assetSymbol: v?.asset?.symbol || null,
      chain: normalizePoolChain(v?.chain?.network || chain),
      chainId: v?.chain?.id ?? chainId,
      source,
    };
  } catch {
    return null;
  }
}

/** Match DefiLlama yields row using Morpho vault symbol + chain (+ optional name hint). */
export function matchYieldsRowForMorphoVault(morphoVault, allPools, { nameHint = null } = {}) {
  if (!morphoVault?.symbol || !Array.isArray(allPools)) return null;
  const sym = String(morphoVault.symbol).toLowerCase();
  const chain = morphoVault.chain;
  let candidates = allPools.filter((p) => {
    const pSym = String(p?.symbol || "").toLowerCase();
    const pChain = normalizePoolChain(p?.chain);
    const proj = String(p?.project || "").toLowerCase();
    return pSym === sym && pChain === chain && /morpho/i.test(proj);
  });
  if (!candidates.length) {
    candidates = allPools.filter(
      (p) => String(p?.symbol || "").toLowerCase() === sym && normalizePoolChain(p?.chain) === chain
    );
  }
  if (!candidates.length) return null;

  const hints = [
    nameHint,
    morphoVault.name,
    morphoVault.symbol,
  ]
    .map((s) => String(s || "").toLowerCase())
    .filter((s) => s.length > 2);

  if (hints.length) {
    const scored = candidates.map((p) => {
      const hay = `${p?.symbol || ""} ${p?.poolMeta || ""} ${morphoVault.name || ""}`.toLowerCase();
      let score = Number(p?.tvlUsd) || 0;
      for (const h of hints) {
        if (hay.includes(h.replace(/\s+/g, ""))) score += 1e9;
        h.split(/\s+/).forEach((w) => {
          if (w.length > 3 && hay.includes(w)) score += 1e6;
        });
      }
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].p;
  }

  return [...candidates].sort((a, b) => (Number(b?.tvlUsd) || 0) - (Number(a?.tvlUsd) || 0))[0];
}
