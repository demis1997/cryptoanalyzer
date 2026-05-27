const TABS = [
  { id: "overview", label: "Overview", icon: "◈" },
  { id: "graph", label: "Risk Graph", icon: "◎" },
  { id: "contracts", label: "Smart Contracts", icon: "⬡" },
  { id: "liquidity", label: "Liquidity & TVL", icon: "◆" },
  { id: "funding", label: "Funding & Investors", icon: "◇" },
  { id: "wallet", label: "Wallet Exposure", icon: "◉" },
  { id: "evidence", label: "Evidence & Sources", icon: "▣" },
  { id: "export", label: "Report Export", icon: "↓" },
];

let motionReady = null;

async function loadMotion() {
  if (motionReady) return motionReady;
  try {
    motionReady = await import("https://cdn.jsdelivr.net/npm/motion@11.15.0/+esm");
  } catch {
    motionReady = { animate: () => {}, stagger: () => 0 };
  }
  return motionReady;
}

export function initShell() {
  const sidebar = document.getElementById("sidebar-nav");
  const panels = document.querySelectorAll("[data-panel]");
  const tabButtons = document.querySelectorAll("[data-tab]");

  function setTab(tabId) {
    tabButtons.forEach((btn) => {
      btn.classList.toggle("sidebar__item--active", btn.dataset.tab === tabId);
    });
    const resultsVisible = document.getElementById("results-hero") && !document.getElementById("results-hero").hidden;
    const landing = document.getElementById("landing-state");
    if (!resultsVisible) {
      if (landing) landing.hidden = tabId === "graph";
      panels.forEach((panel) => {
        if (panel.dataset.panel === "landing") return;
        const on = tabId === "graph" && panel.dataset.panel === "graph";
        panel.classList.toggle("panel--active", on);
        panel.hidden = !on;
      });
    } else {
      if (landing) landing.hidden = true;
      panels.forEach((panel) => {
        if (panel.dataset.panel === "landing") return;
        const on = panel.dataset.panel === tabId;
        panel.classList.toggle("panel--active", on);
        panel.hidden = !on;
      });
      animatePanel(tabId);
    }
    const u = new URL(window.location.href);
    u.searchParams.set("tab", tabId);
    history.replaceState(null, "", u.toString());
    document.dispatchEvent(new CustomEvent("platform-tab", { detail: { tabId } }));

    // Ensure tab navigation actually takes the user to the content.
    // (Most panels are below the fold; switching visibility without scrolling feels broken.)
    requestAnimationFrame(() => {
      const panel = document.querySelector(`[data-panel="${tabId}"]`);
      if (panel && !panel.hidden) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      // Fallback: jump to top if panel isn't present yet.
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  if (sidebar) {
    TABS.forEach((t) => {
      const exists = document.querySelector(`[data-tab="${t.id}"]`);
      if (exists) return;
    });
  }

  tabButtons.forEach((btn) => {
    btn.classList.toggle("sidebar__item--active", btn.dataset.tab === "overview");
  });

  const initial = new URL(window.location.href).searchParams.get("tab") || "overview";
  const resultsVisible = document.getElementById("results-hero") && !document.getElementById("results-hero").hidden;
  if (resultsVisible) setTab(TABS.some((t) => t.id === initial) ? initial : "overview");

  return { setTab };
}

async function animatePanel(tabId) {
  const panel = document.querySelector(`[data-panel="${tabId}"]`);
  if (!panel) return;
  const { animate, stagger } = await loadMotion();
  const cards = panel.querySelectorAll(".animate-in");
  if (!cards.length) return;
  animate(
    cards,
    { opacity: [0, 1], y: [12, 0] },
    { duration: 0.38, delay: stagger(0.04), easing: [0.22, 1, 0.36, 1] }
  );
}

export function setPlatformStatus(message, tone = "info") {
  const el = document.getElementById("platform-status");
  if (!el) return;
  el.textContent = message || "";
  el.dataset.tone = tone;
  el.hidden = !message;
}

export function setAnalyzing(active) {
  const root = document.getElementById("platform-root");
  if (root) root.classList.toggle("platform--loading", Boolean(active));
  const btn = document.getElementById("analyze-btn");
  if (btn) {
    btn.disabled = active;
    btn.querySelector(".btn__label").textContent = active ? "Analyzing…" : "Run intelligence";
  }
}

export function showToast(message, tone = "error") {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("toast--visible");
  setTimeout(() => toast.classList.remove("toast--visible"), 5200);
}

export async function revealResults() {
  const { animate, stagger } = await loadMotion();
  const hero = document.getElementById("results-hero");
  if (hero) {
    hero.hidden = false;
    animate(hero, { opacity: [0, 1], y: [16, 0] }, { duration: 0.45, easing: [0.22, 1, 0.36, 1] });
  }
  const cards = document.querySelectorAll("#results-hero .animate-in, .panel--active .animate-in");
  if (cards.length) {
    animate(cards, { opacity: [0, 1], y: [10, 0] }, { duration: 0.35, delay: stagger(0.03) });
  }
}

export { TABS };
