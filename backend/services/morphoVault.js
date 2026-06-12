import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";
import { parseMorphoLltv } from "./scoringAudit.js";
import { resolvePoolCreatedAtMs } from "./poolContractAge.js";
import { explorerInternalTxUrl, morphoGraphqlUrl } from "./sourceUrls.js";

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
      address symbol name listed creationTimestamp
      state {
        curator fee totalAssetsUsd apy netApy
        allocation {
          supplyAssetsUsd supplyCapUsd
          market {
            lltv
            oracle { address }
            loanAsset { symbol }
            collateralAsset { symbol }
            state { utilization }
          }
        }
      }
      asset { symbol address }
      chain { id network }
    }
  }`;
  const v2Q = `
  query VaultV2($address: String!, $chainId: Int!) {
    vaultV2ByAddress(address: $address, chainId: $chainId) {
      address symbol name listed creationTimestamp
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
    const scoring = extractMorphoScoringFields(v);
    const ageMeta = await resolvePoolCreatedAtMs({
      address: addr,
      chain: normalizePoolChain(v?.chain?.network || chain),
      protocolKind: "morpho_vault",
    });
    if (ageMeta?.poolCreatedAt) Object.assign(scoring, ageMeta);
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
      sourceUrl: morphoGraphqlUrl(),
      poolAgeExplorerUrl: ageMeta?.poolAgeExplorerUrl || explorerInternalTxUrl(addr, chain),
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}

function extractMorphoScoringFields(v) {
  const st = v?.state || {};
  const allocs = Array.isArray(st.allocation) ? st.allocation : [];
  const active = allocs.filter((a) => Number(a?.supplyAssetsUsd) > 0 && a?.market);
  let utilNum = 0;
  let utilDen = 0;
  let lltvSum = 0;
  let lltvN = 0;
  let capFillSum = 0;
  let capFillN = 0;
  const oracleAddrs = [];

  for (const a of active) {
    const w = Number(a.supplyAssetsUsd) || 0;
    const u = Number(a?.market?.state?.utilization);
    if (w > 0 && isFinite(u)) {
      utilNum += u * w;
      utilDen += w;
    }
    const lltv = parseMorphoLltv(a?.market?.lltv);
    if (lltv != null) {
      lltvSum += lltv * (w || 1);
      lltvN += w || 1;
    }
    const cap = Number(a?.supplyCapUsd);
    if (cap > 0 && w > 0) {
      capFillSum += Math.min(1, w / cap);
      capFillN += 1;
    }
    const oa = a?.market?.oracle?.address;
    if (oa) oracleAddrs.push(String(oa).toLowerCase());
  }

  const apyRaw = Number(st.netApy ?? st.apy);
  const out = {};
  if (isFinite(Number(st.totalAssetsUsd))) {
    out.totalAssetsUsd = Number(st.totalAssetsUsd);
    out.tvlEvidence = "Morpho API state.totalAssetsUsd";
  }
  if (isFinite(apyRaw)) {
    out.apyPct = apyRaw <= 1 ? apyRaw * 100 : apyRaw;
    out.apyEvidence = "Morpho API vault netApy";
  }
  if (utilDen > 0) {
    out.utilization = utilNum / utilDen;
    out.utilizationEvidence = `Morpho API weighted market utilization (${active.length} market(s))`;
  }
  if (lltvN > 0) {
    out.lltvPct = lltvSum / lltvN;
    out.lltvEvidence = `Morpho API weighted LLTV across ${active.length} allocation(s)`;
  }
  if (capFillN > 0) {
    out.capUtilization = capFillSum / capFillN;
  }
  if (oracleAddrs.length) {
    out.oracleType = "Chainlink";
    out.oracleEvidence = `Morpho market oracle(s): ${oracleAddrs.slice(0, 3).join(", ")}`;
  }
  return out;
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
