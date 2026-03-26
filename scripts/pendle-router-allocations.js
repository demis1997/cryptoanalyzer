#!/usr/bin/env node
/**
 * Pendle Router allocations (Etherscan-only).
 *
 * What it does:
 * 1) Pull wallet ERC-20 transfers from Etherscan.
 * 2) Filter transfers where the counterparty is the Pendle Router.
 * 3) For each discovered token contract, query current wallet balance via Etherscan `tokenbalance`.
 *
 * Usage:
 *   ETHERSCAN_API_KEY=... node scripts/pendle-router-allocations.js 0xYourWallet
 *
 * Optional:
 *   ROUTER=0x00000000005BBB0EF59571E58418F9a4357b68A0 node scripts/pendle-router-allocations.js 0xYourWallet
 */
import fetch from "node-fetch";

const DEFAULT_ROUTER = "0x00000000005bbb0ef59571e58418f9a4357b68a0"; // Pendle Router V3
const CHAIN_ID = 1;

function isAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || "").trim());
}

function toLowerAddress(v) {
  return String(v || "").trim().toLowerCase();
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function formatUnits(raw, decimals) {
  const d = Number(decimals);
  const cleaned = String(raw || "0").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  let bi;
  try {
    bi = BigInt(cleaned);
  } catch {
    return null;
  }
  if (!Number.isFinite(d) || d <= 0) return bi.toString();
  const base = 10n ** BigInt(Math.min(30, Math.max(0, d)));
  const whole = bi / base;
  const frac = bi % base;
  const fracStr = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

async function etherscanJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const json = await resp.json().catch(() => null);
  if (!json) throw new Error(`Invalid JSON from ${url}`);
  return json;
}

async function getWalletErc20Transfers({ apiKey, wallet }) {
  const url =
    "https://api.etherscan.io/v2/api" +
    `?chainid=${CHAIN_ID}` +
    "&module=account&action=tokentx" +
    `&address=${encodeURIComponent(wallet)}` +
    "&startblock=0&endblock=99999999" +
    "&page=1&offset=2000" +
    "&sort=desc" +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const json = await etherscanJson(url);
  const result = Array.isArray(json?.result) ? json.result : [];
  return result;
}

async function getTokenBalance({ apiKey, wallet, tokenContract }) {
  const url =
    "https://api.etherscan.io/v2/api" +
    `?chainid=${CHAIN_ID}` +
    "&module=account&action=tokenbalance" +
    `&contractaddress=${encodeURIComponent(tokenContract)}` +
    `&address=${encodeURIComponent(wallet)}` +
    "&tag=latest" +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const json = await etherscanJson(url);
  return String(json?.result || "0");
}

async function getNativeEthBalance({ apiKey, wallet }) {
  const url =
    "https://api.etherscan.io/v2/api" +
    `?chainid=${CHAIN_ID}` +
    "&module=account&action=balance" +
    `&address=${encodeURIComponent(wallet)}` +
    "&tag=latest" +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const json = await etherscanJson(url);
  return String(json?.result || "0");
}

async function main() {
  const apiKey = mustEnv("ETHERSCAN_API_KEY");
  const walletArg = process.argv[2];
  if (!isAddress(walletArg)) {
    console.error("Usage: ETHERSCAN_API_KEY=... node scripts/pendle-router-allocations.js 0xYourWallet");
    process.exit(2);
  }
  const wallet = toLowerAddress(walletArg);
  const router = toLowerAddress(process.env.ROUTER || DEFAULT_ROUTER);

  const transfers = await getWalletErc20Transfers({ apiKey, wallet });
  const viaRouter = transfers.filter((t) => {
    const from = toLowerAddress(t?.from);
    const to = toLowerAddress(t?.to);
    return from === router || to === router;
  });

  const tokenMeta = new Map(); // contract -> { symbol, decimals }
  for (const t of viaRouter) {
    const c = toLowerAddress(t?.contractAddress);
    if (!isAddress(c)) continue;
    if (!tokenMeta.has(c)) {
      tokenMeta.set(c, {
        symbol: String(t?.tokenSymbol || "TOKEN"),
        decimals: Number(t?.tokenDecimal || 0),
      });
    }
  }

  console.log(`Wallet: ${wallet}`);
  console.log(`Router: ${router}`);
  console.log(`ERC-20 transfers fetched: ${transfers.length}`);
  console.log(`Transfers involving router: ${viaRouter.length}`);
  console.log(`Unique token contracts seen via router: ${tokenMeta.size}`);
  console.log("");

  const nativeWei = await getNativeEthBalance({ apiKey, wallet });
  const nativeEth = formatUnits(nativeWei, 18);
  console.log(`ETH balance: ${nativeEth} ETH`);
  console.log("");

  if (tokenMeta.size === 0) {
    console.log("No ERC-20 token contracts found via this router for this wallet (in the last 2000 transfers).");
    return;
  }

  const rows = [];
  for (const [contract, meta] of tokenMeta.entries()) {
    const balRaw = await getTokenBalance({ apiKey, wallet, tokenContract: contract }).catch(() => "0");
    const bal = formatUnits(balRaw, meta.decimals);
    const balNum = bal != null ? Number(bal) : NaN;
    rows.push({
      symbol: meta.symbol,
      contract,
      balance: bal ?? "0",
      _sort: Number.isFinite(balNum) ? balNum : 0,
    });
  }

  rows.sort((a, b) => b._sort - a._sort);

  const maxSymbol = Math.max(...rows.map((r) => r.symbol.length), 5);
  console.log(`${"TOKEN".padEnd(maxSymbol)}  BALANCE                 CONTRACT`);
  console.log(`${"-".repeat(maxSymbol)}  ----------------------  ------------------------------------------`);
  for (const r of rows) {
    if (r.balance === "0" || r.balance === "0.0") continue;
    console.log(`${r.symbol.padEnd(maxSymbol)}  ${String(r.balance).padEnd(22)}  ${r.contract}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

