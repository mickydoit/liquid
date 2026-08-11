import test from 'node:test';
import assert from 'node:assert/strict';
import { edt, signedEdt, dilate, erode, close, open, labelComponents, cullComponents, cullHoles, bake, FORMATS } from '../js/bake.js';
import { fieldOutline } from '../js/contour.js';
import { makeBlobField, defaultControls } from '../js/blobfield.js';

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

test('labelComponents finds separate blobs', () => {
  const w = 20, h = 10;
  const m = mk(w, h, (i, j) => (i >= 2 && i <= 4 && j >= 2 && j <= 4) ||
                               (i >= 12 && i <= 15 && j >= 5 && j <= 7));
  const { sizes } = labelComponents(m, w, h, 8);
  assert.equal(sizes.length, 2);
  assert.deepEqual(sizes.slice().sort((a, b) => a - b), [9, 12]);
});

test('labelComponents joins diagonal neighbours at connectivity 8', () => {
  const w = 5, h = 5;
  const m = mk(w, h, (i, j) => (i === 1 && j === 1) || (i === 2 && j === 2));
  assert.equal(labelComponents(m, w, h, 8).sizes.length, 1);
  assert.equal(labelComponents(m, w, h, 4).sizes.length, 2);
});

test('cullComponents removes specks and keeps macro-forms', () => {
  const w = 30, h = 30;
  const m = mk(w, h, (i, j) => (i >= 5 && i <= 20 && j >= 5 && j <= 20) ||
                               (i === 27 && j === 27));
  const c = cullComponents(m, w, h, 10);
  assert.equal(c[27 * w + 27], 0, 'speck must go');
  assert.equal(c[10 * w + 10], 1, 'macro-form must stay');
});

test('cullHoles fills small holes but keeps large ones', () => {
  const w = 40, h = 40;
  const m = mk(w, h, (i, j) => {
    if (i < 3 || i > 36 || j < 3 || j > 36) return false;
    if (i === 8 && j === 8) return false;                       // 1-cell pinhole
    if (i >= 20 && i <= 30 && j >= 20 && j <= 30) return false; // big cavity
    return true;
  });
  const c = cullHoles(m, w, h, 20);
  assert.equal(c[8 * w + 8], 1, 'pinhole must be filled');
  assert.equal(c[25 * w + 25], 0, 'large cavity must survive');
});

test('cullHoles does not fill the exterior', () => {
  const w = 20, h = 20;
  const m = mk(w, h, (i, j) => i >= 5 && i <= 14 && j >= 5 && j <= 14);
  const c = cullHoles(m, w, h, 10000);
  assert.equal(c[0], 0, 'background touching the border is not a hole');
});

// The two tests below pin the connectivity WIRING inside the cull functions,
// not just the connectivity parameter of labelComponents itself. Mixed
// connectivity is deliberate: using the same setting for both foreground and
// background produces the classic diagonal paradox, where a single diagonal
// line of cells simultaneously separates the two regions on either side of it
// (under 4-connectivity, since neither region can step across the diagonal)
// and fails to separate them (under 8-connectivity, since the line itself
// forms a connected path). Foreground must use 8 so a diagonal chain of
// pixels reads as one solid form; background must use 4 so that same diagonal
// chain still counts as a boundary between two different holes/exterior
// regions rather than fusing them. Without a test built so the two
// connectivities give different answers, a swapped call inside cullComponents
// or cullHoles is invisible to every other test in this file.
test('cullComponents wiring must use 8-connectivity, not 4', () => {
  // Two 4x4 blocks (16 cells each) touching ONLY at a diagonal corner:
  // A's corner (5,5) and B's corner (6,6) are diagonal neighbours with no
  // shared edge. Under 8-connectivity this is one 32-cell component, which
  // survives minArea=25 whole. Under 4-connectivity it is two 16-cell
  // components, both below 25, so cullComponents would erase everything.
  const w = 12, h = 12;
  const m = mk(w, h, (i, j) => (i >= 2 && i <= 5 && j >= 2 && j <= 5) ||
                               (i >= 6 && i <= 9 && j >= 6 && j <= 9));
  const c = cullComponents(m, w, h, 25);
  assert.equal(c[3 * w + 3], 1, 'block A must survive under 8-connectivity');
  assert.equal(c[8 * w + 8], 1, 'block B must survive under 8-connectivity');
});

test('cullHoles wiring must use 4-connectivity, not 8', () => {
  // A solid rectangle well inside the raster, carrying two 3-cell background
  // strips that touch ONLY at a diagonal: (12,10) and (13,11) are diagonal
  // neighbours with no shared edge. Under 4-connectivity these are two
  // separate 3-cell holes, both below minArea=5, so both get filled. Under
  // 8-connectivity they fuse into one 6-cell hole, at or above 5, which would
  // survive unfilled.
  const w = 26, h = 26;
  const m = mk(w, h, (i, j) => {
    if (i < 5 || i > 20 || j < 5 || j > 20) return false;
    if (j === 10 && (i === 10 || i === 11 || i === 12)) return false; // strip 1
    if (j === 11 && (i === 13 || i === 14 || i === 15)) return false; // strip 2
    return true;
  });
  const c = cullHoles(m, w, h, 5);
  for (const [i, j] of [[10, 10], [11, 10], [12, 10], [13, 11], [14, 11], [15, 11]]) {
    assert.equal(c[j * w + i], 1, `(${i},${j}) must be filled under 4-connectivity`);
  }
});

const baked = (o = {}, seed = 42) => bake(
  makeBlobField(seed, Object.assign(defaultControls(), o)).field,
  { aspect: FORMATS.portrait, res: 256 },
);

test('bake produces a grid matching the requested aspect', () => {
  const b = baked();
  assert.equal(b.h, 256, 'long edge');
  assert.equal(b.w, Math.round(256 * FORMATS.portrait));
});

test('bake sample is negative inside the form and positive far outside', () => {
  const b = baked();
  assert.ok(b.sample(0, 0) < 0, 'hub should be inside');
  assert.ok(b.sample(50, 50) > 0, 'far outside the grid must read as outside');
});

test('bake removes specks and pinholes', () => {
  const b = baked({ simplify: 0.7 });
  const total = b.w * b.h;
  const { sizes } = labelComponents(b.mask, b.w, b.h, 8);
  const minArea = total * 0.002;
  for (const s of sizes) assert.ok(s >= minArea, `speck of ${s} cells survived`);
});

test('bake is deterministic', () => {
  assert.deepEqual([...baked().grid], [...baked().grid]);
});

test('bake output feeds fieldOutline without producing garbage rings', () => {
  const b = baked();
  const { rings } = fieldOutline((x, y) => b.sample(x, y), {
    bounds: { x0: -FORMATS.portrait, y0: -1, x1: FORMATS.portrait, y1: 1 },
    width: 600, height: 900, res: 220,
  });
  assert.ok(rings.length >= 1, 'expected at least one ring');
  assert.ok(rings.length <= 12, `expected few rings, got ${rings.length}`);
  for (const r of rings) {
    for (const [x, y] of r) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
});
