// A fake MediaWiki Action API (formatversion=2) covering what the engine uses,
// including continuation, title normalisation and redirects.
//
//   pages:     { Title: { links: [raw link targets], views, wikitext, description } }
//   redirects: { From: To }

import { normalizeTitle } from '../src/util/titles.js';

export function createMockWiki({
  pages = {},
  redirects = {},
  pageLimit = 7,
  failFirst = 0,
  latencyMs = 0,
} = {}) {
  const exists = (t) => t in pages || t in redirects;
  const follow = (t) => {
    for (let i = 0; i < 5 && redirects[t]; i++) t = redirects[t];
    return t;
  };
  const redirectsTo = (t) => Object.keys(redirects).filter((r) => redirects[r] === t);

  const backlinks = new Map();
  for (const [source, page] of Object.entries(pages)) {
    for (const target of page.links ?? []) {
      if (!backlinks.has(target)) backlinks.set(target, []);
      backlinks.get(target).push(source);
    }
  }

  let failuresLeft = failFirst;

  const transport = async (rawParams, signal) => {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (failuresLeft > 0) {
      failuresLeft--;
      throw Object.assign(new Error('HTTP 503'), { status: 503 });
    }

    const p = {};
    for (const [k, v] of Object.entries(rawParams)) {
      p[k] = Array.isArray(v) ? v.join('|') : String(v);
    }
    const query = {};
    const json = { batchcomplete: true, query };

    if (p.list === 'search') {
      const target = /linksto:"(.*)"/.exec(p.srsearch)?.[1];
      const total = (backlinks.get(target) ?? []).length + redirectsTo(target).length;
      query.searchinfo = { totalhits: total };
      return json;
    }
    if (p.list === 'random') {
      const titles = Object.keys(pages).slice(0, Number(p.rnlimit));
      query.random = titles.map((title, id) => ({ id, ns: 0, title }));
      return json;
    }

    const requested =
      p.generator === 'prefixsearch'
        ? Object.keys(pages)
            .filter((t) => t.toLowerCase().startsWith(p.gpssearch.toLowerCase()))
            .slice(0, Number(p.gpslimit))
        : (p.titles ?? '').split('|').filter(Boolean);

    const normalized = [];
    const redirected = [];
    const finals = new Set();
    for (const t of requested) {
      const n = normalizeTitle(t);
      if (n !== t) normalized.push({ from: t, to: n });
      const target = p.redirects === '1' ? follow(n) : n;
      if (target !== n) redirected.push({ from: n, to: target });
      finals.add(target);
    }
    if (normalized.length) query.normalized = normalized;
    if (redirected.length) query.redirects = redirected;

    const results = [...finals].map((title, i) =>
      exists(title)
        ? { pageid: i + 1, ns: 0, title, ...(p.generator && { index: i + 1 }) }
        : { ns: 0, title, missing: true },
    );

    // List props are paged across all requested pages, `pageLimit` items per response.
    const paged = (continueKey, field, itemsFor) => {
      const all = [];
      results.forEach((page, i) => {
        if (!page.missing) for (const item of itemsFor(page.title)) all.push([i, item]);
      });
      const offset = Number(p[continueKey] ?? 0);
      for (const [i, item] of all.slice(offset, offset + pageLimit)) {
        (results[i][field] ??= []).push(item);
      }
      if (offset + pageLimit < all.length) {
        json.continue = { [continueKey]: String(offset + pageLimit), continue: '||' };
      }
    };

    const props = new Set((p.prop ?? '').split('|'));
    if (props.has('links')) {
      const only = p.pltitles && new Set(p.pltitles.split('|').map(normalizeTitle));
      paged('plcontinue', 'links', (t) =>
        (pages[t]?.links ?? [])
          .filter((l) => !only || only.has(l))
          .map((title) => ({ ns: 0, title })),
      );
    }
    if (props.has('linkshere')) {
      paged('lhcontinue', 'linkshere', (t) => [
        ...(backlinks.get(t) ?? []).map((title) => ({ ns: 0, title, redirect: false })),
        ...redirectsTo(t).map((title) => ({ ns: 0, title, redirect: true })),
      ]);
    }
    if (props.has('redirects')) {
      paged('rdcontinue', 'redirects', (t) => redirectsTo(t).map((title) => ({ ns: 0, title })));
    }

    for (const page of results) {
      if (page.missing) continue;
      const data = pages[page.title] ?? {};
      if (props.has('pageviews')) {
        const v = data.views ?? 0;
        page.pageviews = { '2026-11-01': v, '2026-11-02': v, '2026-11-03': null };
      }
      if (props.has('revisions')) {
        page.revisions = [{ slots: { main: { content: data.wikitext ?? defaultWikitext(data) } } }];
      }
      if (props.has('description')) page.description = data.description ?? `About ${page.title}`;
      if (props.has('extracts')) page.extract = `${page.title} is a page.`;
    }
    query.pages = results;
    return json;
  };

  return { transport };
}

// First half of the links in the lead, the rest under a heading.
function defaultWikitext({ links = [] }) {
  const half = Math.ceil(links.length / 2);
  const lead = links.slice(0, half).map((l) => `[[${l}]]`).join(' ');
  const body = links.slice(half).map((l) => `[[${l}|label]]`).join(', ');
  return `Lead text ${lead}.\n== Body ==\n${body}`;
}

// Reference answer: a plain one-directional BFS over the resolved link graph.
// Returns the nodes and edges on shortest routes and how many routes there are.
export function oracle({ pages, redirects = {} }, start, end) {
  const follow = (t) => {
    for (let i = 0; i < 5 && redirects[t]; i++) t = redirects[t];
    return t;
  };
  const out = new Map();
  const inn = new Map();
  const add = (map, key, value) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(value);
  for (const [source, page] of Object.entries(pages)) {
    for (const link of page.links ?? []) {
      const target = follow(link);
      if (target in pages && target !== source) {
        add(out, source, target);
        add(inn, target, source);
      }
    }
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
  const ds = distances(start, out);
  const de = distances(end, inn);
  const length = ds.get(end);
  if (length === undefined) return null;

  const nodes = [...ds.keys()].filter((n) => de.has(n) && ds.get(n) + de.get(n) === length);
  const onRoute = new Set(nodes);
  const isStep = (a, b) => onRoute.has(b) && ds.get(b) === ds.get(a) + 1;
  const edges = nodes.flatMap((a) =>
    [...(out.get(a) ?? [])].filter((b) => isStep(a, b)).map((b) => `${a}->${b}`),
  );

  const ways = new Map([[start, 1]]);
  for (const n of [...nodes].sort((a, b) => ds.get(a) - ds.get(b))) {
    if (n === start) continue;
    const parents = [...(inn.get(n) ?? [])].filter((p) => isStep(p, n));
    ways.set(n, parents.reduce((sum, p) => sum + ways.get(p), 0));
  }
  return { length, nodes: nodes.sort(), edges: edges.sort(), count: ways.get(end) };
}
