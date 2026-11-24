// Resolve both titles, find every shortest route, then pick the best one.
//
// Scoring happens in stages because the most expensive signal (where a link
// sits in its article) needs a full page download per step:
//   1. page views for the pages on shortest routes, then the top
//      `candidatePool` routes by popularity, exact over the whole graph;
//   2. whether each step links back, for those candidates;
//   3. link positions, for the best `deepCheck` of them.
// The winner is the best of a good shortlist, not of every tie.

import { bidirectionalSearch, SearchError } from './bfs.js';
import { countPaths, kBestPaths, subgraphOf } from './dag.js';
import { extractLinks, clickScore } from './wikitext.js';
import { DEFAULT_WEIGHTS, describeRoute, popularityOf } from './scoring.js';

export { SearchError };

const DEFAULT_ROUTE_OPTIONS = {
  weights: DEFAULT_WEIGHTS,
  candidatePool: 150,
  deepCheck: 12,
  maxScoredNodes: 2500,
  maxGraphNodes: 400,
  summaryRoutes: 5,
  search: {},
};

export async function findRoute(client, startInput, endInput, opts = {}) {
  try {
    return await run(client, startInput, endInput, { ...DEFAULT_ROUTE_OPTIONS, ...opts });
  } catch (err) {
    if (err.name === 'AbortError') throw new SearchError('cancelled', 'Search cancelled.');
    throw err;
  }
}

async function run(client, startInput, endInput, o) {
  const { signal } = o;
  const emit = (event) => {
    try {
      o.onProgress?.(event);
    } catch (err) {
      console.error('onProgress listener failed:', err);
    }
  };

  emit({ phase: 'resolve' });
  const [s, e] = await Promise.all([
    client.resolve(startInput, signal),
    client.resolve(endInput, signal),
  ]);
  for (const [page, input, which] of [
    [s, startInput, 'start'],
    [e, endInput, 'end'],
  ]) {
    if (page.missing) {
      throw new SearchError('not-found', `No article called "${input}".`, { which });
    }
  }
  emit({ phase: 'resolved', start: s.title, end: e.title });

  const graph = await bidirectionalSearch(client, s.title, e.title, {
    ...o.search,
    signal,
    onProgress: emit,
  });
  const counts = countPaths(graph);
  const ends = new Set([s.title, e.title]);
  const aliases = graph.aliases;
  const canonicalOf = new Map();
  for (const [page, names] of Object.entries(aliases)) {
    for (const name of names) canonicalOf.set(name, page);
  }

  // 1. Popularity. On huge graphs, measure the pages most routes pass through.
  let middle = graph.nodes.filter((n) => !ends.has(n));
  if (middle.length > o.maxScoredNodes) {
    middle.sort((a, b) => counts.through.get(b) - counts.through.get(a));
    middle = middle.slice(0, o.maxScoredNodes);
  }
  emit({ phase: 'score', step: 'popularity' });
  const views = await optional(() => client.pageviews(middle, signal), new Map());
  const popularity = (n) => (ends.has(n) ? 0 : popularityOf(views.get(n)));
  const candidates = kBestPaths(graph, o.candidatePool, popularity);

  // 2. Does each step link back to the one before it?
  emit({ phase: 'score', step: 'relatedness' });
  const hops = candidates.flatMap((c) => c.titles.slice(1).map((to, i) => [c.titles[i], to]));
  const targets = [...new Set(hops.map(([, to]) => to))];
  const sources = [...new Set(hops.flatMap(([from]) => [from, ...(aliases[from] ?? [])]))];
  const linksBack = await optional(async () => {
    const pairs = await client.linkPairs(targets, sources, signal);
    return new Set(
      [...pairs].map((key) => {
        const [to, linked] = key.split('\u0000');
        return `${to}\u0000${canonicalOf.get(linked) ?? linked}`;
      }),
    );
  }, null);

  const shortlist = candidates
    .map((c) => describeRoute(c.titles, { views, linksBack }, o.weights))
    .sort((a, b) => b.score - a.score)
    .slice(0, o.deepCheck);

  // 3. Where each link sits in its article.
  emit({ phase: 'score', step: 'clicks' });
  const pagesToRead = [...new Set(shortlist.flatMap((r) => r.hops.map((h) => h.from)))];
  const clicks = await optional(async () => {
    const texts = await client.wikitext(pagesToRead, signal);
    const map = new Map();
    for (const route of shortlist) {
      for (const { from, to } of route.hops) {
        const names = [to, ...(aliases[to] ?? [])];
        map.set(`${from}\u0000${to}`, clickScore(extractLinks(texts.get(from)), names));
      }
    }
    return map;
  }, null);

  const routes = shortlist
    .map((r) => describeRoute(r.titles, { views, linksBack, clicks }, o.weights))
    .sort((a, b) => b.score - a.score);

  emit({ phase: 'score', step: 'summaries' });
  const shown = [...new Set(routes.slice(0, o.summaryRoutes).flatMap((r) => r.titles))];
  const summaries = await optional(() => client.summaries(shown, signal), new Map());

  const drawn =
    graph.nodes.length > o.maxGraphNodes
      ? subgraphOf(pickRoutesToDraw(routes, candidates, o.maxGraphNodes))
      : graph;

  return {
    start: s.title,
    end: e.title,
    clicks: graph.length,
    totalRoutes: counts.total,
    routes,
    best: routes[0],
    weights: o.weights,
    summaries: Object.fromEntries(summaries),
    graph: {
      nodes: drawn.nodes,
      edges: drawn.edges,
      layers: drawn.layers,
      truncated: drawn !== graph,
      fullNodeCount: graph.nodes.length,
    },
    stats: graph.stats,
  };
}

// When the full graph is too big to draw, draw the most promising routes.
function pickRoutesToDraw(routes, candidates, maxNodes) {
  const picked = [];
  const nodes = new Set();
  for (const { titles } of [...routes, ...candidates]) {
    const added = titles.filter((t) => !nodes.has(t));
    if (nodes.size + added.length > maxNodes) break;
    for (const t of added) nodes.add(t);
    picked.push(titles);
  }
  return picked;
}

// Scoring signals are extras: if one can't be fetched, rank without it.
async function optional(fetch, fallback) {
  try {
    return await fetch();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Ranking without a signal that failed to load:', err);
    return fallback;
  }
}
