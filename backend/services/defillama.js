import fetch from "node-fetch";

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

export async function getDefiLlamaTvl(origin) {
  // Legacy placeholder: current implementation used by the /api/analyze endpoint
  // is “uniswap” TVL. Keep behavior stable.
  const protocolSlug = "uniswap";
  const url = `https://api.llama.fi/tvl/${protocolSlug}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DefiLlama TVL request failed with status ${resp.status}`);
  const data = await resp.json();
  return {
    usd: typeof data === "number" ? data : data?.tvl ?? null,
    source: "defillama",
    raw: data,
  };
}

export async function getDefiLlamaProtocolByUrl(origin) {
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

export async function getDefiLlamaVolume24h(slug) {
  if (!slug) return null;

  const protoUrl = `https://defillama.com/protocol/${encodeURIComponent(slug)}`;
  const resp = await fetch(protoUrl, {
    headers: { "User-Agent": "ProtocolInspector/1.0 (+https://github.com/)" },
  });
  if (!resp.ok) throw new Error(`DefiLlama volume24h request failed: ${resp.status}`);

  const html = await resp.text();
  const text = htmlToVisibleText(html);

  // We want the same "total $<SYMBOL> Volume 24h$" shown in the UI.
  const re = /\$([A-Z][A-Z0-9]{1,12})\s+Volume 24h\$\s*([0-9.,]+)\s*([kKmMbB])?/i;
  const m = re.exec(text);
  if (!m) return { value: null, evidence: ["24h volume not found on DefiLlama protocol page."] };

  const valueRaw = m[2];
  const suffix = (m[3] || "").toLowerCase();

  let v = parseFloat(String(valueRaw).replace(/,/g, ""));
  if (!isFinite(v)) return { value: null, evidence: ["24h volume parse failed."] };

  if (suffix === "k") v *= 1e3;
  else if (suffix === "m") v *= 1e6;
  else if (suffix === "b") v *= 1e9;

  const symbol = m[1] || null;
  return {
    value: v,
    evidence: [`$${symbol} Volume 24h`, protoUrl],
    raw: { matched: m[0] },
  };
}

export async function getDefiLlamaTotalRaisedUsd(slug) {
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
  if (!m) {
    return {
      value: null,
      evidence: ["Total raised not found on DefiLlama protocol page."],
      raw: text.slice(0, 2000),
    };
  }

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

