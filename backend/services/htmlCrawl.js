import fs from "fs";
import fetch from "node-fetch";
import { chromium } from "playwright";
import { isPlaceholderAddress } from "./poolAddress.js";

function firstExistingChromeExecutable() {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else if (process.platform === "linux") {
    candidates.push("/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium");
  }
  const envExe = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (envExe) candidates.unshift(envExe);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

async function launchChromiumBrowser() {
  const isVercel = String(process.env.VERCEL || "") !== "";
  const args = isVercel ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
  const paths = [firstExistingChromeExecutable(), null];
  let lastErr = null;
  for (const executablePath of paths) {
    try {
      const opts = { headless: true, args };
      if (executablePath) opts.executablePath = executablePath;
      return await chromium.launch(opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Playwright chromium launch failed");
}

export function htmlToVisibleText(html) {
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

export function extractAddressesFromText(text) {
  const seen = new Set();
  const out = [];
  const re = /0x[a-fA-F0-9]{40}/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const a = m[0].toLowerCase();
    if (!seen.has(a) && !isPlaceholderAddress(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

function playwrightEnabled() {
  return String(process.env.SKIP_PLAYWRIGHT_RENDER || "").toLowerCase() !== "1";
}

export function shouldRenderHtml({ html, url }) {
  if (!html) return true;
  const lower = String(html).toLowerCase();
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isAppSubdomain =
      host.startsWith("app.") ||
      host.startsWith("trade.") ||
      host.startsWith("vault.") ||
      host.startsWith("markets.");
    const isKnownAppPath =
      /(market|vault|pool|earn|swap|stake|dashboard)/i.test(path);
    if (isAppSubdomain || isKnownAppPath) return true;
  } catch {
    // ignore
  }
  if (lower.includes("failed to load app")) return true;
  if (lower.includes("you need to enable javascript")) return true;
  const text = htmlToVisibleText(html);
  if (text.length < 400) return true;
  const hasRoot =
    lower.includes('id="root"') ||
    lower.includes('id="app"') ||
    lower.includes('data-reactroot');
  const scriptCount = (lower.match(/<script\b/g) || []).length;
  if (hasRoot && scriptCount >= 5) return true;
  if (lower.includes("__next_data__") && scriptCount >= 8) return true;
  return false;
}

export async function renderHtmlWithPlaywright(url, { timeoutMs } = {}) {
  const isVercel = String(process.env.VERCEL || "") !== "";
  const browser = await launchChromiumBrowser();
  try {
    const hardTimeoutMs = Number(
      timeoutMs || process.env.PLAYWRIGHT_RENDER_TIMEOUT_MS || (isVercel ? 60_000 : 35_000)
    );
    let hardTimer = null;
    const hardTimeout = new Promise((_, reject) => {
      hardTimer = setTimeout(async () => {
        try {
          await browser.close();
        } catch {}
        reject(new Error(`Playwright render timed out after ${hardTimeoutMs}ms`));
      }, hardTimeoutMs);
    });

    const work = (async () => {
      const context = await browser.newContext({
        userAgent: "cryptoanalyzer/pool-crawl (+https://github.com/)",
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") return route.abort();
        return route.continue();
      });

      const navTimeoutMs = Number(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS || (isVercel ? 60_000 : 25_000));
      page.setDefaultNavigationTimeout(navTimeoutMs);
      page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_OP_TIMEOUT_MS || (isVercel ? 60_000 : 25_000)));

      let lastErr = null;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (err) {
        lastErr = err;
      }

      try {
        await page.waitForFunction(
          () => {
            const t = (document.body && (document.body.innerText || document.body.textContent)) || "";
            return (
              (/vault|pool|earn|apy|tvl|deposit|liquidity|usdc|integrat/i.test(t) && t.length > 180) ||
              (/\$[\d]/.test(t) && t.length > 280)
            );
          },
          {
            timeout: Number(process.env.PLAYWRIGHT_WAIT_FOR_TEXT_TIMEOUT_MS || (isVercel ? 20_000 : 10_000)),
          }
        );
      } catch {
        // continue with partial DOM
      }
      try {
        await page.waitForTimeout(600);
      } catch {}

      let html = await page.content();
      let innerText = "";
      try {
        innerText = await page.evaluate(() => (document.body && document.body.innerText) || "");
      } catch {
        innerText = "";
      }
      let visible = innerText.length > 80 ? innerText : htmlToVisibleText(html);
      if (visible.length < 300) {
        try {
          await page.waitForTimeout(2000);
        } catch {}
        html = await page.content();
        try {
          innerText = await page.evaluate(() => (document.body && document.body.innerText) || "");
        } catch {
          innerText = "";
        }
        visible = innerText.length > 80 ? innerText : htmlToVisibleText(html);
      }

      await context.close();
      return { html, visible, innerText: innerText || visible, lastErr: lastErr ? String(lastErr.message || lastErr) : null };
    })();

    const result = await Promise.race([work, hardTimeout]);
    if (hardTimer) clearTimeout(hardTimer);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Fetch HTML; render with Playwright when the page looks like a SPA (same as protocol intelligence).
 */
export async function fetchHtmlWithOptionalRender(url, { forceRender = false } = {}) {
  const headers = { "User-Agent": "cryptoanalyzer/pool-crawl (+https://github.com/)" };
  const isVercel = String(process.env.VERCEL || "") !== "";
  const fetchTimeoutMs = Number(process.env.HTML_FETCH_TIMEOUT_MS || (isVercel ? 30_000 : 15_000));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let resp;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    return {
      ok: false,
      status: 504,
      html: "",
      visible: "",
      rendered: false,
      renderError: String(err?.message || err),
      addresses: [],
    };
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, html: "", visible: "", rendered: false, addresses: [] };
  }

  const html = await resp.text();
  const force =
    forceRender || String(process.env.FORCE_RENDER || "").toLowerCase() === "1";
  const should = force || shouldRenderHtml({ html, url });

  if (!should || !playwrightEnabled()) {
    const visible = htmlToVisibleText(html);
    return {
      ok: true,
      status: resp.status,
      html,
      visible,
      rendered: false,
      addresses: extractAddressesFromText(visible + html),
    };
  }

  const rendered = await renderHtmlWithPlaywright(url).catch((err) => ({
    html,
    visible: htmlToVisibleText(html),
    lastErr: String(err?.message || err),
  }));

  const finalHtml = rendered?.html || html;
  const innerText = rendered?.innerText || "";
  const visible =
    innerText.length > 80 ? innerText : rendered?.visible || htmlToVisibleText(finalHtml);
  return {
    ok: true,
    status: resp.status,
    html: finalHtml,
    visible,
    innerText: innerText || visible,
    rendered: Boolean(rendered?.html && rendered.html !== html),
    renderError: rendered?.lastErr || null,
    addresses: extractAddressesFromText(visible + finalHtml),
  };
}
