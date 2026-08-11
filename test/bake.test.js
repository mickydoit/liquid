import test from 'node:test';
import assert from 'node:assert/strict';
import { edt, signedEdt } from '../js/bake.js';

const mk = (w, h, fn) => {
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m[j * w + i] = fn(i, j) ? 1 : 0;
  return m;
};

test('edt of an all-zero mask is zero everywhere', () => {
  const d = edt(new Uint8Array(25), 5, 5);
  assert.ok([...d].every((v) => v === 0));
});

test('edt measures distance to the nearest background cell', () => {
  // A 5x5 block of 1s inside a 9x9 field. The block spans columns/rows 2..6,
  // so the centre at 4 is 3 cells from the nearest 0 (at index 1).
  const w = 9, h = 9;
  const m = mk(w, h, (i, j) => i >= 2 && i <= 6 && j >= 2 && j <= 6);
  const d = edt(m, w, h);
  assert.equal(d[4 * w + 4], 3, 'centre distance');
  assert.equal(d[2 * w + 4], 1, 'top edge of block');
  assert.equal(d[0 * w + 0], 0, 'background is zero');
});

test('edt is exact on a diagonal', () => {
  // A single background cell at the origin; distance to (3,4) must be 5.
  const w = 12, h = 12;
  const m = mk(w, h, (i, j) => !(i === 0 && j === 0));
  const d = edt(m, w, h);
  assert.ok(Math.abs(d[4 * w + 3] - 5) < 1e-9, `got ${d[4 * w + 3]}`);
});

test('signedEdt is negative inside and positive outside', () => {
  const w = 9, h = 9;
  const m = mk(w, h, (i, j) => i >= 2 && i <= 6 && j >= 2 && j <= 6);
  const d = signedEdt(m, w, h);
  assert.ok(d[4 * w + 4] < 0, 'inside must be negative');
  assert.ok(d[0] > 0, 'outside must be positive');
});
