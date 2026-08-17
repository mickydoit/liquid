import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestCellTransform, measureChannels, selectJoins, DEGREE_CAP,
  makeJoinedField, sdSegment, NECK_WIDTH, FILLET_K, cellClearance,
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
      assert.ok(d <= DEGREE_CAP,
        `cell ${cell} had degree ${d} > cap ${DEGREE_CAP} at Join ${join}`);
    }
  }
});

// Two unit discs centred at (-1.5, 0) and (1.5, 0): surfaces 1.0 apart.
const twoDiscs = (x, y) =>
  Math.min(Math.hypot(x + 1.5, y) - 1, Math.hypot(x - 1.5, y) - 1);

const NECK = [{
  ax: -0.5, ay: 0, bx: 0.5, by: 0, r: NECK_WIDTH * 1.0, kf: FILLET_K * 1.0,
}];

test('sdSegment measures distance to the segment, not the infinite line', () => {
  assert.ok(Math.abs(sdSegment(0, 2, -1, 0, 1, 0) - 2) < 1e-9, 'above the middle');
  assert.ok(Math.abs(sdSegment(3, 0, -1, 0, 1, 0) - 2) < 1e-9, 'past the end cap');
});

test('the neck bridges the gap: the midpoint becomes inside', () => {
  assert.ok(twoDiscs(0, 0) > 0, 'unjoined, the midpoint is outside');
  const joined = makeJoinedField(twoDiscs, NECK, Infinity);
  assert.ok(joined(0, 0) < 0, 'joined, the midpoint is inside');
});

// A fillet legitimately deepens the interior near the neck — that is what
// unioning a stub into the shape means. What must NOT move is the outline away
// from the junction, so these are boundary points on the far side of each disc
// plus genuinely distant background.
test('the outline is untouched away from the neck', () => {
  const joined = makeJoinedField(twoDiscs, NECK, Infinity);
  for (const [x, y] of [[-2.5, 0], [2.5, 0], [0, 5], [0, -3], [-4, -4]]) {
    assert.ok(Math.abs(joined(x, y) - twoDiscs(x, y)) < 1e-9,
      `field moved at ${x},${y}: ${joined(x, y)} vs ${twoDiscs(x, y)}`);
  }
});

// The reference's waist pinches INWARD on a tangent arc. A polynomial smin
// bulges outward there and reads as soap bubbles. Measuring the boundary's
// half-width along the neck is what tells them apart: a fillet's half-width must
// be at its MINIMUM at the neck's midpoint.
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
  // A smaller fillet removes less material from the corner, so the capped field
  // is never more inside than the uncapped one.
  assert.ok(capped(0.5, 0.9) >= wide(0.5, 0.9) - 1e-12);
});

// ── the bake ────────────────────────────────────────────────────────────
import { buildJoinedField } from '../js/cymajoin.js';
import { idleState, makeWaterField } from '../js/cymafield.js';
import { FORMATS, labelComponents } from '../js/bake.js';

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

test('raising Join adds necks', () => {
  const count = (join) => buildJoinedField(islandState(join),
    { aspect: FORMATS.portrait, res: 256 }).necks.length;
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

// A blend expressed in raster widths is an absolute size, so an uncapped blend
// closes channels by itself and Join stops controlling the topology. The cap is
// half the narrowest channel Join did NOT select — a selected channel is meant
// to close, so measuring against it would pin the cap to the tightest gap in
// the design and shrink every fillet to nothing.
// Each neck is capped by ITS OWN cells' tightest remaining channel, not by the
// tightest one anywhere. A global cap is pinned by whichever pair in the whole
// design happens to sit closest, which in a 46-cell field collapses every
// fillet to nearly zero — unionRound degenerates to min(), the neck meets the
// lobe at a hard corner, and the form reads as a tube butted onto a blob.
test('each fillet is capped by its own cells local clearance', () => {
  const { unselected, necks, cellSize } = buildJoinedField(islandState(0.8),
    { aspect: FORMATS.portrait, res: 256 });
  assert.ok(necks.length > 0 && unselected.length > 0, 'both sets are non-empty');

  const clear = cellClearance(unselected);
  let clamped = 0;
  for (const nk of necks) {
    const local = Math.min(clear.get(nk.a) ?? Infinity, clear.get(nk.b) ?? Infinity);
    const expect = Math.min(FILLET_K * nk.r,
      Number.isFinite(local) ? local * cellSize * 0.5 : Infinity);
    assert.ok(Math.abs(nk.kf - expect) < 1e-12,
      `neck ${nk.a}-${nk.b}: kf ${nk.kf} is not min(${FILLET_K * nk.r}, local)`);
    if (nk.kf < FILLET_K * nk.r - 1e-12) clamped++;
  }
  // The rule must be genuinely LOCAL: under one global cap every neck would be
  // clamped to the same value, so at least one reaching its full fillet is the
  // evidence that clearances are read per pair.
  assert.ok(clamped < necks.length,
    'every neck was clamped — the cap is behaving globally, not locally');
});

// What the cap is FOR: the blend must not close channels Join did not select.
// Each neck may merge at most two components, so the joined field can never have
// fewer components than (cells - necks). Fewer means the blend closed something
// on its own.
test('the blend closes no channel Join did not select', () => {
  const res = 256;
  const aspect = FORMATS.portrait;
  const { sample, necks, pairs } = buildJoinedField(islandState(0.8), { aspect, res });
  assert.ok(necks.length > 0 && pairs.length > necks.length);

  const raster = (field) => {
    const w = Math.round(res * aspect), h = res;
    const m = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = (-1 + (2 * (i + 0.5)) / w) * aspect;
        const y = 1 - (2 * (j + 0.5)) / h;
        m[j * w + i] = field(x, y) < 0 ? 1 : 0;
      }
    }
    return { m, w, h };
  };

  const before = buildJoinedField(islandState(0), { aspect, res });
  const a = raster(before.sample);
  const b = raster(sample);
  const cells = labelComponents(a.m, a.w, a.h, 8).sizes.filter((v) => v > 20).length;
  const after = labelComponents(b.m, b.w, b.h, 8).sizes.filter((v) => v > 20).length;

  assert.ok(after >= cells - necks.length,
    `components fell to ${after}, below ${cells} - ${necks.length} necks — ` +
    'the blend closed channels Join did not select');
});

// The budget scales against what the cap ACTUALLY allows, not the raw pair
// count. Scaling against the raw count saturated the control above ~0.3:
// measured neck counts were 21, 21, 43, 43, 43 across Join 0.2..1.0.
test('Join spans the whole reachable range without saturating', () => {
  const counts = [0.2, 0.4, 0.6, 0.8, 1.0].map((j) =>
    buildJoinedField(islandState(j), { aspect: FORMATS.portrait, res: 256 }).necks.length);
  const unique = new Set(counts);
  assert.ok(unique.size >= 4,
    `Join saturated — only ${unique.size} distinct neck counts: ${counts}`);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], `count fell: ${counts}`);
  }
  assert.ok(counts[0] < counts[counts.length - 1], 'the range is not flat');
});
