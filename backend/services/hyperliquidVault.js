/**
 * Hyperliquid vault details via public info API.
 */
import fetch from "node-fetch";

export async function fetchHyperliquidVault(vaultAddress) {
  const addr = String(vaultAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;

  try {
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cryptoanalyzer/hyperliquid" },
      body: JSON.stringify({ type: "vaultDetails", vaultAddress: addr }),
    });
    if (!resp.ok) return null;
    const json = await resp.json().catch(() => null);
    if (!json?.vaultAddress) return null;

    let tvlUsd = null;
    const hist = json?.portfolio?.[0]?.[1]?.accountValueHistory;
    if (Array.isArray(hist) && hist.length) {
      const last = hist[hist.length - 1];
      const val = Number(last?.[1]);
      if (isFinite(val) && val > 0) tvlUsd = val;
    }

    const scoring = {
      totalAssetsUsd: tvlUsd,
      tvlEvidence: tvlUsd != null ? `Hyperliquid vault account value $${Math.round(tvlUsd).toLocaleString()}` : null,
    };

    return {
      symbol: json.name || "HL Vault",
      name: json.name || "Hyperliquid Vault",
      chain: "hyperliquid_l1",
      vaultAddress: addr,
      project: "hyperliquid",
      source: "hyperliquid_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
