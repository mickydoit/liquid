import test from 'node:test';
import assert from 'node:assert/strict';
import { edt, signedEdt, dilate, erode, close, open } from '../js/bake.js';

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

const count = (m) => m.reduce((s, v) => s + v, 0);

test('dilate grows and erode shrinks', () => {
  const w = 21, h = 21;
  const m = mk(w, h, (i, j) => i >= 8 && i <= 12 && j >= 8 && j <= 12);
  assert.ok(count(dilate(m, w, h, 2)) > count(m));
  assert.ok(count(erode(m, w, h, 1)) < count(m));
});

test('close fills a small gap without growing the form', () => {
  // Two blocks separated by a 2-cell gap. Closing at radius 3 must bridge it.
  const w = 31, h = 15;
  const m = mk(w, h, (i, j) => j >= 5 && j <= 9 && ((i >= 8 && i <= 13) || (i >= 16 && i <= 21)));
  const c = close(m, w, h, 3);
  assert.equal(c[7 * w + 14], 1, 'gap should be bridged');
  assert.equal(c[0], 0, 'far background must stay background');
});

// Test-only helper: count 8-connected foreground components via iterative
// flood fill (a stack, not recursion, so a large component can't blow the
// call stack). Not a candidate for js/bake.js — a real component labeller is
// a later task's job, and this is deliberately minimal (no labels returned,
// just a count) so it can't be mistaken for that.
function countComponents8ForTest(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  let components = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (mask[nIdx] && !seen[nIdx]) {
            seen[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }
  }
  return components;
}

test('open severs a hairline bridge into two components but keeps a thick waist joined', () => {
  // THIS is the distinction the brief hinges on: hairline filaments go,
  // intentional waists stay. That is a CONNECTIVITY claim — a severed bridge
  // must split the shape into two components, a surviving waist must not —
  // so this counts components rather than probing one cell. A single probe
  // point can't tell the two cases apart here: opening is a local operator,
  // and a point deep inside a corridor reads the same whether or not distant
  // blocks even exist.
  const w = 41, h = 21;
  const hairline = mk(w, h, (i, j) =>
    (i >= 4 && i <= 12 && j >= 6 && j <= 14) ||     // block A
    (i >= 28 && i <= 36 && j >= 6 && j <= 14) ||    // block B
    (i > 12 && i < 28 && j === 10));                // 1-cell bridge
  const openedHairline = open(hairline, w, h, 2);
  assert.equal(
    countComponents8ForTest(openedHairline, w, h), 2,
    'severed hairline bridge must leave two separate components'
  );
  assert.equal(openedHairline[10 * w + 8], 1, 'block A must survive');
  assert.equal(openedHairline[10 * w + 32], 1, 'block B must survive');

  const waist = mk(w, h, (i, j) =>
    (i >= 4 && i <= 12 && j >= 6 && j <= 14) ||
    (i >= 28 && i <= 36 && j >= 6 && j <= 14) ||
    (i > 12 && i < 28 && j >= 7 && j <= 13));       // 7-cell waist
  const openedWaist = open(waist, w, h, 2);
  assert.equal(
    countComponents8ForTest(openedWaist, w, h), 1,
    'thick waist must keep the shape as a single component'
  );
  assert.equal(openedWaist[10 * w + 8], 1, 'block A must survive');
  assert.equal(openedWaist[10 * w + 32], 1, 'block B must survive');
});

test('radius 0 is a no-op', () => {
  const w = 9, h = 9;
  const m = mk(w, h, (i, j) => i > 2 && j > 2);
  assert.deepEqual([...close(m, w, h, 0)], [...m]);
  assert.deepEqual([...open(m, w, h, 0)], [...m]);
});

test('closing a convex block is idempotent', () => {
  // The property that catches an off-by-one between dilate and erode. If
  // erosion peels one ring fewer than dilation adds, this grows every time it
  // runs — silently, and compounding through the four-stage cleanup chain.
  const w = 24, h = 24;
  const m = mk(w, h, (i, j) => i >= 9 && i <= 14 && j >= 9 && j <= 14);
  const once = close(m, w, h, 2);
  assert.deepEqual([...once], [...m], 'closing a convex shape must not change it');
  assert.deepEqual([...close(once, w, h, 2)], [...once], 'and must be stable');
});

test('erode and dilate are dual', () => {
  // erode(r) must equal the complement of dilating the complement by r.
  // This is what pins the strict `< -r` comparison.
  const w = 25, h = 19;
  const m = mk(w, h, (i, j) => Math.hypot(i - 12, j - 9) < 7);
  const inv = Uint8Array.from(m, (v) => (v ? 0 : 1));
  const viaDual = Uint8Array.from(dilate(inv, w, h, 3), (v) => (v ? 0 : 1));
  assert.deepEqual([...erode(m, w, h, 3)], [...viaDual]);
});
