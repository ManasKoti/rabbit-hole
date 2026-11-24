// Bidirectional BFS that returns every shortest route, not just one.
//
// The forward side follows links out of the start page; the backward side
// follows links into the end page. Each step expands a whole level of the
// cheaper side and records all parents, so when the sides meet, every page in
// the middle of a shortest route is in the meeting set.
//
// Redirects: the backward side fetches the redirects of each page it adds and
// treats them as aliases at the same depth, so a forward link to "USA" meets a
// backward "United States" straight away.

import { abortError } from '../util/limiter.js';

const DEFAULT_SEARCH_OPTIONS = {
  maxDepth: 6,
  timeLimitMs: 120_000,
  maxVisited: 2_000_000,
  // Assumed links per page until the first level gives real numbers.
  defaultDegree: 250,
};

export class SearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const getOrAdd = (map, key, make) => map.get(key) ?? map.set(key, make()).get(key);

// Records `node` at `depth`, reached via `from`. Returns true if it is new.
function visit(depths, links, node, depth, from) {
  const d = depths.get(node);
  if (d === undefined) {
    depths.set(node, depth);
    links.set(node, new Set([from]));
    return true;
  }
  if (d === depth) links.get(node).add(from);
  return false;
}

export async function bidirectionalSearch(client, start, end, opts = {}) {
  const o = { ...DEFAULT_SEARCH_OPTIONS, ...opts };
  const startedAt = Date.now();

  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  o.signal?.addEventListener('abort', abort, { once: true });
  if (o.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, o.timeLimitMs);
  const { signal } = ctrl;

  const fwdDepth = new Map([[start, 0]]);
  const fwdParents = new Map([[start, new Set()]]);
  const fwdCanon = new Map(); // raw link title -> page it resolves to
  let fwdFrontier = [start];
  let fLevel = 0;

  const bwdDepth = new Map([[end, 0]]);
  const bwdNext = new Map([[end, new Set()]]); // page -> next pages towards the end
  const bwdAliasOf = new Map(); // redirect -> page it points at
  let bwdFrontier = [end];
  let bLevel = 0;

  const seen = { fwdPages: 0, fwdLinks: 0, bwdPages: 0, bwdLinks: 0 };
  const meetings = new Map(); // page -> route length through it

  const emit = (extra) => {
    try {
      o.onProgress?.({
        phase: 'search',
        fwdLevel: fLevel,
        bwdLevel: bLevel,
        fwdVisited: fwdDepth.size,
        bwdVisited: bwdDepth.size,
        ...extra,
      });
    } catch (err) {
      console.error('onProgress listener failed:', err);
    }
  };

  const checkMeet = (nodes, otherDepth, ownDepth) => {
    for (const n of nodes) {
      if (otherDepth.has(n)) meetings.set(n, ownDepth.get(n) + otherDepth.get(n));
    }
  };

  async function addRedirects(pages, depth) {
    const added = [];
    const reds = await client.redirectsOf(pages.filter((p) => !bwdAliasOf.has(p)), signal);
    for (const [page, list] of reds) {
      for (const r of list) {
        if (bwdDepth.has(r)) continue;
        bwdDepth.set(r, depth);
        bwdNext.set(r, new Set([page]));
        bwdAliasOf.set(r, page);
        bwdFrontier.push(r);
        added.push(r);
      }
    }
    return added;
  }

  async function expandForward() {
    const frontier = fwdFrontier;
    const depth = fLevel + 1;
    const next = [];
    let done = 0;
    emit({ step: 'expanding', side: 'forward', done, total: frontier.length });
    const res = await client.outLinks(frontier, signal, (n) => {
      done += n;
      emit({ step: 'expanding', side: 'forward', done, total: frontier.length });
    });
    for (const p of frontier) {
      const r = res.get(p);
      if (!r) continue;
      if (r.canonical !== p) fwdCanon.set(p, r.canonical);
      seen.fwdPages++;
      seen.fwdLinks += r.links.length;
      for (const c of r.links) {
        if (c !== p && c !== r.canonical && visit(fwdDepth, fwdParents, c, depth, p)) next.push(c);
      }
    }
    fwdFrontier = next;
    fLevel = depth;
    checkMeet(next, bwdDepth, fwdDepth);
  }

  async function expandBackward() {
    const frontier = bwdFrontier;
    const depth = bLevel + 1;
    const next = [];
    let done = 0;
    emit({ step: 'expanding', side: 'backward', done, total: frontier.length });
    const res = await client.inLinks(frontier, signal, (n) => {
      done += n;
      emit({ step: 'expanding', side: 'backward', done, total: frontier.length });
    });

    // Redirects missed by addRedirects (rare) are aliases on the current level.
    const lateAliases = [];
    for (const t of frontier) {
      const r = res.get(t);
      if (!r) continue;
      seen.bwdPages++;
      seen.bwdLinks += r.links.length;
      for (const p of r.links) {
        if (p !== t && visit(bwdDepth, bwdNext, p, depth, t)) next.push(p);
      }
      for (const red of r.redirects) {
        if (bwdDepth.has(red)) continue;
        const target = bwdAliasOf.get(t) ?? t;
        bwdDepth.set(red, bLevel);
        bwdNext.set(red, new Set([target]));
        bwdAliasOf.set(red, target);
        lateAliases.push(red);
      }
    }
    if (lateAliases.length) {
      for (const [t, r] of await client.inLinks(lateAliases, signal)) {
        for (const p of r.links) if (visit(bwdDepth, bwdNext, p, depth, t)) next.push(p);
      }
      checkMeet(lateAliases, fwdDepth, bwdDepth);
    }

    bwdFrontier = next;
    bLevel = depth;
    const aliases = await addRedirects(next, depth);
    checkMeet([...next, ...aliases], fwdDepth, bwdDepth);
  }

  try {
    emit({ step: 'starting' });
    const endAliases = await addRedirects([end], 0);
    checkMeet([end, ...endAliases], fwdDepth, bwdDepth);
    // One cheap search call, so we never start by downloading the millions of
    // backlinks of a page like "United States".
    const endInDegree = await client.backlinkCount(end, signal);

    while (meetings.size === 0) {
      if (fLevel + bLevel + 1 > o.maxDepth) {
        throw new SearchError('depth-limit', `No route within ${o.maxDepth} clicks.`);
      }
      if (!fwdFrontier.length || !bwdFrontier.length) {
        const side = fwdFrontier.length ? 'backward' : 'forward';
        throw new SearchError('no-path', 'No route exists.', { side });
      }
      if (fwdDepth.size + bwdDepth.size > o.maxVisited) {
        throw new SearchError('too-big', 'The search grew too large.');
      }

      const avgOut = seen.fwdPages ? seen.fwdLinks / seen.fwdPages : o.defaultDegree;
      const avgIn = seen.bwdPages ? seen.bwdLinks / seen.bwdPages : o.defaultDegree;
      const fwdCost = fwdFrontier.length * avgOut;
      const bwdCost =
        bLevel === 0 && endInDegree != null ? endInDegree : bwdFrontier.length * avgIn;
      const side = fwdCost <= bwdCost ? 'forward' : 'backward';

      await (side === 'forward' ? expandForward() : expandBackward());
      emit({ step: 'level-done', side });
    }

    const length = Math.min(...meetings.values());
    const meeting = [...meetings].filter(([, l]) => l === length).map(([n]) => n);
    const graph = buildRouteGraph({
      start,
      end,
      meeting,
      fwdParents,
      bwdNext,
      canon: (x) => fwdCanon.get(x) ?? bwdAliasOf.get(x) ?? x,
    });
    emit({ step: 'met', length: graph.length });
    return {
      ...graph,
      stats: {
        ms: Date.now() - startedAt,
        requests: client.stats.requests,
        pagesSeen: fwdDepth.size + bwdDepth.size,
      },
    };
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    throw timedOut
      ? new SearchError('timeout', `Gave up after ${Math.round(o.timeLimitMs / 1000)} seconds.`)
      : new SearchError('cancelled', 'Search cancelled.');
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', abort);
  }
}

// Turns the two search trees into one layered graph of shortest routes over
// canonical titles: { length, nodes, edges, layers, aliases }. Redirects can
// collapse two nodes into one, so anything no longer on a shortest route is
// pruned afterwards.
function buildRouteGraph({ start, end, meeting, fwdParents, bwdNext, canon }) {
  const edgeKeys = new Set();
  const aliasSets = new Map();
  const addEdge = (a, b) => {
    const ca = canon(a);
    const cb = canon(b);
    if (a !== ca) getOrAdd(aliasSets, ca, () => new Set()).add(a);
    if (b !== cb) getOrAdd(aliasSets, cb, () => new Set()).add(b);
    if (ca !== cb) edgeKeys.add(`${ca}\u0000${cb}`);
  };

  const walk = (links, edge) => {
    const done = new Set();
    const stack = [...meeting];
    while (stack.length) {
      const n = stack.pop();
      if (done.has(n)) continue;
      done.add(n);
      for (const m of links.get(n) ?? []) {
        edge(n, m);
        stack.push(m);
      }
    }
  };
  walk(fwdParents, (n, parent) => addEdge(parent, n));
  walk(bwdNext, (n, next) => addEdge(n, next));

  const s = canon(start);
  const e = canon(end);
  if (s === e) return { length: 0, nodes: [s], edges: [], layers: [[s]], aliases: {} };

  const out = new Map();
  const inn = new Map();
  for (const key of edgeKeys) {
    const [a, b] = key.split('\u0000');
    getOrAdd(out, a, () => new Set()).add(b);
    getOrAdd(inn, b, () => new Set()).add(a);
  }

  const distances = (from, adj) => {
    const dist = new Map([[from, 0]]);
    const queue = [from];
    for (const n of queue) {
      for (const m of adj.get(n) ?? []) {
        if (!dist.has(m)) {
          dist.set(m, dist.get(n) + 1);
          queue.push(m);
        }
      }
    }
    return dist;
  };
  const ds = distances(s, out);
  const de = distances(e, inn);
  const length = ds.get(e);
  if (length === undefined) {
    return { length: Infinity, nodes: [], edges: [], layers: [], aliases: {} };
  }

  const nodes = [...ds.keys()].filter((n) => de.has(n) && ds.get(n) + de.get(n) === length);
  const onRoute = new Set(nodes);
  const edges = [];
  for (const a of nodes) {
    for (const b of out.get(a) ?? []) {
      if (onRoute.has(b) && ds.get(b) === ds.get(a) + 1) edges.push([a, b]);
    }
  }
  const layers = Array.from({ length: length + 1 }, () => []);
  for (const n of nodes) layers[ds.get(n)].push(n);
  const aliases = {};
  for (const n of nodes) if (aliasSets.has(n)) aliases[n] = [...aliasSets.get(n)];
  return { length, nodes, edges, layers, aliases };
}
