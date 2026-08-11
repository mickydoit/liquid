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

test('edt matches a brute-force nearest-background computation on random non-square masks', () => {
  // The four tests above are all degenerate: a single background cell, or a
  // convex axis-aligned block where every competing parabola has equal
  // height, and every raster/mask here is square and transpose-symmetric.
  // None of that exercises the pop loop in dt1d (which only fires when two
  // parabolas of DIFFERENT finite heights compete) or would notice a w/h
  // transposition. A small deterministic LCG (not Math.random — determinism
  // is a hard constraint, and bake.js's tests stay independent of
  // blobfield.js's mulberry32) drives mixed-density random masks on a
  // non-square 23x17 raster, checked cell-by-cell against an O(n^2)
  // brute-force nearest-background-cell distance.
  const lcg = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  const bruteForceEdt = (mask, w, h) => {
    const bg = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (!mask[j * w + i]) bg.push([i, j]);
    const out = new Float64Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!mask[j * w + i]) continue;
        let best = Infinity;
        for (const [bi, bj] of bg) {
          const dx = i - bi, dy = j - bj;
          const dd = dx * dx + dy * dy;
          if (dd < best) best = dd;
        }
        out[j * w + i] = Math.sqrt(best);
      }
    }
    return out;
  };

  const w = 23, h = 17;
  const rng = lcg(0xc0ffee);
  for (const density of [0.2, 0.5, 0.8]) {
    const m = mk(w, h, () => rng() < density);
    const got = edt(m, w, h);
    const want = bruteForceEdt(m, w, h);
    for (let idx = 0; idx < got.length; idx++) {
      assert.ok(
        Math.abs(got[idx] - want[idx]) < 1e-9,
        `density ${density}, cell ${idx}: got ${got[idx]}, want ${want[idx]}`
      );
    }
  }
});

test('signedEdt has no zero level set — magnitude 1 is the nearest boundary value', () => {
  // Cell-centre to cell-centre distance means no inside cell is ever exactly
  // on the boundary: the row through the block's centre reads straight from
  // 1 to -1 with nothing in between. That absent zero is the whole reason
  // erosion by r must be the strict {d < -r} rather than {d <= -r} — at
  // r = 1, <= would keep every inside cell (an identity, not an erosion).
  const w = 9, h = 9;
  const m = mk(w, h, (i, j) => i >= 2 && i <= 6 && j >= 2 && j <= 6);
  const d = signedEdt(m, w, h);
  const row = [];
  for (let i = 0; i < w; i++) row.push(d[4 * w + i]);
  assert.deepEqual(row, [2, 1, -1, -2, -3, -2, -1, 1, 2]);
});
