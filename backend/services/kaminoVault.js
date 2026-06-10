/**
 * Kamino Earn vault (KVault) metrics via public REST API.
 */
import fetch from "node-fetch";
const API_BASE = "https://api.kamino.finance";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let vaultListCache = null;
let vaultListCacheAt = 0;

async function fetchVaultList() {
  if (vaultListCache && Date.now() - vaultListCacheAt < 300_000) return vaultListCache;
  const resp = await fetch(`${API_BASE}/kvaults/vaults`, {
    headers: { "User-Agent": "cryptoanalyzer/kamino-vault" },
  });
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => []);
  vaultListCache = Array.isArray(json) ? json : [];
  vaultListCacheAt = Date.now();
  return vaultListCache;
}

function normSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isValidSolanaAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ""));
}

/**
 * Resolve Kamino vault pubkey from slug (e.g. steakhouse-usdc) or explicit address.
 */
export async function findKaminoVault({ nameHint, solanaAddress } = {}) {
  if (isValidSolanaAddress(solanaAddress)) return solanaAddress;

  const slug = normSlug(nameHint);
  if (!slug) return null;

  const vaults = await fetchVaultList();
  const steakhouse = vaults.filter((v) => /steakhouse/i.test(JSON.stringify(v)));

  const usdcMint = (v) => v?.state?.tokenMint === USDC_MINT;
  const candidates = steakhouse.length ? steakhouse : vaults;

  let best = null;
  let bestScore = 0;

  for (const v of candidates) {
    const hay = normSlug(JSON.stringify(v));
    let score = 0;
    if (hay.includes(slug)) score += 100;
    if (slug.includes("usdc") && usdcMint(v)) score += 50;
    if (slug.includes("steakhouse") && /steakhouse/i.test(hay)) score += 40;
    if (slug.includes("usdc") && normSlug(v?.state?.tokenMint).includes("usdc")) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }

  if (!best?.address) return null;

  if (slug.includes("usdc")) {
    const usdcSteak = [];
    for (const v of steakhouse.filter(usdcMint)) {
      const m = await fetchKaminoVaultMetrics(v.address).catch(() => null);
      usdcSteak.push({ v, tvl: Number(m?.tokensInvestedUsd) || 0 });
    }
    if (usdcSteak.length) {
      usdcSteak.sort((a, b) => b.tvl - a.tvl);
      return usdcSteak[0].v.address;
    }
  }

  return best.address;
}

export async function fetchKaminoVaultMetrics(pubkey) {
  if (!isValidSolanaAddress(pubkey)) return null;
  const resp = await fetch(`${API_BASE}/kvaults/vaults/${pubkey}/metrics`, {
    headers: { "User-Agent": "cryptoanalyzer/kamino-vault" },
  });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

export async function fetchKaminoVault({ nameHint, solanaAddress } = {}) {
  const pubkey = isValidSolanaAddress(solanaAddress)
    ? solanaAddress
    : await findKaminoVault({ nameHint, solanaAddress });

  if (!pubkey) return null;

  try {
    const metrics = await fetchKaminoVaultMetrics(pubkey);
    if (!metrics) return null;

    const tvlUsd = Number(metrics.tokensInvestedUsd);
    const availableUsd = Number(metrics.tokensAvailableUsd);
    const apy = Number(metrics.apy);
    const exitLiquidityRatio =
      isFinite(tvlUsd) && tvlUsd > 0 && isFinite(availableUsd) ? availableUsd / tvlUsd : null;

    const sym = String(nameHint || "Kamino vault")
      .replace(/\s+/g, " ")
      .trim();

    const scoring = {
      totalAssetsUsd: isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : null,
      tvlEvidence: isFinite(tvlUsd) ? `Kamino API tokensInvestedUsd $${Math.round(tvlUsd).toLocaleString()}` : null,
      apyPct: isFinite(apy) ? apy * 100 : null,
      apyEvidence: isFinite(apy) ? `Kamino API vault APY ${(apy * 100).toFixed(2)}%` : null,
      utilization: exitLiquidityRatio != null ? 1 - exitLiquidityRatio : null,
      utilizationEvidence:
        exitLiquidityRatio != null
          ? `Kamino instant liquidity ${(exitLiquidityRatio * 100).toFixed(2)}% of TVL (withdrawable)`
          : null,
      oracleType: "Pyth",
      oracleEvidence: "Kamino uses Pyth/Switchboard oracles on Solana",
    };

    return {
      symbol: sym,
      name: sym,
      chain: "solana",
      vaultAddress: pubkey,
      solanaAddress: pubkey,
      project: "kamino",
      source: "kamino_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
