import { escapeHtml } from "./ui-components.js";

const KIND_COLORS = {
  protocol: "#38bdf8",
  yield_pool: "#818cf8",
  token: "#34d399",
  contract: "#fbbf24",
  asset: "#a78bfa",
  bridge: "#f472b6",
  oracle: "#22d3ee",
};

export const DEMO_GRAPH = {
  ref: "protocol:wbtc",
  nodes: [
    { ref: "protocol:wbtc", kind: "protocol", label: "WBTC Bridge" },
    { ref: "token:wbtc", kind: "token", label: "WBTC" },
    { ref: "protocol:ethereum", kind: "protocol", label: "Ethereum" },
    { ref: "protocol:bitgo", kind: "protocol", label: "Custodian" },
    { ref: "protocol:uniswap", kind: "protocol", label: "Uniswap" },
    { ref: "protocol:chainlink", kind: "oracle", label: "Chainlink" },
    { ref: "protocol:aave", kind: "protocol", label: "Aave" },
    { ref: "yield_pool:eth-wbtc", kind: "yield_pool", label: "ETH-WBTC Pool" },
    { ref: "contract:bridge", kind: "contract", label: "Bridge Router" },
    { ref: "protocol:curve", kind: "protocol", label: "Curve" },
  ],
  edges: [
    { from: "protocol:wbtc", to: "token:wbtc", relation: "wraps" },
    { from: "protocol:wbtc", to: "protocol:bitgo", relation: "custody" },
    { from: "protocol:wbtc", to: "protocol:ethereum", relation: "settlement" },
    { from: "token:wbtc", to: "protocol:uniswap", relation: "liquidity" },
    { from: "token:wbtc", to: "protocol:aave", relation: "collateral" },
    { from: "protocol:wbtc", to: "protocol:chainlink", relation: "oracle" },
    { from: "protocol:wbtc", to: "contract:bridge", relation: "routes" },
    { from: "contract:bridge", to: "yield_pool:eth-wbtc", relation: "pool" },
    { from: "token:wbtc", to: "protocol:curve", relation: "liquidity" },
  ],
};

function colorForKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (KIND_COLORS[k]) return KIND_COLORS[k];
  if (k.includes("bridge")) return KIND_COLORS.bridge;
  if (k.includes("oracle")) return KIND_COLORS.oracle;
  return "#64748b";
}

function bfsLayers(rootRef, nodes, edges, maxDepth = 5) {
  const adj = new Map();
  for (const e of edges) {
    const a = String(e.from);
    const b = String(e.to);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const depth = new Map([[rootRef, 0]]);
  const q = [rootRef];
  while (q.length) {
    const cur = q.shift();
    const d = depth.get(cur);
    if (d >= maxDepth) continue;
    for (const nb of adj.get(cur) || []) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        q.push(nb);
      }
    }
  }
  return depth;
}

export class GraphPanel {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect?: (node: object) => void }} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.onSelect = opts.onSelect || (() => {});
    this.depth = 3;
    this.pan = { x: 0, y: 0, k: 1 };
    this.drag = null;
    this.data = null;
    this.selectedRef = null;
  }

  setDepth(d) {
    this.depth = Math.min(5, Math.max(1, Number(d) || 2));
    if (this.data) this.render(this.data);
  }

  /** @param {{ ref?: string, nodes: object[], edges: object[] }} graph */
  render(graph) {
    this.data = graph;
    const nodesIn = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edgesIn = Array.isArray(graph?.edges) ? graph.edges : [];
    const rootRef =
      graph?.ref ||
      nodesIn.find((n) => n.kind === "protocol")?.ref ||
      nodesIn[0]?.ref ||
      "root";

    const depthMap = bfsLayers(rootRef, nodesIn, edgesIn, this.depth);
    const nodes = nodesIn.filter((n) => depthMap.has(n.ref));
    const allowed = new Set(nodes.map((n) => n.ref));
    const edges = edgesIn.filter((e) => allowed.has(e.from) && allowed.has(e.to));

    if (!nodes.length) {
      this.container.innerHTML = `<div class="graph-panel__empty">No graph data available for this depth.</div>`;
      return;
    }

    const w = 1200;
    const h = 520;
    const cx = w / 2;
    const cy = h / 2;
    const layers = new Map();
    for (const n of nodes) {
      const d = depthMap.get(n.ref) || 0;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(n);
    }

    const positions = new Map();
    positions.set(rootRef, { x: cx, y: cy });

    const maxLayer = Math.max(...layers.keys());
    for (let layer = 1; layer <= maxLayer; layer++) {
      const list = layers.get(layer) || [];
      const radius = 70 + layer * 95;
      list.forEach((n, i) => {
        const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
        positions.set(n.ref, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      });
    }

    const edgePaths = edges
      .map((e) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return "";
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - 18;
        const rel = String(e.relation || e.type || "link");
        const weak = /bridge|custody|oracle/i.test(rel);
        return `
          <path class="graph-edge ${weak ? "graph-edge--weak" : ""}" d="M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}"/>
          <text class="graph-edge-label" x="${mx}" y="${my - 4}" text-anchor="middle">${escapeHtml(rel.slice(0, 14))}</text>
        `;
      })
      .join("");

    const nodeEls = nodes
      .map((n) => {
        const p = positions.get(n.ref);
        if (!p) return "";
        const isRoot = n.ref === rootRef;
        const col = colorForKind(n.kind);
        const label = String(n.label || n.name || n.ref).slice(0, 22);
        const wBox = isRoot ? 148 : 128;
        const hBox = isRoot ? 44 : 36;
        return `
          <g class="graph-node ${isRoot ? "graph-node--root" : ""} ${this.selectedRef === n.ref ? "graph-node--active" : ""}"
             data-ref="${escapeHtml(n.ref)}" transform="translate(${p.x - wBox / 2},${p.y - hBox / 2})" style="cursor:pointer">
            <rect width="${wBox}" height="${hBox}" rx="12" fill="rgba(8,14,28,0.92)" stroke="${col}" stroke-width="${isRoot ? 2 : 1.2}"/>
            <text x="${wBox / 2}" y="${hBox / 2 + 4}" text-anchor="middle" fill="#e2e8f0" font-size="${isRoot ? 12 : 11}" font-weight="${isRoot ? 600 : 500}">${escapeHtml(label)}</text>
            <text x="${wBox / 2}" y="${hBox - 6}" text-anchor="middle" fill="#64748b" font-size="9">${escapeHtml(String(n.kind || ""))}</text>
          </g>
        `;
      })
      .join("");

    this.container.innerHTML = `
      <div class="graph-panel__toolbar">
        <span class="graph-panel__stat">${nodes.length} nodes</span>
        <span class="graph-panel__stat">${edges.length} dependencies</span>
        <span class="graph-panel__stat">Depth ${this.depth}</span>
      </div>
      <svg class="graph-panel__svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Protocol risk dependency graph">
        <defs>
          <radialGradient id="graphGlow" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stop-color="#1e3a5f" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#020617" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="${w}" height="${h}" fill="#030712" rx="16"/>
        <rect width="${w}" height="${h}" fill="url(#graphGlow)"/>
        <g id="graph-viewport" transform="translate(${this.pan.x} ${this.pan.y}) scale(${this.pan.k})">
          ${edgePaths}
          ${nodeEls}
        </g>
      </svg>
      <div class="graph-legend">
        ${Object.entries(KIND_COLORS)
          .slice(0, 6)
          .map(([k, c]) => `<span class="graph-legend__item"><i style="background:${c}"></i>${k}</span>`)
          .join("")}
      </div>
    `;

    this._bindInteractions(nodes);
  }

  renderDemo() {
    this.render({ ...DEMO_GRAPH, ref: DEMO_GRAPH.ref });
  }

  /** Convert analysis.connections to graph format */
  static fromConnections(connections, rootLabel = "Subject") {
    const nodes = Array.isArray(connections?.nodes) ? connections.nodes : [];
    const edges = Array.isArray(connections?.edges) ? connections.edges : [];
    if (!nodes.length) return null;
    const normalizedNodes = nodes.map((n) => ({
      ref: n.id || n.ref || n.address || String(n.label),
      kind: n.kind || n.type || "contract",
      label: n.label || n.name || n.id || "Node",
      address: n.address,
    }));
    const normalizedEdges = edges.map((e) => ({
      from: e.from,
      to: e.to,
      relation: e.relation || e.label || "connected",
    }));
    const root =
      normalizedNodes.find((n) => n.kind === "protocol")?.ref || normalizedNodes[0]?.ref;
    return { ref: root, nodes: normalizedNodes, edges: normalizedEdges };
  }

  _bindInteractions(nodes) {
    const svg = this.container.querySelector(".graph-panel__svg");
    const viewport = this.container.querySelector("#graph-viewport");
    if (!svg || !viewport) return;

    const byRef = new Map(nodes.map((n) => [n.ref, n]));

    this.container.querySelectorAll(".graph-node").forEach((g) => {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        const ref = g.getAttribute("data-ref");
        this.selectedRef = ref;
        this.container.querySelectorAll(".graph-node").forEach((el) => el.classList.remove("graph-node--active"));
        g.classList.add("graph-node--active");
        const node = byRef.get(ref);
        if (node) this.onSelect(node);
        if (this.data) this.render(this.data);
      });
    });

    if (svg.__bound) return;
    svg.__bound = true;

    const clientToSvg = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const m = svg.getScreenCTM();
      if (!m) return { x: 0, y: 0 };
      return pt.matrixTransform(m.inverse());
    };

    const apply = () => {
      viewport.setAttribute("transform", `translate(${this.pan.x} ${this.pan.y}) scale(${this.pan.k})`);
    };

    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".graph-node")) return;
      this.drag = { pt: clientToSvg(e), active: true };
      svg.setPointerCapture?.(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!this.drag?.active) return;
      const p = clientToSvg(e);
      this.pan.x += p.x - this.drag.pt.x;
      this.pan.y += p.y - this.drag.pt.y;
      this.drag.pt = p;
      apply();
    });
    const end = () => {
      this.drag = null;
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const oldK = this.pan.k;
        const dir = e.deltaY > 0 ? 0.92 : 1.08;
        const next = Math.min(2.5, Math.max(0.45, oldK * dir));
        const p = clientToSvg(e);
        this.pan.x = p.x - ((p.x - this.pan.x) * next) / oldK;
        this.pan.y = p.y - ((p.y - this.pan.y) * next) / oldK;
        this.pan.k = next;
        apply();
      },
      { passive: false }
    );
  }
}
