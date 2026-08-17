import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestCellTransform } from '../js/cymajoin.js';

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
