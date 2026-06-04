# Pool-Level Scoring Methodology
**Version:** 2.0  
**Date:** 2026-05-25 (updated criteria numbering & P.5 HHI/WSC model)  
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
| P.5 | Depositor Concentration Risk | 8% | — |
| P.6 | Pool Age | 5% | — |
| P.7 | Pool TVL | 7% | — |
| P.8 | Yield Quality & Sustainability | 5% | — |
| P.9 | Curator / Risk Manager | 5% | Non-curated pools (vanilla lending, staking, AMM) |

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

**COMMENTS**
9/10 - Clear proof methodology. Simple underlying idea. Still need to be revised by hand, especially in cases like Pendle and so on.



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
| Small-cap / illiquid token | misc protocol tokens | 0.10 |

**small cap tokens weight reduced from 0.3 to 0.1 **

> **Note for multi-asset pools:** use the score of the *lowest-quality* asset in the pool. A USDC/USDT pool = 0.95; a USDC/CRV pool = 0.60.

---

## P.2 — Liquidity & Exit Risk

**What:** How easily can you exit the position at full value? Covers utilization-driven lock (lending), withdrawal queues (staking), time-to-maturity (fixed-term), and cooldown periods (structured vaults).

**Data sources:**
- Lending: protocol dashboard or API → current utilization rate
- Staking/LRT: protocol docs or on-chain queue estimator (e.g., rated.network for ETH validator queue)
- PT/structured: maturity date from protocol UI

**COMMENTS**

8/10 - Not so clear proof methodology. Simple underlying idea. 
- Slippage criteria is good. 
- Utiliztion for lending markets - I think is ok for now, but in the future should be combined with TVL estimation. 
- !!! Staking LRT withdrawal criteria sholud criticaly influence the investment limits. 
From math point of view, dividing criteria like that will bring to the situation of unfair estimation in highly volatile period for pool/project/coin
- Not so clear why 1 day on staking - 0.9 but 1 day for structured vault is 0.85 - **discuss** how to re-estimate

- **Insert redeem cost calculation coef.**


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

**COMMENTS**

9/10 - Clear proof methodology. Simple underlying idea. I think it is ok for now. The exact vaules of coefficients are **discussable** 


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

**COMMENTS**

7.5/10 - Not so clear proof methodology. Good underlying idea.

I think this criteria also shouldn't be estimated without context of liquidity. Current model even with 10% weight will affect the final score in too much.  
More than it, with current liquidation mechanisms updates it is hard to say what will be more safe for particular investment strategy.

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

## P.5 — Depositor Concentration Risk

**What:** What fraction of the pool's TVL is controlled by the top depositors? A single whale holding 70%+ of pool TVL can cause a near-complete drain in one transaction — liquidating remaining positions and causing bad debt. Even without malicious intent, a large depositor redeeming normally can exhaust available liquidity.


**Data sources:**
- On-chain: filter `Deposit` / `Mint` events, aggregate by address
- Protocol subgraphs (The Graph): position data per address
- Dune Analytics dashboards (many protocols have community-built dashboards)
- Nansen, arkham.intelligence for whale identification

**Scoring:**

## Step 1 — Compute concentration

The liquidity concentration of the pool is measured using the Herfindahl-Hirschman Index (HHI):
```
HHI= $\sum_{i=1}^{N} s_i^2$
```
where:

- ( s_i ) — share of total pool TVL controlled by depositor ( i );
    
- ( N ) — total number of depositors.
    

The HHI metric captures the overall concentration structure of liquidity within the protocol. Higher values indicate stronger dependence on a small number of liquidity providers.

---

## Step 2 — Normalize HHI

The raw HHI value is transformed into a normalized score within the interval ([0,1]):
```
ScoreHHI = $1 - \sqrt{\frac{HHI}{0.30}}$
```
where:

- `0.30` represents the critical concentration threshold.
    

The square root transformation increases sensitivity in high-risk concentration zones.

### HHI Interpretation

|HHI|Interpretation|
|---|---|
|< 0.01|Highly decentralized|
|0.01 – 0.03|Healthy|
|0.03 – 0.07|Moderate concentration|
|0.07 – 0.15|High concentration|
|0.15 – 0.30|Dangerous|
|> 0.30|Critical|

---

## Step 3 — Compute withdrawal fragility

Withdrawal fragility is evaluated using the Withdrawal Shock Capacity metric:

$WSC{50}$

where:

- ( WSC_{50} ) represents the minimum number of largest depositors whose simultaneous withdrawal removes at least 50% of the total pool TVL.
    

This metric estimates how easily the protocol liquidity can be destabilized through coordinated or correlated withdrawals.

### WSC Interpretation

|WSC_50|Interpretation|
|---|---|
|> 30|Excellent|
|15 – 30|Strong|
|8 – 15|Acceptable|
|4 – 8|Fragile|
|2 – 4|Dangerous|
|1|Catastrophic|

---

## Step 4 — Normalize WSC

The WSC metric is normalized using logarithmic scaling:
```
ScoreWSC= $\frac{\log(1 + WSC)}{\log(31)}$
```

where:

- `31` corresponds to the selected upper normalization boundary.
    

The logarithmic transformation reflects the diminishing marginal improvement in resilience as the number of independent liquidity providers increases.

---

## Step 5 — Final aggregation

The final liquidity resilience score is computed using the harmonic mean of the two normalized metrics:
```
FinalScore=$2⋅ScoreHHI⋅ScoreWSCScoreHHI+ScoreWSCFinalScore$ = $\frac{2 \cdot Score_{HHI} \cdot Score_{WSC}} {Score_{HHI} + Score_{WSC}}$
```

The harmonic aggregation penalizes imbalance between concentration risk and withdrawal fragility. As a result, a protocol cannot achieve a high final score if one of the two dimensions remains critically weak.

---

## Final Score Interpretation

|Final Score|Risk Level|
|---|---|
|0.85 – 1.00|Very resilient|
|0.70 – 0.85|Healthy|
|0.50 – 0.70|Moderate risk|
|0.30 – 0.50|High risk|
|0.15 – 0.30|Dangerous|
|< 0.15|Critical|

Example 1. Pendle pool 

https://app.pendle.finance/trade/pools/0x299674f6da858f903d77486fba50bc9f2e0db24d/zap/in?chain=arbitrum&page=1

### TOP 10 depositors by pool sharing

Shares of top 10 depositors

| Share   | Squared |
| ------- | ------- |
| 0.22456 | 0.05043 |
| 0.17085 | 0.02919 |
| 0.16537 | 0.02735 |
| 0.10922 | 0.01193 |
| 0.07148 | 0.00511 |
| 0.05823 | 0.00339 |
| 0.03565 | 0.00127 |
| 0.02004 | 0.00040 |
| 0.01694 | 0.00029 |
| 0.01124 | 0.00013 |

1. HHI= $\sum_{i=1}^{N} s_i^2$ = 0.13 

2. ScoreHHI = $1 - \sqrt{\frac{HHI}{0.30}}$ = 0.34

3. WSC{50} = 3 (From table it is clearly seen that first 3 depositors share about 56% of total liquidity)

4. ScoreWSC= $\frac{\log(1 + WSC)}{\log(31)}$ = 0.4

5. Then, final score  
   
   FinalScore = $\frac{2 \cdot Score_{HHI} \cdot Score_{WSC}} {Score_{HHI} + Score_{WSC}}$ = 0.2745 / 0.74 = 0.37


6. Final Score Interpretation -> high risk, close to dangerous

| Final Score | Risk Level     |
| ----------- | -------------- |
| 0.85 – 1.00 | Very resilient |
| 0.70 – 0.85 | Healthy        |
| 0.50 – 0.70 | Moderate risk  |
| 0.30 – 0.50 | High risk      |
| 0.15 – 0.30 | Dangerous      |
| < 0.15      | Critical       |
 

---

## P.6 — Pool Age

**What:** How long *this specific pool or vault* has been live. A new vault on a mature protocol still has unproven parameter configurations, curator behavior, and usage patterns. Distinct from protocol age (a protocol-level criterion).

**COMMENTS**
9/10 - Clear proof methodology. Good underlying idea. I think will be more useful as coefficient in calculation process in other criteria.

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

## P.7 — Pool TVL

**What:** The absolute size of capital in the pool. Small pools have high per-dollar price impact, limited ability to handle large withdrawals, and are often less curated. This criterion is independent of protocol TVL — a $500K pool in a $10B protocol is still a $500K pool.

**COMMENTS**
10/10 - Clear proof methodology. As said, as an independent criteria is less useful rather than as part of inner calculation for other criteria.

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

## P.8 — Yield Quality & Sustainability

**What:** Two separate signals combined: (1) **yield source** — is the APY generated by organic demand or inflated by token emissions? (2) **APY stability** — how volatile is the APY over the past 30 days? Stable organic yield = sustainable position. High-emission-driven APY = mercenary capital risk; yield disappears when emissions end.

**COMMENTS**
9/10 - Clear proof methodology. Very good idea. 


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
score_P8 = yield_source_score × apy_stability_multiplier
```

---

## P.9 — Curator / Risk Manager Quality

**What:** For curated vaults (Morpho Blue MetaMorpho, Euler EVault, similar architectures), the curator defines which markets the vault uses, sets allocation limits, and updates risk parameters. A professional curator with a track record significantly reduces parameter risk beyond what the protocol code alone guarantees.

**COMMENTS**
7/10 - Idk what how good is that proof methodology. **DISCUSS**

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
| Known team, limited public methodology | KPK, Telos Consilium, Galaxy, Tulipa Capital, Anthias Labs, Gami Labs, AlphaPing, Yearn | 0.60 |
| Anonymous or unverifiable curator | UltraYield Curator, Vault Bridge, Alterscope, Apostro, Muscadine, 9Summits, Tanken Capital, YFarmer, Relend Network, Hakutora, Clearstar | 0.30 |
| No curator (permissionless market, no parameter governance) | Fully permissionless Morpho markets, unmanaged Euler markets, direct peer-to-peer lending deployments | N/A |

---

## N/A Matrix by Pool Type

Use this table to quickly identify which criteria apply:

| Criterion | Lending | Staking / LRT | AMM / LP | Pendle PT | Structured Vault |
|-----------|:-------:|:-------------:|:--------:|:---------:|:----------------:|
| P.1 Asset Quality | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.2 Liquidity & Exit | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.3 Oracle Quality | ✓ | **N/A** | ✓ | ✓ | ✓ |
| P.4 Parameter Safety | ✓ | **N/A** | **N/A** | ✓* | ✓* |
| P.5 Depositor Risk | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.6 Pool Age | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.7 Pool TVL | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.8 Yield Quality | ✓ | ✓ | ✓ | ✓ | ✓ |
| P.9 Curator Quality | ✓** | **N/A** | **N/A** | **N/A** | ✓** |

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
| P.5 | Depositor Concentration | Top-1: 15%, Top-3: 38% (healthy HHI proxy) | 0.85 |
| P.6 | Pool Age | 18 months | 0.85 |
| P.7 | Pool TVL | ~$180M | 1.00 |
| P.8 | Yield Quality | 70% organic, CV=0.18 | 0.77 |
| P.9 | Curator | Steakhouse Financial | 1.00 |

```
pool_score = sum(score × weight) / sum(weight) × 100
           = (0.95×0.20 + 0.85×0.15 + 0.90×0.15 + 0.70×0.10 + 0.85×0.08
             + 0.85×0.05 + 1.00×0.07 + 0.77×0.05 + 1.00×0.05) / 1.00 × 100
           ≈ 87.6
```

**Pool Score: ~87.6 / 100**

---

*Document version 2.0 — integrated in Risk Engine `backend/llm/poolScoring.js`.*
