/**
 * Fluid lending token metrics via Instadapp API.
 */
import fetch from "node-fetch";
import { normalizePoolChain } from "./poolAddress.js";

const CHAIN_NUM = { ethereum: 1, arbitrum: 42161, base: 8453 };

async function fetchFluidTokenDetail(chainNum, tokenAddress) {
  const resp = await fetch(`https://api.fluid.instadapp.io/v2/lending/${chainNum}/tokens/${tokenAddress}`, {
    headers: { "User-Agent": "cryptoanalyzer/fluid-lending" },
  });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

export async function fetchFluidLendingToken({ chain, nameHint }) {
  const chainNum = CHAIN_NUM[normalizePoolChain(chain)] || 1;
  const hint = String(nameHint || "").toLowerCase();

  try {
    const resp = await fetch(`https://api.fluid.instadapp.io/v2/lending/${chainNum}/tokens`, {
      headers: { "User-Agent": "cryptoanalyzer/fluid-lending" },
    });
    if (!resp.ok) return null;
    const json = await resp.json().catch(() => null);
    const tokens = Array.isArray(json?.data) ? json.data : [];
    let hit =
      tokens.find((t) => {
        const hay = `${t?.symbol || ""} ${t?.name || ""} ${t?.asset?.symbol || ""}`.toLowerCase();
        return hint && hay.includes(hint.replace(/\s+/g, ""));
      }) ||
      tokens.find((t) => /wsteth/i.test(`${t?.symbol}${t?.name}${t?.asset?.symbol}`) && /wsteth/i.test(hint));

    if (hit?.address) {
      const detail = await fetchFluidTokenDetail(chainNum, hit.address);
      if (detail?.address) hit = detail;
    }

    if (!hit) {
      const totalTvl = Number(json?.totalAssetsInUsd);
      if (isFinite(totalTvl) && totalTvl > 0 && !hint) {
        return {
          symbol: "Fluid lending",
          chain: normalizePoolChain(chain),
          project: "fluid",
          source: "fluid_api",
          scoring: {
            totalAssetsUsd: totalTvl,
            tvlEvidence: `Fluid API totalAssetsInUsd $${Math.round(totalTvl).toLocaleString()}`,
          },
        };
      }
      return null;
    }

    const decimals = Number(hit?.decimals) || 18;
    const totalAssets = Number(hit?.totalAssets) / 10 ** decimals;
    const price = Number(hit?.asset?.price);
    const supplyUsd =
      isFinite(totalAssets) && isFinite(price) && totalAssets > 0
        ? totalAssets * price
        : Number(json?.totalAssetsInUsd) || null;
    const liq = hit?.liquiditySupplyData || {};
    const supplyRaw = Number(liq.supply ?? hit?.totalAssets);
    const withdrawableRaw = Number(liq.withdrawable ?? liq.withdrawableUntilLimit);
    let util = Number(hit?.liquiditySupplyData?.utilization ?? hit?.utilization);
    if (!isFinite(util) && isFinite(supplyRaw) && supplyRaw > 0 && isFinite(withdrawableRaw)) {
      util = 1 - withdrawableRaw / supplyRaw;
    }
    const apy = Number(hit?.totalRate ?? hit?.supplyRate);

    const scoring = {
      totalAssetsUsd: isFinite(supplyUsd) && supplyUsd > 0 ? supplyUsd : null,
      tvlEvidence: isFinite(supplyUsd)
        ? `Fluid API ${hit.asset?.symbol || hit.symbol} ~$${Math.round(supplyUsd).toLocaleString()}`
        : `Fluid API total lending TVL`,
      utilization: isFinite(util) ? (util > 1 ? util / 100 : Math.max(0, Math.min(1, util))) : null,
      utilizationEvidence: isFinite(util)
        ? `Fluid supply utilization ${(Math.max(0, Math.min(1, util > 1 ? util / 100 : util)) * 100).toFixed(1)}% (1 − withdrawable/supply)`
        : null,
      apyPct: isFinite(apy) ? apy : null,
      oracleType: "Chainlink",
      oracleEvidence: "Fluid / Instadapp lending oracles",
    };

    return {
      symbol: hit.asset?.symbol || hit.symbol || "Fluid",
      name: hit.name || hit.symbol,
      chain: normalizePoolChain(chain),
      vaultAddress: hit.address ? String(hit.address).toLowerCase() : null,
      underlyingTokens: hit.assetAddress ? [String(hit.assetAddress).toLowerCase()] : [],
      project: "fluid",
      source: "fluid_api",
      scoring,
      ...scoring,
    };
  } catch {
    return null;
  }
}
