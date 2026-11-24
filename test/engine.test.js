import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WikiClient } from '../src/api/wiki-client.js';
import { bidirectionalSearch } from '../src/engine/bfs.js';
import { findRoute } from '../src/engine/find-route.js';
import { extractLinks, clickScore } from '../src/engine/wikitext.js';
import { countPaths, kBestPaths } from '../src/engine/dag.js';
import { normalizeTitle } from '../src/util/titles.js';
import { createMockWiki, oracle } from './mock-wiki.js';

const clientFor = (world, extra = {}) =>
  new WikiClient({ transport: createMockWiki({ ...world, ...extra }).transport, concurrency: 4 });

const edgeKeys = (g) => g.edges.map(([a, b]) => `${a}->${b}`).sort();


test('title normalisation', () => {
  assert.equal(normalizeTitle('  albert_einstein '), 'Albert einstein');
  assert.equal(normalizeTitle('ébène'), 'Ébène');
  assert.equal(normalizeTitle('a  b'), 'A b');
});

test('client follows continuations and maps redirects back to requested titles', async () => {
  const world = {
    pages: { A: { links: Array.from({ length: 23 }, (_, i) => `L${i}`) }, B: { links: ['X'] } },
    redirects: { Alpha: 'A' },
  };
  const c = clientFor(world, { pageLimit: 5 });
  const res = await c.outLinks(['Alpha', 'B']);
  assert.equal(res.get('Alpha').canonical, 'A');
  assert.equal(res.get('Alpha').links.length, 23);
  assert.deepEqual(res.get('B').links, ['X']);
});

test('client retries transient failures', async () => {
  const world = { pages: { A: { links: [] } } };
  const c = clientFor(world, { failFirst: 2 });
  const r = await c.resolve('A');
  assert.equal(r.title, 'A');
  assert.equal(c.stats.retries, 2);
});

test('direct link is one click', async () => {
  const world = { pages: { A: { links: ['B'] }, B: { links: [] } } };
  const g = await bidirectionalSearch(clientFor(world), 'A', 'B');
  assert.equal(g.length, 1);
  assert.deepEqual(edgeKeys(g), ['A->B']);
});

test('start equals end', async () => {
  const world = { pages: { A: { links: ['B'] }, B: { links: [] } } };
  const r = await findRoute(clientFor(world), 'A', 'a');
  assert.equal(r.clicks, 0);
  assert.deepEqual(r.best.titles, ['A']);
});

test('finds every tied shortest route', async () => {
  const world = {
    pages: {
      S: { links: ['A', 'B', 'C'] },
      A: { links: ['M', 'N'] },
      B: { links: ['M'] },
      C: { links: ['Z'] },
      Z: { links: ['E'] },
      M: { links: ['E'] },
      N: { links: ['E'] },
      E: { links: [] },
    },
  };
  const g = await bidirectionalSearch(clientFor(world), 'S', 'E');
  const ref = oracle(world, 'S', 'E');
  assert.equal(g.length, 3);
  assert.deepEqual(edgeKeys(g), ref.edges);
  assert.equal(countPaths(g).total, 4);
});

test('routes through redirects collapse to the real pages', async () => {
  const world = {
    pages: {
      S: { links: ['USA', 'France'] },
      'United States': { links: ['E'] },
      France: { links: ['E'] },
      E: { links: [] },
      P: { links: ['Ee'] },
    },
    redirects: { USA: 'United States', Ee: 'E' },
  };
  const g = await bidirectionalSearch(clientFor(world), 'S', 'E');
  assert.equal(g.length, 2);
  assert.deepEqual(edgeKeys(g), ['France->E', 'S->France', 'S->United States', 'United States->E']);
  assert.deepEqual(g.aliases['United States'], ['USA']);
});

test('a link to a redirect of the end page still counts as reaching it', async () => {
  const world = {
    pages: { S: { links: ['Q'] }, Q: { links: ['End (alias)'] }, End: { links: [] } },
    redirects: { 'End (alias)': 'End' },
  };
  const g = await bidirectionalSearch(clientFor(world), 'S', 'End');
  assert.equal(g.length, 2);
  assert.deepEqual(edgeKeys(g), ['Q->End', 'S->Q']);
});

test('no route and depth limit are reported clearly', async () => {
  const world = { pages: { A: { links: ['B'] }, B: { links: [] }, C: { links: ['A'] } } };
  await assert.rejects(bidirectionalSearch(clientFor(world), 'A', 'C'), { code: 'no-path' });

  const chain = { pages: {} };
  for (let i = 0; i < 10; i++) chain.pages[`P${i}`] = { links: [`P${i + 1}`] };
  chain.pages.P10 = { links: [] };
  await assert.rejects(bidirectionalSearch(clientFor(chain), 'P0', 'P10', { maxDepth: 6 }), {
    code: 'depth-limit',
  });
  const ok = await bidirectionalSearch(clientFor(chain), 'P0', 'P10', { maxDepth: 10 });
  assert.equal(ok.length, 10);
});

test('missing articles are rejected before searching', async () => {
  const world = { pages: { A: { links: [] } } };
  await assert.rejects(findRoute(clientFor(world), 'A', 'Nope'), { code: 'not-found' });
});

test('cancel and timeout', async () => {
  const world = { pages: {} };
  for (let i = 0; i < 30; i++) world.pages[`P${i}`] = { links: [`P${i + 1}`] };
  world.pages.P30 = { links: [] };
  const ctrl = new AbortController();
  const slow = () => clientFor(world, { latencyMs: 15 });
  const p = bidirectionalSearch(slow(), 'P0', 'P30', { signal: ctrl.signal, maxDepth: 40 });
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(p, { code: 'cancelled' });
  await assert.rejects(
    bidirectionalSearch(slow(), 'P0', 'P30', { timeLimitMs: 80, maxDepth: 40 }),
    { code: 'timeout' },
  );
});

// Property test: on many random graphs (with redirects and red links), the
// engine's route graph must equal a plain single-direction BFS.
test('matches a reference BFS on 400 random graphs', async () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let compared = 0;
  for (let trial = 0; trial < 400; trial++) {
    const n = 5 + Math.floor(rnd() * 60);
    const deg = 1 + rnd() * 4;
    const names = Array.from({ length: n }, (_, i) => `N${i}`);
    const redirects = {};
    for (let i = 0; i < n / 5; i++) redirects[`R${i}`] = names[Math.floor(rnd() * n)];
    const targets = [...names, ...Object.keys(redirects), 'Redlink'];
    const pages = {};
    for (const t of names) {
      const links = new Set();
      const k = Math.floor(rnd() * deg * 2);
      for (let j = 0; j < k; j++) links.add(targets[Math.floor(rnd() * targets.length)]);
      pages[t] = { links: [...links] };
    }
    const world = { pages, redirects };
    const s = names[0];
    const e = names[1 + Math.floor(rnd() * (n - 1))];
    const ref = oracle(world, s, e);
    let g = null;
    try {
      g = await bidirectionalSearch(clientFor(world, { pageLimit: 3 }), s, e, { maxDepth: 50 });
    } catch (err) {
      assert.ok(['no-path', 'depth-limit'].includes(err.code), err.message);
    }
    if (!ref) {
      assert.equal(g, null, `trial ${trial}: engine found a route the oracle didn't`);
      continue;
    }
    assert.ok(g, `trial ${trial}: engine missed a route of length ${ref.length}`);
    assert.equal(g.length, ref.length, `trial ${trial}: length`);
    assert.deepEqual([...g.nodes].sort(), ref.nodes, `trial ${trial}: nodes`);
    assert.deepEqual(edgeKeys(g), ref.edges, `trial ${trial}: edges`);
    assert.equal(countPaths(g).total, ref.count, `trial ${trial}: count`);
    compared++;
  }
  assert.ok(compared > 150, `only ${compared} graphs had routes`);
});


test('k-best paths are exact', () => {
  const g = {
    length: 2,
    nodes: ['S', 'A', 'B', 'C', 'E'],
    edges: [['S', 'A'], ['S', 'B'], ['S', 'C'], ['A', 'E'], ['B', 'E'], ['C', 'E']],
    layers: [['S'], ['A', 'B', 'C'], ['E']],
  };
  const score = { S: 0, A: 1, B: 3, C: 2, E: 0 };
  const best = kBestPaths(g, 2, (n) => score[n]);
  assert.deepEqual(best.map((b) => b.titles[1]), ['B', 'C']);
});

test('wikitext link extraction', () => {
  const wt = `{{Infobox|x=[[Infobox link]]}}
'''Thing''' is a [[Foo bar|foo]] and [[baz#Section]]. <ref>[[In a ref]]</ref>
[[File:Pic.jpg|thumb|[[Caption link]]]] [[Category:Things]] [[fr:Chose]] [[It: Chapter Two]]
<!-- [[Hidden]] -->
== History ==
Later [[Qux]] and again [[foo bar]].`;
  const { links, leadEnd } = extractLinks(wt);
  assert.deepEqual(links, [
    'Infobox link',
    'Foo bar',
    'Baz',
    'Caption link',
    'It: Chapter Two',
    'Qux',
  ]);
  assert.equal(leadEnd, 5);
  const lead = clickScore({ links, leadEnd }, ['Foo bar']);
  const late = clickScore({ links, leadEnd }, ['Qux']);
  const none = clickScore({ links, leadEnd }, ['Nowhere']);
  assert.ok(lead.score > late.score && late.score > none.score);
  assert.equal(none.viaTemplate, true);
});

function tieWorld(overrides = {}) {
  // Three routes S -> X -> E, differing in popularity, link-back and link position.
  const pages = {
    S: { links: ['Pop', 'Back', 'Early'], views: 50 },
    Pop: { links: ['E'], views: 90_000 },
    Back: { links: ['E', 'S'], views: 100 },
    Early: { links: ['E'], views: 100 },
    E: { links: ['Back'], views: 10 },
    ...overrides,
  };
  return { pages };
}

test('popularity breaks ties when it is the only signal', async () => {
  const r = await findRoute(clientFor(tieWorld()), 'S', 'E', {
    weights: { popularity: 1, relatedness: 0, human: 0 },
  });
  assert.equal(r.totalRoutes, 3);
  assert.deepEqual(r.best.titles, ['S', 'Pop', 'E']);
});

test('relatedness breaks ties when it is the only signal', async () => {
  const r = await findRoute(clientFor(tieWorld()), 'S', 'E', {
    weights: { popularity: 0, relatedness: 1, human: 0 },
  });
  assert.deepEqual(r.best.titles, ['S', 'Back', 'E']);
  assert.equal(r.best.features.relatedness, 1);
});

test('human-likeness prefers links in the lead', async () => {
  const world = tieWorld({
    S: {
      links: ['Pop', 'Back', 'Early'],
      wikitext: `Intro mentions [[Early]] first.\n== Later ==\n[[Back]] [[Pop]]`,
    },
  });
  const r = await findRoute(clientFor(world), 'S', 'E', {
    weights: { popularity: 0, relatedness: 0, human: 1 },
  });
  assert.equal(r.best.titles[1], 'Early');
  assert.equal(r.best.hops[0].click.inLead, true);
});

test('result shape and blended ranking', async () => {
  const r = await findRoute(clientFor(tieWorld()), 'S', 'E');
  assert.equal(r.clicks, 2);
  assert.equal(r.routes.length, 3);
  for (const route of r.routes) {
    assert.ok(route.score >= 0 && route.score <= 1);
    for (const k of ['popularity', 'relatedness', 'human']) {
      assert.equal(typeof route.features[k], 'number');
    }
  }
  assert.ok(r.summaries.Pop.description);
  assert.equal(r.graph.nodes.length, 5);
});

test('large tie sets are scored from a shortlist and the drawn graph is capped', async () => {
  const mids = Array.from({ length: 600 }, (_, i) => `M${i}`);
  const pages = { S: { links: mids }, E: { links: [] } };
  mids.forEach((m, i) => (pages[m] = { links: ['E'], views: i }));
  const r = await findRoute(clientFor({ pages }, { pageLimit: 200 }), 'S', 'E', {
    maxGraphNodes: 100,
  });
  assert.equal(r.totalRoutes, 600);
  assert.equal(r.routes.length, 12);
  assert.ok(r.graph.truncated && r.graph.nodes.length <= 100);
  assert.equal(r.best.titles[1].startsWith('M5'), true);
});

test('a throwing progress listener does not break the search', async () => {
  const world = { pages: { A: { links: ['B'] }, B: { links: ['C'] }, C: { links: [] } } };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await findRoute(clientFor(world), 'A', 'C', {
      onProgress: () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(r.best.titles, ['A', 'B', 'C']);
  } finally {
    console.error = orig;
  }
});
