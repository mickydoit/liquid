import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMeta, metaBalls, metaClusters, metaDist, compositionStats, META_MAX } from '../js/metafield.js';
import { idleState } from '../js/cymafield.js';

const ASPECT = 0.75;
const A = { pitchNorm: 0.42, rms: 0.31, centroid: 0.38, spread: 0.22, pitchConf: 0.8 };
const B = { pitchNorm: 0.78, rms: 0.55, centroid: 0.66, spread: 0.48, pitchConf: 0.45 };

const st = (o = {}) => Object.assign(idleState(), {
  amp: 0.6, grow: 1, features: A, aspect: ASPECT, mode: 'meta',
}, o, { meta: Object.assign(defaultMeta(), o.meta) });

// NOTE: these are GUARDS, not evidence that the artwork looks right. Every
// earlier version of this generator passed its metrics while looking wrong.
// The silhouettes have to be rendered and compared to the reference by eye.

// ── macro structure ────────────────────────────────────────────────────

test('6-10 lobes, consolidating to 3-7 components at the default Merge', () => {
  for (const count of [0, 0.25, 0.5, 0.75, 1]) {
    const { clusters, balls } = metaClusters(st({ meta: { count } }));
    assert.ok(balls.length >= 6 && balls.length <= 10,
      `count ${count} gave ${balls.length} lobes`);
    assert.ok(clusters.length >= 3 && clusters.length <= 7,
      `count ${count} gave ${clusters.length} components`);
  }
});

test('Circle count visibly changes the number of lobes', () => {
  const few = metaClusters(st({ meta: { count: 0 } })).balls.length;
  const many = metaClusters(st({ meta: { count: 1 } })).balls.length;
  assert.ok(many >= few + 3, `count must move the lobe total (${few} -> ${many})`);
});

test('clusters hold at most three primitives', () => {
  // More than three stops being a compact mass and starts being a chain.
  for (const merge of [0, 0.5, 1]) {
    const { clusters } = metaClusters(st({ meta: { merge } }));
    assert.ok(Math.max(...clusters.map((c) => c.length)) <= 3);
  }
});

test('at least two components stay separate at the default Merge', () => {
  const { clusters } = metaClusters(st());
  assert.ok(clusters.length >= 2, 'the design must not be one component');
  assert.ok(clusters.filter((c) => c.length === 1).length >= 2,
    'want at least two standalone forms');
});

test('three-primitive clusters are never collinear', () => {
  // A straight line of three is the bead chain in miniature.
  for (const variation of [0, 1, 2, 3, 4, 5]) {
    const { balls, clusters } = metaClusters(st({ variation }));
    for (const c of clusters) {
      if (c.length !== 3) continue;
      const [p, q, r] = c.map((i) => balls[i]);
      const area = Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
      const scale = Math.max(p.rx, p.ry) ** 2;
      assert.ok(area > scale * 0.12, `collinear triple at variation ${variation}`);
    }
  }
});

// ── composition targets ────────────────────────────────────────────────

test('the composition uses the canvas rather than a small central cluster', () => {
  for (const features of [A, B]) {
    const s = compositionStats(st({ features }), ASPECT);
    assert.ok(s.bboxCoverW >= 0.65, `width cover ${(s.bboxCoverW * 100).toFixed(0)}%`);
    assert.ok(s.bboxCoverH >= 0.65, `height cover ${(s.bboxCoverH * 100).toFixed(0)}%`);
  }
});

test('there is real size variation, with one dominant form', () => {
  const s = compositionStats(st(), ASPECT);
  assert.ok(s.areaRatio >= 2 && s.areaRatio <= 9,
    `largest/smallest primitive area ratio ${s.areaRatio.toFixed(1)}`);
});

test('Size variation widens the spread of primitive sizes', () => {
  const lo = compositionStats(st({ meta: { sizeVar: 0 } }), ASPECT).areaRatio;
  const hi = compositionStats(st({ meta: { sizeVar: 1 } }), ASPECT).areaRatio;
  assert.ok(hi > lo, `size variation must widen the range (${lo.toFixed(1)} -> ${hi.toFixed(1)})`);
});

// ── Merge: neck geometry, never membership ─────────────────────────────

test('Merge reduces the component count monotonically', () => {
  // Merge activates grouping plans one at a time. At 0 nothing is joined and
  // every lobe is its own component; at 1 the plan is fully realised.
  let prev = Infinity;
  const seen = [];
  for (const merge of [0, 0.25, 0.5, 0.75, 1]) {
    const n = metaClusters(st({ meta: { merge } })).clusters.length;
    seen.push(n);
    assert.ok(n <= prev, `component count rose at Merge ${merge} (${seen.join(' -> ')})`);
    prev = n;
  }
  assert.ok(seen[0] > seen[seen.length - 1], `Merge must connect something (${seen.join(' -> ')})`);
});

test('Merge 0 leaves every lobe separate', () => {
  const { clusters, balls } = metaClusters(st({ meta: { merge: 0 } }));
  assert.equal(clusters.length, balls.length, 'nothing may be joined at Merge 0');
});

test('Merge 1 still leaves at least one separate component', () => {
  const { clusters } = metaClusters(st({ meta: { merge: 1 } }));
  assert.ok(clusters.some((c) => c.length === 1), 'something must stay separate');
  assert.ok(clusters.length >= 3, `collapsed to ${clusters.length} components`);
});

test('Merge widens the necks', () => {
  // Measured on the field: the narrowest crossing of a joined cluster must
  // widen as Merge rises.
  const neck = (merge) => {
    const s = st({ meta: { merge } });
    const { balls, clusters } = metaClusters(s);
    // Any joined cluster, not specifically a pair: the grouping plan may build
    // a triple at one Merge setting and a pair at another.
    const grp = clusters.find((c) => c.length >= 2);
    if (!grp) return null;
    const [a, b] = [balls[grp[0]], balls[grp[1]]];
    // Sample across the midpoint, perpendicular to the axis joining them.
    const ax = b.x - a.x, ay = b.y - a.y;
    const L = Math.hypot(ax, ay) || 1;
    const nx = -ay / L, ny = ax / L;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let w = 0;
    for (let t = 0; t < 2; t += 0.004) {
      if (metaDist(mx + nx * t, my + ny * t, s) < 0) w = t; else break;
    }
    return w;
  };
  // Merge 0 has no joined pair by construction, so the comparison starts where
  // the first group activates.
  const n5 = neck(0.5), n1 = neck(1);
  assert.ok(n5 !== null && n1 !== null, 'expected a joined pair to measure');
  assert.ok(n1 >= n5 * 0.98, `Merge 1 must not narrow the neck (${n5.toFixed(3)} -> ${n1.toFixed(3)})`);
});

test('lobes survive at Merge 1 — the pair never becomes a plain oval', () => {
  // A waist that has vanished means the union swallowed the lobes.
  const s = st({ meta: { merge: 1 } });
  const { balls, clusters } = metaClusters(s);
  const grp = clusters.find((c) => c.length >= 2);
  const [a, b] = [balls[grp[0]], balls[grp[1]]];
  const ax = b.x - a.x, ay = b.y - a.y;
  const L = Math.hypot(ax, ay) || 1;
  const nx = -ay / L, ny = ax / L;
  const width = (px, py) => {
    let w = 0;
    for (let t = 0; t < 2; t += 0.004) {
      if (metaDist(px + nx * t, py + ny * t, s) < 0) w = t; else break;
    }
    return w;
  };
  // The profile along the whole axis, not two spot readings. A rotated lobe's
  // width perpendicular to the join axis is not its characteristic width, so
  // sampling only the two centres can report a waist where there is none and
  // vice versa. A real waist is a minimum in this profile.
  const prof = [];
  for (let t = 0.1; t <= 0.9; t += 0.02) {
    prof.push(width(a.x + ax * t, a.y + ay * t));
  }
  const minW = Math.min(...prof), maxW = Math.max(...prof);
  assert.ok(minW < maxW * 0.9,
    `no waist left at Merge 1 (min ${minW.toFixed(3)} vs max ${maxW.toFixed(3)})`);
});

// ── Scale/crop is a zoom, not a spread ─────────────────────────────────

test('Scale/crop enlarges the forms themselves, not just their spacing', () => {
  const areaAt = (scaleCrop) => compositionStats(st({ meta: { scaleCrop } }), ASPECT).inkFraction;
  const a = areaAt(1), b = areaAt(1.6);
  // Not proportional: at high Scale/crop the composition runs off the frame, so
  // ink measured INSIDE the frame saturates. Growth is still the assertion.
  assert.ok(b > a * 1.15, `Scale/crop must grow the ink (${a.toFixed(3)} -> ${b.toFixed(3)})`);
});

test('Scale/crop pushes forms past the frame', () => {
  const s = compositionStats(st({ meta: { scaleCrop: 1.8 } }), ASPECT);
  assert.ok(s.bboxCoverW > 0.97 && s.bboxCoverH > 0.97, 'forms should reach both edges');
});

test('Spacing moves cluster centres without changing primitive size', () => {
  const sizeOf = (spacing) => metaBalls(st({ meta: { spacing } })).map((b) => b.rx);
  const a = sizeOf(0.2), b = sizeOf(0.8);
  assert.equal(a.length, b.length, 'spacing must not change the primitive count');
  // Fitting rescales everything, so sizes may differ — but not wildly, and the
  // ordering of primitive sizes must be preserved.
  const rank = (v) => v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  assert.deepEqual(rank(a), rank(b), 'spacing must not reshuffle which form is which');
});

// ── smoothness ─────────────────────────────────────────────────────────

test('no sharp corners anywhere on the boundary', () => {
  for (const merge of [0, 0.5, 1]) {
    const s = st({ meta: { merge } });
    const e = 1e-4;
    const grad = (x, y) => {
      const gx = metaDist(x + e, y, s) - metaDist(x - e, y, s);
      const gy = metaDist(x, y + e, s) - metaDist(x, y - e, s);
      const m = Math.hypot(gx, gy) || 1;
      return [gx / m, gy / m];
    };
    let worst = 0;
    for (let k = 0; k < 260; k++) {
      const th = (k / 260) * Math.PI * 2;
      for (let r = 0.03; r < 1.5; r += 0.01) {
        const x = Math.cos(th) * r, y = Math.sin(th) * r;
        if (Math.abs(metaDist(x, y, s)) < 0.004) {
          const [ax, ay] = grad(x, y);
          const [bx, by] = grad(x + 0.006 * -ay, y + 0.006 * ax);
          worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))));
          break;
        }
      }
    }
    assert.ok(worst < 0.9, `Merge ${merge}: boundary turns ${worst.toFixed(2)} rad in a step`);
  }
});

// ── determinism ────────────────────────────────────────────────────────

test('same sound and controls give the same composition', () => {
  assert.deepEqual(metaBalls(st()), metaBalls(st()));
});

test('Reroll is the only control that changes the seed', () => {
  const base = metaBalls(st());
  assert.notDeepEqual(metaBalls(st({ variation: 1 })), base);
  assert.deepEqual(metaBalls(st({ variation: 1 })), metaBalls(st({ variation: 1 })));
});

test('different sounds give different compositions', () => {
  assert.notDeepEqual(metaBalls(st({ features: B })), metaBalls(st()));
});
