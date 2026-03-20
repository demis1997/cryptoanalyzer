import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import fs from "fs";
import { chromium } from "playwright";
import {
  getDefiLlamaTvl as getDefiLlamaTvlFromModule,
  getDefiLlamaProtocolByUrl as getDefiLlamaProtocolByUrlFromModule,
  getDefiLlamaVolume24h as getDefiLlamaVolume24hFromModule,
  getDefiLlamaTotalRaisedUsd as getDefiLlamaTotalRaisedUsdFromModule,
  getDefiLlamaProtocolInformation as getDefiLlamaProtocolInformationFromModule,
  getDefiLlamaTokenLiquidityFromYields as getDefiLlamaTokenLiquidityFromYieldsFromModule,
} from "./backend/services/defillama.js";
import { buildHeuristicRiskAssessment as buildHeuristicRiskAssessmentFromModule } from "./backend/llm/riskHeuristics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
export { app };
export default app;
const PORT = process.env.PORT || 3000;

app.use(express.json());

// On Vercel, static assets are typically picked from `public/`.
// Serve `public/` first, then fall back to repo root for local/dev.
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.use(express.static(__dirname));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    routes: {
      analyze: "GET /api/analyze?url=...",
      riskSchema: "GET /api/risk-schema",
      riskAssessment: "POST /api/risk-assessment",
    },
  });
});

app.get("/api/analyze", async (req, res) => {
  const url = req.query.url;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url query parameter." });
  }

  const origin = normalizeUrl(url);

  try {
    const [tvl, contracts, txs, investors] = await Promise.all([
      getDefiLlamaTvlFromModule(origin).catch((err) => {
        console.error("DefiLlama TVL error:", err.message);
        return null;
      }),
      getEtherscanContracts(origin).catch((err) => {
        console.error("Etherscan contracts error:", err.message);
        return [];
      }),
      getTransactionsPerDay(origin).catch((err) => {
        console.error("Tx per day error:", err.message);
        return null;
      }),
      getInvestorsStub(origin).catch((err) => {
        console.error("Investors stub error:", err.message);
        return [];
      }),
    ]);

    return res.json({
      origin,
      contracts,
      tvl,
      investors,
      txsPerDay: txs,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error while analyzing protocol." });
  }
});

app.post("/api/llm-analyze", async (req, res) => {
  const { url, walletAddress } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' in request body." });
  }

  const origin = normalizeUrl(url);

  try {
    const defillama = await getDefiLlamaProtocolByUrlFromModule(origin).catch((err) => {
      console.warn("DefiLlama protocol match error:", err.message);
      return null;
    });

    const defiLlamaSlug =
      defillama?.slug ||
      (defillama?.defillamaUrl
        ? (() => {
            try {
              const u = new URL(defillama.defillamaUrl);
              const parts = u.pathname.split("/").filter(Boolean);
              return parts[parts.length - 1] || null;
            } catch {
              return null;
            }
          })()
        : null);

    const page = await fetchHtmlWithOptionalRender(origin);
    if (!page.ok) {
      return res.status(502).json({
        error: "Failed to fetch protocol website.",
        status: page.status,
      });
    }

    const html = page.html;

    // Heuristic extraction directly from the full HTML (no LLM).
    const tvlFromHtml = extractTvlFromHtml(html);
    const tokenLiquidity = (page.extracted?.tokenLiquidity?.length
      ? page.extracted.tokenLiquidity
      : extractTokenLiquidityFromHtml(html));

    // Fallback: if the submitted page doesn't expose token liquidity,
    // pull a best-effort token+TVL list from DefiLlama yields.
    let tokenLiquidityFinal = tokenLiquidity;
    if (
      Array.isArray(tokenLiquidity) &&
      tokenLiquidity.length === 0 &&
      defiLlamaSlug
    ) {
      const fromYields = await getDefiLlamaTokenLiquidityFromYieldsFromModule(defiLlamaSlug).catch(() => null);
      if (Array.isArray(fromYields) && fromYields.length) tokenLiquidityFinal = fromYields;
    }

    // Investors are not extracted; we show DefiLlama "Total raised" instead.
    const investorsFromHtml = [];

    // Keep the HTML snippet for the local model very small so we stay within
    // the 2048 token context window. This is enough for titles, headings, and key descriptions.
    const snippet = html.slice(0, 800);

    // Website LLM analysis can be slow (and can block the request) on some hosts.
    // Default to heuristic/non-LLM behavior unless explicitly enabled.
    const enableWebsiteLlm = String(process.env.ENABLE_WEBSITE_LLM || "").toLowerCase() === "1";
    const analysis = enableWebsiteLlm
      ? await runWebsiteAnalysisWithGpt4All(origin, snippet).catch((err) => {
          console.warn("LLM website analysis failed, falling back to non-LLM data:", err.message);
          return null;
        })
      : null;

    // Enrich: DefiLlama TVL + basic metadata
    const enriched = analysis ? { ...analysis } : {};

    // Always return protocol metadata so the frontend can render an identity even
    // when the LLM fails and DefiLlama has no match.
    enriched.protocol = {
      ...(enriched.protocol || {}),
      url: origin,
      name: (enriched?.protocol?.name || defillama?.name || inferNameFromUrl(origin)),
    };
    if (defillama?.listedAt && !enriched.protocol.listedAt) {
      enriched.protocol.listedAt = defillama.listedAt;
    }
    if (Array.isArray(defillama?.chains) && defillama.chains.length) {
      enriched.protocol.chains = defillama.chains;
    }

    // Prefer DefiLlama description/methodology/audits when available.
    if (!enriched.protocol.description && defillama?.description) {
      enriched.protocol.description = defillama.description;
    }
    if (!enriched.protocol.methodology && defillama?.methodology) {
      enriched.protocol.methodology = defillama.methodology;
    }
    if (!enriched.protocol.methodologyUrl && defillama?.methodologyUrl) {
      enriched.protocol.methodologyUrl = defillama.methodologyUrl;
    }
    if (enriched.protocol.audits == null && defillama?.audits != null) {
      enriched.protocol.audits = defillama.audits;
    }
    if ((!enriched.protocol.auditLinks || !enriched.protocol.auditLinks.length) && defillama?.auditLinks?.length) {
      enriched.protocol.auditLinks = defillama.auditLinks;
    }

    // Compatibility: some clients expect `origin` at the top level.
    enriched.origin = origin;

    // Step-4 aligned fields
    enriched.chainsSupported = Array.isArray(defillama?.chains) ? defillama.chains : (enriched.protocol.chains || []);
    enriched.pageType = inferPageType({ url: origin });
    enriched.urlAnalysis = analyzeInputUrl(origin);

    // Protocol description + features (best-effort from rendered text)
    if (!enriched.protocol.description || !enriched.protocol.features) {
      const protoInfo = extractProtocolInfoFromHtml(html, {
        protocolName: enriched.protocol.name,
        knownTokens: Array.isArray(tokenLiquidityFinal)
          ? tokenLiquidityFinal.map((t) => t.token).filter(Boolean)
          : [],
      });
      if (protoInfo?.description && !enriched.protocol.description) {
        enriched.protocol.description = protoInfo.description;
      }
      if (Array.isArray(protoInfo?.features) && !Array.isArray(enriched.protocol.features)) {
        enriched.protocol.features = protoInfo.features;
      }
      if (protoInfo?.nativeToken && !enriched.protocol.nativeToken) {
        enriched.protocol.nativeToken = protoInfo.nativeToken;
      }
    }

    if (defillama?.tvlUsd != null) {
      enriched.tvl = {
        valueUsd: defillama.tvlUsd,
        evidence: [
          `DefiLlama TVL for ${defillama.name}: https://defillama.com/protocol/${defillama.slug}`,
        ],
      };
    }

    // If no DefiLlama match, fall back to TVL found directly on the website.
    if (!enriched.tvl) {
      const domMetric = page.extracted?.bestMetric?.usd
        ? page.extracted.bestMetric
        : null;

      const tokenLiquiditySumUsd =
        Array.isArray(tokenLiquidity) && tokenLiquidity.length
          ? tokenLiquidity.reduce(
              (acc, t) => acc + (typeof t.liquidityUsd === "number" ? t.liquidityUsd : 0),
              0
            )
          : 0;

      // If we have a per-token liquidity table, prefer summing it. This is the most
      // reliable cross-site fallback for dashboards that show token rows.
      if (tokenLiquiditySumUsd > 0) {
        enriched.tvl = {
          valueUsd: tokenLiquiditySumUsd,
          evidence: [
            `Sum of per-token liquidity: ${tokenLiquidity.length} tokens (from rendered page)`,
          ],
        };
      } else if (domMetric) {
        enriched.tvl = {
          valueUsd: domMetric.usd,
          evidence: [
            `${domMetric.label}: ${domMetric.moneyLabel} (from rendered page)`,
          ],
        };
      } else if (tvlFromHtml) {
        enriched.tvl = {
          valueUsd: tvlFromHtml.valueUsd,
          evidence: [
            `${tvlFromHtml.text}${
              page.rendered ? " (from rendered page)" : ""
            }`,
          ],
        };
      } else {
        enriched.tvl = { valueUsd: null, evidence: [] };
      }
    }

    if (!Array.isArray(enriched.tokenLiquidity) || enriched.tokenLiquidity.length === 0) {
      enriched.tokenLiquidity = tokenLiquidityFinal;
    }

    // Step-4 aligned: asset list
    if (!Array.isArray(enriched.assets) || enriched.assets.length === 0) {
      enriched.assets = (Array.isArray(enriched.tokenLiquidity) ? enriched.tokenLiquidity : []).map((t) => ({
        symbol: t.token || t.asset || null,
        liquidityUsd: typeof t.liquidityUsd === "number" ? t.liquidityUsd : null,
        evidence: t.evidence || [],
      }));
    }

    function slugifyForDefiLlama(name) {
      return String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    }

    // Total raised (replaces investors UI)
    const totalRaisedSlugs = Array.from(
      new Set(
        [
          defiLlamaSlug,
          defillama?.slug,
          defillama?.name ? slugifyForDefiLlama(defillama.name) : null,
          enriched?.protocol?.name ? slugifyForDefiLlama(enriched.protocol.name) : null,
        ].filter(Boolean)
      )
    );

    let totalRaisedCandidate = null;
    let totalRaisedEvidence = [];
    for (const s of totalRaisedSlugs) {
      const tr = await getDefiLlamaTotalRaisedUsdFromModule(s).catch((err) => {
        console.warn("DefiLlama totalRaised error:", err.message);
        return { value: null, evidence: [`Total raised request failed for slug "${s}": ${err.message}`] };
      });
      if (tr?.evidence && Array.isArray(tr.evidence) && tr.evidence.length && !totalRaisedEvidence.length) {
        totalRaisedEvidence = tr.evidence;
      }
      if (tr && typeof tr.value === "number") {
        totalRaisedCandidate = tr;
        break;
      }
    }

    if (totalRaisedCandidate?.value != null && typeof totalRaisedCandidate.value === "number") {
      enriched.protocol.totalRaisedUsd = totalRaisedCandidate.value;
    }
    // Always attach evidence for troubleshooting (even if parse failed).
    enriched.protocol.totalRaisedEvidence = totalRaisedCandidate?.evidence || totalRaisedEvidence || [];

    // Protocol Information (DefiLlama) -> map into our existing description slot
    let defiProtocolInfo = null;
    for (const s of totalRaisedSlugs) {
      const info = await getDefiLlamaProtocolInformationFromModule(s).catch(() => null);
      if (info?.description) {
        defiProtocolInfo = info;
        break;
      }
    }
    if (defiProtocolInfo?.description) enriched.protocol.description = defiProtocolInfo.description;

    enriched.investors = [];

    // Wallet allocations (optional): summarize token flows between the wallet and detected contracts.
    if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
      const alloc = await getWalletAllocationsFromEtherscan({
        walletAddress: walletAddress.trim(),
        contracts: Array.isArray(enriched.contracts) ? enriched.contracts : [],
      }).catch((err) => {
        console.warn("Wallet allocations error:", err.message);
        return null;
      });
      if (alloc?.allocations) {
        enriched.allocations = alloc.allocations;
        enriched.wallet = { address: walletAddress.trim(), evidence: alloc.evidence || [] };
      }
    }

    /*
    if (cryptoRank?.investors?.length) {
      enriched.investors = cryptoRank.investors.map((n) => ({
        name: n,
        role: "Investor",
        evidence: cryptoRank.evidence || [],
      }));
    } else if (!enriched.investors) {
      enriched.investors = [];
    }
    */

    // Contracts: if LLM didn't find any, try extraction as fallback.
    // Important: only consider explorer links and *visible text* to avoid pulling
    // random addresses from bundled scripts which cannot be labeled reliably.
    if (!Array.isArray(enriched.contracts) || enriched.contracts.length === 0) {
      enriched.contracts = extractContractsFromHtml(html, { visibleTextOnly: true });
    }

    // If no visible-text contracts exist, but rendered DOM has explorer links, expose them as contracts.
    if (
      Array.isArray(enriched.contracts) &&
      enriched.contracts.length === 0 &&
      Array.isArray(page.extracted?.contractLinks) &&
      page.extracted.contractLinks.length
    ) {
      enriched.contracts = page.extracted.contractLinks.map((cl) => ({
        label: cl.label && cl.label.length <= 80 ? cl.label : "Explorer link",
        network: "Unknown",
        address: cl.address,
        evidence: cl.href,
      }));
    }

    // If still empty, use any addresses found in rendered hrefs (e.g. pool links).
    if (
      Array.isArray(enriched.contracts) &&
      enriched.contracts.length === 0 &&
      Array.isArray(page.extracted?.hrefAddresses) &&
      page.extracted.hrefAddresses.length
    ) {
      const seen = new Set();
      enriched.contracts = page.extracted.hrefAddresses
        .filter((h) => {
          const k = String(h.address).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 25)
        .map((h) => ({
          label: h.label && h.label.length <= 100 ? h.label : "Address link",
          network: "Unknown",
          address: h.address,
          evidence: h.href,
        }));
    }

    // 24h Volume (DefiLlama): protocol-level metric (works for any protocol with a DefiLlama match).
    if (!enriched.txsPerDay || (enriched.txsPerDay && enriched.txsPerDay.value == null)) {
      const volume = await getDefiLlamaVolume24hFromModule(defiLlamaSlug).catch((err) => {
        console.warn("DefiLlama volume24h error:", err.message);
        return null;
      });
      if (volume && typeof volume.value === "number") {
        enriched.txsPerDay = {
          value: volume.value,
          evidence: volume.evidence || [],
          source: "defillama",
        };
      } else {
        enriched.txsPerDay = { value: null, evidence: volume?.evidence || [] };
      }
    }

    // Step-4 aligned: pools / asset info (best-effort)
    if (!Array.isArray(enriched.pools) || enriched.pools.length === 0) {
      const pools = [];
      const seenPool = new Set();
      const hrefs = Array.isArray(page.extracted?.hrefAddresses) ? page.extracted.hrefAddresses : [];
      for (const h of hrefs) {
        const hint = String(h.href || "").toLowerCase();
        const isPool = hint.includes("pool") || hint.includes("pools") || hint.includes("market") || hint.includes("markets");
        if (!isPool) continue;
        const addr = String(h.address || "").toLowerCase();
        if (!addr || seenPool.has(addr)) continue;
        seenPool.add(addr);
        pools.push({
          poolContract: h.address,
          tokenPair: null,
          network: inferNetworkFromUrl(origin),
          evidence: [h.href],
        });
        if (pools.length >= 15) break;
      }
      enriched.pools = pools;
    }

    // If we rendered the page, use contract links discovered from the DOM to improve labeling.
    if (Array.isArray(page.extracted?.contractLinks) && page.extracted.contractLinks.length) {
      const byAddr = new Map(
        (enriched.contracts || []).map((c) => [String(c.address).toLowerCase(), c])
      );
      for (const cl of page.extracted.contractLinks) {
        const key = String(cl.address).toLowerCase();
        const existing = byAddr.get(key);
        const label = cl.label && cl.label.length <= 80 ? cl.label : "Explorer link";
        if (existing) {
          if (existing.label?.startsWith("Detected contract")) {
            existing.label = label;
          }
          if (!existing.evidence) existing.evidence = cl.href ? cl.href : undefined;
        } else {
          enriched.contracts.push({
            label,
            network: "Unknown",
            address: cl.address,
            evidence: cl.href,
          });
        }
      }
    }

    // Additional labeling: if rendered DOM provides context around an address, infer a role label.
    if (Array.isArray(page.extracted?.addressContexts) && page.extracted.addressContexts.length) {
      const byAddr = new Map(
        (enriched.contracts || []).map((c) => [String(c.address).toLowerCase(), c])
      );
      for (const ac of page.extracted.addressContexts) {
        const key = String(ac.address).toLowerCase();
        const existing = byAddr.get(key);
        if (!existing) continue;
        const inferred = inferContractLabelFromText(ac.context);
        if (inferred && (!existing.label || /contract \(|detected/i.test(existing.label))) {
          existing.label = inferred;
        }
        if (ac.context && !existing.evidence) {
          existing.evidence = ac.context;
        }
      }
    }

    // Surface where the HTML came from for debugging/evidence.
    enriched.page = {
      fetched: true,
      rendered: page.rendered,
      notes: page.rendered
        ? ["Content extracted after JavaScript rendering."]
        : [
            "Content extracted from raw HTML response (no JavaScript).",
            ...(page.renderError ? [`Playwright render error: ${page.renderError}`] : []),
          ],
    };
    if (page.rendered) {
      enriched.page.notes.push(
        `Extracted tokenLiquidity=${Array.isArray(enriched.tokenLiquidity) ? enriched.tokenLiquidity.length : 0}, contracts=${Array.isArray(enriched.contracts) ? enriched.contracts.length : 0}`
      );
    }

    res.json(enriched);
  } catch (err) {
    console.error("Error in /api/llm-analyze:", err);
    res.status(500).json({ error: "Unexpected error in /api/llm-analyze." });
  }
});

async function crawlInvestorPages(origin, { knownTokens = [] } = {}) {
  const u = new URL(origin);
  const base = `${u.protocol}//${u.host}`;

  // Keep this crawl cheap: too many rendered pages makes /api/llm-analyze feel "stuck".
  const candidates = ["/", "/investors", "/backers", "/funding", "/partners", "/about", "/press"];

  const visited = new Set();
  // name -> { name, evidence[], count }
  const results = new Map();

  const start = Date.now();
  const TIME_BUDGET_MS = 25_000;
  let renderAttempts = 0;
  const MAX_RENDER_ATTEMPTS = 2;

  for (const path of candidates) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    const url = base + path;
    if (visited.has(url)) continue;
    visited.add(url);

    // First try: raw HTML only (fast)
    const rawPage = await fetchHtmlRaw(url, 8000).catch(() => null);
    const htmlToParse = rawPage?.html || "";
    let names = extractInvestorsFromHtml(htmlToParse, { knownTokens });
    if (!Array.isArray(names) || !names.length) continue;

    for (const n of names) {
      const key = String(n).toLowerCase();
      const ev = results.get(key) || { name: n, evidence: [], count: 0 };
      ev.count += 1;
      if (ev.evidence.length < 3) ev.evidence.push(url);
      results.set(key, ev);
    }

    // Stop early if we have a decent list.
    if (results.size >= 12) break;

    // If raw HTML didn't contain anything, try rendering just a couple pages.
    if (renderAttempts < MAX_RENDER_ATTEMPTS && results.size < 6) {
      const renderedPage = await fetchHtmlWithOptionalRender(url).catch(() => null);
      if (renderedPage?.ok && renderedPage?.html) {
        const renderedNames = extractInvestorsFromHtml(renderedPage.html, { knownTokens });
        for (const n of renderedNames) {
          const key = String(n).toLowerCase();
          const ev = results.get(key) || { name: n, evidence: [], count: 0 };
          ev.count += 1;
          if (ev.evidence.length < 3) ev.evidence.push(url);
          results.set(key, ev);
        }
        renderAttempts++;
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 25);
}

async function fetchHtmlRaw(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, html: "" };
    const html = await resp.text();
    return { ok: true, status: resp.status, html };
  } finally {
    clearTimeout(t);
  }
}

function extractProtocolInfoFromHtml(html, { protocolName, knownTokens }) {
  const raw = String(html || "");
  const visible = htmlToVisibleText(raw);
  const lower = visible.toLowerCase();

  const titleMatch = raw.match(/<title[^>]*>([^<]{1,180})<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  const metaDescMatch = raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].replace(/\s+/g, " ").trim() : "";

  // Build a short description from meta description or first meaningful lines.
  let description = metaDesc;
  if (!description) {
    const lines = visible
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const pick = [];
    for (const l of lines) {
      if (l.length < 40) continue;
      if (l.length > 220) continue;
      if (/cookie|privacy|terms|connect wallet|all rights reserved/i.test(l)) continue;
      pick.push(l);
      if (pick.length >= 2) break;
    }
    description = pick.join(" ");
  }
  if (!description && title) description = title;
  if (description) description = description.slice(0, 320);

  // Feature detection (generic keywords)
  const features = [];
  const add = (key, label) => {
    if (key && !features.includes(label)) features.push(label);
  };

  if (/\bswap(s|ping)?\b|\btrade\b|\bdex\b/.test(lower)) add(true, "Swaps / trading");
  if (/\bstake\b|\bstaking\b|\breward(s)?\b|\bearn\b/.test(lower)) add(true, "Staking / rewards");
  if (/\blend\b|\blending\b|\bborrow\b|\bloan(s)?\b/.test(lower)) add(true, "Lending / borrowing");
  if (/\bbridge\b|\bcross[- ]chain\b/.test(lower)) add(true, "Bridging / cross-chain");
  if (/\byield\b|\bapy\b|\bapr\b|\bpool(s)?\b|\bliquidity\b/.test(lower)) add(true, "Yield / liquidity pools");
  if (/\bgovernance\b|\bvote\b|\bproposal(s)?\b/.test(lower)) add(true, "Governance");
  if (/\baudit\b|\baudited\b|\bsecurity\b/.test(lower)) add(true, "Security / audits (mentions)");

  // Native token best-effort: look for "$TOKEN", "TOKEN token", or a known token that matches protocol name.
  let nativeToken = null;
  const dollar = visible.match(/\$([A-Z][A-Z0-9]{2,10})\b/);
  if (dollar) nativeToken = dollar[1];

  if (!nativeToken) {
    const tokenWord = visible.match(/\b([A-Z][A-Z0-9]{2,10})\b\s+(token|governance token|staking token)\b/i);
    if (tokenWord) nativeToken = tokenWord[1];
  }

  if (!nativeToken && protocolName && Array.isArray(knownTokens)) {
    const pn = String(protocolName).toLowerCase();
    const candidate = knownTokens.find((t) => String(t).toLowerCase() === pn);
    if (candidate) nativeToken = candidate;
  }

  return {
    title,
    description: description || null,
    features,
    nativeToken: nativeToken || null,
  };
}

async function estimateTxsPerDayFromEtherscan({ contracts, apiKey }) {
  if (!apiKey) {
    return { value: null, evidence: ["ETHERSCAN_API_KEY not configured."] };
  }

  const ethCandidates = (contracts || [])
    .filter((c) => String(c?.network || "").toLowerCase() === "ethereum" || String(c?.network || "").toLowerCase() === "unknown")
    .map((c) => String(c.address || ""))
    .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a));

  const uniq = Array.from(new Set(ethCandidates.map((a) => a.toLowerCase()))).slice(0, 10);
  if (uniq.length === 0) {
    return { value: null, evidence: ["No Ethereum contract address available to query Etherscan."] };
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const since = now - dayMs;

  // Query up to 10 candidates and pick the most active in the last 24h.
  let best = { address: null, count: 0 };
  const per = [];

  for (const addrLower of uniq) {
    const addr = addrLower;
    const url =
      "https://api.etherscan.io/api?module=account&action=txlist" +
      `&address=${encodeURIComponent(addr)}` +
      "&page=1&offset=200&sort=desc" +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      per.push({ address: addr, tx24h: 0, note: `HTTP ${resp.status}` });
      continue;
    }
    const json = await resp.json().catch(() => null);

    // Etherscan returns: { status: "1"|"0", message: "...", result: [...]|"...error..." }
    const status = String(json?.status || "");
    const message = String(json?.message || "");
    const result = json?.result;
    if (status === "0") {
      const errText = typeof result === "string" ? result : message || "NOTOK";
      const note = `Etherscan NOTOK: ${errText}`.slice(0, 140);
      per.push({ address: addr, tx24h: 0, note });
      // If the key is invalid or rate-limited, stop early and return the reason.
      if (/invalid api key|missing api key|rate limit|max rate|not authorized/i.test(errText)) {
        return { value: null, evidence: [note] };
      }
      continue;
    }

    const txs = Array.isArray(result) ? result : [];

    let count = 0;
    for (const t of txs) {
      const ts = Number(t.timeStamp) * 1000;
      if (!isFinite(ts)) continue;
      if (ts < since) break;
      count++;
    }

    per.push({ address: addr, tx24h: count, note: "OK" });
    if (count > best.count) best = { address: addr, count };
  }

  if (!best.address) {
    return {
      value: null,
      evidence: [
        "Etherscan returned no tx data for detected addresses.",
        `Candidates checked: ${per
          .map((p) => `${p.address.slice(0, 6)}…=${p.tx24h}${p.note ? ` (${p.note})` : ""}`)
          .join(", ")}`,
      ],
    };
  }

  return {
    value: best.count,
    evidence: [
      `Etherscan txlist: ${best.count} tx in last 24h for ${best.address}`,
      `https://etherscan.io/address/${best.address}`,
      `Candidates checked: ${per.map((p) => `${p.address.slice(0, 6)}…=${p.tx24h}${p.note ? ` (${p.note})` : ""}`).join(", ")}`,
    ],
  };
}

function inferPageType({ url }) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "").toLowerCase();
    if (p.includes("/trade/pools/") || p.includes("/pools/0x")) return "pool_page";
    if (p.includes("/trade/markets") || p.includes("/markets")) return "markets_page";
    if (p.includes("/docs") || p.includes("/documentation")) return "docs_page";
    return "protocol_site";
  } catch {
    return "protocol_site";
  }
}

function inferNetworkFromUrl(url) {
  try {
    const u = new URL(url);
    const chain = (u.searchParams.get("chain") || "").toLowerCase();
    if (chain) return chain[0].toUpperCase() + chain.slice(1);
    return null;
  } catch {
    return null;
  }
}

function analyzeInputUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname || "";
    const chain = u.searchParams.get("chain") || null;
    const m = pathname.match(/(0x[a-fA-F0-9]{40})/);
    const poolAddress = m ? m[1] : null;
    const pageType = inferPageType({ url });
    return {
      inputUrl: url,
      pageType,
      chain,
      poolAddress,
    };
  } catch {
    return { inputUrl: url, pageType: "protocol_site", chain: null, poolAddress: null };
  }
}

app.get("/api/risk-schema", (req, res) => {
  try {
    const schemaPath = path.join(__dirname, "risk_schema.json");
    const schemaRaw = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(schemaRaw);
    res.json(schema);
  } catch (err) {
    console.error("Failed to load risk_schema.json:", err);
    res.status(500).json({ error: "Failed to load risk schema." });
  }
});

app.post("/api/report/pdf", async (req, res) => {
  const { analysis, riskAssessment, generatedAt } = req.body || {};
  if (!analysis || typeof analysis !== "object") {
    return res.status(400).json({ error: "Missing 'analysis' in request body." });
  }

  const protocolName = analysis?.protocol?.name || "Protocol";
  const html = buildPdfReportHtml({ analysis, riskAssessment, generatedAt });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1240, height: 1754 } });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    });
    await context.close();

    const filename = `${safePdfFilename(protocolName)}-report.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(pdf);
  } catch (err) {
    console.error("PDF report generation error:", err);
    return res.status(500).json({ error: "Failed to generate PDF report." });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post("/api/risk-assessment", async (req, res) => {
  const { protocolName, url, analysis } = req.body || {};

  if (!url && !protocolName) {
    return res
      .status(400)
      .json({ error: "Provide at least 'url' or 'protocolName' in the request body." });
  }

  try {
    // Default: avoid crashing local models with oversized prompts.
    // Enable full LLM rubric scoring explicitly by setting ENABLE_LLM_RISK=1.
    const enableLlmRisk = String(process.env.ENABLE_LLM_RISK || "") === "1";

    const schemaPath = path.join(__dirname, "risk_schema.json");
    const schemaRaw = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(schemaRaw);

    if (!enableLlmRisk) {
      const fallback = buildHeuristicRiskAssessmentFromModule({
        protocolName: protocolName || analysis?.protocol?.name || null,
        url: url || analysis?.protocol?.url || null,
        analysis,
      });
      return res.json(fallback);
    }

    // LLM mode (safe): score section-by-section so prompts fit in small local contexts.
    const assessment = await runRiskAssessmentSectionWiseWithGpt4All({
      schema,
      protocolName: protocolName || analysis?.protocol?.name || null,
      url: url || analysis?.protocol?.url || null,
      analysis,
    });
    if (assessment) return res.json(assessment);

    // If the model still fails, fall back to deterministic assessment.
    const fallback = buildHeuristicRiskAssessmentFromModule({
      protocolName: protocolName || analysis?.protocol?.name || null,
      url: url || analysis?.protocol?.url || null,
      analysis,
    });
    return res.json(fallback);
  } catch (err) {
    console.error("Error in /api/risk-assessment:", err);
    res.status(500).json({ error: "Failed to prepare risk assessment prompt." });
  }
});

function safePdfFilename(name) {
  return String(name || "protocol")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtUsd(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function buildPdfReportHtml({ analysis, riskAssessment, generatedAt }) {
  const a = analysis || {};
  const p = a.protocol || {};
  const urlAnalysis = a.urlAnalysis || {};
  const tvlUsd = a?.tvl?.valueUsd;
  const chains = Array.isArray(a?.chainsSupported) ? a.chainsSupported : (Array.isArray(p?.chains) ? p.chains : []);
  const totalRaisedUsd = typeof p?.totalRaisedUsd === "number" ? p.totalRaisedUsd : null;
  const totalRaisedEvidence = Array.isArray(p?.totalRaisedEvidence) ? p.totalRaisedEvidence : [];
  const contracts = Array.isArray(a?.contracts) ? a.contracts : [];
  const tokens = Array.isArray(a?.tokenLiquidity) ? a.tokenLiquidity : [];
  const allocations = Array.isArray(a?.allocations) ? a.allocations : [];

  const auditsCount = Number.isFinite(p?.audits) ? p.audits : null;
  const methodology = p?.methodology || null;
  const methodologyUrl = p?.methodologyUrl || null;
  const auditLinks = Array.isArray(p?.auditLinks) ? p.auditLinks : [];
  const vol24h = a?.txsPerDay?.value;
  const txEvidence = Array.isArray(a?.txsPerDay?.evidence) ? a.txsPerDay.evidence : [];

  const overall = riskAssessment?.overallTotal;
  const sectionTotals = Array.isArray(riskAssessment?.sectionTotals) ? riskAssessment.sectionTotals : [];

  const topTokens = tokens
    .filter((t) => typeof t?.liquidityUsd === "number")
    .sort((x, y) => (y.liquidityUsd || 0) - (x.liquidityUsd || 0))
    .slice(0, 20);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root { --bg:#0b1220; --card:#111c33; --muted:#94a3b8; --text:#e5e7eb; --accent:#38bdf8; --border:rgba(148,163,184,.25); }
      * { box-sizing:border-box; }
      body { margin:0; font-family: -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: var(--text); background: var(--bg); }
      .wrap { padding: 18px; }
      .header { display:flex; justify-content:space-between; gap: 14px; align-items:flex-start; }
      .title { font-size: 20px; font-weight: 700; margin:0; }
      .sub { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
      .pill { display:inline-block; padding: 4px 10px; border-radius: 999px; border:1px solid var(--border); color: var(--muted); font-size: 11px; }
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
      .card { border:1px solid var(--border); background: var(--card); border-radius: 14px; padding: 12px; }
      .h { margin:0 0 8px; font-size: 13px; letter-spacing:.02em; color:#cbd5e1; }
      .k { color: var(--muted); font-size: 11px; }
      .v { font-size: 14px; font-weight: 600; margin-top: 2px; }
      table { width:100%; border-collapse: collapse; }
      th, td { text-align:left; padding: 6px 0; border-bottom: 1px solid rgba(148,163,184,.18); font-size: 11px; vertical-align: top; }
      th { color: var(--muted); font-weight: 600; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .small { font-size: 10px; color: var(--muted); }
      .twoCol { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .score { color: var(--accent); font-weight: 800; }
      .muted { color: var(--muted); }
      .list { margin:0; padding-left: 16px; }
      .list li { margin: 2px 0; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <div>
          <h1 class="title">${escapeHtml(p?.name || "Protocol")} — Report</h1>
          <div class="sub">Generated: ${escapeHtml(generatedAt || new Date().toISOString())}</div>
          <div class="sub">URL: <span class="mono">${escapeHtml(p?.url || a?.origin || "")}</span></div>
          ${chains.length ? `<div class="sub">Chains: ${escapeHtml(chains.join(", "))}</div>` : ""}
        </div>
        <div class="pill">Protocol Inspector</div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="h">Key metrics</div>
          <div class="twoCol">
            <div>
              <div class="k">TVL / Liquidity</div>
              <div class="v">${escapeHtml(fmtUsd(tvlUsd))}</div>
              <div class="small">${escapeHtml((a?.tvl?.evidence?.[0]) || "")}</div>
            </div>
            <div>
              <div class="k">Native token volume (24h)</div>
              <div class="v">${escapeHtml(typeof vol24h === "number" ? String(vol24h) : "—")}</div>
              <div class="small">${escapeHtml(txEvidence[0] || "")}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="h">URL analysis</div>
          <div class="twoCol">
            <div>
              <div class="k">Page type</div>
              <div class="v">${escapeHtml(urlAnalysis.pageType || a.pageType || "—")}</div>
            </div>
            <div>
              <div class="k">Chain</div>
              <div class="v">${escapeHtml(urlAnalysis.chain || "—")}</div>
            </div>
          </div>
          <div style="height:8px;"></div>
          <div class="k">Pool / contract address (from URL)</div>
          <div class="v mono">${escapeHtml(urlAnalysis.poolAddress || "—")}</div>
        </div>

        <div class="card">
          <div class="h">Protocol description</div>
          <div class="small muted">${escapeHtml(p?.description || "—")}</div>
          <div style="height:8px;"></div>
          <div class="k">DefiLlama audits</div>
          <div class="v">${escapeHtml(auditsCount != null ? String(auditsCount) : "—")}</div>
          ${
            auditLinks.length
              ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(
                  auditLinks.slice(0, 5).join(", ")
                )}</div>`
              : `<div class="small muted" style="margin-top:4px;">No audit links found on DefiLlama.</div>`
          }
          <div style="height:8px;"></div>
          <div class="k">Methodology</div>
          <div class="small muted">${escapeHtml(methodology || "—")}</div>
          ${
            methodologyUrl
              ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(
                  methodologyUrl
                )}</div>`
              : ""
          }
          <div style="height:8px;"></div>
          <div class="k">Features</div>
          ${
            Array.isArray(p?.features) && p.features.length
              ? `<ul class="list">${p.features
                  .slice(0, 10)
                  .map((f) => `<li>${escapeHtml(f)}</li>`)
                  .join("")}</ul>`
              : `<div class="small muted">—</div>`
          }
          <div style="height:8px;"></div>
          <div class="k">Native token</div>
          <div class="v">${escapeHtml(p?.nativeToken || "—")}</div>
        </div>

        <div class="card">
          <div class="h">Risk summary</div>
          <div class="k">Overall score (0–1)</div>
          <div class="v"><span class="score">${escapeHtml(typeof overall === "number" ? overall.toFixed(2) : "—")}</span></div>
          ${sectionTotals.length ? `
            <table>
              <thead><tr><th>Section</th><th>Score</th></tr></thead>
              <tbody>
                ${sectionTotals.slice(0, 10).map((s) => `<tr><td>${escapeHtml(s.sectionId)}</td><td>${escapeHtml(typeof s.score === "number" ? s.score.toFixed(2) : "—")}</td></tr>`).join("")}
              </tbody>
            </table>
          ` : `<div class="small muted">Run “Risk score” to include section totals.</div>`}
        </div>

        <div class="card">
          <div class="h">Top token liquidity</div>
          ${topTokens.length ? `
            <table>
              <thead><tr><th>Token</th><th>Liquidity</th></tr></thead>
              <tbody>
                ${topTokens.map((t) => `<tr><td>${escapeHtml(t.token || "—")}</td><td>${escapeHtml(fmtUsd(t.liquidityUsd))}</td></tr>`).join("")}
              </tbody>
            </table>
          ` : `<div class="small muted">No token liquidity table detected.</div>`}
        </div>

        <div class="card">
          <div class="h">Total raised</div>
          ${
            typeof totalRaisedUsd === "number" ? `
              <div class="v">${escapeHtml(fmtUsd(totalRaisedUsd))}</div>
              ${
                totalRaisedEvidence.length
                  ? `<div class="small muted" style="margin-top:6px;">${escapeHtml(totalRaisedEvidence[0] || "")}</div>`
                  : ""
              }
            `
            : `<div class="small muted">No total raised amount found.</div>`
          }
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <div class="h">Smart contracts (best‑effort)</div>
          ${contracts.length ? `
            <table>
              <thead><tr><th>Label</th><th>Network</th><th>Address</th></tr></thead>
              <tbody>
                ${contracts.slice(0, 30).map((c) => `
                  <tr>
                    <td>${escapeHtml(c.label || "Contract")}</td>
                    <td>${escapeHtml(c.network || "Unknown")}</td>
                    <td class="mono">${escapeHtml(c.address || "")}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `<div class="small muted">No contract addresses exposed by the submitted page.</div>`}
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <div class="h">Wallet allocations (optional)</div>
          ${allocations.length ? `
            <table>
              <thead><tr><th>Target</th><th>Token</th><th>Net</th><th>Note</th></tr></thead>
              <tbody>
                ${allocations.slice(0, 30).map((x) => `
                  <tr>
                    <td>${escapeHtml(x.target || "—")}</td>
                    <td>${escapeHtml(x.token || "—")}</td>
                    <td>${escapeHtml(x.netAmount ? `${x.netDirection === "net_deposit" ? "+" : "-"}${x.netAmount}` : "—")}</td>
                    <td class="small">${escapeHtml(x.tvlLabel || "")}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `<div class="small muted">Provide a wallet address in the UI to include allocations (requires Etherscan API key).</div>`}
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function buildCompactProtocolContext(analysis) {
  const a = analysis || {};
  const tvl = a?.tvl?.valueUsd;
  const tokenLiquidity = Array.isArray(a?.tokenLiquidity) ? a.tokenLiquidity : [];
  const topTokens = tokenLiquidity
    .filter((t) => typeof t?.liquidityUsd === "number")
    .sort((x, y) => (y.liquidityUsd || 0) - (x.liquidityUsd || 0))
    .slice(0, 12)
    .map((t) => ({ token: t.token, liquidityUsd: t.liquidityUsd }));

  const totalRaisedUsd =
    typeof a?.protocol?.totalRaisedUsd === "number" ? a.protocol.totalRaisedUsd : null;

  const contracts = Array.isArray(a?.contracts) ? a.contracts.slice(0, 8) : [];

  return {
    protocolName: a?.protocol?.name || null,
    protocolUrl: a?.protocol?.url || null,
    listedAt: a?.protocol?.listedAt || null,
    tvlUsd: typeof tvl === "number" ? Math.round(tvl) : null,
    topTokenLiquidityUsd: topTokens.map((t) => [t.token, Math.round(t.liquidityUsd)]),
    totalRaisedUsd: typeof totalRaisedUsd === "number" ? Math.round(totalRaisedUsd) : null,
    contracts: contracts.map((c) => [c.label || null, c.network || null, c.address || null]),
  };
}

function buildRubricSectionLite(section) {
  const criteria = Array.isArray(section?.criteria) ? section.criteria : [];
  return {
    id: section?.id || "section",
    label: section?.label || section?.id || "Section",
    criteria: criteria.slice(0, 12).map((c) => ({
      id: c?.id || null,
      label: c?.label || null,
      weight: typeof c?.weight === "number" ? c.weight : null,
      subcriteria: Array.isArray(c?.subcriteria)
        ? c.subcriteria.slice(0, 10).map((s) => ({
            id: s?.id || null,
            label: s?.label || null,
            type: s?.type || null,
          }))
        : [],
    })),
  };
}

function estimateTokens(prompt) {
  // Very rough: 1 token ~= 4 chars in English-ish text.
  return Math.ceil(String(prompt || "").length / 4);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runRiskAssessmentSectionWiseWithGpt4All({ schema, protocolName, url, analysis }) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;
    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const context = buildCompactProtocolContext(analysis);
    const sectionTotals = [];
    const allCriteria = [];

    const sections = Array.isArray(schema?.sections) ? schema.sections : [];
    for (const section of sections) {
      const sectionId = section?.id || "section";
      const sectionLabel = section?.label || sectionId;
      const lite = buildRubricSectionLite(section);
      const criteriaChunks = chunkArray(lite.criteria, 4);

      const chunkTotals = [];
      for (const chunk of criteriaChunks) {
        const chunkPayload = { ...lite, criteria: chunk };

        const prompt = `
You are a DeFi protocol risk analyst.

Only use the provided facts. Do NOT browse the web.
Do NOT invent audits, exploits, investors, or dates.

Return JSON only:
{
  "sectionId": string,
  "criteria": [
    {
      "criterionId": string,
      "subcriterionId": string | null,
      "score": number,
      "weight": number | null,
      "weightedScore": number | null,
      "evidence": string[],
      "reasoning": string
    }
  ],
  "sectionTotal": number
}

Protocol: ${protocolName || context.protocolName || "null"} (${url || context.protocolUrl || "null"})
Facts: ${JSON.stringify(context)}
Rubric: ${JSON.stringify(chunkPayload)}
`.trim();

        if (estimateTokens(prompt) > 1700) {
          // Too large even after compression; skip LLM for this chunk.
          continue;
        }

        const completion = await createCompletion(model, prompt);
        const message = completion.choices?.[0]?.message;
        const text = typeof message === "string" ? message : message?.content ?? "";
        if (!text) continue;

        const parsed = parseLikelyJson(text);
        if (!parsed || parsed.sectionId !== sectionId) continue;

        if (Array.isArray(parsed.criteria)) {
          parsed.criteria.forEach((c) => {
            allCriteria.push({
              sectionId,
              criterionId: c.criterionId,
              subcriterionId: c.subcriterionId ?? null,
              score: c.score,
              weight: c.weight ?? null,
              weightedScore: c.weightedScore ?? null,
              evidence: Array.isArray(c.evidence) ? c.evidence : [],
              reasoning: c.reasoning || "",
            });
          });
        }

        if (typeof parsed.sectionTotal === "number" && isFinite(parsed.sectionTotal)) {
          chunkTotals.push(clamp01(parsed.sectionTotal));
        }
      }

      if (chunkTotals.length) {
        const sectionTotal = chunkTotals.reduce((a, b) => a + b, 0) / chunkTotals.length;
        sectionTotals.push({ sectionId, score: clamp01(sectionTotal) });
      }
    }

    if (typeof model.dispose === "function") model.dispose();

    if (!sectionTotals.length) return null;

    const overallTotal =
      sectionTotals.reduce((acc, s) => acc + (typeof s.score === "number" ? s.score : 0), 0) /
      sectionTotals.length;

    return {
      protocol: { name: protocolName || null, url: url || null },
      criteria: allCriteria,
      sectionTotals,
      overallTotal: clamp01(overallTotal),
      evidence: ["LLM section-wise scoring (compact prompts)."],
    };
  } catch (err) {
    console.error("runRiskAssessmentSectionWiseWithGpt4All error:", err);
    return null;
  }
}

function buildHeuristicRiskAssessment({ protocolName, url, analysis }) {
  const a = analysis || {};
  const tvl = a?.tvl?.valueUsd;
  const listedAt = a?.protocol?.listedAt;
  const audits = a?.protocol?.audits;
  const auditLinks = Array.isArray(a?.protocol?.auditLinks) ? a.protocol.auditLinks : [];
  const totalRaisedUsd = typeof a?.protocol?.totalRaisedUsd === "number" ? a.protocol.totalRaisedUsd : null;

  const liquidityScore = heuristicLiquidityScore(tvl);
  const raisedScore = heuristicRaisedScore(totalRaisedUsd);
  const longevityScore = heuristicLongevityScore(listedAt);
  const auditCount = Number.isFinite(audits) ? audits : auditLinks.length ? auditLinks.length : null;
  const auditScore = heuristicAuditScore(auditCount);

  // Overall: average available scores (simple + explainable).
  const scores = [liquidityScore, raisedScore, longevityScore, auditScore].filter((x) => typeof x === "number");
  const overallTotal = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0.5;

  return {
    protocol: { name: protocolName || null, url: url || null },
    criteria: [],
    sectionTotals: [
      { sectionId: "liquidity", score: liquidityScore ?? 0 },
      { sectionId: "investment_reputation", score: raisedScore ?? 0 },
      { sectionId: "longevity", score: longevityScore ?? 0 },
      { sectionId: "audits", score: auditScore ?? 0 },
    ],
    overallTotal,
    evidence: [
      "Heuristic fallback: GPT4All did not return valid JSON for full rubric scoring.",
      typeof tvl === "number" ? `Liquidity/TVL observed: ${tvl}` : "Liquidity/TVL not available.",
      typeof totalRaisedUsd === "number" ? `Total raised: ${totalRaisedUsd}` : "Total raised unknown.",
      typeof listedAt === "number" ? `DefiLlama listedAt: ${listedAt}` : "DefiLlama listedAt unknown.",
      auditCount != null ? `DefiLlama audits detected: ${auditCount}` : "DefiLlama audit info unknown.",
    ],
  };
}

function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function heuristicLiquidityScore(tvl) {
  if (typeof tvl !== "number" || !isFinite(tvl) || tvl <= 0) return null;
  if (tvl >= 1_000_000_000) return 1.0;
  if (tvl >= 100_000_000) return 0.85;
  if (tvl >= 10_000_000) return 0.7;
  if (tvl >= 1_000_000) return 0.55;
  if (tvl >= 100_000) return 0.4;
  return 0.25;
}

function heuristicRaisedScore(totalRaisedUsd) {
  if (typeof totalRaisedUsd !== "number" || !isFinite(totalRaisedUsd) || totalRaisedUsd <= 0) return null;
  // Higher raised => safer fundraising/reputation.
  if (totalRaisedUsd >= 100_000_000) return 0.95;
  if (totalRaisedUsd >= 50_000_000) return 0.9;
  if (totalRaisedUsd >= 10_000_000) return 0.8;
  if (totalRaisedUsd >= 1_000_000) return 0.65;
  return 0.4;
}

function heuristicLongevityScore(listedAt) {
  if (typeof listedAt !== "number" || !isFinite(listedAt) || listedAt <= 0) return null;
  const ageDays = (Date.now() / 1000 - listedAt) / 86400;
  if (!isFinite(ageDays) || ageDays <= 0) return null;
  // 4 years -> 1.0
  return clamp01(ageDays / (365 * 4));
}

function heuristicAuditScore(auditCount) {
  if (!Number.isFinite(auditCount)) return null;
  if (auditCount >= 3) return 0.95;
  if (auditCount === 2) return 0.9;
  if (auditCount === 1) return 0.75;
  if (auditCount === 0) return 0.4;
  return null;
}

async function runRiskAssessmentWithGpt4All(prompt) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;

    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const completion = await createCompletion(model, prompt);
    const message = completion.choices?.[0]?.message;
    const text = typeof message === "string" ? message : message?.content ?? "";

    if (typeof model.dispose === "function") {
      model.dispose();
    }

    if (!text) {
      throw new Error("GPT4All returned empty response.");
    }

    const parsed = parseLikelyJson(text);
    return parsed;
  } catch (err) {
    console.error("runRiskAssessmentWithGpt4All error:", err);
    return null;
  }
}

function parseLikelyJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("No JSON object found in GPT4All output.");
  }
}

function extractTvlFromHtml(html) {
  if (!html) return null;
  const text = htmlToVisibleText(html);
  const lower = text.toLowerCase();
  const idx = lower.search(/\b(tvl|total value locked|liquidity)\b/);
  if (idx === -1) return null;

  const windowSize = 200;
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + windowSize);
  const snippet = text.slice(start, end);

  // Match patterns like $28B, $1.2M, 28B, 1.2M, 100,000,000 etc near TVL/liquidity.
  const tvlRegex =
    /(?:\$?\s*([\d.,]+)\s*(k|m|b|bn)?)(?:\s*(?:tvl|total value locked|liquidity))/i;
  const reversedRegex =
    /(?:tvl|total value locked|liquidity)[^$0-9]{0,60}\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;

  let m = tvlRegex.exec(snippet) || reversedRegex.exec(snippet);
  if (!m) return null;

  const raw = m[1];
  const suffix = (m[2] || "").toLowerCase();
  let value = parseFloat(raw.replace(/,/g, ""));
  if (!isFinite(value)) return null;

  if (suffix === "k") value *= 1e3;
  else if (suffix === "m") value *= 1e6;
  else if (suffix === "b" || suffix === "bn") value *= 1e9;

  return {
    valueUsd: value,
    text: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

function htmlToVisibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function inferNameFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (!parts.length) return null;

    // Skip common non-brand subdomains like "app", "www", "beta", etc.
    const skip = new Set(["app", "www", "beta", "alpha", "staging", "test"]);
    let candidate = parts[0];
    if (skip.has(candidate.toLowerCase()) && parts.length >= 2) {
      candidate = parts[1];
    }

    // If still something generic, fall back to the registrable domain label.
    if (skip.has(String(candidate).toLowerCase()) && parts.length >= 2) {
      candidate = parts[parts.length - 2];
    }

    if (!candidate) return null;
    const pretty = candidate
      .replace(/[-_]+/g, " ")
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ")
      .trim();
    return pretty || null;
  } catch {
    return null;
  }
}

function parseMoneyToUsd(raw, suffix) {
  let value = parseFloat(String(raw).replace(/,/g, ""));
  if (!isFinite(value)) return null;
  const s = String(suffix || "").toLowerCase();
  if (s === "k") value *= 1e3;
  else if (s === "m") value *= 1e6;
  else if (s === "b" || s === "bn") value *= 1e9;
  return value;
}

function extractTokenLiquidityFromHtml(html) {
  const text = htmlToVisibleText(html);
  if (!text) return [];

  // Normalize to line-ish chunks; many UIs render tables where each row becomes a few adjacent tokens.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const results = [];
  const seen = new Set();

  // Look for patterns that appear in dashboards:
  // TOKEN ... Total Liquidity ... $43.39M  or  TOKEN ... $43.39M ... Total Liquidity
  const moneyRe = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;
  const tokenRe = /^[A-Z][A-Z0-9.-]{1,10}$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (!lower.includes("liquidity")) continue;

    // Search a local window around the "liquidity" line for a likely token label and a money value.
    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4));

    let money = null;
    let token = null;

    for (const w of window) {
      const m = moneyRe.exec(w);
      if (m && !money) {
        const matched = String(m[0] || "");
        const hasDollar = matched.includes("$");
        const hasSuffix = Boolean(m[2]);
        const hasComma = String(m[1] || "").includes(",");
        const digitsOnly = String(m[1] || "").replace(/[.,]/g, "");
        const enoughDigits = digitsOnly.length >= 4;
        if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;

        const usd = parseMoneyToUsd(m[1], m[2]);
        if (usd != null) money = { usd, label: (m[0] || "").trim() };
      }
      if (!token && tokenRe.test(w) && w.toLowerCase() !== "tvl") {
        token = w;
      }
    }

    if (token && money) {
      const key = `${token}:${money.usd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        token,
        liquidityUsd: money.usd,
        liquidityLabel: money.label,
        evidence: [`Found near "liquidity" in page text${html.includes("data-state") ? "" : ""}.`],
      });
      if (results.length >= 25) break;
    }
  }

  // If we didn't find "liquidity"-anchored rows, fall back to a generic table-like scan:
  // TOKEN then nearby money value.
  if (results.length === 0) {
    for (let i = 0; i < lines.length - 1; i++) {
      const tokenCandidate = lines[i];
      if (!tokenRe.test(tokenCandidate)) continue;

      const lookahead = lines.slice(i + 1, Math.min(lines.length, i + 6)).join(" ");
      const m = moneyRe.exec(lookahead);
      if (!m) continue;
      const matched = String(m[0] || "");
      const hasDollar = matched.includes("$");
      const hasSuffix = Boolean(m[2]);
      const hasComma = String(m[1] || "").includes(",");
      const digitsOnly = String(m[1] || "").replace(/[.,]/g, "");
      const enoughDigits = digitsOnly.length >= 4;
      if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;
      const usd = parseMoneyToUsd(m[1], m[2]);
      if (usd == null) continue;

      const key = `${tokenCandidate}:${usd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        token: tokenCandidate,
        liquidityUsd: usd,
        liquidityLabel: (m[0] || "").trim(),
        evidence: ["Token and nearby USD value found in rendered page text."],
      });
      if (results.length >= 25) break;
    }
  }

  return results;
}

async function fetchHtmlWithOptionalRender(url) {
  const headers = {
    "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)",
  };

  const isVercel = String(process.env.VERCEL || "") !== "";
  const fetchTimeoutMs = Number(
    process.env.HTML_FETCH_TIMEOUT_MS || (isVercel ? 30_000 : 15_000)
  );
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let resp;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);
    // Network timeouts are common when rendering JS-heavy pages.
    return {
      ok: false,
      status: 504,
      html: "",
      rendered: false,
      renderError: `Fetch timed out/failed: ${msg}`,
    };
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) {
    return { ok: false, status: resp.status, html: "", rendered: false };
  }

  const html = await resp.text();
  const force = String(process.env.FORCE_RENDER || "").toLowerCase() === "1";
  const should = force || shouldRenderHtml(html);
  if (!should) {
    return { ok: true, status: resp.status, html, rendered: false };
  }

  // Safety valve for local debugging: some JS-heavy pages can make Playwright slow.
  if (String(process.env.SKIP_PLAYWRIGHT_RENDER || "").toLowerCase() === "1") {
    return { ok: true, status: resp.status, html, rendered: false, extracted: null };
  }

  let renderError = null;
  const renderTimeoutMs = Number(process.env.PLAYWRIGHT_RENDER_TIMEOUT_MS || 45_000);
  const rendered = await Promise.race([
    renderHtmlWithPlaywright(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Playwright render timed out after ${renderTimeoutMs}ms`)), renderTimeoutMs)
    ),
  ]).catch((err) => {
    renderError = err?.message ? String(err.message) : String(err);
    console.warn("Playwright render failed, using raw HTML:", renderError);
    return null;
  });

  if (rendered?.html) {
    return {
      ok: true,
      status: resp.status,
      html: rendered.html,
      rendered: true,
      extracted: rendered.extracted || null,
    };
  }

  return {
    ok: true,
    status: resp.status,
    html,
    rendered: false,
    extracted: null,
    renderError,
  };
}

function shouldRenderHtml(html) {
  if (!html) return true;
  const lower = html.toLowerCase();

  // Common SPA shells / error states.
  if (lower.includes("failed to load app")) return true;
  if (lower.includes("you need to enable javascript")) return true;

  // If there's very little meaningful text, it's likely JS-rendered.
  const text = lower
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 400) return true;

  // Heuristic: SPA root + lots of scripts, little body content.
  const hasRoot =
    lower.includes('id="root"') ||
    lower.includes('id="app"') ||
    lower.includes('data-reactroot');
  const scriptCount = (lower.match(/<script\b/g) || []).length;
  if (hasRoot && scriptCount >= 5) return true;

  return false;
}

async function renderHtmlWithPlaywright(url) {
  // Serverless (Vercel) often needs these flags. Locally, apply default
  // Chromium settings to avoid hangs/regressions.
  const isVercel = String(process.env.VERCEL || "") !== "";
  const browser = await chromium.launch({
    headless: true,
    args: isVercel ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  try {
    const context = await browser.newContext({
      userAgent: "ProtocolInspector/1.0 (+https://github.com/)",
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Don’t hang forever on slow/non-responsive pages.
    const navTimeoutMs = Number(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS || (isVercel ? 60_000 : 25_000));
    const opTimeoutMs = Number(process.env.PLAYWRIGHT_OP_TIMEOUT_MS || (isVercel ? 60_000 : 25_000));
    page.setDefaultNavigationTimeout(navTimeoutMs);
    page.setDefaultTimeout(opTimeoutMs);

    let lastErr = null;
    try {
      // SPA apps often never reach `networkidle` due to polling/WebSockets.
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      lastErr = err;
      console.warn("Playwright goto failed; extracting partial content:", err.message);
    }

    // Give the app time to paint real UI text (generic signal: "liquidity" + "$").
    // Works for many dashboards and avoids needing site-specific selectors.
    try {
      await page.waitForFunction(
        () => {
          const t = (document.body && (document.body.innerText || document.body.textContent)) || "";
          return /liquidity/i.test(t) && /\$[\d]/.test(t);
        },
        {
          timeout: Number(
            process.env.PLAYWRIGHT_WAIT_FOR_TEXT_TIMEOUT_MS ||
              (isVercel ? 20_000 : 8_000)
          ),
        }
      );
    } catch {
      // If it never appears, continue with whatever we have.
    }
    try {
      await page.waitForTimeout(500);
    } catch {
      // ignore
    }

    let html = await page.content();
    let extracted = await extractFromRenderedDom(page).catch(() => null);

    // If the page still looks like an empty shell, wait a bit longer and try again.
    const visible = htmlToVisibleText(html);
    if (visible.length < 300 || (extracted && Array.isArray(extracted.tokenLiquidity) && extracted.tokenLiquidity.length === 0)) {
      try {
        await page.waitForTimeout(2500);
      } catch {
        // ignore
      }
      html = await page.content();
      extracted = await extractFromRenderedDom(page).catch(() => extracted);
    }

    await context.close();
    return { html, extracted, lastErr: lastErr ? String(lastErr.message || lastErr) : null };
  } finally {
    await browser.close();
  }
}

async function extractFromRenderedDom(page) {
  const data = await page.evaluate(() => {
    const moneyRe = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/i;

    function parseMoney(str) {
      const m = moneyRe.exec(str || "");
      if (!m) return null;
      const raw = m[1];
      const suffix = (m[2] || "").toLowerCase();
      const matched = String(m[0] || "");
      // Guardrails: avoid interpreting "24h" / column labels as money.
      const hasDollar = matched.includes("$");
      const hasSuffix = Boolean(suffix);
      const hasComma = raw.includes(",");
      const digitsOnly = raw.replace(/[.,]/g, "");
      const enoughDigits = digitsOnly.length >= 4; // e.g. 1000+
      if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) return null;

      let v = parseFloat(String(raw).replace(/,/g, ""));
      if (!isFinite(v)) return null;
      if (suffix === "k") v *= 1e3;
      else if (suffix === "m") v *= 1e6;
      else if (suffix === "b" || suffix === "bn") v *= 1e9;
      return { usd: v, label: m[0].trim() };
    }

    function parseAllMoney(str) {
      const s = String(str || "");
      const matches = [];
      const re = /\$?\s*([\d.,]+)\s*(k|m|b|bn)?/gi;
      let m;
      while ((m = re.exec(s)) !== null) {
        const raw = m[1];
        const suffix = (m[2] || "").toLowerCase();
        const matched = String(m[0] || "");
        const hasDollar = matched.includes("$");
        const hasSuffix = Boolean(suffix);
        const hasComma = String(raw).includes(",");
        const digitsOnly = String(raw).replace(/[.,]/g, "");
        const enoughDigits = digitsOnly.length >= 4;
        if (!(hasDollar || hasSuffix || hasComma || enoughDigits)) continue;
        let v = parseFloat(String(raw).replace(/,/g, ""));
        if (!isFinite(v)) continue;
        if (suffix === "k") v *= 1e3;
        else if (suffix === "m") v *= 1e6;
        else if (suffix === "b" || suffix === "bn") v *= 1e9;
        matches.push({ usd: v, label: matched.trim() });
      }
      return matches;
    }

    function textOf(el) {
      return (el && (el.innerText || el.textContent) ? String(el.innerText || el.textContent) : "")
        .replace(/\s+/g, " ")
        .trim();
    }

    // 1) Metric extraction: find a label like "Total Liquidity" and the nearest money value in its container.
    const metricLabels = ["total liquidity", "liquidity", "tvl", "total value locked"];
    const metricCandidates = [];
    const all = Array.from(document.querySelectorAll("body *")).slice(0, 8000);
    for (const el of all) {
      const t = textOf(el);
      if (!t || t.length > 80) continue;
      const lower = t.toLowerCase();
      if (!metricLabels.some((k) => lower.includes(k))) continue;
      const container = el.closest("section,article,div,li,td,th") || el.parentElement || el;
      const containerText = textOf(container);
      const monies = parseAllMoney(containerText);
      const money = monies.sort((a, b) => b.usd - a.usd)[0] || null;
      if (money && money.usd != null) {
        metricCandidates.push({
          label: t,
          containerText: containerText.slice(0, 240),
          usd: money.usd,
          moneyLabel: money.label,
        });
      }
      if (metricCandidates.length >= 30) break;
    }

    // Prefer "Total Liquidity" over generic "Liquidity" over "TVL".
    function pickBestMetric() {
      const ranked = metricCandidates
        .map((m) => {
          const l = m.label.toLowerCase();
          let score = 0;
          if (l.includes("total liquidity")) score += 30;
          if (l.includes("total value locked")) score += 25;
          if (l === "tvl" || l.includes(" tvl")) score += 20;
          if (l.includes("liquidity")) score += 10;
          // Larger numbers usually are the main TVL/liquidity, de-prioritize tiny ones.
          score += Math.min(20, Math.log10(Math.max(1, m.usd)) * 3);
          return { score, m };
        })
        .sort((a, b) => b.score - a.score);
      return ranked.length ? ranked[0].m : null;
    }

    const bestMetric = pickBestMetric();

    // 2) Token liquidity table extraction: find a header row with a liquidity column and parse rows.
    function getCells(row) {
      const cells = Array.from(row.querySelectorAll("th,td,[role='cell'],[role='gridcell']"));
      return cells.length ? cells : Array.from(row.children || []);
    }

    function normalizeHeader(s) {
      return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    }

    const rows = [
      ...Array.from(document.querySelectorAll("tr")),
      ...Array.from(document.querySelectorAll("[role='row']")),
    ];

    let header = null;
    let liquidityCol = -1;
    for (const r of rows) {
      const cells = getCells(r).map((c) => normalizeHeader(textOf(c)));
      const joined = cells.join(" | ");
      if (!cells.length) continue;
      if (joined.includes("liquidity") || joined.includes("total liquidity") || joined.includes("tvl")) {
        const idx = cells.findIndex((c) => c.includes("total liquidity") || c === "liquidity" || c.includes("liquidity"));
        if (idx >= 0) {
          header = r;
          liquidityCol = idx;
          break;
        }
      }
    }

    const tokenLiquidity = [];
    if (header && liquidityCol >= 0) {
      const headerIndex = rows.indexOf(header);
      for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 120); i++) {
        const r = rows[i];
        // stop if we hit another header-ish row
        const cells = getCells(r);
        if (!cells.length) continue;
        const cellTexts = cells.map((c) => textOf(c));
        const headerish = cellTexts.some((t) => /total\s+liquidity|liquidity|tvl/i.test(t)) && cellTexts.every((t) => t.length < 30);
        if (headerish) break;

        const tokenText = (cellTexts[0] || "").trim();
        if (!tokenText) continue;
        const liqCell = cells[liquidityCol] || null;
        const liqText = textOf(liqCell);
        const money = parseMoney(liqText);
        if (!money) continue;

        tokenLiquidity.push({
          token: tokenText.split(/\s+/)[0],
          liquidityUsd: money.usd,
          liquidityLabel: money.label,
          evidence: ["Extracted from rendered table row."],
        });
        if (tokenLiquidity.length >= 50) break;
      }
    }

    // 3) Contract links: capture explorer address links and visible anchor text.
    const contractLinks = [];
    const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 6000);
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/address\/(0x[a-fA-F0-9]{40})/);
      if (!m) continue;
      const address = m[1];
      const label = textOf(a) || a.getAttribute("aria-label") || "Explorer link";
      contractLinks.push({ address, label, href });
      if (contractLinks.length >= 60) break;
    }

    // 3b) Generic address discovery in hrefs (pool links, internal routes, etc).
    // This is safe (doesn't read bundled scripts), and works for apps that encode
    // pool/market addresses in the URL (e.g. /pools/0x...).
    const hrefAddresses = [];
    const addrRe = /(0x[a-fA-F0-9]{40})/g;
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (!href.includes("0x")) continue;
      let mm;
      while ((mm = addrRe.exec(href)) !== null) {
        const address = mm[1];
        const labelText = textOf(a) || a.getAttribute("aria-label") || "";
        const pathHint = href.toLowerCase();
        let kind = "Address link";
        if (pathHint.includes("pool")) kind = "Pool";
        else if (pathHint.includes("market")) kind = "Market";
        else if (pathHint.includes("router")) kind = "Router";
        else if (pathHint.includes("vault")) kind = "Vault";
        else if (pathHint.includes("token")) kind = "Token";
        hrefAddresses.push({
          address,
          href,
          label: labelText ? `${kind}: ${labelText}` : `${kind} address`,
        });
        if (hrefAddresses.length >= 120) break;
      }
      if (hrefAddresses.length >= 120) break;
    }

    // 4) Address contexts: if addresses appear in text, capture nearby container text
    // to help label what the contract likely is.
    const addressRe = /0x[a-fA-F0-9]{40}/g;
    const addressContexts = [];
    const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || "";
    const addrSet = new Set((bodyText.match(addressRe) || []).slice(0, 200).map((a) => a.toLowerCase()));

    // Try to find a DOM element that contains each address.
    const allTextNodes = Array.from(document.querySelectorAll("body *")).slice(0, 12000);
    for (const addr of addrSet) {
      let el = null;
      for (const node of allTextNodes) {
        const t = textOf(node);
        if (t && t.toLowerCase().includes(addr)) {
          el = node;
          break;
        }
      }
      if (!el) continue;
      const container = el.closest("tr,[role='row'],section,article,li,div") || el.parentElement || el;
      const ctx = textOf(container);
      addressContexts.push({
        address: addr,
        context: ctx.slice(0, 260),
      });
      if (addressContexts.length >= 80) break;
    }

    return {
      bestMetric,
      tokenLiquidity,
      contractLinks,
      addressContexts,
      hrefAddresses,
    };
  });

  return data;
}

function extractInvestorsFromHtml(html, opts = {}) {
  if (!html) return [];
  const results = new Set();
  const knownTokens = Array.isArray(opts.knownTokens) ? opts.knownTokens : [];
  const knownTokenSet = new Set(knownTokens.map((t) => String(t || "").toUpperCase()).filter(Boolean));

  // 1) Visible text heuristics (works for rendered SPAs)
  const text = htmlToVisibleText(html);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const anchors = [
    "investors",
    "backers",
    "backed by",
    "funding",
    "seed",
    "series a",
    "series b",
    "strategic",
    "raised",
  ];

  const stopWords = new Set([
    "investors",
    "backers",
    "partners",
    "funding",
    "seed",
    "series",
    "round",
    "raised",
    "our",
    "the",
    "and",
  ]);

  const tokenLike = /^[A-Z][A-Z0-9.-]{1,10}$/;
  const marketTableAnchors = ["asset", "liquidity", "apy", "tvl", "volume", "leverage"];

  function addCandidate(name) {
    const n = String(name || "").replace(/\s+/g, " ").trim();
    if (!n) return;
    if (n.length < 3 || n.length > 60) return;
    if (/^\$|%|^\d/.test(n)) return;
    // Exclude any known token symbols from being misclassified as investors.
    // This fixes cases where tokens like USDe / NUSD appear near investor/funding text.
    if (knownTokenSet.has(n.toUpperCase())) return;
    if (tokenLike.test(n)) return; // avoid tokens like USDC, NUSD, etc.
    if (stopWords.has(n.toLowerCase())) return;
    // require at least one letter
    if (!/[a-z]/i.test(n)) return;
    // Require org-ish structure (at least 2 words) or common org suffix.
    const orgish =
      n.includes(" ") ||
      /(capital|ventures|labs|foundation|partners|dao|research|fund|holdings|group)/i.test(n);
    if (!orgish) return;
    results.add(n);
  }

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (!anchors.some((a) => lower.includes(a))) continue;

    // Take a small window after the anchor and extract likely org names.
    const window = lines.slice(i, Math.min(lines.length, i + 8)).join(" • ");
    // Avoid parsing market tables as investor lists.
    const windowLower = window.toLowerCase();
    if (marketTableAnchors.filter((a) => windowLower.includes(a)).length >= 3) continue;
    // Split on common separators and filter plausible org-ish tokens.
    window
      .split(/[,•|·]/)
      .map((s) => s.trim())
      .forEach((piece) => {
        if (!piece) return;
        if (anchors.some((a) => piece.toLowerCase() === a)) return;
        // Skip obvious boilerplate.
        if (/learn more|read more|privacy|terms|discord|twitter|telegram/i.test(piece)) return;
        // Heuristic: organizations often have capitals or known suffixes, or multiple words.
        const looksOrg =
          /[A-Z]/.test(piece[0]) ||
          piece.includes(" ") ||
          /(capital|ventures|labs|foundation|partners|dao|research|fund)/i.test(piece);
        if (!looksOrg) return;
        // Remove trailing words like "investor(s)".
        const cleaned = piece.replace(/\b(investors?|backers?|partners?)\b/gi, "").trim();
        addCandidate(cleaned);
      });

    if (results.size >= 25) break;
  }

  // 2) Alt-text/logo scan (many sites list investors as logos)
  const altMatches = String(html)
    .match(/alt="([^"]{2,80})"/gi) || [];
  for (const a of altMatches) {
    const m = a.match(/alt="([^"]+)"/i);
    const alt = m?.[1] || "";
    if (!alt) continue;
    if (/logo|icon|image|app|download|asset|liquidity|apy|tvl/i.test(alt.toLowerCase())) continue;
    if (alt.length > 60) continue;
    // Only keep plausible brand names
    if (!/[a-z]/i.test(alt)) continue;
    if (tokenLike.test(alt.trim())) continue;
    if (knownTokenSet.has(alt.trim().toUpperCase())) continue;
    addCandidate(alt);
    if (results.size >= 25) break;
  }

  return Array.from(results).slice(0, 25);
}

async function getWalletAllocationsFromEtherscan({ walletAddress, contracts }) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return {
      allocations: [],
      evidence: ["ETHERSCAN_API_KEY not configured; cannot query wallet allocations."],
    };
  }

  const wallet = String(walletAddress).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { allocations: [], evidence: ["Invalid wallet address format."] };
  }

  const contractSet = new Set(
    (contracts || [])
      .map((c) => String(c.address || "").toLowerCase())
      .filter((a) => /^0x[a-f0-9]{40}$/.test(a))
  );
  if (contractSet.size === 0) {
    return { allocations: [], evidence: ["No protocol contracts detected to match against."] };
  }

  const url =
    "https://api.etherscan.io/api?module=account&action=tokentx" +
    `&address=${encodeURIComponent(wallet)}` +
    "&page=1&offset=200&sort=desc" +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Etherscan tokentx failed: ${resp.status}`);
  const json = await resp.json();
  const txs = Array.isArray(json?.result) ? json.result : [];

  // Summarize net flows per token where counterparty is one of the protocol contracts.
  const byToken = new Map();
  for (const t of txs) {
    const from = String(t.from || "").toLowerCase();
    const to = String(t.to || "").toLowerCase();
    const counterparty = from === wallet ? to : from;
    if (!contractSet.has(counterparty)) continue;

    const symbol = t.tokenSymbol || "TOKEN";
    const decimals = Number(t.tokenDecimal || 0);
    const raw = BigInt(String(t.value || "0"));
    const signed = from === wallet ? raw : -raw; // outgoing positive "deposit", incoming negative "withdraw"

    const key = `${symbol}:${t.contractAddress || ""}`.toLowerCase();
    const prev = byToken.get(key) || {
      token: symbol,
      tokenAddress: t.contractAddress || null,
      decimals,
      netRaw: 0n,
      counterparties: new Set(),
      evidence: [],
    };
    prev.netRaw += signed;
    prev.counterparties.add(counterparty);
    if (prev.evidence.length < 3) {
      prev.evidence.push(`tx ${t.hash} (${from === wallet ? "to" : "from"} ${counterparty})`);
    }
    byToken.set(key, prev);
  }

  const allocations = Array.from(byToken.values())
    .filter((x) => x.netRaw !== 0n)
    .map((x) => {
      const scale = x.decimals > 0 ? 10n ** BigInt(x.decimals) : 1n;
      const abs = x.netRaw < 0n ? -x.netRaw : x.netRaw;
      const whole = abs / scale;
      const frac = x.decimals > 0 ? (abs % scale).toString().padStart(x.decimals, "0").slice(0, 6) : "0";
      const amount = `${whole.toString()}${x.decimals > 0 ? "." + frac : ""}`;
      const direction = x.netRaw > 0n ? "net_deposit" : "net_withdraw";
      return {
        target: "Protocol contracts (matched on Etherscan)",
        token: x.token,
        netDirection: direction,
        netAmount: amount,
        tvlLabel: `${direction === "net_deposit" ? "+" : "-"}${amount} ${x.token}`,
        evidence: x.evidence,
      };
    })
    .slice(0, 50);

  return {
    allocations,
    evidence: [
      "Source: Etherscan account tokentx API (latest 200 ERC-20 transfers).",
      "Allocations represent net token flow between your wallet and detected protocol contracts.",
    ],
  };
}

async function runWebsiteAnalysisWithGpt4All(url, htmlSnippet) {
  try {
    const gpt4all = await import("gpt4all");
    const { loadModel, createCompletion } = gpt4all;

    const modelName = process.env.GPT4ALL_MODEL || "orca-mini-3b-gguf2-q4_0.gguf";

    const model = await loadModel(modelName, {
      verbose: true,
      device: process.env.GPT4ALL_DEVICE || "cpu",
    });

    const prompt = `
You are a DeFi protocol analyst.

Your task is to analyze the given protocol WEBSITE HTML and extract on-chain and risk information
without fabricating details that are not clearly implied by the text.

INPUT:
- Protocol URL: ${url}
- Main page HTML (possibly truncated):
${htmlSnippet}

TASKS:
1. Extract any smart contract addresses you can find in the HTML (or clearly linked pages if they are included in the HTML text),
   and, if possible, infer their roles (e.g. core protocol, pool, token).
2. Infer rough TVL, investors, and daily activity ONLY if the HTML explicitly hints at them (do not guess from prior knowledge).
3. Produce a short qualitative risk summary across these dimensions: security, technical, financial, operational, documentation,
   community, investment/reputation. Base this ONLY on what you see in the HTML (or clearly linked text if present).

Return ONLY JSON in exactly this shape (no extra keys, no extra text):
{
  "protocol": {
    "url": string,
    "name": string | null
  },
  "contracts": [
    {
      "label": string,
      "network": string | null,
      "address": string
    }
  ],
  "tvl": {
    "valueUsd": number | null,
    "evidence": string[]
  },
  "investors": [
    {
      "name": string,
      "role": string | null,
      "evidence": string[]
    }
  ],
  "txsPerDay": {
    "value": number | null,
    "evidence": string[]
  },
  "risk": {
    "level": "low" | "medium" | "high" | "unknown",
    "summary": string
  }
}

IMPORTANT:
- If you cannot find a field from the HTML, set its value to null (for numbers/strings) or [] (for arrays) and mention that
  limitation in the evidence/summary. Do NOT invent contract addresses or TVL from prior knowledge.
`.trim();

    const completion = await createCompletion(model, prompt);
    const message = completion.choices?.[0]?.message;
    const text = typeof message === "string" ? message : message?.content ?? "";

    if (typeof model.dispose === "function") {
      model.dispose();
    }

    if (!text) {
      throw new Error("GPT4All returned empty response for website analysis.");
    }

    const parsed = parseLikelyJson(text);
    return parsed;
  } catch (err) {
    console.error("runWebsiteAnalysisWithGpt4All error:", err);
    return null;
  }
}

function extractContractsFromHtml(html, opts = {}) {
  const results = [];
  const seen = new Set();
  const visibleText = htmlToVisibleText(html);
  const visibleLower = visibleText.toLowerCase();

  const visibleTextOnly = Boolean(opts.visibleTextOnly);

  const etherscanRegex =
    /https?:\/\/([a-z0-9-]*scan)\.io\/address\/(0x[a-fA-F0-9]{40})/g;
  let m;
  while ((m = etherscanRegex.exec(html)) !== null) {
    const host = m[1];
    const address = m[2];
    if (seen.has(address)) continue;
    seen.add(address);
    const network = mapScanHostToNetwork(host);
    const ctx = extractContextAround(html, m.index, 220);
    const inferred = inferContractLabelFromText(ctx.visibleText) || "Contract (explorer link)";
    results.push({
      label: inferred,
      network,
      address,
      evidence: ctx.visibleText ? ctx.visibleText.slice(0, 220) : undefined,
      source: "explorer_link",
    });
  }

  const bareAddressRegex = /0x[a-fA-F0-9]{40}/g;
  const addressSourceText = visibleTextOnly ? visibleText : html;
  while ((m = bareAddressRegex.exec(addressSourceText)) !== null) {
    const address = m[0];
    if (seen.has(address)) continue;
    seen.add(address);

    // Prefer context from visible text (less noisy than raw HTML).
    const idx = visibleLower.indexOf(address.toLowerCase());
    const snippet = idx >= 0 ? extractTextWindow(visibleText, idx, 240) : "";
    const inferred = inferContractLabelFromText(snippet) || "Contract (detected on page)";
    results.push({
      label: inferred,
      network: "Unknown",
      address,
      evidence: snippet || undefined,
      source: "visible_text",
    });
    if (results.length >= 10) break;
  }

  return results;
}

function extractTextWindow(text, index, windowSize) {
  const start = Math.max(0, index - Math.floor(windowSize / 2));
  const end = Math.min(text.length, index + Math.floor(windowSize / 2));
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractContextAround(html, index, windowSize) {
  const start = Math.max(0, index - Math.floor(windowSize / 2));
  const end = Math.min(html.length, index + Math.floor(windowSize / 2));
  const raw = html.slice(start, end);
  return { raw, visibleText: htmlToVisibleText(raw) };
}

function inferContractLabelFromText(context) {
  const t = String(context || "").toLowerCase();
  if (!t) return null;

  // Order matters: prefer more specific matches first.
  const rules = [
    ["router", "Router contract"],
    ["factory", "Factory contract"],
    ["vault", "Vault contract"],
    ["pool", "Pool contract"],
    ["market", "Market contract"],
    ["pair", "Pair contract"],
    ["staking", "Staking contract"],
    ["gauge", "Gauge contract"],
    ["oracle", "Oracle contract"],
    ["aggregator", "Aggregator contract"],
    ["bridge", "Bridge contract"],
    ["token", "Token contract"],
    ["erc20", "Token (ERC‑20) contract"],
    ["governance", "Governance contract"],
    ["treasury", "Treasury contract"],
    ["proxy", "Proxy contract"],
    ["implementation", "Implementation contract"],
    ["multisig", "Multisig contract"],
    ["timelock", "Timelock contract"],
    ["admin", "Admin contract"],
  ];

  for (const [needle, label] of rules) {
    if (t.includes(needle)) return label;
  }

  // If context mentions chain explorers, label generically.
  if (t.includes("etherscan") || t.includes("arbiscan") || t.includes("polygonscan")) {
    return "Contract address (explorer)";
  }

  return null;
}

function mapScanHostToNetwork(host) {
  if (host === "etherscan") return "Ethereum";
  if (host === "arbiscan") return "Arbitrum";
  if (host === "polygonscan") return "Polygon";
  if (host === "bscscan") return "BNB Chain";
  if (host === "optimistic" || host === "optimism") return "Optimism";
  if (host === "basescan") return "Base";
  return "Unknown";
}

// In Vercel Serverless Functions we shouldn't bind to a port.
// When running locally (or outside Vercel), start the HTTP server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(
      "Enabled routes: GET /api/health, GET /api/analyze, POST /api/llm-analyze, GET /api/risk-schema, POST /api/risk-assessment"
    );
  });
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl.trim();
  }
}

async function getDefiLlamaTvl(origin) {
  console.log("[DefiLlama] Fetching TVL for origin:", origin);

  const protocolSlug = "uniswap";

  const url = `https://api.llama.fi/tvl/${protocolSlug}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`DefiLlama TVL request failed with status ${resp.status}`);
  }

  const data = await resp.json();

  return {
    usd: typeof data === "number" ? data : data?.tvl ?? null,
    source: "defillama",
    raw: data,
  };
}

async function getDefiLlamaProtocolByUrl(origin) {
  // Matches the protocol entry by URL (best-effort).
  // API: https://api.llama.fi/protocols
  const resp = await fetch("https://api.llama.fi/protocols");
  if (!resp.ok) throw new Error(`DefiLlama protocols request failed: ${resp.status}`);
  const protocols = await resp.json();

  const originHost = safeHost(origin);
  const originBase = baseDomain(originHost);

  const match = protocols.find((p) => {
    const pUrl = typeof p?.url === "string" ? p.url : "";
    const pHost = safeHost(pUrl);
    if (!pHost || !originHost) return false;
    if (pHost === originHost) return true;
    // subdomain match (app.foo.com vs foo.com)
    if (originHost.endsWith("." + pHost)) return true;
    if (pHost.endsWith("." + originHost)) return true;
    // base-domain match
    const pBase = baseDomain(pHost);
    return Boolean(originBase && pBase && originBase === pBase);
  });

  if (!match) return null;

  return {
    name: match.name || null,
    slug: match.slug || null,
    tvlUsd: typeof match.tvl === "number" ? match.tvl : null,
    defillamaUrl: match.url || null,
    chains: Array.isArray(match.chains) ? match.chains : [],
    listedAt: typeof match.listedAt === "number" ? match.listedAt : null,
    description: typeof match.description === "string" ? match.description : null,
    methodology: typeof match.methodology === "string" ? match.methodology : null,
    methodologyUrl: typeof match.methodologyURL === "string" ? match.methodologyURL : null,
    // audits is usually a string/number; normalize to number or null
    audits:
      match?.audits == null
        ? null
        : Number.isFinite(Number(match.audits))
          ? Number(match.audits)
          : null,
    auditLinks: Array.isArray(match.audit_links) ? match.audit_links : [],
    // keep original for debugging
    rawProtocol: match,
  };
}

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function baseDomain(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return h;
  return parts.slice(-2).join(".");
}

async function getCryptoRankInvestors(protocolName) {
  const CRYPTORANK_API_KEY = process.env.CRYPTORANK_API_KEY;
  if (!CRYPTORANK_API_KEY) {
    return {
      investors: [],
      evidence: ["CryptoRank API key not configured (set CRYPTORANK_API_KEY)."],
    };
  }

  if (!protocolName) {
    return { investors: [], evidence: ["No protocol name available to query CryptoRank."] };
  }

  // 1) Search currency/project by name
  const searchUrl =
    "https://api.cryptorank.io/v2/currencies/search?query=" + encodeURIComponent(protocolName);
  const searchResp = await fetch(searchUrl, {
    headers: { "X-Api-Key": CRYPTORANK_API_KEY },
  });
  if (!searchResp.ok) throw new Error(`CryptoRank search failed: ${searchResp.status}`);
  const searchJson = await searchResp.json();

  const first = Array.isArray(searchJson?.data) ? searchJson.data[0] : null;
  const id = first?.id;
  if (!id) {
    return {
      investors: [],
      evidence: [`CryptoRank search returned no project for "${protocolName}".`],
    };
  }

  // 2) Funding rounds by currency id
  const roundsUrl = `https://api.cryptorank.io/v2/currencies/${id}/funding-rounds`;
  const roundsResp = await fetch(roundsUrl, {
    headers: { "X-Api-Key": CRYPTORANK_API_KEY },
  });
  if (!roundsResp.ok) throw new Error(`CryptoRank funding rounds failed: ${roundsResp.status}`);
  const roundsJson = await roundsResp.json();

  const rounds = Array.isArray(roundsJson?.data) ? roundsJson.data : [];
  const investorNames = new Set();

  for (const r of rounds) {
    const investors = Array.isArray(r?.investors) ? r.investors : [];
    for (const inv of investors) {
      if (typeof inv?.name === "string" && inv.name.trim()) investorNames.add(inv.name.trim());
    }
  }

  return {
    investors: Array.from(investorNames).slice(0, 25),
    evidence: [
      `CryptoRank API funding rounds for "${first?.name || protocolName}" (id=${id})`,
      "Source: https://cryptorank.io/",
    ],
  };
}

async function getEtherscanContracts(origin) {
  console.log("[Contracts] Discovering contracts for origin:", origin);

  const url = new URL(origin);
  const host = url.hostname;

  // 1) Optional override via local mapping file (you can curate this yourself).
  try {
    const contractsPath = path.join(__dirname, "protocol_contracts.json");
    if (fs.existsSync(contractsPath)) {
      const raw = fs.readFileSync(contractsPath, "utf8");
      const mapping = JSON.parse(raw);
      const match = mapping[host] || mapping[origin];
      if (Array.isArray(match) && match.length > 0) {
        console.log("[Contracts] Using local protocol_contracts.json mapping for", host);
        return match;
      }
    }
  } catch (e) {
    console.warn("[Contracts] Failed to read protocol_contracts.json:", e.message);
  }

  // 2) Automatic discovery from the protocol website HTML.
  try {
    const resp = await fetch(origin, {
      headers: {
        "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)",
      },
    });

    if (!resp.ok) {
      console.warn("[Contracts] Failed to fetch HTML:", resp.status);
    } else {
      const html = await resp.text();
      const discovered = extractContractsFromHtml(html);
      if (discovered.length > 0) {
        console.log(
          `[Contracts] Discovered ${discovered.length} contract address(es) directly from HTML.`
        );
        return discovered;
      }
    }
  } catch (e) {
    console.warn("[Contracts] Error while fetching/parsing HTML:", e.message);
  }

  console.warn(
    "[Contracts] No contracts discovered automatically. Consider adding protocol_contracts.json overrides."
  );
  return [];
}

async function getTransactionsPerDay(origin) {
  console.log("[Txs] Fetching txs/day for origin:", origin);

  // TODO: plug in your analytics/indexer here (Covalent, Alchemy, Dune, custom indexer, etc.).
  // For now, return null so the frontend shows 'No tx data yet.' instead of crashing.
  return null;
}

async function getDefiLlamaVolume24h(slug) {
  if (!slug) return null;

  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const resp = await fetch(protoUrl, {
    headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
  });
  if (!resp.ok) throw new Error(`DefiLlama protocol page failed: ${resp.status}`);
  const html = await resp.text();
  const text = htmlToVisibleText(html);

  function parseCompactMoney(raw, suffix) {
    let v = parseFloat(String(raw || "").replace(/,/g, ""));
    if (!isFinite(v)) return null;
    const s = String(suffix || "").toLowerCase();
    if (s === "k") v *= 1e3;
    else if (s === "m") v *= 1e6;
    else if (s === "b") v *= 1e9;
    return v;
  }

  const dexRe = /DEX\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const tokenRe = /\$([A-Z][A-Z0-9]{1,12})\s+Volume\s+24h\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/gi;
  let match;
  const values = [];
  while ((match = tokenRe.exec(text)) !== null) {
    const v = parseCompactMoney(match[2], match[3]);
    if (v == null) continue;
    values.push({ symbol: match[1], value: v });
  }

  // Prefer native token volume first.
  if (values.length) {
    const chosen = values[0];
    return {
      value: chosen.value,
      evidence: [`$${chosen.symbol} Volume 24h (native token, DefiLlama protocol page)`, protoUrl],
      raw: { chosen, source: "native_token_volume_24h" },
    };
  }

  // Fallback: DEX Volume 24h row.
  const dexM = dexRe.exec(text);
  if (!dexM) return { value: null, evidence: ["No 24h volume found on protocol page."], raw: null };

  const v = parseCompactMoney(dexM[1], dexM[2]);
  if (v == null) return { value: null, evidence: ["24h volume parse failed."], raw: null };

  return {
    value: v,
    evidence: ["DEX Volume 24h (DefiLlama protocol page)", protoUrl],
    raw: { matched: dexM[0], source: "dex_volume_24h" },
  };
}

async function getDefiLlamaTotalRaisedUsd(slug) {
  if (!slug) return null;
  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const resp = await fetch(protoUrl, {
    headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
  });
  if (!resp.ok) throw new Error(`DefiLlama totalRaised request failed: ${resp.status}`);
  const html = await resp.text();
  const text = htmlToVisibleText(html);

  // Example: "Total Raised$3.7m"
  const re = /Total Raised\s*\$?\s*([\d.,]+)\s*([kKmMbB])?/i;
  const m = re.exec(text);
  if (!m) return { value: null, evidence: ["Total raised not found on DefiLlama protocol page."], raw: text.slice(0, 2000) };

  const raw = m[1];
  const suffix = (m[2] || "").toLowerCase();
  let v = parseFloat(String(raw).replace(/,/g, ""));
  if (!isFinite(v)) return { value: null, evidence: ["Total raised parse failed."] };
  if (suffix === "k") v *= 1e3;
  else if (suffix === "m") v *= 1e6;
  else if (suffix === "b") v *= 1e9;

  return {
    value: v,
    evidence: ["Total raised (from DefiLlama protocol page)", protoUrl],
    raw: { matched: m[0] },
  };
}

async function getInvestorsStub(origin) {
  console.log("[Investors] Returning stubbed investors for origin:", origin);

  return [
    { name: "Placeholder Capital", stake: "3.5%" },
    { name: "Demo Ventures", stake: "2.1%" },
    { name: "Sample Labs", stake: "1.2%" },
  ];
}

