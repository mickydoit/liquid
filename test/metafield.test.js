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

test('3-7 macro components built from 6-12 primitives', () => {
  for (const count of [0, 0.25, 0.5, 0.75, 1]) {
    const { clusters, balls } = metaClusters(st({ meta: { count } }));
    assert.ok(clusters.length >= 3 && clusters.length <= 7,
      `count ${count} gave ${clusters.length} components`);
    assert.ok(balls.length >= 5 && balls.length <= META_MAX,
      `count ${count} gave ${balls.length} primitives`);
  }
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

test('Merge does not change which forms are connected', () => {
  // The old generator grew chains as Merge rose. Membership is now fixed by the
  // seed, so Merge can only widen the waists that already exist.
  const base = metaClusters(st({ meta: { merge: 0 } })).clusters.map((c) => c.join(',')).sort();
  for (const merge of [0.25, 0.5, 0.75, 1]) {
    const now = metaClusters(st({ meta: { merge } })).clusters.map((c) => c.join(',')).sort();
    assert.deepEqual(now, base, `Merge ${merge} changed cluster membership`);
  }
});

test('Merge widens the necks', () => {
  // Measured on the field: the narrowest crossing of a joined cluster must
  // widen as Merge rises.
  const neck = (merge) => {
    const s = st({ meta: { merge } });
    const { balls, clusters } = metaClusters(s);
    const pair = clusters.find((c) => c.length === 2);
    if (!pair) return null;
    const [a, b] = pair.map((i) => balls[i]);
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
  const n0 = neck(0), n5 = neck(0.5), n1 = neck(1);
  assert.ok(n0 !== null, 'expected a two-primitive cluster to measure');
  assert.ok(n5 > n0, `Merge 0.5 must widen the neck (${n0.toFixed(3)} -> ${n5.toFixed(3)})`);
  assert.ok(n1 > n5, `Merge 1 must widen it further (${n5.toFixed(3)} -> ${n1.toFixed(3)})`);
});

test('lobes survive at Merge 1 — the pair never becomes a plain oval', () => {
  // A waist that has vanished means the union swallowed the lobes.
  const s = st({ meta: { merge: 1 } });
  const { balls, clusters } = metaClusters(s);
  const pair = clusters.find((c) => c.length === 2);
  const [a, b] = pair.map((i) => balls[i]);
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
  assert.ok(b > a * 1.35, `Scale/crop must grow the ink (${a.toFixed(3)} -> ${b.toFixed(3)})`);
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
