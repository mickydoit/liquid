import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestCellTransform, measureChannels, selectJoins, degreeCap,
} from '../js/cymajoin.js';

// A 9x1 strip: one foreground cell at each end, seven background between.
function strip() {
  const w = 9, h = 1;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;
  mask[8] = 1;
  return { mask, w, h };
}

test('nearest-cell transform assigns each gap pixel to its closer cell', () => {
  const { mask, w, h } = strip();
  const { label, dist } = nearestCellTransform(mask, w, h);

  assert.equal(label[0], label[1], 'pixel 1 belongs to the left cell');
  assert.equal(label[7], label[8], 'pixel 7 belongs to the right cell');
  assert.notEqual(label[0], label[8], 'the two cells are distinct components');

  assert.equal(dist[0], 0, 'a foreground pixel is its own site');
  assert.equal(dist[1], 1);
  assert.equal(dist[7], 1);
  // The midpoint is 4 from either end; ties may go to either side.
  assert.equal(dist[4], 4);
});

test('nearest-cell distance matches Euclidean distance off-axis', () => {
  const w = 5, h = 5;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;                       // single site at (0,0)
  const { dist, label } = nearestCellTransform(mask, w, h);
  assert.equal(label[4 * w + 3], 1, 'everything belongs to the only cell');
  assert.ok(Math.abs(dist[4 * w + 3] - Math.hypot(3, 4)) < 1e-9);
});

// Filled discs of radius r on a w x h raster, at the given centres.
function discs(w, h, r, centres) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (const [cx, cy] of centres) {
        if (Math.hypot(x - cx, y - cy) <= r) { mask[y * w + x] = 1; break; }
      }
    }
  }
  return mask;
}

test('channel measurement recovers the true gap between two discs', () => {
  const w = 80, h = 40, r = 8;
  // Centres 40 apart, radius 8 each -> surface-to-surface gap 40 - 16 = 24.
  const mask = discs(w, h, r, [[20, 20], [60, 20]]);
  const pairs = measureChannels(mask, w, h);

  assert.equal(pairs.length, 1, 'two cells give exactly one pair');
  assert.ok(Math.abs(pairs[0].gap - 24) < 1.5, `gap was ${pairs[0].gap}`);
});

test('channel measurement returns pairs narrowest-first', () => {
  const w = 140, h = 40, r = 8;
  // Gaps: A-B is 24, B-C is 44.
  const mask = discs(w, h, r, [[20, 20], [60, 20], [120, 20]]);
  const pairs = measureChannels(mask, w, h);

  assert.ok(pairs.length >= 2);
  assert.ok(pairs[0].gap < pairs[1].gap, 'sorted ascending by gap');
  assert.ok(Math.abs(pairs[0].gap - 24) < 1.5);
});

// Regression: a pair hard against the raster edge must measure the same as one
// in open space. A per-pair cropped EDT cannot see the background just outside
// its bbox and overestimates distances at a cell's extremes.
test('channel measurement is unaffected by proximity to the raster edge', () => {
  const w = 80, h = 40, r = 8;
  const open = measureChannels(discs(w, h, r, [[20, 20], [60, 20]]), w, h);
  const edge = measureChannels(discs(w, h, r, [[20, 9], [60, 9]]), w, h);
  assert.ok(Math.abs(open[0].gap - edge[0].gap) < 0.5,
    `open ${open[0].gap} vs edge ${edge[0].gap}`);
});

// Ten cells in a row, each gap slightly wider than the last.
const CHAIN = Array.from({ length: 9 }, (_, i) => ({
  a: i + 1, b: i + 2, gap: 10 + i, ax: 0, ay: 0, bx: 0, by: 0,
}));

test('Join 0 selects nothing', () => {
  assert.deepEqual(selectJoins(CHAIN, 0), []);
});

test('selection is narrowest-first', () => {
  const got = selectJoins(CHAIN, 0.35);
  assert.ok(got.length > 0);
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i - 1].gap <= got[i].gap, 'accepted pairs stay sorted');
  }
  assert.equal(got[0].gap, 10, 'the narrowest gap is always taken first');
});

test('selected count rises monotonically with Join', () => {
  let prev = -1;
  for (let j = 0; j <= 1.0001; j += 0.1) {
    const n = selectJoins(CHAIN, Math.min(j, 1)).length;
    assert.ok(n >= prev, `count fell at Join ${j.toFixed(1)}: ${prev} -> ${n}`);
    prev = n;
  }
});

// The field-scaffold measurements found that ranking by channel width ALONE
// chains four consecutive inner-band cells into one long arc, because channels
// narrow toward the centre and the inner band owns the head of the sorted list.
test('no cell exceeds its degree cap at any Join', () => {
  for (let j = 0.05; j <= 1.0001; j += 0.05) {
    const join = Math.min(j, 1);
    const deg = new Map();
    for (const p of selectJoins(CHAIN, join)) {
      deg.set(p.a, (deg.get(p.a) ?? 0) + 1);
      deg.set(p.b, (deg.get(p.b) ?? 0) + 1);
    }
    for (const [cell, d] of deg) {
      assert.ok(d <= degreeCap(join),
        `cell ${cell} had degree ${d} > cap ${degreeCap(join)} at Join ${join}`);
    }
  }
});
