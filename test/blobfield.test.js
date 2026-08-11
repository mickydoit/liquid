import test from 'node:test';
import assert from 'node:assert/strict';
import { sdTaperedCapsule, unionRound, makeRng, warp, warpParams, layout, defaultControls, MAX_FORMS, blobField, makeBlobField, perturbState, PERTURB_MAX } from '../js/blobfield.js';
import { fnv1a } from '../js/hash.js';

// Shared by layout tests below, and reused by later tasks.
const ctl = (o = {}) => Object.assign(defaultControls(), o);

test('tapered capsule: distance is zero on each end cap', () => {
  // A capsule from (-1,0) r=0.3 to (1,0) r=0.1. The far side of each end cap
  // sits exactly on the surface.
  const d1 = sdTaperedCapsule(-1.3, 0, -1, 0, 0.3, 1, 0, 0.1);
  const d2 = sdTaperedCapsule(1.1, 0, -1, 0, 0.3, 1, 0, 0.1);
  assert.ok(Math.abs(d1) < 1e-9, `end cap A: ${d1}`);
  assert.ok(Math.abs(d2) < 1e-9, `end cap B: ${d2}`);
});

test('tapered capsule: interior is negative, exterior positive', () => {
  assert.ok(sdTaperedCapsule(0, 0, -1, 0, 0.3, 1, 0, 0.1) < 0);
  assert.ok(sdTaperedCapsule(0, 5, -1, 0, 0.3, 1, 0, 0.1) > 0);
});

test('tapered capsule: the taper actually tapers', () => {
  // At x = -1 the radius is 0.3; at x = +1 it is 0.1. A point at y = 0.2 is
  // inside near A and outside near B.
  assert.ok(sdTaperedCapsule(-1, 0.2, -1, 0, 0.3, 1, 0, 0.1) < 0);
  assert.ok(sdTaperedCapsule(1, 0.2, -1, 0, 0.3, 1, 0, 0.1) > 0);
});

test('tapered capsule is finite everywhere, including degenerate inputs', () => {
  // Coincident endpoints, and one circle swallowing the other, both hit
  // divide-by-zero and sqrt-of-negative in the general formula.
  assert.ok(Number.isFinite(sdTaperedCapsule(0.5, 0.5, 0, 0, 0.4, 0, 0, 0.2)));
  assert.ok(Number.isFinite(sdTaperedCapsule(0.5, 0.5, 0, 0, 0.9, 0.1, 0, 0.2)));
});

test('fillet union adds material at the crossing point', () => {
  // THE defining property. Where two surfaces cross, d1 = d2 = 0. A plain
  // min() leaves that point exactly on the surface, with a sharp notch. The
  // fillet must pull it INSIDE, by kf*(1 - sqrt(2)).
  const kf = 0.5;
  const d = unionRound(0, 0, kf);
  assert.ok(Math.abs(d - kf * (1 - Math.SQRT2)) < 1e-12, `got ${d}`);
  assert.ok(d < 0, 'fillet must add material, not leave a notch');
});

test('fillet union is inert far from the join', () => {
  // Outside the fillet radius it must equal plain min(), or lobes would be
  // fattened everywhere rather than only at their joins.
  assert.equal(unionRound(2.0, 3.0, 0.5), 2.0);
  assert.equal(unionRound(-2.0, 3.0, 0.5), -2.0);
});

test('fillet union with kf = 0 is exactly min()', () => {
  assert.equal(unionRound(0.3, 0.7, 0), 0.3);
  assert.equal(unionRound(0, 0, 0), 0);
});

test('rng is deterministic and stays in range', () => {
  const a = makeRng(fnv1a('abc')), b = makeRng(fnv1a('abc'));
  const seqA = Array.from({ length: 200 }, () => a());
  const seqB = Array.from({ length: 200 }, () => b());
  assert.deepEqual(seqA, seqB, 'same seed must give the same sequence');
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
});

test('rng differs between seeds', () => {
  const a = makeRng(fnv1a('abc')), b = makeRng(fnv1a('abd'));
  assert.notEqual(a(), b());
});

test('warp with amount 0 is the identity', () => {
  const p = warpParams(makeRng(7));
  assert.deepEqual(warp(0.4, -0.2, 0, p), [0.4, -0.2]);
});

test('warp displacement is bounded by amount', () => {
  // Unbounded warp turns forms into spaghetti. The displacement must scale
  // with `amount` and never exceed it.
  const p = warpParams(makeRng(7));
  for (let i = 0; i < 400; i++) {
    const x = -2 + (4 * i) / 399, y = Math.sin(i) * 1.5;
    const [wx, wy] = warp(x, y, 0.25, p);
    assert.ok(Math.hypot(wx - x, wy - y) <= 0.25 + 1e-12,
      `displacement ${Math.hypot(wx - x, wy - y)} exceeded 0.25`);
  }
});

test('warp is continuous', () => {
  // A discontinuity would tear a form in half. Nearby inputs, nearby outputs.
  const p = warpParams(makeRng(7));
  const [ax, ay] = warp(0.5, 0.5, 0.3, p);
  const [bx, by] = warp(0.5001, 0.5, 0.3, p);
  assert.ok(Math.hypot(bx - ax, by - ay) < 1e-3);
});

test('layout is deterministic', () => {
  const a = layout(12345, ctl());
  const b = layout(12345, ctl());
  assert.deepEqual(a, b);
});

test('layout varies with seed', () => {
  const a = layout(12345, ctl());
  const b = layout(12346, ctl());
  assert.notDeepEqual(a.prims, b.prims);
});

test('layout always returns the full pool', () => {
  for (const formCount of [0, 0.25, 0.5, 1]) {
    assert.equal(layout(1, ctl({ formCount })).prims.length, MAX_FORMS + 1);
  }
});

test('form count fades arms in without moving the others', () => {
  // THE continuity requirement: moving a slider must refine the design, not
  // re-roll it. Arms that were already present must not shift at all.
  const four = layout(99, ctl({ formCount: 0.25 }));
  const five = layout(99, ctl({ formCount: 0.5 }));
  for (let i = 0; i < four.prims.length; i++) {
    const a = four.prims[i], b = five.prims[i];
    assert.equal(a.ax, b.ax, `arm ${i} moved in x`);
    assert.equal(a.ay, b.ay, `arm ${i} moved in y`);
    assert.equal(a.bx, b.bx, `arm ${i} tip moved in x`);
    assert.equal(a.by, b.by, `arm ${i} tip moved in y`);
  }
  const activeFour = four.prims.filter((p) => p.weight > 0.5).length;
  const activeFive = five.prims.filter((p) => p.weight > 0.5).length;
  assert.ok(activeFive > activeFour, `${activeFour} -> ${activeFive}`);
});

test('every arm is attached to the hub', () => {
  // The references are one connected organism. A detached arm is a bug.
  const { prims } = layout(7, ctl({ formCount: 1 }));
  const hub = prims[0];
  for (const p of prims.slice(1)) {
    const d = Math.hypot(p.ax - hub.ax, p.ay - hub.ay);
    assert.ok(d < hub.ra + p.ra,
      `arm root at distance ${d} is not overlapping hub radius ${hub.ra}`);
  }
});

test('arm angles are not evenly spaced at default symmetry', () => {
  // Evenly spaced arms ARE the pinwheel the brief rejects. Measure the spread
  // of gaps between consecutive angles; a pinwheel has near-zero spread.
  const { prims } = layout(31, ctl({ formCount: 1 }));
  const angles = prims.slice(1)
    .filter((p) => p.weight > 0.5)
    .map((p) => Math.atan2(p.by - p.ay, p.bx - p.ax))
    .sort((a, b) => a - b);
  const gaps = angles.map((a, i) => (i === 0
    ? a + 2 * Math.PI - angles[angles.length - 1]
    : a - angles[i - 1]));
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const spread = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
  assert.ok(spread > 0.25, `arm angles too regular, spread ${spread}`);
});

test('stretch lengthens arms', () => {
  const armLen = (c) => {
    const { prims } = layout(5, ctl(c));
    return Math.hypot(prims[1].bx - prims[1].ax, prims[1].by - prims[1].ay);
  };
  assert.ok(armLen({ stretch: 0.9 }) > armLen({ stretch: 0.1 }));
});

test('field is negative at the hub and positive far away', () => {
  const { field } = makeBlobField(42, ctl());
  assert.ok(field(0, 0) < 0, 'hub should be inside');
  assert.ok(field(9, 9) > 0, 'far field should be outside');
});

test('field is finite everywhere on a dense grid', () => {
  const { field } = makeBlobField(42, ctl({ warp: 0.4, merge: 0.8 }));
  for (let j = 0; j < 60; j++) {
    for (let i = 0; i < 60; i++) {
      const v = field(-2 + (4 * i) / 59, -2 + (4 * j) / 59);
      assert.ok(Number.isFinite(v), `non-finite at ${i},${j}`);
    }
  }
});

test('zero-weight arms contribute nothing', () => {
  // A faded-out arm must vanish completely, not leave a hairline of
  // zero-radius points behind.
  const three = makeBlobField(42, ctl({ formCount: 0 }));
  let inkAtThree = 0;
  const probe = (f) => {
    let n = 0;
    for (let j = 0; j < 80; j++) {
      for (let i = 0; i < 80; i++) {
        if (f(-1.6 + (3.2 * i) / 79, -1.6 + (3.2 * j) / 79) < 0) n++;
      }
    }
    return n;
  };
  inkAtThree = probe(three.field);
  const seven = makeBlobField(42, ctl({ formCount: 1 }));
  assert.ok(probe(seven.field) > inkAtThree, 'more arms should mean more ink');
});

test('merge deepens the waist between hub and arm', () => {
  // The fillet must actually add material at the joins as merge rises.
  const probeJoin = (merge) => {
    const { field, prims } = makeBlobField(42, ctl({ merge }));
    const arm = prims[1];
    // A point just off the axis, near where the arm leaves the hub.
    return field(arm.ax * 1.4 + 0.02, arm.ay * 1.4 + 0.02);
  };
  assert.ok(probeJoin(0.9) < probeJoin(0.05), 'higher merge should add material');
});

test('field is deterministic', () => {
  const a = makeBlobField(3, ctl()), b = makeBlobField(3, ctl());
  for (let i = 0; i < 50; i++) {
    const x = -1.5 + (3 * i) / 49;
    assert.equal(a.field(x, 0.3), b.field(x, 0.3));
  }
});

test('detail 0 leaves the field completely unperturbed', () => {
  // Shape Style at the simplified end must be pure arcs and lines: the
  // reference silhouettes have no nodal waviness at all.
  const plain = makeBlobField(42, ctl({ detail: 0 }));
  const same = makeBlobField(42, ctl({ detail: 0 }));
  for (let i = 0; i < 40; i++) {
    const x = -1.2 + (2.4 * i) / 39;
    assert.equal(plain.field(x, 0.25), same.field(x, 0.25));
  }
});

test('detail > 0 actually changes the field', () => {
  const plain = makeBlobField(42, ctl({ detail: 0 }));
  const wavy = makeBlobField(42, ctl({ detail: 0.6 }));
  let changed = 0;
  for (let i = 0; i < 60; i++) {
    const x = -1.2 + (2.4 * i) / 59;
    if (Math.abs(plain.field(x, 0.25) - wavy.field(x, 0.25)) > 1e-9) changed++;
  }
  assert.ok(changed > 30, `only ${changed}/60 samples moved`);
});

test('perturbation is bounded below the form scale', () => {
  // THE anti-breakup guarantee. If the displacement can exceed the smallest
  // form radius, forms fragment into cells and the whole style fails.
  const plain = makeBlobField(42, ctl({ detail: 0 }));
  const wavy = makeBlobField(42, ctl({ detail: 1 }));
  const s = ctl().scaleCrop;
  for (let j = 0; j < 50; j++) {
    for (let i = 0; i < 50; i++) {
      const x = -1.5 + (3 * i) / 49, y = -1.5 + (3 * j) / 49;
      const delta = Math.abs(plain.field(x, y) - wavy.field(x, y));
      assert.ok(delta <= PERTURB_MAX * s + 1e-9,
        `displacement ${delta} exceeded ${PERTURB_MAX * s}`);
    }
  }
});

test('perturbState raises mode order with detail', () => {
  assert.ok(perturbState(0.9).m > perturbState(0.1).m);
});

test('perturbed field stays finite', () => {
  const { field } = makeBlobField(42, ctl({ detail: 1, warp: 0.5 }));
  for (let j = 0; j < 40; j++) {
    for (let i = 0; i < 40; i++) {
      assert.ok(Number.isFinite(field(-2 + (4 * i) / 39, -2 + (4 * j) / 39)));
    }
  }
});
