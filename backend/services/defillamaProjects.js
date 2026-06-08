const PROJECT_ALIASES = {
  morpho: ["morpho-blue", "morpho-aave", "morpho-compound"],
  avantis: ["avantis"],
  aave: ["aave-v3", "aave-v2", "aave"],
  pendle: ["pendle"],
  euler: ["euler-v2", "euler"],
  curve: ["curve-dex", "curve"],
  compound: ["compound-v3", "compound"],
  uniswap: ["uniswap-v3", "uniswap-v2"],
  balancer: ["balancer-v2", "balancer"],
  ethena: ["ethena"],
  maple: ["maple-finance", "maple"],
  fluid: ["fluid", "instadapp"],
  yearn: ["yearn-finance", "yearn"],
  convex: ["convex-finance"],
  sky: ["sky-lending", "maker"],
};

export function projectCandidates(project) {
  const p = String(project || "").trim().toLowerCase();
  const aliases = PROJECT_ALIASES[p] || [p];
  return [...new Set([p, ...aliases].filter(Boolean))];
}

export { PROJECT_ALIASES };
