# Pool-Level Scoring Methodology
**Version:** 1.0  
**Date:** 2026-05-25  
**Author:** Tria Finance Risk Team

---

## Purpose

This document defines criteria for scoring a **specific pool, vault, or position** within a DeFi protocol.

Pool scoring is complementary to protocol-level scoring — it captures risks that are position-specific rather than protocol-wide: the quality of the deposited asset, exit liquidity, oracle setup, collateral parameters, depositor concentration, and yield sustainability.

**Universal design principle:** every criterion returns a score in **[0.0 — 1.0]** or **N/A**. N/A values are excluded from the final calculation and the remaining weights are renormalized to 100%. This prevents structurally absent risks (e.g., no oracle in a pure staking pool) from unfairly penalizing a position.

---

## Scoring Model — Criteria & Weights

| # | Criterion | Weight | N/A when |
|---|-----------|-------:|----------|
| P.1 | Asset Quality | 20% | — |
| P.2 | Liquidity & Exit Risk | 15% | — |
| P.3 | Oracle Quality | 15% | Pure staking, fixed-rate (no liquidation) |
| P.4 | Parameter Safety | 10% | Staking, LP pools (no collateral params) |
| P.5 | Depeg / Volatility Risk | 8% | — |
| P.6 | Pool Age | 5% | — |
| P.7 | Depositor Concentration | 10% | — |
| P.8 | Pool TVL | 7% | — |
| P.9 | Yield Quality & Sustainability | 5% | — |
| P.10 | Curator / Risk Manager | 5% | Non-curated pools (vanilla lending, staking, AMM) |

**Total: 100%** (renormalized when N/A criteria are excluded)

**Final Pool Score (0–100):**
```
pool_score = sum(score_i × weight_i for available criteria) 
           / sum(weight_i for available criteria) × 100
```

---

## P.1 — Asset Quality

**What:** The risk tier of the core asset being deposited or used as collateral. Captures liquidity depth, price stability, and smart contract wrapping risk of the underlying token.

**Data sources:**
- Token address → CoinGecko / DefiLlama for market cap, liquidity
- Protocol docs → identify the exact asset (e.g., distinguish weETH from ETH)
- DeFiSafety / audit reports for wrapped/synthetic tokens

**Scoring:**

| Asset Type | Examples | Score |
|------------|----------|------:|
| Native chain asset | ETH, WBTC, WETH | 1.00 |
| Major fiat-backed stablecoin | USDC, USDT | 0.95 |
| Battle-tested algo/over-coll stable | DAI/USDS, FRAX | 0.80 |
| Yield-bearing stablecoin | sDAI, sUSDe, cUSDC | 0.85 |
| Liquid Staking Token (LST) | wstETH, rETH, cbETH | 0.80 |
| Liquid Restaking Token (LRT) | weETH, rsETH, ezETH | 0.65 |
| Pendle Principal Token (PT) | PT-weETH, PT-sUSDe | 0.70 |
| Top-100 governance / protocol token | AAVE, CRV, ARB | 0.60 |
| LP token (audited DEX) | Curve LP, Balancer BPT | 0.50 |
| Small-cap / illiquid token | misc protocol tokens | 0.30 |

> **Note for multi-asset pools:** use the score of the *lowest-quality* asset in the pool. A USDC/USDT pool = 0.95; a USDC/CRV pool = 0.60.

---

## P.2 — Liquidity & Exit Risk

**What:** How easily can you exit the position at full value? Covers utilization-driven lock (lending), withdrawal queues (staking), time-to-maturity (fixed-term), and cooldown periods (structured vaults).

**Data sources:**
- Lending: protocol dashboard or API → current utilization rate
- Staking/LRT: protocol docs or on-chain queue estimator (e.g., rated.network for ETH validator queue)
- PT/structured: maturity date from protocol UI

**Scoring by pool type:**

**Lending (money market):**
| Utilization | Score |
|------------|------:|
| < 70% | 1.00 |
| 70–80% | 0.85 |
| 80–90% | 0.60 |
| 90–95% | 0.30 |
| ≥ 95% | 0.10 |

**Staking / LRT withdrawal queue:**
| Queue wait | Score | +0.05 if secondary market (DEX sell) |
|-----------|------:|--------------------------------------|
| Instant | 1.00 | |
| ≤ 1 day | 0.90 | |
| 2–7 days | 0.75 | |
| 8–30 days | 0.55 | |
| > 30 days | 0.30 | |

**AMM / LP:**
| Condition | Score |
|-----------|------:|
| Can exit anytime with low slippage | 0.90 |
| Deep single-sided only | 0.70 |

**Pendle PT (fixed maturity):**
| Days to maturity | Score |
|-----------------|------:|
| Matured (≥ par) | 1.00 |
| ≤ 30 days | 0.70 |
| 31–90 days | 0.80 |
| > 90 days | 0.90 |
> Subtract 0.30 if no active secondary market for the PT token.

**Structured vault (e.g., Ethena-style with cooldown):**
| Cooldown | Score |
|---------|------:|
| ≤ 1 day | 0.85 |
| 2–7 days | 0.70 |
| > 7 days | 0.50 |

---

## P.3 — Oracle Quality

**What:** How the protocol determines asset prices for liquidations, accounting, or redemptions. A compromised or manipulable oracle can result in bad debt or cascading liquidations.

**N/A:** Pure staking pools and fixed-rate positions where no price oracle is needed for redemption. Mark as N/A — the weight is excluded from the total.

**Data sources:**
- Protocol docs → "Oracle" or "Price Feed" section
- Etherscan → read oracle address from pool/market contract
- Chainlink feeds directory: data.chain.link

**Scoring:**

| Oracle Type | Description | Score |
|-------------|-------------|------:|
| Chainlink (direct) | Single Chainlink feed; heartbeat + deviation threshold | 1.00 |
| Chainlink (derived) | Computed from 2+ Chainlink feeds (e.g., wstETH/USD via stETH/ETH × ETH/USD) | 0.90 |
| Pyth + on-chain TWAP backup | Push oracle with fallback | 0.80 |
| On-chain TWAP ≥ 30 min | Uniswap V3 TWAP, long window | 0.70 |
| Custom multi-source | Proprietary oracle with multiple price sources (e.g., Fluid) | 0.65 |
| On-chain TWAP < 30 min | Short TWAP window — sandwich / flash-loan manipulation risk | 0.40 |
| Single-source custom | Unaudited, single price source | 0.30 |

---

## P.4 — Parameter Safety

**What:** How aggressively the pool's risk parameters are set. For lending markets: the maximum loan-to-value ratio (LLTV/LTV) and how full the supply/borrow caps are. Aggressive LTVs reduce the liquidation buffer; full caps block new supply and may trap existing depositors.

**N/A:** Pure staking pools, LP positions — no collateral or cap parameters exist.

**Data sources:**
- Protocol UI or contract → `lltv()`, `ltv()`, `liquidationThreshold()`
- Protocol risk dashboard (Gauntlet, Chaos Labs, B.Protocol reports)
- On-chain: `supplyCap`, `borrowCap` from pool/market contract

**Scoring:**

**LLTV (Liquidation LTV) — hairline before bad debt:**
| Max LLTV | Score |
|---------|------:|
| ≤ 70% | 1.00 |
| 71–80% | 0.85 |
| 81–86% | 0.70 |
| 87–90% | 0.50 |
| 91–91.5% | 0.35 |
| > 91.5% | 0.20 |

**Cap utilization — supply or borrow cap % filled:**
| Cap fill | Multiplier |
|---------|-----------|
| < 70% | × 1.00 |
| 70–85% | × 0.85 |
| 85–95% | × 0.65 |
| ≥ 95% | × 0.40 |

```
score_P4 = lltv_score × cap_multiplier
```

> If both supply and borrow caps exist, use the more conservative (lower) multiplier.

---

## P.5 — Depeg / Volatility Risk

**What:** The risk that the pool's core asset loses its peg to the expected value, or exhibits significant price volatility that can trigger liquidation cascades. Distinct from P.1 (which scores the *quality tier*) — P.5 scores the *peg stability* specifically.

**Data sources:**
- Historical price data: CoinGecko, DefiLlama
- Depeg events: search "[token] depeg" on Twitter/X and Rekt News
- For PT tokens: days to maturity (converges to par at maturity)

**Scoring:**

| Asset / Situation | Score |
|-------------------|------:|
| No peg (ETH, WBTC — no peg to lose) | 1.00 |
| Fiat-backed stablecoin (USDC, USDT) | 0.95 |
| Battle-tested over-collateralized stable (DAI/USDS) | 0.80 |
| LST (wstETH, rETH) — ETH-backed, minimal depeg history | 0.85 |
| LRT (weETH, rsETH) — LST + restaking risk layer | 0.65 |
| Pendle PT ≤ 90 days to maturity (converges to par) | 0.85 |
| Pendle PT > 90 days (discounted price, pre-maturity uncertainty) | 0.70 |
| Synthetic stable (Ethena USDe) — funding-rate dependent | 0.70 |
| Algorithmic stable with limited track record | 0.40 |

---

## P.6 — Pool Age

**What:** How long *this specific pool or vault* has been live. A new vault on a mature protocol still has unproven parameter configurations, curator behavior, and usage patterns. Distinct from protocol age (a protocol-level criterion).

**Data sources:**
- On-chain: pool/vault contract deployment transaction (first tx on Etherscan)
- Protocol UI: "Created" date on vault/market page

**Scoring:**

| Age | Score |
|-----|------:|
| < 1 month | 0.10 |
| 1–3 months | 0.30 |
| 3–6 months | 0.50 |
| 6–12 months | 0.70 |
| 12–24 months | 0.85 |
| > 24 months | 1.00 |

---

## P.7 — Depositor Concentration Risk

**What:** What fraction of the pool's TVL is controlled by the top depositors? A single whale holding 70%+ of pool TVL can cause a near-complete drain in one transaction — liquidating remaining positions and causing bad debt. Even without malicious intent, a large depositor redeeming normally can exhaust available liquidity.

**Data sources:**
- On-chain: filter `Deposit` / `Mint` events, aggregate by address
- Protocol subgraphs (The Graph): position data per address
- Dune Analytics dashboards (many protocols have community-built dashboards)
- Nansen, arkham.intelligence for whale identification

**Scoring:**

| Situation | Score |
|-----------|------:|
| Top-1 depositor < 10% of pool TVL | 1.00 |
| Top-1 < 25% AND Top-3 < 40% | 0.85 |
| Top-1 < 25% AND Top-3 40–60% | 0.70 |
| Top-1 25–50% | 0.50 |
| Top-1 50–70% | 0.30 |
| Top-1 > 70% | 0.10 |

> **Exception:** if the top depositor is a smart contract routing retail funds (e.g., a yield aggregator), and that aggregator itself has distributed depositors, downgrade the risk by one tier.

---

## P.8 — Pool TVL

**What:** The absolute size of capital in the pool. Small pools have high per-dollar price impact, limited ability to handle large withdrawals, and are often less curated. This criterion is independent of protocol TVL — a $500K pool in a $10B protocol is still a $500K pool.

**Data sources:**
- DefiLlama Yields API: `GET https://yields.llama.fi/pools` → filter by pool address or protocol+symbol
- Protocol dashboard: pool detail page
- On-chain: token balance of vault/pool contract

**Scoring:**

| Pool TVL | Score |
|---------|------:|
| > $100M | 1.00 |
| $10M – $100M | 0.80 |
| $1M – $10M | 0.60 |
| $500K – $1M | 0.40 |
| < $500K | 0.20 |

---

## P.9 — Yield Quality & Sustainability

**What:** Two separate signals combined: (1) **yield source** — is the APY generated by organic demand or inflated by token emissions? (2) **APY stability** — how volatile is the APY over the past 30 days? Stable organic yield = sustainable position. High-emission-driven APY = mercenary capital risk; yield disappears when emissions end.

**Data sources:**
- DefiLlama Yields API: `apyBase` (organic) vs `apyReward` (emissions) breakdown
- Protocol tokenomics: emission schedule, when do incentives end?
- Historical APY: DefiLlama `chart` endpoint for a given pool

**Scoring:**

**Step 1 — Yield source score:**
```
base_share = apyBase / (apyBase + apyReward)   # fraction that is organic
```
| base_share | Score |
|-----------|------:|
| ≥ 80% organic | 1.00 |
| 60–80% organic | 0.85 |
| 40–60% organic | 0.70 |
| 20–40% organic | 0.50 |
| < 20% organic (mostly emissions) | 0.30 |
| 0% organic (pure incentives) | 0.15 |

**Step 2 — APY stability (CV over 30 days):**
```
CV = stddev(apy_daily_30d) / mean(apy_daily_30d)
```
| CV | Multiplier |
|----|-----------|
| < 0.10 | × 1.00 |
| 0.10–0.25 | × 0.90 |
| 0.25–0.50 | × 0.75 |
| > 0.50 | × 0.60 |

```
score_P9 = yield_source_score × apy_stability_multiplier
```

---

## P.10 — Curator / Risk Manager Quality

**What:** For curated vaults (Morpho Blue MetaMorpho, Euler EVault, similar architectures), the curator defines which markets the vault uses, sets allocation limits, and updates risk parameters. A professional curator with a track record significantly reduces parameter risk beyond what the protocol code alone guarantees.

**N/A:** Standard lending markets, staking, LP pools — wherever no human/DAO curator manages risk parameters on top of the protocol.

**Data sources:**
- Protocol UI: curator address or name listed on vault page
- Curator's website / governance forum: track record, methodology
- Morpho-specific: `morpho.xyz/vault/{address}` → curator field

**Scoring:**

| Curator Type | Examples | Score |
|-------------|----------|------:|
| Institutional risk manager, public methodology, audited | Gauntlet, B.Protocol, Steakhouse Financial, Chaos Labs | 1.00 |
| Known team, public allocation policy, active monitoring | Re7 Labs, MEV Capital, Smokehouse | 0.80 |
| Known team, limited public methodology | — | 0.60 |
| Anonymous or unverifiable curator | — | 0.30 |
| No curator (permissionless market, no parameter governance) | — | N/A |

---

## N/A Matrix by Pool Type

Use this table to quickly identify which criteria apply:

| Criterion | Lending | Staking / LRT | AMM / LP | Pendle PT | Structured Vault |
|-----------|:-------:|:-------------:|:--------:|:---------:|:----------------:|
| P.1 Asset Quality | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.2 Liquidity & Exit | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.3 Oracle Quality | ✓ | **N/A** | ✓ | ✓ | ✓ |
| P.4 Parameter Safety | ✓ | **N/A** | **N/A** | ✓* | ✓* |
| P.5 Depeg Risk | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.6 Pool Age | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.7 Concentration | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.8 Pool TVL | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.9 Yield Quality | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.10 Curator Quality | ✓** | **N/A** | **N/A** | **N/A** | ✓** |

\* Only if the pool has explicit LLTV / liquidation parameters  
\*\* Only if the pool uses a curator-based architecture (MetaMorpho, EVault, etc.)

---

## Qualitative Flags (not scored, always check manually)

These factors don't fit cleanly into a 0–1 scale but should block or flag a position if present:

- **Cross-protocol dependency depth** — count how many protocols stand between you and the base asset. Depth > 2 warrants manual review regardless of scores. Example: Pendle PT(weETH) → weETH (ether.fi) → stETH (Lido) = depth 3.
- **Recent parameter change** — if LLTV or allocation limits were changed in the last 30 days, re-evaluate P.4 and understand *why*.
- **Supply cap near full (>95%) with no governance action** — indicates either overwhelming demand or a misconfiguration. Check governance forum for discussion.
- **Reward token is the same protocol's native token** — circular: protocol spends its own token to attract TVL that inflates token price. One sell-off can cascade both metrics.

---

## Worked Example: Morpho steakUSDC vault (supply side)

| # | Criterion | Input | Score |
|---|-----------|-------|------:|
| P.1 | Asset Quality | USDC → `major_stable` | 0.95 |
| P.2 | Liquidity & Exit | lending, utilization 72% | 0.85 |
| P.3 | Oracle Quality | Chainlink (ETH/USD, cbETH/ETH) | 0.90 |
| P.4 | Parameter Safety | LLTV 86%, cap fill 60% | 0.70 |
| P.5 | Depeg Risk | USDC → `hard_stable` | 0.95 |
| P.6 | Pool Age | 18 months | 0.85 |
| P.7 | Concentration | Top-1: 15%, Top-3: 38% | 0.85 |
| P.8 | Pool TVL | ~$180M | 1.00 |
| P.9 | Yield Quality | 70% organic, CV=0.18 | 0.77 |
| P.10 | Curator | Steakhouse Financial | 1.00 |

```
pool_score = sum(score × weight) / 100 × 100
           = (0.95×20 + 0.85×15 + 0.90×15 + 0.70×10 + 0.95×8
             + 0.85×5 + 0.85×10 + 1.00×7 + 0.77×5 + 1.00×5) / 100 × 100
           = 88.5 / 100 × 100 = 88.5
```

**Pool Score: 88.5 / 100**

---

*Document version 1.0 — 2026-05-25. To be integrated into the Risk Engine pool scoring module.*
