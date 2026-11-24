// Helpers for the layered route graph from the search:
// { length, nodes, edges: [[a, b]], layers: [[start], ..., [end]] }

function adjacency(graph) {
  const out = new Map(graph.nodes.map((n) => [n, []]));
  const inn = new Map(graph.nodes.map((n) => [n, []]));
  for (const [a, b] of graph.edges) {
    out.get(a).push(b);
    inn.get(b).push(a);
  }
  return { out, inn };
}

// How many shortest routes reach each node, leave it, and pass through it.
export function countPaths(graph) {
  const { out, inn } = adjacency(graph);
  const fromStart = new Map();
  const toEnd = new Map();
  const L = graph.length;
  for (let d = 0; d <= L; d++) {
    for (const n of graph.layers[d]) {
      fromStart.set(n, d === 0 ? 1 : inn.get(n).reduce((s, p) => s + fromStart.get(p), 0));
    }
  }
  for (let d = L; d >= 0; d--) {
    for (const n of graph.layers[d]) {
      toEnd.set(n, d === L ? 1 : out.get(n).reduce((s, c) => s + toEnd.get(c), 0));
    }
  }
  const through = new Map(graph.nodes.map((n) => [n, fromStart.get(n) * toEnd.get(n)]));
  const end = graph.layers[L]?.[0];
  return { total: end === undefined ? 0 : fromStart.get(end), through };
}

// The k routes with the highest total nodeScore. Exact: each node keeps its
// own top k partial routes. All routes have the same length, so totals rank
// the same as averages.
export function kBestPaths(graph, k, nodeScore) {
  const { inn } = adjacency(graph);
  const best = new Map(); // node -> partial routes as linked lists { score, node, prev }
  for (const [depth, layer] of graph.layers.entries()) {
    for (const n of layer) {
      const score = nodeScore(n);
      if (depth === 0) {
        best.set(n, [{ score, node: n, prev: null }]);
        continue;
      }
      const extended = inn
        .get(n)
        .flatMap((p) => best.get(p).map((prev) => ({ score: prev.score + score, node: n, prev })));
      best.set(n, extended.sort((a, b) => b.score - a.score).slice(0, k));
    }
  }
  const end = graph.layers.at(-1)?.[0];
  if (end === undefined) return [];
  return best.get(end).map((leaf) => {
    const titles = [];
    for (let x = leaf; x; x = x.prev) titles.unshift(x.node);
    return { titles };
  });
}

// A graph of just the given routes, for drawing when the full one is too big.
export function subgraphOf(routes) {
  const nodes = new Set();
  const edges = new Set();
  let length = 0;
  for (const r of routes) {
    length = r.length - 1;
    r.forEach((t, i) => {
      nodes.add(t);
      if (i) edges.add(`${r[i - 1]}\u0000${t}`);
    });
  }
  const layers = Array.from({ length: length + 1 }, () => new Set());
  for (const r of routes) r.forEach((t, i) => layers[i].add(t));
  return {
    length,
    nodes: [...nodes],
    edges: [...edges].map((e) => e.split('\u0000')),
    layers: layers.map((s) => [...s]),
  };
}
