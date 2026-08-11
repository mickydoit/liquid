# Shape Style Geometry Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CPU geometry engine for the Simplified Metaball shape style — tapered-capsule primitives, fillet union, connected-organism layout, and a bake pipeline with real morphological cleanup — renderable to PNG from node with no browser.

**Architecture:** Pure ES modules with no WebGL and no dependencies. `js/blobfield.js` produces a signed distance field from seeded primitives. `js/bake.js` rasterises that field, cleans it with morphology driven by a Euclidean distance transform, and returns a cleaned signed field. `tools/render.mjs` writes PNGs so results can be looked at, which is the actual acceptance gate.

**Tech Stack:** Vanilla ES modules, `node --test`, node's built-in `zlib` for PNG encoding. No new dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-08-11-liquid-shape-style-design.md`

**Scope:** This plan covers geometry only. App integration — the GLSL live path, SDF texture upload, Shape Style and the ten controls in the panel, the Format system, Solid preview, the `shader.js:79` crispness fix, and export wiring — is a second plan that follows this one.

## Global Constraints

- **No new dependencies.** `package.json` stays dependency-free. Node built-ins only.
- **No build step.** Vanilla ES modules, `type: module`.
- **Determinism is absolute.** No `Math.random()` anywhere in `js/`. All variation comes from the seeded PRNG. Same inputs must give byte-identical output.
- **Pure functions.** Everything in `js/blobfield.js` and `js/bake.js` is a pure function of its arguments. No module-level mutable state.
- **Existing tests must keep passing.** `npm test` currently runs 28 tests; none may break.
- **Do not modify `js/cymafield.js` or `js/shader.js` in this plan.** Shape Style 0 must stay bit-identical to today.
- **Field convention:** signed distance, **negative inside** the form. This matches `makeWaterField` (`cymafield.js:203`) and `fieldOutline` (`contour.js:170`, "negative inside").
- **Coordinate convention:** world space, y-up, matching `cymafield.js`. The frame is `x ∈ [−a, a], y ∈ [−1, 1]` where `a` is the format aspect ratio.

---

### Task 1: Tapered capsule SDF and fillet union

**Files:**
- Create: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `sdTaperedCapsule(px, py, ax, ay, ra, bx, by, rb) → number`
  - `unionRound(d1, d2, kf) → number`

- [ ] **Step 1: Write the failing test**

Create `test/blobfield.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sdTaperedCapsule, unionRound } from '../js/blobfield.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `Cannot find module '../js/blobfield.js'`

- [ ] **Step 3: Write minimal implementation**

Create `js/blobfield.js`:

```js
// Simplified-metaball geometry for Liquid's Shape Style control.
//
// The primitive is a TAPERED CAPSULE: two circles of independent radius joined
// by their outer tangents. Equal radii give a capsule, unequal a teardrop, two
// joined at a pinch an hourglass. That single primitive is the whole silhouette
// vocabulary of the reference identity, which is drawn exactly this way.
//
// Joins use a CIRCULAR FILLET, never a polynomial smooth-minimum. A smooth-min
// bulges convexly at the join; every waist in the reference pinches inward on
// an arc tangent to both lobes. That difference is the whole reason Liquid read
// as soap bubbles the last time it was a metaball (see cymafield.js:3-6).
//
// Signed distance, NEGATIVE INSIDE, matching contour.js's convention.

// Distance to the convex hull of circles (a, ra) and (b, rb).
// Inigo Quilez's 2D rounded cone, with the two degenerate cases guarded.
export function sdTaperedCapsule(px, py, ax, ay, ra, bx, by, rb) {
  const bax = bx - ax, bay = by - ay;
  const l2 = bax * bax + bay * bay;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;

  // Coincident endpoints, or one circle entirely containing the other. The
  // general formula divides by l2 and roots a2, so both would go non-finite.
  if (l2 < 1e-12 || a2 <= 1e-12) {
    return Math.min(Math.hypot(px - ax, py - ay) - ra,
                    Math.hypot(px - bx, py - by) - rb);
  }

  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay;
  const y = pax * bax + pay * bay;
  const z = y - l2;
  const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y;
  const x2 = qx * qx + qy * qy;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;

  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

// Circular fillet union. Adds an arc of radius kf tangent to both surfaces in
// the concave corner where they meet.
//
// At the crossing point (d1 = d2 = 0) this returns kf*(1 - sqrt(2)) — inside.
// Plain min() would return 0 and leave a sharp notch.
export function unionRound(d1, d2, kf) {
  if (kf <= 0) return Math.min(d1, d2);
  const ux = Math.max(kf - d1, 0), uy = Math.max(kf - d2, 0);
  return Math.max(kf, Math.min(d1, d2)) - Math.hypot(ux, uy);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS, 35 tests (28 existing + 7 new)

- [ ] **Step 6: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: tapered capsule SDF and circular fillet union"
```

---

### Task 2: Seeded PRNG and domain warp

**Files:**
- Modify: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: `fnv1a` from `js/hash.js` (existing, `hash.js:3`)
- Produces:
  - `makeRng(seed) → () => number` — uniform in [0,1)
  - `warp(px, py, amount, rng2) → [x, y]` where `rng2` is a frozen 6-number array from `warpParams`
  - `warpParams(rng) → number[6]`

- [ ] **Step 1: Write the failing test**

Append to `test/blobfield.test.js`:

```js
import { makeRng, warp, warpParams } from '../js/blobfield.js';
import { fnv1a } from '../js/hash.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `makeRng is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/blobfield.js`:

```js
// Mulberry32. Small, fast, and good enough for layout jitter. Seeded from the
// audio fingerprint via fnv1a, so a design is reproducible from its sound.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Frozen warp parameters: three sinusoid phases and three frequencies. Drawn
// once per design so the warp field itself is stable while `amount` varies.
export function warpParams(rng) {
  return [
    0.7 + rng() * 1.6, 0.7 + rng() * 1.6,   // frequencies
    rng() * Math.PI * 2, rng() * Math.PI * 2, // phases
    0.6 + rng() * 1.1, rng() * Math.PI * 2,   // cross term
  ];
}

// Smooth, bounded, continuous domain warp. The displacement vector is
// normalised so |offset| <= amount exactly — an unbounded warp shreds forms
// instead of bending them.
export function warp(px, py, amount, p) {
  if (amount <= 0) return [px, py];
  const [f1, f2, a1, a2, f3, a3] = p;
  let dx = Math.sin(py * f1 + a1) + 0.5 * Math.sin(px * f3 + a3);
  let dy = Math.sin(px * f2 + a2) + 0.5 * Math.cos(py * f3 + a3);
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return [px + dx * amount, py + dy * amount];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: seeded rng and bounded domain warp"
```

---

### Task 3: Connected-organism layout

**Files:**
- Modify: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: `makeRng`, `warpParams` (Task 2)
- Produces:
  - `MAX_FORMS = 7` (constant)
  - `defaultControls() → object` with keys `detail, formCount, merge, simplify, symmetry, stretch, warp, scaleCrop, edgeSoftness, invert` — all numbers in [0,1] except:
    - `invert` — 0 or 1
    - `scaleCrop` — a frame-scale **multiplier**, roughly [0.5, 2.0]. 1.0 means the organism exactly fits the frame; above 1 it overflows and gets cropped. It is not a normalised control, and `resolveControls` (Task 10) deliberately treats it differently from the rest.
  - `layout(seed, controls) → { prims, warpP }` where `prims` is an array of
    `{ ax, ay, ra, bx, by, rb, weight }`, always length `MAX_FORMS + 1`
    (index 0 is the central hub), and `weight ∈ [0,1]`

**Design notes for the implementer:**
The references are **one connected organism** — a central node with arms radiating off it, not scattered blobs. Arm angles are deliberately *uneven*: even spacing produces the pinwheel the brief explicitly rejects. `Symmetry` at 1 means evenly spaced, at 0 means heavily jittered; the default sits near 0.25.

`formCount` fades arms in and out via `weight` rather than changing the array length. That is what makes the control continuous — going from 4 arms to 5 must add one arm and leave the other four untouched.

- [ ] **Step 1: Write the failing test**

Append to `test/blobfield.test.js`:

```js
import { layout, defaultControls, MAX_FORMS } from '../js/blobfield.js';

const ctl = (o = {}) => Object.assign(defaultControls(), o);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `layout is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/blobfield.js`:

```js
// The pool is fixed. Form Count fades arms in and out by weight rather than
// resizing the pool, which is what keeps the control continuous: raising it
// ADDS an arm and leaves the others exactly where they were.
export const MAX_FORMS = 7;

export function defaultControls() {
  return {
    detail: 0,        // psi perturbation. 0 at full Simplified: the reference
                      // silhouettes are pure arcs and lines, with no waviness.
    formCount: 0.5,
    merge: 0.45,
    simplify: 0.5,
    symmetry: 0.25,   // low = irregular. High symmetry is the rejected pinwheel.
    stretch: 0.55,
    warp: 0.3,
    scaleCrop: 1.15,  // >1 pushes the organism off-frame
    edgeSoftness: 0.15,
    invert: 0,
  };
}

// One connected organism: a central hub plus MAX_FORMS arms, each a tapered
// capsule running from inside the hub out to a terminal disc.
export function layout(seed, controls) {
  const c = Object.assign(defaultControls(), controls);
  const rng = makeRng(seed);

  // Drawn BEFORE anything weight-dependent, so changing formCount cannot
  // shift the rng sequence and move existing arms.
  const hubR = 0.16 + rng() * 0.06;
  const baseAngle = rng() * Math.PI * 2;
  const raw = Array.from({ length: MAX_FORMS }, () => ({
    jitter: rng() * 2 - 1,
    len: rng(),
    tip: rng(),
    root: rng(),
  }));
  const warpP = warpParams(rng);

  const hub = { ax: 0, ay: 0, ra: hubR, bx: 0, by: 0, rb: hubR, weight: 1 };

  // How many arms are active. formCount 0 -> 3 arms, 1 -> MAX_FORMS.
  const active = 3 + c.formCount * (MAX_FORMS - 3);

  const prims = raw.map((r, i) => {
    // Even spacing is a pinwheel, so the base angle is perturbed by a
    // per-arm jitter scaled by (1 - symmetry).
    const even = baseAngle + (i / MAX_FORMS) * Math.PI * 2;
    const th = even + r.jitter * (1 - c.symmetry) * (Math.PI / MAX_FORMS) * 1.8;

    const len = (0.34 + r.len * 0.30) * (0.65 + c.stretch * 1.05);
    const tipR = (0.10 + r.tip * 0.13) * (1.25 - c.stretch * 0.45);
    const rootR = hubR * (0.45 + r.root * 0.35);

    // Root sits INSIDE the hub so the union is genuinely connected.
    const rootD = hubR * 0.35;

    // weight ramps over one arm's width, so an arm grows in rather than
    // popping. Arms are ordered, so arm i activates as `active` passes i+1.
    const weight = Math.max(0, Math.min(1, active - i));

    return {
      ax: Math.cos(th) * rootD,
      ay: Math.sin(th) * rootD,
      ra: rootR,
      bx: Math.cos(th) * (rootD + len),
      by: Math.sin(th) * (rootD + len),
      rb: tipR,
      weight,
    };
  });

  return { prims: [hub, ...prims], warpP };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 19 tests

- [ ] **Step 5: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: connected-organism layout with continuous form count"
```

---

### Task 4: Assemble the blob field

**Files:**
- Modify: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: `sdTaperedCapsule`, `unionRound`, `warp`, `layout` (Tasks 1–3)
- Produces:
  - `blobField(px, py, prims, warpP, controls) → number` — signed, negative inside
  - `makeBlobField(seed, controls) → { field: (x, y) => number, prims, warpP }`

**Design note:** an arm with `weight` 0 must contribute *nothing*. Scaling its radii to zero is not enough — a zero-radius capsule is still a line of zero-distance points. Weight scales the radii **and** pushes the primitive's distance to `+Infinity` below a threshold.

- [ ] **Step 1: Write the failing test**

Append to `test/blobfield.test.js`:

```js
import { blobField, makeBlobField } from '../js/blobfield.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `blobField is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/blobfield.js`:

```js
// Below this weight an arm is gone entirely. Scaling radii to zero is not
// enough: a zero-radius capsule is still a line of zero-distance points, which
// would leave a hairline scratch exactly where the arm faded out.
const WEIGHT_EPS = 1e-3;

// `controls` must be a COMPLETE control object — run it through
// defaultControls() once in the caller. This is evaluated per cell during the
// bake (~500k times), so allocating a merged object here would dominate.
export function blobField(px, py, prims, warpP, c) {
  const [wx, wy] = warp(px, py, c.warp * 0.35, warpP);

  // Merge maps to the fillet radius. Scaled by hub radius so the waist keeps
  // its proportion as the organism scales.
  const kf = c.merge * 0.22;

  let d = Infinity;
  for (const p of prims) {
    if (p.weight <= WEIGHT_EPS) continue;
    const w = p.weight;
    const di = sdTaperedCapsule(wx, wy, p.ax, p.ay, p.ra * w, p.bx, p.by, p.rb * w);
    d = (d === Infinity) ? di : unionRound(d, di, kf);
  }
  if (d === Infinity) return Infinity;

  // Edge Softness rounds the field itself, so it smooths the CONTOUR and
  // therefore the exported path. It is not an opacity ramp.
  d -= c.edgeSoftness * 0.05;

  return c.invert ? -d : d;
}

export function makeBlobField(seed, controls) {
  const c = Object.assign(defaultControls(), controls);
  const { prims, warpP } = layout(seed, c);
  // Scale/Crop enlarges the organism relative to the frame, which is what
  // pushes arms off the edge and takes the centre out of view.
  const s = c.scaleCrop;
  return {
    prims, warpP, controls: c,
    field: (x, y) => blobField(x / s, y / s, prims, warpP, c) * s,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 24 tests

- [ ] **Step 5: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: assemble blob field from primitives"
```

---

### Task 4b: Shape Style perturbation by ψ

**Files:**
- Modify: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: `psi`, `idleState` from `js/cymafield.js` (existing, `cymafield.js:51` and `cymafield.js:29`); `blobField` (Task 4)
- Produces:
  - `PERTURB_MAX = 0.045` (constant)
  - `perturbState(detail) → object` — a cymatic state suitable for `psi`
  - `blobField` gains the perturbation term (same signature)

**Design note — this is the Shape Style blend, and why it is a perturbation rather than a crossfade.** The capsule union is a true signed *distance* field, so ψ can displace its contour by a bounded number of world units. Crossfading the two fields instead would break into cells wherever the oscillating ψ outweighs the smooth capsule field — reproducing the exact "too many separate radial cells and thin accidental bridges" failure the brief rejects, at half strength.

`PERTURB_MAX` is 0.045 against a smallest form radius of 0.10 (`layout`'s minimum `tipR`). Staying well under the form scale is what makes breakup impossible by construction, so **do not raise it** without re-running the acceptance component-count assertions.

ψ must be clamped before scaling: it is a superposition of cosines with a range of roughly ±2, so using it raw would overshoot the bound.

- [ ] **Step 1: Write the failing test**

Append to `test/blobfield.test.js`:

```js
import { perturbState, PERTURB_MAX } from '../js/blobfield.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `perturbState is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `js/blobfield.js`:

```js
import { psi, idleState } from './cymafield.js';
```

Append to `js/blobfield.js`:

```js
// Maximum contour displacement from the psi perturbation, in world units.
//
// The smallest form radius layout() produces is 0.10. Keeping the displacement
// well under that is what makes cellular breakup impossible by construction --
// it is the reason Shape Style is a bounded perturbation of a distance field
// rather than a crossfade between two fields. Raising this re-opens the
// breakup failure; re-run the acceptance component-count tests if you do.
export const PERTURB_MAX = 0.045;

// A cymatic state for psi(). Detail raises the mode order, so higher Detail
// gives finer waviness along the contour rather than a bigger wobble.
export function perturbState(detail) {
  return Object.assign(idleState(), {
    m: 2 + detail * 7.5,
    n: 1.5 + detail * 5.0,
    kr: 4.5 + detail * 16,
    ma: 2 + detail * 6,
    mix: 0.5,
    amp: 1,
    grow: 1,
  });
}
```

Then modify `blobField` — after the Edge Softness line and before the invert, insert:

```js
  // Shape Style: psi displaces the contour by a BOUNDED distance. psi is a
  // superposition of cosines ranging to about +-2, so it is clamped before
  // scaling or it would overshoot PERTURB_MAX.
  if (c.detail > 0) {
    const w = Math.max(-1, Math.min(1, psi(wx, wy, c._psiState)));
    d -= w * c.detail * PERTURB_MAX;
  }
```

And in `makeBlobField`, build the state once rather than per cell:

```js
export function makeBlobField(seed, controls) {
  const c = Object.assign(defaultControls(), controls);
  // Built once: psi's state is constant across the field, and rebuilding it
  // per cell would allocate an object ~500k times during a bake.
  c._psiState = perturbState(c.detail);
  const { prims, warpP } = layout(seed, c);
  const s = c.scaleCrop;
  return {
    prims, warpP, controls: c,
    field: (x, y) => blobField(x / s, y / s, prims, warpP, c) * s,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 29 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — `cymafield.js` is imported but not modified, so its 28 tests are unaffected

- [ ] **Step 6: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: bounded psi perturbation for shape style blend"
```

---

### Task 5: PNG writer and field rasteriser

**Files:**
- Create: `tools/png.mjs`
- Create: `tools/render.mjs`
- Test: `test/png.test.js`

**Interfaces:**
- Consumes: `makeBlobField` (Task 4)
- Produces:
  - `encodePNG(width, height, rgb) → Buffer` where `rgb` is a `Uint8Array` of length `width*height*3`
  - `tools/render.mjs` — CLI writing a PNG per seed

**Why now:** everything after this is judged by eye. Getting a picture on screen before writing the morphology means each later task can be *looked at* rather than only asserted against.

- [ ] **Step 1: Write the failing test**

Create `test/png.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../tools/png.mjs';

test('encodePNG emits a valid PNG signature and IHDR', () => {
  const buf = encodePNG(2, 2, new Uint8Array(12).fill(128));
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(buf.readUInt32BE(16), 2, 'width');
  assert.equal(buf.readUInt32BE(20), 2, 'height');
});

test('encodePNG ends with IEND', () => {
  const buf = encodePNG(1, 1, new Uint8Array([0, 0, 0]));
  assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString('latin1'), 'IEND');
});

test('encodePNG rejects a wrong-sized buffer', () => {
  assert.throws(() => encodePNG(2, 2, new Uint8Array(5)), /expected 12 bytes/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/png.test.js`
Expected: FAIL — `Cannot find module '../tools/png.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `tools/png.mjs`:

```js
// Minimal PNG encoder, so acceptance renders can be LOOKED AT from node with
// no browser and no dependencies. zlib is a node built-in.
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePNG(width, height, rgb) {
  const want = width * height * 3;
  if (rgb.length !== want) throw new Error(`expected ${want} bytes, got ${rgb.length}`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  // 10,11,12 = compression, filter, interlace — all 0

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = y * (1 + width * 3);
    raw[dst] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + src, width * 3).copy(raw, dst + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
```

Create `tools/render.mjs`:

```js
// Render blob fields to PNG for visual review.
//
//   node tools/render.mjs out/ 1 2 3
//
// Writes out/blob-<seed>.png for each seed. Solid preview only: black form on
// white ground, hard threshold, so what you see is the silhouette itself with
// no material dressing it up.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { makeBlobField, defaultControls } from '../js/blobfield.js';

export function renderField(field, { width = 900, height = 1350, aspect = null } = {}) {
  const a = aspect ?? width / height;
  const rgb = new Uint8Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    // World y-up, image y-down.
    const y = 1 - (2 * (j + 0.5)) / height;
    for (let i = 0; i < width; i++) {
      const x = (-1 + (2 * (i + 0.5)) / width) * a;
      const v = field(x, y) < 0 ? 0 : 255;
      const o = (j * width + i) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
    }
  }
  return { rgb, width, height };
}

const [, , outDir = 'out', ...seeds] = process.argv;
if (seeds.length) {
  mkdirSync(outDir, { recursive: true });
  for (const s of seeds) {
    const { field } = makeBlobField(Number(s), defaultControls());
    const { rgb, width, height } = renderField(field);
    writeFileSync(`${outDir}/blob-${s}.png`, encodePNG(width, height, rgb));
    console.log(`${outDir}/blob-${s}.png`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/png.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Render and LOOK at the result**

Run: `node tools/render.mjs /tmp/blob-out 1 2 3 4 5 6`

Open the six PNGs. This is the first visual checkpoint. Expect: one connected organism, a hub with irregularly spaced arms ending in discs of varying size, concave waists where arms leave the hub, and some arms running off the frame edge. Do **not** expect the reference composition yet — no cleanup has run.

If arms look evenly spaced, `symmetry` is too high. If waists bulge convexly instead of pinching, `unionRound` is wrong — re-check Task 1.

- [ ] **Step 6: Commit**

```bash
git add tools/png.mjs tools/render.mjs test/png.test.js
git commit -m "feat: png encoder and headless field renderer"
```

---

### Task 6: Euclidean distance transform

**Files:**
- Create: `js/bake.js`
- Test: `test/bake.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `edt(mask, w, h) → Float64Array` — for each cell, the distance **in cells** to the nearest cell where `mask` is 0. Cells where `mask` is 0 get 0.
  - `signedEdt(mask, w, h) → Float64Array` — negative inside (mask 1), positive outside

**Design note:** this is Felzenszwalb & Huttenlocher's exact algorithm — a 1D lower-envelope-of-parabolas transform run down the columns, then across the rows. It is exact and O(n), and everything else in the bake is expressed in terms of it: dilation by r is `signedEdt <= r`, erosion by r is `signedEdt < -r`. Building morphology on the EDT avoids the square-structuring-element artefacts of iterative dilate/erode.

**The erosion comparison is strict, and that is not a stylistic choice.** `edt` measures cell-centre to cell-centre, so no inside cell ever has distance 0 — the minimum magnitude is 1. `{d <= -r}` would therefore retain every inside cell at `r = 1` (an identity, not an erosion) while `{d <= r}` correctly adds one ring, so dilation would add `r` rings while erosion peeled only `r - 1`. Closing would stop being idempotent and every shape would come out one ring fatter. Duality requires `erode(r) = complement(dilate(r, complement))` = `{d < -r}` exactly.

- [ ] **Step 1: Write the failing test**

Create `test/bake.test.js`:

```js
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
  // A 5x5 block of 1s inside a 9x9 field. The centre is 2 cells from the
  // nearest 0 (at index 1 along the row through the centre... the block spans
  // 2..6, so the centre at 4 is 2 cells from the 0 at index 1).
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bake.test.js`
Expected: FAIL — `Cannot find module '../js/bake.js'`

- [ ] **Step 3: Write minimal implementation**

Create `js/bake.js`:

```js
// Bake: rasterise a signed field, clean it with real morphology, and hand back
// a cleaned signed field.
//
// Morphological closing, component culling and hole removal are GLOBAL
// operations over a raster. No per-pixel function can express them, in JS or
// in GLSL — which is why the simplified style bakes on settle rather than
// being evaluated per pixel per frame like cymafield.js.
//
// Everything here is expressed in terms of an exact Euclidean distance
// transform: dilation by r is {d <= r}, erosion by r is {d <= -r}. That avoids
// the blocky artefacts of iterative square-kernel dilate/erode.

const INF = 1e20;

// Felzenszwalb & Huttenlocher 1D squared-distance transform: the lower
// envelope of parabolas rooted at each sample. Exact and linear.
function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Distance in cells from every cell to the nearest cell where mask === 0.
export function edt(mask, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < mask.length; i++) g[i] = mask[i] ? INF : 0;

  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}

// Negative inside the mask, positive outside.
export function signedEdt(mask, w, h) {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const dOut = edt(mask, w, h);   // distance from inside to the outside
  const dIn = edt(inv, w, h);     // distance from outside to the inside
  const out = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? -dOut[i] : dIn[i];
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bake.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add js/bake.js test/bake.test.js
git commit -m "feat: exact euclidean distance transform"
```

---

### Task 7: Morphological close and open

**Files:**
- Modify: `js/bake.js`
- Test: `test/bake.test.js`

**Interfaces:**
- Consumes: `signedEdt` (Task 6)
- Produces:
  - `dilate(mask, w, h, r) → Uint8Array`
  - `erode(mask, w, h, r) → Uint8Array`
  - `close(mask, w, h, r) → Uint8Array` — dilate then erode; fills gaps
  - `open(mask, w, h, r) → Uint8Array` — erode then dilate; removes filaments

- [ ] **Step 1: Write the failing test**

Append to `test/bake.test.js`:

```js
import { dilate, erode, close, open } from '../js/bake.js';

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

test('open removes a hairline bridge but keeps a thick waist', () => {
  // THIS is the distinction the brief hinges on: hairline filaments go,
  // intentional waists stay. They differ only in width, so a single opening
  // radius between the two separates them.
  const w = 41, h = 21;
  const hairline = mk(w, h, (i, j) =>
    (i >= 4 && i <= 12 && j >= 6 && j <= 14) ||     // block A
    (i >= 28 && i <= 36 && j >= 6 && j <= 14) ||    // block B
    (i > 12 && i < 28 && j === 10));                // 1-cell bridge
  const opened = open(hairline, w, h, 2);
  assert.equal(opened[10 * w + 20], 0, 'hairline bridge must be removed');
  assert.equal(opened[10 * w + 8], 1, 'block A must survive');

  const waist = mk(w, h, (i, j) =>
    (i >= 4 && i <= 12 && j >= 6 && j <= 14) ||
    (i >= 28 && i <= 36 && j >= 6 && j <= 14) ||
    (i > 12 && i < 28 && j >= 7 && j <= 13));       // 7-cell waist
  assert.equal(open(waist, w, h, 2)[10 * w + 20], 1, 'thick waist must survive');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bake.test.js`
Expected: FAIL — `dilate is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/bake.js`:

```js
// Morphology via the distance transform. Dilation by r is every cell within r
// of the mask; erosion by r is every masked cell at least r from the boundary.
// Both use a true circular structuring element, unlike iterative kernels.

export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = signedEdt(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

// STRICT comparison. edt is cell-centre to cell-centre, so no inside cell has
// distance 0 and `<= -r` would be an identity at r = 1 rather than an erosion.
// Duality with dilate demands `< -r`; getting this wrong makes close() grow the
// shape by a ring every time instead of leaving it unchanged.
export function erode(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = signedEdt(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = d[i] < -r ? 1 : 0;
  return out;
}

// Fills gaps and pinholes narrower than r.
export function close(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  return erode(dilate(mask, w, h, r), w, h, r);
}

// Removes filaments and spurs thinner than r. A waist wider than 2r survives,
// which is exactly how an intentional waist is told from a hairline bridge.
export function open(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  return dilate(erode(mask, w, h, r), w, h, r);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bake.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add js/bake.js test/bake.test.js
git commit -m "feat: morphological close and open via distance transform"
```

---

### Task 8: Component and hole culling

**Files:**
- Modify: `js/bake.js`
- Test: `test/bake.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `labelComponents(mask, w, h, connectivity) → { labels: Int32Array, sizes: number[] }` — labels are 1-based, 0 means not in the mask
  - `cullComponents(mask, w, h, minArea) → Uint8Array`
  - `cullHoles(mask, w, h, minArea) → Uint8Array`

**Design note on connectivity:** foreground uses 8-connectivity and background 4-connectivity. Using the same connectivity for both creates the classic topological paradox where a diagonal line both separates and fails to separate the regions either side of it.

Holes are background components that do **not** touch the border. A background region touching the border is outside the form, not a hole in it.

- [ ] **Step 1: Write the failing test**

Append to `test/bake.test.js`:

```js
import { labelComponents, cullComponents, cullHoles } from '../js/bake.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bake.test.js`
Expected: FAIL — `labelComponents is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/bake.js`:

```js
// Connected components by iterative flood fill. Iterative rather than
// recursive: a full-frame component would blow the call stack.
//
// Foreground uses 8-connectivity and background 4-connectivity. Using the same
// for both produces the classic paradox where a diagonal line simultaneously
// does and does not separate the regions either side of it.
export function labelComponents(mask, w, h, connectivity = 8) {
  const labels = new Int32Array(w * h);
  const sizes = [];
  const stack = [];
  const d8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nbrs = connectivity === 4 ? d8.slice(0, 4) : d8;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = sizes.length + 1;
    let n = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const cur = stack.pop();
      n++;
      const cx = cur % w, cy = (cur - cx) / w;
      for (const [dx, dy] of nbrs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] && !labels[ni]) { labels[ni] = id; stack.push(ni); }
      }
    }
    sizes.push(n);
  }
  return { labels, sizes };
}

// Drop foreground components below minArea cells — the detached specks.
export function cullComponents(mask, w, h, minArea) {
  if (minArea <= 1) return Uint8Array.from(mask);
  const { labels, sizes } = labelComponents(mask, w, h, 8);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = labels[i] && sizes[labels[i] - 1] >= minArea ? 1 : 0;
  }
  return out;
}

// Fill background components below minArea that do NOT touch the border. A
// background region reaching the border is the exterior, not a hole.
export function cullHoles(mask, w, h, minArea) {
  if (minArea <= 1) return Uint8Array.from(mask);
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const { labels, sizes } = labelComponents(inv, w, h, 4);

  const touchesBorder = new Uint8Array(sizes.length + 1);
  for (let x = 0; x < w; x++) {
    if (labels[x]) touchesBorder[labels[x]] = 1;
    const b = (h - 1) * w + x;
    if (labels[b]) touchesBorder[labels[b]] = 1;
  }
  for (let y = 0; y < h; y++) {
    if (labels[y * w]) touchesBorder[labels[y * w]] = 1;
    const r = y * w + w - 1;
    if (labels[r]) touchesBorder[labels[r]] = 1;
  }

  const out = Uint8Array.from(mask);
  for (let i = 0; i < mask.length; i++) {
    const id = labels[i];
    if (id && !touchesBorder[id] && sizes[id - 1] < minArea) out[i] = 1;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bake.test.js`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add js/bake.js test/bake.test.js
git commit -m "feat: connected-component and hole culling"
```

---

### Task 9: The bake orchestrator

**Files:**
- Modify: `js/bake.js`
- Test: `test/bake.test.js`

**Interfaces:**
- Consumes: `close`, `open`, `cullComponents`, `cullHoles`, `signedEdt` (Tasks 6–8); `makeBlobField` (Task 4)
- Produces:
  - `FORMATS = { portrait: 2/3, square: 1, landscape: 3/2 }`
  - `bake(field, { aspect, res, simplify }) → { grid, w, h, aspect, sample(x, y), mask }`
    where `grid` is a `Float64Array` of signed distance **in world units**, `sample` bilinearly interpolates it, and `mask` is the cleaned `Uint8Array`

**Design note:** `res` is the long edge. The spec fixes it at 1024 for export; tests use a smaller value for speed. `sample` must extrapolate sensibly outside the grid — return a large positive number, i.e. "far outside" — so `fieldOutline` never trails off the edge into garbage.

- [ ] **Step 1: Write the failing test**

Append to `test/bake.test.js`:

```js
import { bake, FORMATS } from '../js/bake.js';
import { makeBlobField, defaultControls } from '../js/blobfield.js';

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
```

Add to the imports at the top of `test/bake.test.js`:

```js
import { fieldOutline } from '../js/contour.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bake.test.js`
Expected: FAIL — `bake is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `js/bake.js`:

```js
// Frame ratios (width / height). The frame is x in [-a, a], y in [-1, 1].
export const FORMATS = { portrait: 2 / 3, square: 1, landscape: 3 / 2 };

// Rasterise, clean, and recover a signed field.
//
// `simplify` in [0,1] scales all four cleanup radii together, so one control
// takes the result from "every detail kept" to "macro-forms only".
export function bake(field, { aspect = FORMATS.portrait, res = 1024, simplify = 0.5 } = {}) {
  const h = res, w = Math.round(res * aspect);
  const total = w * h;

  // World units per cell. y spans [-1, 1] over h cells.
  const scale = 2 / h;
  const toWorld = (i, j) => [(-1 + (2 * (i + 0.5)) / w) * aspect, 1 - (2 * (j + 0.5)) / h];

  let mask = new Uint8Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = toWorld(i, j);
      mask[j * w + i] = field(x, y) < 0 ? 1 : 0;
    }
  }

  // Radii in CELLS, derived from `simplify` and scaled by resolution so the
  // result is resolution-independent.
  const closeR = (0.004 + simplify * 0.020) * h;
  const openR = (0.003 + simplify * 0.016) * h;
  const minArea = (0.0004 + simplify * 0.008) * total;
  const minHole = (0.0004 + simplify * 0.010) * total;

  mask = close(mask, w, h, closeR);          // bridge gaps
  mask = cullHoles(mask, w, h, minHole);     // pinholes out
  mask = open(mask, w, h, openR);            // hairline filaments out
  mask = cullComponents(mask, w, h, minArea); // detached specks out
  mask = cullHoles(mask, w, h, minHole);     // opening can open new pinholes

  // Recover a clean signed field, converted from cells back to world units.
  const cells = signedEdt(mask, w, h);
  const grid = new Float64Array(total);
  for (let i = 0; i < total; i++) grid[i] = cells[i] * scale;

  const FAR = 10;
  const sample = (x, y) => {
    // World -> continuous grid coordinates.
    const gi = ((x / aspect + 1) / 2) * w - 0.5;
    const gj = ((1 - y) / 2) * h - 0.5;
    if (gi < 0 || gj < 0 || gi > w - 1 || gj > h - 1) return FAR;
    const i0 = Math.floor(gi), j0 = Math.floor(gj);
    const i1 = Math.min(i0 + 1, w - 1), j1 = Math.min(j0 + 1, h - 1);
    const fx = gi - i0, fy = gj - j0;
    const a = grid[j0 * w + i0], b = grid[j0 * w + i1];
    const c = grid[j1 * w + i0], d = grid[j1 * w + i1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  return { grid, mask, w, h, aspect, sample };
}
```

Note `bake.js` must **not** import from `blobfield.js`. It takes a field function as an argument, which is what keeps the two modules independently testable and lets the same pipeline clean any field.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bake.test.js`
Expected: PASS, 19 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 28 existing + 29 blobfield + 19 bake + 3 png

- [ ] **Step 6: Commit**

```bash
git add js/bake.js test/bake.test.js
git commit -m "feat: bake pipeline with morphological cleanup"
```

---

### Task 10: Audio mapping and control resolution

**Files:**
- Modify: `js/blobfield.js`
- Test: `test/blobfield.test.js`

**Interfaces:**
- Consumes: `defaultControls` (Task 3)
- Produces:
  - `audioTargets(features) → object` — same keys as `defaultControls`, each in [0,1]
  - `resolveControls(sliders, features) → object` — combines the two
  - `seedFor(features, variation) → number`

**Design note:** the combination rule from the spec is `v = clamp01(slider + (audio − 0.5) · depth)`. The slider sets the centre; the sound deviates around it. At every slider position the fingerprint still moves the result, and at no position does the slider discard it.

Feature names match `cymafield.js:142-146`: `pitchNorm`, `rms`, `centroid`, `spread`, `pitchConf`.

- [ ] **Step 1: Write the failing test**

Append to `test/blobfield.test.js`:

```js
import { audioTargets, resolveControls, seedFor } from '../js/blobfield.js';

const feat = (o = {}) => Object.assign(
  { pitchNorm: 0.4, rms: 0.3, centroid: 0.3, spread: 0.3, pitchConf: 0.5 }, o);

test('audioTargets returns every control key in range', () => {
  const t = audioTargets(feat());
  for (const k of Object.keys(defaultControls())) {
    if (k === 'invert') continue;
    assert.ok(k in t, `missing ${k}`);
    assert.ok(t[k] >= 0 && t[k] <= 1, `${k} out of range: ${t[k]}`);
  }
});

test('audioTargets handles missing features without producing NaN', () => {
  const t = audioTargets({});
  for (const [k, v] of Object.entries(t)) assert.ok(Number.isFinite(v), `${k} is ${v}`);
});

test('pitch drives form count', () => {
  assert.ok(audioTargets(feat({ pitchNorm: 0.9 })).formCount >
            audioTargets(feat({ pitchNorm: 0.1 })).formCount);
});

test('spectral spread drives warp and asymmetry', () => {
  const lo = audioTargets(feat({ spread: 0.1 })), hi = audioTargets(feat({ spread: 0.9 }));
  assert.ok(hi.warp > lo.warp);
  assert.ok(hi.symmetry < lo.symmetry, 'noisier input should be less symmetrical');
});

test('the slider sets the centre and sound deviates around it', () => {
  // Two different sounds must give different results at the SAME slider
  // position — otherwise the slider has discarded the fingerprint.
  const a = resolveControls({ formCount: 0.5 }, feat({ pitchNorm: 0.1 }));
  const b = resolveControls({ formCount: 0.5 }, feat({ pitchNorm: 0.9 }));
  assert.notEqual(a.formCount, b.formCount);
  // And the slider must still dominate: both sit near 0.5, not at the extremes.
  assert.ok(Math.abs(a.formCount - 0.5) < 0.3);
  assert.ok(Math.abs(b.formCount - 0.5) < 0.3);
});

test('resolveControls clamps to [0,1]', () => {
  const r = resolveControls({ warp: 1, formCount: 0 }, feat({ spread: 1, pitchNorm: 0 }));
  for (const [k, v] of Object.entries(r)) {
    if (k === 'invert' || k === 'scaleCrop') continue;
    assert.ok(v >= 0 && v <= 1, `${k} = ${v}`);
  }
});

test('seedFor is stable for the same sound and steps with variation', () => {
  assert.equal(seedFor(feat(), 0), seedFor(feat(), 0));
  assert.notEqual(seedFor(feat(), 0), seedFor(feat(), 1));
  assert.notEqual(seedFor(feat(), 0), seedFor(feat({ pitchNorm: 0.8 }), 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobfield.test.js`
Expected: FAIL — `audioTargets is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `js/blobfield.js`:

```js
import { fnv1a } from './hash.js';
```

Append to `js/blobfield.js`:

```js
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// How far the sound may move each control away from its slider position.
// Zero for the three that are pure art direction.
const DEPTH = {
  detail: 0.5, formCount: 0.5, merge: 0.4, simplify: 0,
  symmetry: 0.5, stretch: 0.4, warp: 0.5, scaleCrop: 0.3,
  edgeSoftness: 0, invert: 0,
};

// Sound -> control targets, each in [0,1]. Feature names match cymafield.js.
export function audioTargets(f) {
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const rms = clamp01(f.rms ?? 0);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);

  return {
    detail: centroid,
    formCount: pitch,
    merge: clamp01(Math.min(1, rms * 3.2)),
    simplify: 0.5,
    // Noisy, atonal input reads as less ordered.
    symmetry: clamp01(1 - spread),
    stretch: conf,
    warp: spread,
    scaleCrop: clamp01(Math.min(1, rms * 3.2)),
    edgeSoftness: 0.5,
    invert: 0,
  };
}

// The slider sets the centre; the sound deviates around it by DEPTH.
export function resolveControls(sliders, features) {
  const s = Object.assign(defaultControls(), sliders);
  const a = audioTargets(features ?? {});
  const out = {};
  for (const k of Object.keys(defaultControls())) {
    if (k === 'invert') { out[k] = s[k]; continue; }
    if (k === 'scaleCrop') {
      // scaleCrop is not a 0-1 control; it is a multiplier around 1.
      out[k] = Math.max(0.5, s[k] + (a[k] - 0.5) * DEPTH[k]);
      continue;
    }
    out[k] = clamp01(s[k] + (a[k] - 0.5) * DEPTH[k]);
  }
  return out;
}

// Layout seed: the sound's fingerprint XOR the Variation step. Determinism
// holds — same sound, same settings, same variation, same composition — while
// Variation still offers alternative takes on a recording worth keeping.
export function seedFor(features, variation = 0) {
  const f = features ?? {};
  const key = [f.pitchNorm, f.rms, f.centroid, f.spread, f.pitchConf]
    .map((v) => (typeof v === 'number' ? v.toFixed(3) : '-'))
    .join(',');
  return (fnv1a(key) ^ Math.imul(variation >>> 0, 0x9e3779b1)) >>> 0;
}
```

Move the `import { fnv1a } from './hash.js';` line to the **top** of `js/blobfield.js` with the other imports — ES module imports are hoisted, but keeping it inline is misleading to read.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobfield.test.js`
Expected: PASS, 36 tests

- [ ] **Step 5: Commit**

```bash
git add js/blobfield.js test/blobfield.test.js
git commit -m "feat: audio mapping and control resolution"
```

---

### Task 11: Acceptance renders and postconditions

**Files:**
- Modify: `tools/render.mjs`
- Create: `test/acceptance.test.js`
- Modify: `package.json` (add a `refs` script)

**Interfaces:**
- Consumes: `makeBlobField`, `resolveControls`, `seedFor` (Tasks 4, 10); `bake`, `FORMATS`, `labelComponents` (Tasks 8, 9); `encodePNG`, `renderField` (Task 5)
- Produces: `SCENARIOS` — the three named acceptance configurations

**These tests are guards, not the gate.** A design can satisfy every assertion here and still look nothing like the references. The gate is looking at the PNGs.

- [ ] **Step 1: Write the failing test**

Create `test/acceptance.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, bakeScenario } from '../tools/render.mjs';
import { labelComponents } from '../js/bake.js';

// Several seeds per scenario: a postcondition that holds for one lucky layout
// is not a postcondition.
const SEEDS = [11, 23, 47, 91, 138];

for (const name of Object.keys(SCENARIOS)) {
  test(`${name}: 3-7 macro-forms, no specks, no pinholes`, () => {
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      const total = b.w * b.h;
      const { sizes } = labelComponents(b.mask, b.w, b.h, 8);

      // 3-7 is the spec's acceptance criterion, not a crash guard. If this
      // fails, the scenario values need tuning — which is the work of this
      // task. Do NOT loosen the bound to make it pass.
      assert.ok(sizes.length >= 3 && sizes.length <= 7,
        `${name}/${seed}: ${sizes.length} components`);
      for (const s of sizes) {
        assert.ok(s / total >= 0.002, `${name}/${seed}: speck at ${s / total}`);
      }

      const inv = new Uint8Array(total);
      for (let i = 0; i < total; i++) inv[i] = b.mask[i] ? 0 : 1;
      const bg = labelComponents(inv, b.w, b.h, 4);
      const border = new Set();
      for (let x = 0; x < b.w; x++) {
        border.add(bg.labels[x]);
        border.add(bg.labels[(b.h - 1) * b.w + x]);
      }
      for (let y = 0; y < b.h; y++) {
        border.add(bg.labels[y * b.w]);
        border.add(bg.labels[y * b.w + b.w - 1]);
      }
      bg.sizes.forEach((s, i) => {
        if (border.has(i + 1)) return;
        assert.ok(s / total >= 0.002, `${name}/${seed}: pinhole at ${s / total}`);
      });
    }
  });

  test(`${name}: ink covers a substantial area`, () => {
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      const ink = b.mask.reduce((s, v) => s + v, 0) / (b.w * b.h);
      assert.ok(ink > 0.08 && ink < 0.85, `${name}/${seed}: ink ${ink}`);
    }
  });

  test(`${name}: crops the frame`, () => {
    // The brief's editorial feel depends on forms leaving the frame. Count
    // border cells that are ink.
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      let touching = 0;
      for (let x = 0; x < b.w; x++) {
        if (b.mask[x]) touching++;
        if (b.mask[(b.h - 1) * b.w + x]) touching++;
      }
      for (let y = 0; y < b.h; y++) {
        if (b.mask[y * b.w]) touching++;
        if (b.mask[y * b.w + b.w - 1]) touching++;
      }
      assert.ok(touching > 0, `${name}/${seed}: nothing reaches the frame edge`);
    }
  });

  test(`${name}: no k-fold rotational symmetry`, () => {
    // Pinwheels and rings of similar cells are exactly what the brief rejects.
    // Radial TOPOLOGY is fine — the reference mark is arms around a centre.
    // Radial REGULARITY is not. Compare the mask against itself rotated.
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      for (let k = 3; k <= 8; k++) {
        const diff = rotationDiff(b, (2 * Math.PI) / k);
        assert.ok(diff > 0.06,
          `${name}/${seed}: ${k}-fold symmetric, diff only ${diff.toFixed(4)}`);
      }
    }
  });
}

// Fraction of cells that disagree between the mask and the mask rotated about
// the frame centre by `theta`.
function rotationDiff(b, theta) {
  const cx = (b.w - 1) / 2, cy = (b.h - 1) / 2;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  let differ = 0, counted = 0;
  for (let j = 0; j < b.h; j++) {
    for (let i = 0; i < b.w; i++) {
      const dx = i - cx, dy = j - cy;
      const si = Math.round(cx + dx * cos - dy * sin);
      const sj = Math.round(cy + dx * sin + dy * cos);
      if (si < 0 || sj < 0 || si >= b.w || sj >= b.h) continue;
      counted++;
      if (b.mask[j * b.w + i] !== b.mask[sj * b.w + si]) differ++;
    }
  }
  return counted ? differ / counted : 1;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/acceptance.test.js`
Expected: FAIL — `SCENARIOS is not exported`

- [ ] **Step 3: Write minimal implementation**

Replace the CLI section at the bottom of `tools/render.mjs` with:

```js
// The three acceptance scenarios from the spec.
export const SCENARIOS = {
  // 1. Three or four very large cropped forms with strong negative space.
  large: { formCount: 0.1, stretch: 0.35, merge: 0.30, simplify: 0.75,
           warp: 0.25, symmetry: 0.15, scaleCrop: 1.85, detail: 0 },
  // 2. Five to seven elongated forms with several narrow waists.
  elongated: { formCount: 1.0, stretch: 0.9, merge: 0.55, simplify: 0.5,
               warp: 0.4, symmetry: 0.2, scaleCrop: 1.25, detail: 0 },
  // 3. An intermediate keeping a hint of cymatic structure.
  intermediate: { formCount: 0.6, stretch: 0.6, merge: 0.45, simplify: 0.35,
                  warp: 0.3, symmetry: 0.3, scaleCrop: 1.35, detail: 0.35 },
};

export function bakeScenario(name, seed, res = 256) {
  const controls = Object.assign(defaultControls(), SCENARIOS[name]);
  const { field } = makeBlobField(seed, controls);
  return bake(field, { aspect: FORMATS.portrait, res, simplify: controls.simplify });
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  const outDir = process.argv[2] ?? 'out';
  const seeds = process.argv.slice(3).map(Number);
  const list = seeds.length ? seeds : [11, 23, 47];
  mkdirSync(outDir, { recursive: true });
  for (const name of Object.keys(SCENARIOS)) {
    for (const seed of list) {
      const b = bakeScenario(name, seed, 900);
      const { rgb, width, height } = renderField((x, y) => b.sample(x, y),
        { width: Math.round(900 * FORMATS.portrait), height: 900, aspect: FORMATS.portrait });
      const path = `${outDir}/${name}-${seed}.png`;
      writeFileSync(path, encodePNG(width, height, rgb));
      console.log(path);
    }
  }
}
```

Update the imports at the top of `tools/render.mjs`:

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { makeBlobField, defaultControls } from '../js/blobfield.js';
import { bake, FORMATS } from '../js/bake.js';
```

Add to `package.json` scripts:

```json
"refs": "node tools/render.mjs out 11 23 47"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/acceptance.test.js`
Expected: PASS, 12 tests (4 per scenario)

If the symmetry assertion fails, lower `symmetry` in that scenario. If the crop assertion fails, raise `scaleCrop`. If component count exceeds 7, raise `simplify`.

- [ ] **Step 5: Render the acceptance set and LOOK at it**

Run: `npm run refs`

Open all nine PNGs and compare them against the reference images. Check specifically:

- Waists **pinch inward** on an arc. If they bulge, `unionRound` is wrong.
- Arms are **irregular** in angle, length and terminal radius. Even spacing means `symmetry` is too high.
- Forms **run off the frame edge**, and in `large` the centre is off-frame entirely.
- **No** small internal holes, no detached specks, no hairline filaments.
- Terminal discs read as **discs**, not points — if they are spiky, `stretch` is too high.

Tune the `SCENARIOS` values until they match, re-running `npm run refs` each time. This is the real work of this task; the assertions above only stop obvious regressions.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, all tests including the original 28

- [ ] **Step 7: Commit**

```bash
git add tools/render.mjs test/acceptance.test.js package.json
git commit -m "feat: acceptance scenarios and postcondition tests"
```

---

## Done when

- `npm test` passes, with the original 28 tests untouched
- `npm run refs` writes nine PNGs
- Those PNGs show connected organisms with concave waists, irregular arms, and genuine frame cropping — judged **by eye against the reference images**, not by the assertions

## Next plan

App integration: the GLSL live path for the capsule union, SDF texture upload, the Shape Style slider and the ten controls in the panel, the Format system in `renderer.js` and `app.js`, Solid preview, the `shader.js:79` crispness fix, and wiring `bake` into `export.js`.

Two spec items land there rather than here, because both are driven by the renderer rather than by the field:

- **Emergence.** `grow` drives the iso threshold — `field(x, y) + (1 − grow) · reach` — so each form blooms from its own core instead of being wiped in radially from the centre. A radial wipe would re-impose exactly the centring the simplified style exists to escape.
- **Dropping the two radial crops.** `cymafield.js:114` and `cymafield.js:125` must not apply to the simplified path. Nothing in this plan introduces them, so this is a matter of the shader taking the blob branch before either is evaluated.
