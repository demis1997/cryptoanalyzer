import { fullYieldsPoolRow } from "./yieldsPoolRow.js";
import { normalizePoolChain } from "./poolAddress.js";
import { projectCandidates } from "./defillamaProjects.js";

function normSym(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function scoreCandidate(row, { symbol, chain, issuerSlugs, nameHint, vaultAddress, onChainTvlUsd }) {
  let score = Number(row?.tvlUsd) || 0;
  const rowSym = normSym(row?.symbol);
  const wantSym = normSym(symbol);
  const rowChain = normalizePoolChain(row?.chain);
  const wantChain = normalizePoolChain(chain);
  const proj = String(row?.project || "").toLowerCase();

  if (wantSym && rowSym === wantSym) score += 5e11;
  else if (wantSym && rowSym.includes(wantSym)) score += 2e11;
  if (wantChain && rowChain === wantChain) score += 1e10;
  if (issuerSlugs?.length && issuerSlugs.includes(proj)) score += 5e9;

  const hint = String(nameHint || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ");
  if (hint.length > 2) {
    const hay = `${row?.symbol || ""} ${row?.poolMeta || ""}`.toLowerCase();
    for (const w of hint.split(/\s+/)) {
      if (w.length > 3 && hay.includes(w)) score += 1e8;
    }
  }

  const vault = String(vaultAddress || "").toLowerCase();
  if (vault) {
    const under = (row?.underlyingTokens || []).map((t) => String(t).toLowerCase());
    const meta = String(row?.poolMeta || "").toLowerCase();
    if (under.includes(vault) || meta.includes(vault)) score += 1e12;
  }

  if (onChainTvlUsd && row?.tvlUsd) {
    const ratio = Math.min(row.tvlUsd, onChainTvlUsd) / Math.max(row.tvlUsd, onChainTvlUsd);
    if (ratio > 0.85) score += 3e10;
  }

  return score;
}

export function findBestYieldsPool(allPools, opts = {}) {
  const pools = Array.isArray(allPools) ? allPools : [];
  if (!pools.length) return null;

  const issuerSlugs = projectCandidates(opts.issuerSlug || opts.project || "");
  let candidates = pools;

  const sym = opts.symbol;
  const chain = opts.chain;
  if (sym) {
    const ns = normSym(sym);
    candidates = candidates.filter((p) => {
      const rs = normSym(p?.symbol);
      return rs === ns || rs.includes(ns) || ns.includes(rs);
    });
  }
  if (chain) {
    const want = normalizePoolChain(chain);
    const onChain = candidates.filter((p) => normalizePoolChain(p?.chain) === want);
    if (onChain.length) candidates = onChain;
  }
  if (issuerSlugs.length) {
    const onProj = candidates.filter((p) => issuerSlugs.includes(String(p?.project || "").toLowerCase()));
    if (onProj.length) candidates = onProj;
  }

  if (!candidates.length) return null;

  const scored = candidates.map((p) => ({
    row: p,
    score: scoreCandidate(p, { ...opts, issuerSlugs }),
  }));
  scored.sort((a, b) => b.score - a.score);
  return fullYieldsPoolRow(scored[0].row);
}
