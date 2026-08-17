# Cymatic Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `Join` control to Detailed Cymatic that closes gaps between cells with circular-fillet necks, matching the join character of the reference posters.

**Architecture:** Above `Join = 0` the geometry is computed once on settle rather than evaluated per-pixel: rasterise the analytic water field, label the cells, measure every adjacent pair's channel by a nearest-cell transform, select pairs narrowest-first under a degree cap, and bridge each selected pair with a segment stub joined by a circular fillet union. The result is baked to a grid that both the renderer and the vector export read, so the joined path introduces no new CPU/GLSL mirror.

**Tech Stack:** Vanilla ES modules, no build step. `node --test` for tests, hand-rolled WebGL1 for rendering, dependency-free PNG writer in `tools/png.mjs` for visual review.

**Spec:** `docs/superpowers/specs/2026-08-17-cymatic-join-design.md`

## Global Constraints

- **No build step.** Vanilla ES modules only. No new runtime dependencies.
- **Cache-busting query strings.** Every intra-`js/` import carries `?v=87f2b33d`. New imports must too; `npm run bust` rewrites them. Tools under `tools/` and tests under `test/` import without the query string — follow the file you are editing.
- **Fillet, never `smin`.** Use `unionRound` from `js/blobfield.js:53`. A polynomial smooth-min bulges convexly and reads as soap bubbles; this single detail decides whether the result looks like the reference. Stated at `js/shader.js:89` and `js/blobfield.js:48`.
- **No capsules between cell centres.** They produce bone shapes. Bridges span the two nearest *boundary* points, not the centres.
- **The fillet radius is capped at half the narrowest measured channel** across the whole design. A blend expressed in raster widths is an absolute size, so at coarse rasters an uncapped blend closes channels by itself and `Join` stops controlling the topology.
- **`Join = 0` must be bit-identical to today.** Every existing preset and export is a regression target.
- **Test at landscape as well as portrait.** A bake's resolution is its LONG edge, so landscape gives the short edge `res/aspect` cells. Portrait-only testing has hidden a quantization bug in this repo before.
- **Baseline: 150 tests passing** on branch `cymatic-join` at commit `242e335`.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/cymajoin.js` | **New.** The whole join pipeline: nearest-cell transform, channel measurement, pair selection, neck construction, bake orchestration. Pure geometry, no DOM, no WebGL. |
| `js/sdftex.js` | **Restored** from `c912c07`. Packs a signed-distance grid into RGBA8 for WebGL1. |
| `js/cymafield.js` | `join` added to `idleState()`. |
| `js/export.js` | Contours the joined field when `join > 0`. |
| `js/renderer.js` | Uploads and samples the SDF texture; triggers the bake on settle. |
| `js/shader.js` | Texture-sampling branch, mirroring `unpackDistance`. |
| `js/app.js` | Slider wiring, params, URL state. |
| `index.html` | The slider. |
| `test/cymajoin.test.js` | **New.** Unit tests for every pure function above. |
| `tools/joinladder.mjs` | **New.** Renders a PNG ladder across `Join` values. The acceptance artefact. |

**Deviation from the spec, deliberate:** the spec lists `js/organism.worker.js` as a file to restore. It does not exist at `c912c07` (only `js/sdftex.js` does), and a synchronous bake on settle is simpler. Task 5 measures the bake; **if it exceeds 400 ms, add the worker then** — not before.

---

## CHECKPOINT after Task 6

Tasks 1–6 are pure geometry and produce the render ladder. **Stop there and put the PNGs in front of the user before starting Task 7.** The standing lesson in this repo is that green tests never once indicated the look was right — all three `large` failures in the Shape Style work passed their tests while looking wrong, and were caught only by rendering and looking. Tasks 7–9 are integration work that is wasted if the look is wrong.

---

### Task 1: Nearest-cell transform

Every later stage needs to know, for each background pixel, which cell is nearest and how far. Computing that once removes the need for per-pair cropped EDTs — and with them the padded-crop bug that a tight bbox causes by not seeing background just outside it.

**Files:**
- Create: `js/cymajoin.js`
- Test: `test/cymajoin.test.js`

**Interfaces:**
- Consumes: `labelComponents` from `js/bake.js:121`.
- Produces: `nearestCellTransform(mask, w, h)` → `{ label: Int32Array, sx: Int32Array, sy: Int32Array, dist: Float64Array }`, one entry per pixel. `label[i]` is the 1-based component id of the nearest foreground pixel (0 only if the mask is empty); `sx[i]`/`sy[i]` are that pixel's coordinates; `dist[i]` is the Euclidean distance to it in cells. Foreground pixels are their own site, `dist = 0`.

- [ ] **Step 1: Write the failing test**

```js
// test/cymajoin.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="nearest-cell"`
Expected: FAIL — `Cannot find module '../js/cymajoin.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/cymajoin.js
// Cymatic Join: bridge neighbouring cells with filleted necks.
//
// The cells in Detailed Cymatic are a threshold on |psi| (cymafield.js:186),
// so the shape of the passage between two of them is whatever the field's
// saddle happens to be, and lowering the threshold joins dozens of cells at
// once rather than two chosen ones. A designed neck therefore cannot be a
// level set of the field; it has to be a geometric operation on identified
// cells, which is a whole-image job and bakes rather than evaluating
// per pixel.
import { labelComponents } from './bake.js?v=87f2b33d';

// Nearest foreground cell for every pixel, by two-pass vector propagation
// (Danielsson). Exact on convex arrangements and within a fraction of a cell
// elsewhere — far more accuracy than a channel measurement needs.
//
// Doing this ONCE for the whole raster is what lets channel measurement avoid
// per-pair cropped EDTs. A crop tight to a pair cannot see the background just
// outside it, so it overestimates distances at a cell's extremes; that bug has
// already been found and fixed once in this project's field-scaffold work, and
// this approach cannot reintroduce it.
export function nearestCellTransform(mask, w, h) {
  const n = w * h;
  const label = new Int32Array(n);
  const sx = new Int32Array(n).fill(-1);
  const sy = new Int32Array(n).fill(-1);
  const d2 = new Float64Array(n).fill(Infinity);
  const { labels } = labelComponents(mask, w, h, 8);

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    label[i] = labels[i];
    sx[i] = i % w;
    sy[i] = (i - (i % w)) / w;
    d2[i] = 0;
  }

  // Pull j's site into i if it is closer than i's current one.
  const relax = (i, j) => {
    if (sx[j] < 0) return;
    const x = i % w, y = (i - (i % w)) / w;
    const dx = x - sx[j], dy = y - sy[j];
    const c = dx * dx + dy * dy;
    if (c >= d2[i]) return;
    d2[i] = c; sx[i] = sx[j]; sy[i] = sy[j]; label[i] = label[j];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1);
      if (y > 0) relax(i, i - w);
      if (x > 0 && y > 0) relax(i, i - w - 1);
      if (x + 1 < w && y > 0) relax(i, i - w + 1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x + 1 < w) relax(i, i + 1);
      if (y + 1 < h) relax(i, i + w);
      if (x + 1 < w && y + 1 < h) relax(i, i + w + 1);
      if (x > 0 && y + 1 < h) relax(i, i + w - 1);
    }
  }

  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) dist[i] = Math.sqrt(d2[i]);
  return { label, sx, sy, dist };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="nearest-cell"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add js/cymajoin.js test/cymajoin.test.js
git commit -m "feat: nearest-cell transform for channel measurement"
```

---

### Task 2: Channel measurement

**Files:**
- Modify: `js/cymajoin.js`
- Test: `test/cymajoin.test.js`

**Interfaces:**
- Consumes: `nearestCellTransform` from Task 1.
- Produces: `measureChannels(mask, w, h)` → array of `{ a, b, gap, ax, ay, bx, by }` sorted by `gap` ascending. `a < b` are component ids; `gap` is the narrowest channel between them in cells; `(ax, ay)` and `(bx, by)` are the two nearest boundary pixels across that narrowest point.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/cymajoin.test.js
import { measureChannels } from '../js/cymajoin.js';

// Three filled discs of radius r on a w x h raster, at the given centres.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="channel measurement"`
Expected: FAIL — `measureChannels is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// Append to js/cymajoin.js

// The narrowest channel between every pair of adjacent cells.
//
// A background pixel whose 4-neighbour belongs to a DIFFERENT cell sits on the
// watershed between them, and the channel width there is the sum of the two
// pixels' distances to their own cells. Taking the minimum over the whole
// watershed gives the narrowest passage, and the two site points give the
// bridge its endpoints — boundary points, not centres, because a capsule
// between centres produces bone shapes.
export function measureChannels(mask, w, h) {
  const { label, sx, sy, dist } = nearestCellTransform(mask, w, h);
  const best = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] || !label[i]) continue;
      // Right and down only: every unordered neighbour pair is still visited
      // exactly once, at half the work.
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0 || mask[j] || !label[j] || label[j] === label[i]) continue;
        const gap = dist[i] + dist[j];
        const a = Math.min(label[i], label[j]);
        const b = Math.max(label[i], label[j]);
        const k = `${a}:${b}`;
        const cur = best.get(k);
        if (cur && cur.gap <= gap) continue;
        const [lo, hi] = label[i] < label[j] ? [i, j] : [j, i];
        best.set(k, { a, b, gap, ax: sx[lo], ay: sy[lo], bx: sx[hi], by: sy[hi] });
      }
    }
  }
  return [...best.values()].sort((p, q) => p.gap - q.gap);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="channel measurement"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add js/cymajoin.js test/cymajoin.test.js
git commit -m "feat: measure the narrowest channel between adjacent cells"
```

---

### Task 3: Pair selection with a degree cap

**Files:**
- Modify: `js/cymajoin.js`
- Test: `test/cymajoin.test.js`

**Interfaces:**
- Consumes: the pair array from Task 2.
- Produces: `degreeCap(join)` → `1 | 2`; `selectJoins(pairs, join)` → the accepted subset, in the same narrowest-first order.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/cymajoin.test.js
import { selectJoins, degreeCap } from '../js/cymajoin.js';

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
// narrow toward the centre and the inner band therefore owns the head of the
// sorted list.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="Join 0 selects|narrowest-first|monotonic|degree cap"`
Expected: FAIL — `selectJoins is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// Append to js/cymajoin.js

// How many necks any one cell may take.
//
// Sorting by channel width alone chains consecutive inner-band cells into a
// single long arc, because channels narrow toward the centre and the inner
// band owns the head of the sorted list. The cap is what keeps the ramp
// reading as necks between cells rather than as one merged mass, and it is
// also what leaves islands unjoined at the top of the range.
export function degreeCap(join) { return join > 0.5 ? 2 : 1; }

// Take pairs narrowest-first until the Join budget is spent, skipping any pair
// that would push either of its cells past the cap.
export function selectJoins(pairs, join) {
  if (join <= 0) return [];
  const cap = degreeCap(join);
  const want = Math.round(join * pairs.length);
  const deg = new Map();
  const out = [];
  for (const p of pairs) {
    if (out.length >= want) break;
    const da = deg.get(p.a) ?? 0, db = deg.get(p.b) ?? 0;
    if (da >= cap || db >= cap) continue;
    deg.set(p.a, da + 1);
    deg.set(p.b, db + 1);
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="Join 0 selects|narrowest-first|monotonic|degree cap"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add js/cymajoin.js test/cymajoin.test.js
git commit -m "feat: narrowest-first pair selection under a degree cap"
```

---

### Task 4: The filleted neck field

**Files:**
- Modify: `js/cymajoin.js`
- Test: `test/cymajoin.test.js`

**Interfaces:**
- Consumes: `unionRound` from `js/blobfield.js:53`; selected pairs from Task 3.
- Produces: `sdSegment(px, py, ax, ay, bx, by)` → distance to a segment; `NECK_WIDTH`, `FILLET_K` constants; `makeNecks(selected, toWorld, cellSize)` → `[{ ax, ay, bx, by, r, kf }]` in **world** units; `makeJoinedField(base, necks, filletCap)` → `(x, y) => signedDistance`.

**Note on `base`:** it must be a true signed **distance** field, not `makeWaterField`'s `iso - thickness`. `unionRound` computes a fillet of radius `kf` in the metric of its arguments, so feeding it a field whose gradient is not 1 produces a fillet of the wrong size. Task 5 supplies the EDT-derived distance for this reason.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/cymajoin.test.js
import { makeJoinedField, sdSegment, NECK_WIDTH, FILLET_K } from '../js/cymajoin.js';

// Two unit discs centred at (-1.5, 0) and (1.5, 0): surfaces 1.0 apart.
const twoDiscs = (x, y) =>
  Math.min(Math.hypot(x + 1.5, y) - 1, Math.hypot(x - 1.5, y) - 1);

const NECK = [{ ax: -0.5, ay: 0, bx: 0.5, by: 0, r: NECK_WIDTH * 1.0, kf: FILLET_K * 1.0 }];

test('sdSegment measures distance to the segment, not the infinite line', () => {
  assert.ok(Math.abs(sdSegment(0, 2, -1, 0, 1, 0) - 2) < 1e-9, 'above the middle');
  assert.ok(Math.abs(sdSegment(3, 0, -1, 0, 1, 0) - 2) < 1e-9, 'past the end cap');
});

test('the neck bridges the gap: the midpoint becomes inside', () => {
  assert.ok(twoDiscs(0, 0) > 0, 'unjoined, the midpoint is outside');
  const joined = makeJoinedField(twoDiscs, NECK, Infinity);
  assert.ok(joined(0, 0) < 0, 'joined, the midpoint is inside');
});

test('the field is untouched far from any neck', () => {
  const joined = makeJoinedField(twoDiscs, NECK, Infinity);
  for (const [x, y] of [[-1.5, 0], [1.5, 0], [0, 5], [-4, -4]]) {
    assert.ok(Math.abs(joined(x, y) - twoDiscs(x, y)) < 1e-9,
      `field moved at ${x},${y}`);
  }
});

// The reference's waist pinches INWARD on a tangent arc. A polynomial smin
// bulges outward there and reads as soap bubbles. Measuring the boundary's
// half-width along the neck is what tells them apart: a fillet's half-width
// must be at its MINIMUM at the neck's midpoint.
test('the junction is concave — the waist is a minimum, not a bulge', () => {
  const joined = makeJoinedField(twoDiscs, NECK, Infinity);
  const halfWidth = (x) => {
    let y = 0;
    while (y < 4 && joined(x, y) < 0) y += 0.002;
    return y;
  };
  const mid = halfWidth(0);
  assert.ok(mid > 0, 'the neck exists at the midpoint');
  assert.ok(mid < halfWidth(0.45), 'widens toward the right disc');
  assert.ok(mid < halfWidth(-0.45), 'widens toward the left disc');
});

test('the fillet cap limits the blend', () => {
  const wide = makeJoinedField(twoDiscs, NECK, Infinity);
  const capped = makeJoinedField(twoDiscs, NECK, 0.05);
  // A smaller fillet removes less material from the corner, so the capped
  // field is never more inside than the uncapped one.
  assert.ok(capped(0.5, 0.9) >= wide(0.5, 0.9) - 1e-12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="sdSegment|neck bridges|untouched far|concave|fillet cap"`
Expected: FAIL — `makeJoinedField is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// Append to js/cymajoin.js — and extend the import at the top of the file to:
// import { labelComponents } from './bake.js?v=87f2b33d';
// import { unionRound } from './blobfield.js?v=87f2b33d';

// Neck half-width and fillet radius, both as fractions of the measured channel.
// Tuned against the reference posters: the neck is appreciably narrower than
// the lobes it joins, and the fillet is large enough that the junction reads as
// a tangent arc rather than a rounded-off corner.
export const NECK_WIDTH = 0.55;
export const FILLET_K = 0.90;

export function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 <= 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// Selected pairs, in raster coordinates, become bridge stubs in world units.
// `toWorld(i, j)` converts a pixel to world space; `cellSize` is world units
// per cell, which is what turns a gap measured in cells into a world radius.
export function makeNecks(selected, toWorld, cellSize) {
  return selected.map((p) => {
    const [ax, ay] = toWorld(p.ax, p.ay);
    const [bx, by] = toWorld(p.bx, p.by);
    const gap = p.gap * cellSize;
    return { ax, ay, bx, by, r: NECK_WIDTH * gap, kf: FILLET_K * gap };
  });
}

// The joined field: the base distance, unioned with each neck stub through a
// CIRCULAR FILLET.
//
// Not a polynomial smin. A fillet cuts a concave tangent arc in the corner
// where the two surfaces meet, which is the waist this look is built on; smin
// bulges convexly there and reads as soap bubbles (js/shader.js:89).
//
// `filletCap` bounds every fillet radius. A blend expressed in raster widths is
// an absolute size, so at coarse rasters an uncapped blend closes channels by
// itself and Join stops controlling the topology. Task 5 passes half the
// narrowest measured channel in the whole design.
export function makeJoinedField(base, necks, filletCap = Infinity) {
  return (x, y) => {
    let d = base(x, y);
    for (const nk of necks) {
      const kf = Math.min(nk.kf, filletCap);
      const ds = sdSegment(x, y, nk.ax, nk.ay, nk.bx, nk.by) - nk.r;
      // Beyond kf of both surfaces the fillet union is identical to min(), so
      // skipping there is an optimisation and not an approximation.
      if (ds > kf && d > kf) { d = Math.min(d, ds); continue; }
      d = unionRound(d, ds, kf);
    }
    return d;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="sdSegment|neck bridges|untouched far|concave|fillet cap"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add js/cymajoin.js test/cymajoin.test.js
git commit -m "feat: filleted neck field, concave at the waist"
```

---

### Task 5: Bake orchestrator

**Files:**
- Modify: `js/cymajoin.js`
- Test: `test/cymajoin.test.js`

**Interfaces:**
- Consumes: everything above; `signedEdt`, `gridSampler`, `FORMATS` from `js/bake.js`; `makeWaterField`, `WATER_EDGE` from `js/cymafield.js`.
- Produces: `buildJoinedField(state, { aspect, res })` → `{ sample, grid, w, h, aspect, necks, pairs }`. `sample(x, y)` is a signed field, negative inside water, drop-in for `makeWaterField(state)`.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/cymajoin.test.js
import { buildJoinedField } from '../js/cymajoin.js';
import { idleState, makeWaterField } from '../js/cymafield.js';
import { FORMATS } from '../js/bake.js';

// A design in the island regime — the look the Join control is for.
function islandState(join) {
  return { ...idleState(), mass: 0.92, simple: 0.55, amp: 0.62, grow: 1, join };
}

test('Join 0 leaves the water field numerically identical', () => {
  const s = islandState(0);
  const analytic = makeWaterField(s);
  const { sample } = buildJoinedField(s, { aspect: FORMATS.portrait, res: 256 });
  for (const [x, y] of [[0, 0], [0.3, -0.4], [-0.7, 0.55], [0.9, 0.9]]) {
    assert.ok(Math.abs(sample(x, y) - analytic(x, y)) < 1e-12,
      `diverged at ${x},${y}`);
  }
});

test('raising Join reduces the component count', () => {
  const count = (join) => {
    const { necks } = buildJoinedField(islandState(join),
      { aspect: FORMATS.portrait, res: 256 });
    return necks.length;
  };
  assert.equal(count(0), 0);
  assert.ok(count(0.6) > count(0.2), 'more necks at higher Join');
});

// A bake's resolution is its LONG edge, so landscape gives the short edge
// res/aspect cells. Portrait-only testing has hidden a quantization bug here
// before.
test('the bake works at landscape as well as portrait', () => {
  for (const aspect of [FORMATS.portrait, FORMATS.landscape]) {
    const { w, h, sample } = buildJoinedField(islandState(0.5), { aspect, res: 256 });
    assert.equal(Math.max(w, h), 256, 'res is the long edge');
    assert.ok(Number.isFinite(sample(0, 0)), `sample finite at aspect ${aspect}`);
  }
});

test('the fillet cap never exceeds half the narrowest channel', () => {
  const { necks, pairs, cellSize } = buildJoinedField(islandState(0.8),
    { aspect: FORMATS.portrait, res: 256 });
  if (!pairs.length) return;
  const narrowest = pairs[0].gap * cellSize;
  for (const nk of necks) {
    assert.ok(nk.kf <= narrowest * 0.5 + 1e-12,
      `fillet ${nk.kf} exceeds half the narrowest channel ${narrowest}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="Join 0 leaves|reduces the component|landscape as well|never exceeds half"`
Expected: FAIL — `buildJoinedField is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// Append to js/cymajoin.js — extend the imports at the top to add:
// import { labelComponents, signedEdt, gridSampler, FORMATS } from './bake.js?v=87f2b33d';
// import { makeWaterField } from './cymafield.js?v=87f2b33d';

export function buildJoinedField(state, { aspect = FORMATS.portrait, res = 1024 } = {}) {
  const analytic = makeWaterField(state);
  const join = state.join ?? 0;

  // res is the LONG edge, so a landscape bake costs the same as a portrait one.
  const w = aspect >= 1 ? res : Math.round(res * aspect);
  const h = aspect >= 1 ? Math.round(res / aspect) : res;
  const total = w * h;
  const cellSize = 2 / h;                       // world units per cell
  const toWorld = (i, j) => [
    (-1 + (2 * (i + 0.5)) / w) * aspect,
    1 - (2 * (j + 0.5)) / h,
  ];

  if (join <= 0) {
    // Identity. Returning the analytic field itself rather than a bake of it is
    // what makes Join 0 bit-identical to today rather than merely close.
    return { sample: analytic, grid: null, w, h, aspect, cellSize, necks: [], pairs: [] };
  }

  // Rasterise. `raw` keeps the analytic value, not just its sign.
  const raw = new Float64Array(total);
  const mask = new Uint8Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = toWorld(i, j);
      const v = analytic(x, y);
      raw[j * w + i] = v;
      mask[j * w + i] = v < 0 ? 1 : 0;
    }
  }

  const pairs = measureChannels(mask, w, h);
  const selected = selectJoins(pairs, join);
  const necks = makeNecks(selected, toWorld, cellSize);
  // Half the narrowest channel in the WHOLE design, not per pair: the cap
  // exists to stop the blend closing channels Join has not selected.
  const filletCap = pairs.length ? pairs[0].gap * cellSize * 0.5 : Infinity;

  // The base for the fillet must be a true DISTANCE. makeWaterField returns
  // `iso - thickness`, whose gradient is nowhere near 1, and unionRound
  // computes a fillet of radius kf in the metric of its arguments — feeding it
  // a non-distance produces a fillet of the wrong size.
  const edtCells = signedEdt(mask, w, h);
  const dist = new Float64Array(total);
  for (let i = 0; i < total; i++) dist[i] = edtCells[i] * cellSize;
  const distSample = gridSampler(dist, w, h, aspect);
  const joined = makeJoinedField(distSample, necks, filletCap);

  // Where the necks changed nothing, keep the ANALYTIC value. Thresholding to a
  // binary mask and rebuilding distance from it quantises the zero level set to
  // a half-cell staircase at EVERY resolution — measured at 0.225 cells RMS
  // versus 0.002 for this hybrid (bake.js:236-253). The two expressions differ
  // in scale away from the boundary but agree in sign, and every zero crossing
  // lies inside whichever region owns it.
  const grid = new Float64Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const [x, y] = toWorld(i, j);
      const dj = joined(x, y);
      // If no neck moved this cell, the joined distance still equals the EDT
      // distance there, and the analytic value is the more precise of the two.
      grid[k] = Math.abs(dj - dist[k]) < 1e-12 ? raw[k] : dj;
    }
  }

  return {
    sample: gridSampler(grid, w, h, aspect),
    grid, w, h, aspect, cellSize, necks, pairs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="Join 0 leaves|reduces the component|landscape as well|never exceeds half"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Measure the bake and record it**

Run:
```bash
node -e "
import('./js/cymajoin.js').then(async (m) => {
  const { idleState } = await import('./js/cymafield.js');
  const s = { ...idleState(), mass: 0.92, simple: 0.55, amp: 0.62, grow: 1, join: 0.6 };
  const t = process.hrtime.bigint();
  const r = m.buildJoinedField(s, { res: 1024 });
  console.log('bake ms', Number(process.hrtime.bigint() - t) / 1e6, 'necks', r.necks.length);
});
"
```

Record the figure in the commit message. **If it exceeds 400 ms, stop and add a worker** before Task 8 — the spec anticipated this and the file to model it on is `tools/render.mjs`'s synchronous usage plus a `postMessage` boundary that transfers `grid.buffer`. Below 400 ms, proceed synchronously.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 150 baseline + the new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/cymajoin.js test/cymajoin.test.js
git commit -m "feat: bake the joined cymatic field"
```

---

### Task 6: The render ladder — THE ACCEPTANCE ARTEFACT

**Files:**
- Create: `tools/joinladder.mjs`
- Modify: `package.json` (add the script)

**Interfaces:**
- Consumes: `buildJoinedField`; `encodePNG` from `tools/png.mjs:30`; `renderField` from `tools/render.mjs:13`.
- Produces: `out/join/ladder-<aspect>-<join>.png`.

- [ ] **Step 1: Write the tool**

```js
// tools/joinladder.mjs
// Render a ladder of Join values to PNG for visual review.
//
//   node tools/joinladder.mjs out/join
//
// Green tests never once indicated the look was right in this project — all
// three `large` failures in the Shape Style work passed their tests while
// looking wrong, and were caught only by rendering and looking. This ladder is
// the gate for the Join control.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { renderField } from './render.mjs';
import { buildJoinedField } from '../js/cymajoin.js';
import { idleState } from '../js/cymafield.js';
import { FORMATS } from '../js/bake.js';

const dir = process.argv[2] ?? 'out/join';
const STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

// The island regime the Join control is for: water on the antinodes, broad
// cells, a fully grown figure.
const base = { ...idleState(), mass: 0.92, simple: 0.55, amp: 0.62, grow: 1 };

mkdirSync(dir, { recursive: true });
for (const [name, aspect] of [['portrait', FORMATS.portrait], ['landscape', FORMATS.landscape]]) {
  for (const join of STEPS) {
    const { sample, necks } = buildJoinedField({ ...base, join }, { aspect, res: 1024 });
    const width = aspect >= 1 ? 1350 : 900;
    const height = Math.round(width / aspect);
    const { rgb } = renderField(sample, { width, height, aspect });
    const file = `${dir}/ladder-${name}-${join.toFixed(1)}.png`;
    writeFileSync(file, encodePNG(width, height, rgb));
    console.log(`${file}  necks=${necks.length}`);
  }
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `scripts`:

```json
"join-ladder": "node tools/joinladder.mjs out/join"
```

- [ ] **Step 3: Run it**

Run: `npm run join-ladder`
Expected: 12 PNGs written, neck counts rising with Join and 0 at Join 0.

- [ ] **Step 4: Commit**

```bash
git add tools/joinladder.mjs package.json
git commit -m "tools: render a Join ladder for visual review"
```

- [ ] **Step 5: STOP — hand the ladder to the user**

Do not start Task 7. Present `out/join/ladder-portrait-*.png` and `ladder-landscape-*.png` and ask whether the join character matches the reference. Specifically ask about:
- Whether the waists read as concave tangent arcs or as soap-bubble bulges.
- Whether joins look **composed** or evenly speckled. If speckled, the spec's deferred alternative applies: bias selection along a path through the disc, which is a change to `selectJoins` only.
- Whether `NECK_WIDTH` (0.55) and `FILLET_K` (0.90) want adjusting.

---

### Task 7: Vector export reads the joined field

**Files:**
- Modify: `js/export.js:58-59` and `js/export.js:96-97`
- Test: `test/export.test.js`

**Interfaces:**
- Consumes: `buildJoinedField` from Task 5.
- Produces: no new exports; `buildSVG` and `exportPDF` route through the joined field when `state.join > 0`.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/export.test.js
import { buildSVG } from '../js/export.js';
import { idleState } from '../js/cymafield.js';

const islands = (join) => ({
  ...idleState(), mass: 0.92, simple: 0.55, amp: 0.62, grow: 1, join,
});
const rings = (svg) => (svg.match(/M/g) ?? []).length;

test('Join 0 exports exactly what it does today', () => {
  const a = buildSVG({ state: islands(0), width: 900, height: 1350, ink: '#111' });
  const b = buildSVG({ state: { ...islands(0), join: undefined },
    width: 900, height: 1350, ink: '#111' });
  assert.equal(a, b, 'an absent join and join 0 must agree');
});

test('joining merges rings, so the export has fewer subpaths', () => {
  const open = buildSVG({ state: islands(0), width: 900, height: 1350, ink: '#111' });
  const shut = buildSVG({ state: islands(0.8), width: 900, height: 1350, ink: '#111' });
  assert.ok(rings(shut) < rings(open),
    `joined ${rings(shut)} not fewer than unjoined ${rings(open)}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="exports exactly what|merges rings"`
Expected: FAIL — the ring counts are equal, because `join` is ignored.

- [ ] **Step 3: Implement**

Add to the imports at the top of `js/export.js`:

```js
import { buildJoinedField } from './cymajoin.js?v=87f2b33d';
```

Then replace the field selection in **both** `buildSVG` (lines 58-59) and `exportPDF` (lines 96-97) with a call to this shared helper, added above `buildSVG`:

```js
// The field the export contours.
//
// Detailed Cymatic traces the CENTRELINE — outlining a nodal ribbon's boundary
// draws both sides of every line and every curve arrives doubled. A metaball
// has no spine, so it keeps its boundary.
//
// Above Join 0 the geometry is a bake, and the export reads the SAME baked
// grid the screen does. Contouring the analytic field here instead would put
// necks on screen that the SVG does not have.
function exportField(state, variant, width, height) {
  if (variant === 'outline' && !isMeta(state)) return makeCentrelineField(state);
  if (!isMeta(state) && (state.join ?? 0) > 0) {
    return buildJoinedField(state, { aspect: width / height }).sample;
  }
  return makeWaterField(state);
}
```

and call it as `const field = exportField(state, variant, width, height);` in both functions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="exports exactly what|merges rings"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures. In particular the three `silhouette unchanged:` tests must still pass — they assert the unjoined geometry.

- [ ] **Step 6: Commit**

```bash
git add js/export.js test/export.test.js
git commit -m "feat: export the joined field when Join is above zero"
```

---

### Task 8: SDF texture and the shader path

**Files:**
- Create: `js/sdftex.js` (restore: `git show c912c07:js/sdftex.js > js/sdftex.js`)
- Modify: `js/shader.js`, `js/renderer.js`
- Test: `test/sdftex.test.js` (restore: `git show c912c07:test/sdftex.test.js > test/sdftex.test.js`)

**Interfaces:**
- Consumes: `buildJoinedField().grid`.
- Produces: `packSDF(grid, w, h)` → `Uint8Array` RGBA8; `unpackDistance(r, g)` → number; `RANGE = 2.0`.

- [ ] **Step 1: Restore the module and its tests**

```bash
git show c912c07:js/sdftex.js > js/sdftex.js
git show c912c07:test/sdftex.test.js > test/sdftex.test.js
```

- [ ] **Step 2: Run the restored tests**

Run: `npm test -- --test-name-pattern="pack|unpack|SDF"`
Expected: PASS. If they fail, the module's contract has drifted — fix the module, not the tests.

- [ ] **Step 3: Add the GLSL decode**

In `js/shader.js`, add beside the other uniforms (near line 27):

```glsl
uniform sampler2D uJoinTex;   // baked joined field, RGBA8, distance in R+G
uniform float uJoinOn;        // 0 = analytic cymatic path, 1 = baked
uniform vec2 uJoinAspect;     // frame half-extent the bake was made against
```

and, beside `metaDistf`:

```glsl
// MIRRORS unpackDistance() in js/sdftex.js. These are one format split across
// two languages: WebGL1 has no guaranteed float textures, so the distance is
// packed into 16 bits across R and G of an ordinary RGBA8 texture.
const float JOIN_RANGE = 2.0;

float joinDistf(vec2 p) {
  vec2 uv = vec2((p.x / uJoinAspect.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  vec4 t = texture2D(uJoinTex, uv);
  return ((t.r + t.g / 255.0)) * 2.0 * JOIN_RANGE - JOIN_RANGE;
}
```

Route the cymatic thickness through it: where `nodalAt` currently supplies the Detailed Cymatic coverage, take `joinDistf` instead when `uJoinOn > 0.5`, converting distance to coverage with the same `WATER_EDGE` ramp the analytic path uses.

- [ ] **Step 4: Upload the texture in the renderer**

In `js/renderer.js`, on settle (the same point that currently promotes a design to the held state), when `state.join > 0`:

```js
import { buildJoinedField } from './cymajoin.js?v=87f2b33d';
import { packSDF } from './sdftex.js?v=87f2b33d';

// ... in the settle handler:
const aspect = this.canvas.width / this.canvas.height;
const { grid, w, h } = buildJoinedField(state, { aspect });
const px = packSDF(grid, w, h);
gl.bindTexture(gl.TEXTURE_2D, this.joinTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
// LINEAR, and CLAMP_TO_EDGE so a sample past the frame does not wrap the far
// side of the design into view.
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
```

Set `uJoinOn` to `state.join > 0 ? 1 : 0` and `uJoinAspect` to `[aspect, 1]` each frame.

- [ ] **Step 5: Verify on screen**

Run: `npm start`, open `http://localhost:8788`, record or load a sound, switch to Detailed Cymatic, set Mass high and raise Join.
Expected: the on-screen necks match `out/join/ladder-portrait-*.png` at the same Join value. **A mismatch here means the shader and the bake disagree — fix the shader, never the bake, since the bake is what the SVG uses.**

- [ ] **Step 6: Commit**

```bash
git add js/sdftex.js test/sdftex.test.js js/shader.js js/renderer.js
git commit -m "feat: read the joined bake on screen through an SDF texture"
```

---

### Task 9: The control

**Files:**
- Modify: `index.html:80-85`, `js/app.js`, `js/cymafield.js:35-68`

**Interfaces:**
- Consumes: everything above.
- Produces: `idleState().join === 0`; `params.join` round-trips through URL state.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/cymafield.test.js
import { idleState } from '../js/cymafield.js';

test('Join defaults to off, so existing designs are unchanged', () => {
  assert.equal(idleState().join, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="Join defaults to off"`
Expected: FAIL — `undefined !== 0`.

- [ ] **Step 3: Implement**

In `js/cymafield.js`, inside `idleState()`, beside `mass`:

```js
    // Join: 0 leaves the cells as islands, exactly as before. Above 0 the
    // geometry bakes and neighbouring cells grow filleted necks, tightest
    // channels first. See js/cymajoin.js.
    join: 0,
```

In `index.html`, in the `cymatic-group` block after the Mass slider:

```html
      <label>Join — islands to connected<input type="range" id="sl-join" min="0" max="1" step="0.02" value="0"></label>
```

In `js/app.js`, wire `sl-join` exactly as `sl-mass` is wired — into `params`, into the state pushed to the conductor, and into the URL hash.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="Join defaults to off"`
Expected: PASS.

- [ ] **Step 5: Bust the cache and run everything**

Run: `npm run bust && npm test`
Expected: 0 failures; every `?v=` query string updated consistently.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js js/cymafield.js test/cymafield.test.js
git commit -m "feat: the Join control"
```

---

## Done when

- `npm test` passes with no regressions against the 150-test baseline.
- `npm run join-ladder` produces a ladder the user has approved.
- On screen and in the exported SVG, the same Join value gives the same geometry.
- `Join = 0` exports byte-identical SVG to `main`.
