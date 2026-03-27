import fetch from "node-fetch";

function splitChainPrefixedAddress(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)-(0x[a-fA-F0-9]{40})$/);
  if (!m) return { chainId: null, address: null };
  return { chainId: Number(m[1]), address: m[2] };
}

function chainNameFromId(id) {
  const n = Number(id);
  if (n === 1) return "Ethereum";
  if (n === 42161) return "Arbitrum";
  if (n === 10) return "Optimism";
  if (n === 8453) return "Base";
  if (n === 56) return "BNB Chain";
  return `Chain ${n}`;
}

function chainIdHintFromUrl(origin) {
  try {
    const u = new URL(String(origin || ""));
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const q = (u.searchParams.get("chain") || "").toLowerCase();
    const s = `${host} ${path} ${q}`;
    if (/\beth(ereum)?\b/.test(s)) return 1;
    if (/\barb(itrum)?\b/.test(s)) return 42161;
    if (/\bop(timism)?\b/.test(s)) return 10;
    if (/\bbase\b/.test(s)) return 8453;
    if (/\bbsc|bnb\b/.test(s)) return 56;
  } catch {
    // ignore
  }
  return 1; // default to ethereum for root pages
}

export async function getPendleMarketSnapshot({ origin, maxPages = 6, pageLimit = 100 } = {}) {
  const chainIdHint = chainIdHintFromUrl(origin);
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const skip = page * pageLimit;
    const url = `https://api-v2.pendle.finance/core/v2/markets/all?skip=${skip}&limit=${pageLimit}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
    }).catch(() => null);
    if (!resp || !resp.ok) break;
    const json = await resp.json().catch(() => null);
    const rows = Array.isArray(json?.results) ? json.results : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageLimit) break;
  }

  const filtered = all.filter((m) => Number(m?.chainId) === Number(chainIdHint));
  const use = filtered.length ? filtered : all;

  const tokenMap = new Map(); // addr|symbol -> row
  const contracts = [];
  const seenContracts = new Set();

  const addContract = (label, address, chainId, evidence) => {
    const a = String(address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(a)) return;
    if (seenContracts.has(a)) return;
    seenContracts.add(a);
    contracts.push({
      label,
      network: chainNameFromId(chainId),
      address,
      evidence,
    });
  };

  for (const m of use) {
    const chainId = Number(m?.chainId || 0) || chainIdHint;
    const marketAddr = String(m?.address || "");
    addContract(`Pendle Market: ${m?.name || "Market"}`, marketAddr, chainId, "Source: Pendle markets API");

    const pt = splitChainPrefixedAddress(m?.pt);
    const yt = splitChainPrefixedAddress(m?.yt);
    const sy = splitChainPrefixedAddress(m?.sy);
    const ua = splitChainPrefixedAddress(m?.underlyingAsset);
    if (pt.address) addContract(`PT (${m?.name || "Market"})`, pt.address, pt.chainId || chainId, "Source: Pendle markets API");
    if (yt.address) addContract(`YT (${m?.name || "Market"})`, yt.address, yt.chainId || chainId, "Source: Pendle markets API");
    if (sy.address) addContract(`SY (${m?.name || "Market"})`, sy.address, sy.chainId || chainId, "Source: Pendle markets API");
    if (ua.address) addContract(`Underlying token (${m?.name || "Market"})`, ua.address, ua.chainId || chainId, "Source: Pendle markets API");

    const symbol = String(m?.name || "").trim();
    const key = ua.address ? ua.address.toLowerCase() : symbol.toLowerCase();
    if (!key) continue;

    const tvl = Number(m?.details?.totalTvl || m?.details?.liquidity || 0);
    const current = tokenMap.get(key);
    if (!current) {
      tokenMap.set(key, {
        token: symbol || "Token",
        tokenAddress: ua.address || null,
        liquidityUsd: Number.isFinite(tvl) ? tvl : 0,
        evidence: [
          "Source: Pendle markets API",
          `https://api-v2.pendle.finance/core/v2/markets/all`,
        ],
      });
    } else {
      current.liquidityUsd += Number.isFinite(tvl) ? tvl : 0;
    }
  }

  const tokenLiquidity = Array.from(tokenMap.values())
    .filter((t) => Number.isFinite(t.liquidityUsd) && t.liquidityUsd > 0)
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))
    .slice(0, 120);

  return {
    chainId: chainIdHint,
    tokenLiquidity,
    contracts,
    evidence: [
      `Pendle markets snapshot: ${use.length} market rows (${filtered.length ? "chain-filtered" : "all chains fallback"})`,
    ],
  };
}

