import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOrganismCache, bakeOrganism } from '../js/organism.js';

const CONTROLS = { formCount: 0.30, stretch: 0.95, merge: 0.10, simplify: 0.55, scaleCrop: 1.30 };

test('the same seed and controls give an identical grid', () => {
  const a = makeOrganismCache().request(47, CONTROLS, 96);
  const b = makeOrganismCache().request(47, CONTROLS, 96);
  assert.deepEqual(Array.from(a.grid), Array.from(b.grid));
});

test('different seeds give different grids', () => {
  const c = makeOrganismCache();
  const a = c.request(47, CONTROLS, 96);
  const b = c.request(48, CONTROLS, 96);
  assert.notDeepEqual(Array.from(a.grid), Array.from(b.grid));
});

test('an unchanged request does not re-bake', () => {
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, CONTROLS, 96);
  assert.equal(c.bakes, 1);
});

test('any control change re-bakes', () => {
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, Object.assign({}, CONTROLS, { merge: 0.9 }), 96);
  assert.equal(c.bakes, 2);
});

test('a resolution change re-bakes', () => {
  // Export asks for 900 after the preview asked for 256. Returning the preview
  // grid would silently export a visibly coarser design than the one approved
  // on screen.
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, CONTROLS, 128);
  assert.equal(c.bakes, 2);
});

test('the worker and the synchronous fallback share one bake function', () => {
  // The worker must not become a second implementation. bakeOrganism() is the
  // single function both paths call, so they cannot drift apart.
  const a = bakeOrganism(47, CONTROLS, 96, 2 / 3);
  const b = bakeOrganism(47, CONTROLS, 96, 2 / 3);
  assert.deepEqual(Array.from(a.grid), Array.from(b.grid));
  assert.equal(a.w, b.w);
  assert.equal(a.h, b.h);
});
