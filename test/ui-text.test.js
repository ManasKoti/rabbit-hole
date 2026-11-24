import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as text from '../src/ui/text.js';

test('click counts read as words', () => {
  assert.equal(text.clicksLede(0), 'Same article.');
  assert.equal(text.clicksLede(1), 'One click.');
  assert.equal(text.clicksLede(3), 'Three clicks.');
  assert.equal(text.clicksLede(12), '12 clicks.');
});

test('route note says why the route was picked', () => {
  const result = {
    start: 'Pizza',
    end: 'Apollo 11',
    clicks: 3,
    totalRoutes: 6,
    weights: { popularity: 0.4, relatedness: 0.3, human: 0.3 },
    best: { features: { popularity: 0.9, relatedness: 0.3, human: 0.5 } },
  };
  assert.equal(
    text.routeNote(result, { picked: false }),
    'One of six routes this short. This one goes through the best-known pages.',
  );
  assert.equal(
    text.routeNote({ ...result, totalRoutes: 1204 }, { picked: true }),
    'One of 1,204 routes this short. This is one you picked.',
  );
  assert.equal(text.routeNote({ ...result, totalRoutes: 1 }, {}), 'The only route this short.');
  assert.equal(text.routeNote({ ...result, clicks: 1 }, {}), 'Pizza links straight to Apollo 11.');
});

test('search status handles every progress event', () => {
  const names = { start: 'Pizza', end: 'Apollo 11' };
  const events = [
    { phase: 'resolve' },
    { phase: 'search', step: 'starting' },
    { phase: 'search', step: 'expanding', side: 'forward', fwdLevel: 0, total: 1, done: 0 },
    { phase: 'search', step: 'level-done', side: 'forward', fwdLevel: 1 },
    { phase: 'score', step: 'popularity' },
  ];
  for (const p of events) assert.equal(typeof text.searchStatus(p, names), 'string');
  assert.equal(
    text.searchStatus(
      { phase: 'search', step: 'expanding', side: 'backward', bwdLevel: 2, total: 1840 },
      names,
    ),
    'Finding what links to the 1,840 pages two clicks before Apollo 11',
  );
});

test('every error has a message', () => {
  const codes = ['empty', 'cancelled', 'not-found', 'no-path', 'depth-limit', 'timeout', 'too-big'];
  for (const code of [...codes, undefined]) {
    const copy = text.errorCopy({ code, details: {} }, { start: 'A', end: 'B' });
    assert.ok(copy.message, code);
  }
});
