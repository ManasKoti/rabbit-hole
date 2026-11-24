// The "See all" graph: every shortest route, one column per click. The
// current route is red, and picking any other page switches to a route
// through it.

function el(tag, attrs, parent) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent?.append(node);
  return node;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderGraph(container, graph, routeTitles, onPick) {
  const { layers } = graph;
  const last = layers.length - 1;
  const marginX = 48;
  const width = Math.max(container.clientWidth || 544, marginX * 2 + last * 130);
  const colGap = (width - marginX * 2) / Math.max(last, 1);
  const maxRows = Math.max(...layers.map((l) => l.length));
  const rowGap = maxRows > 14 ? 22 : 64;
  const top = 44;
  const height = top + Math.max(1, maxRows - 1) * rowGap + 44;

  const onRoute = new Set(routeTitles);
  const pos = new Map();
  layers.forEach((layer, d) => {
    // The current route's page sits in the middle of its column.
    const routePage = layer.find((t) => onRoute.has(t));
    const others = layer.filter((t) => t !== routePage);
    const half = Math.floor(others.length / 2);
    const order = routePage ? [...others.slice(0, half), routePage, ...others.slice(half)] : layer;
    const y0 = top + ((maxRows - layer.length) * rowGap) / 2;
    order.forEach((t, i) => pos.set(t, [marginX + d * colGap, y0 + i * rowGap]));
  });

  const routeEdges = new Set(routeTitles.slice(1).map((t, i) => `${routeTitles[i]}\u0000${t}`));

  const svg = el('svg', {
    class: 'graph',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-label': `Every shortest route from ${layers[0][0]} to ${layers[last][0]}`,
  });

  const edges = el('g', { 'aria-hidden': 'true' }, svg);
  const isRouteEdge = ([a, b]) => routeEdges.has(`${a}\u0000${b}`);
  // Route edges go last so the red line is drawn on top.
  const ordered = [
    ...graph.edges.filter((e) => !isRouteEdge(e)),
    ...graph.edges.filter(isRouteEdge),
  ];
  for (const [a, b] of ordered) {
    const [x1, y1] = pos.get(a);
    const [x2, y2] = pos.get(b);
    const dx = (x2 - x1) / 2;
    el('path', {
      class: isRouteEdge([a, b]) ? 'edge on' : 'edge',
      d: `M${x1} ${y1} C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`,
    }, edges);
  }

  const showLabels = maxRows <= 14;
  layers.forEach((layer, d) => {
    for (const t of layer) {
      const [x, y] = pos.get(t);
      const isEnd = d === 0 || d === last;
      const on = onRoute.has(t);
      if (isEnd) {
        el('circle', { class: 'node end', cx: x, cy: y, r: 7 }, svg);
        const anchor =
          d === 0 ? { 'text-anchor': 'start', dx: -8 } : { 'text-anchor': 'end', dx: 8 };
        const label = el('text', { class: 'label', x, y: y + 28, ...anchor }, svg);
        label.textContent = clip(t, 24);
        continue;
      }
      const name = on ? `${t}, on the current route` : `Show the route through ${t}`;
      const g = el('g', { class: 'pick', tabindex: '0', role: 'button', 'aria-label': name }, svg);
      el('title', {}, g).textContent = t;
      el('circle', { class: 'hit', cx: x, cy: y, r: 14 }, g);
      el('circle', { class: `node${on ? ' on' : ''}`, cx: x, cy: y, r: on ? 5 : 4.5 }, g);
      if (showLabels || on) {
        const cls = on ? 'label on' : 'label';
        const label = el('text', { class: cls, x, y: y - 14, 'text-anchor': 'middle' }, g);
        label.textContent = clip(t, Math.floor(colGap / 8));
      }
      if (!on) {
        const pick = () => onPick(t);
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      }
    }
  });

  container.replaceChildren(svg);
}

// A shortest route through `title`, keeping to the pages of `prefer` where it can.
export function routeThrough(graph, title, prefer) {
  const parents = new Map();
  const children = new Map();
  for (const [a, b] of graph.edges) {
    if (!parents.has(b)) parents.set(b, []);
    if (!children.has(a)) children.set(a, []);
    parents.get(b).push(a);
    children.get(a).push(b);
  }
  const choose = (options) => options.find((o) => prefer.includes(o)) ?? options[0];
  const route = [title];
  while (parents.has(route[0])) route.unshift(choose(parents.get(route[0])));
  while (children.has(route.at(-1))) route.push(choose(children.get(route.at(-1))));
  return route;
}
