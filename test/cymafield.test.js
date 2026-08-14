import test from 'node:test';
import assert from 'node:assert/strict';
import { idleState, psi, nodalThickness, thickness, reveal, stepGrow, GROW_SEC,
         targetFromFeatures, glide, advance, kick, makeWaterField } from '../js/cymafield.js';
import { marchingSquares, fieldOutline } from '../js/contour.js';

const grid = (fn, n = 90, span = 1.15) => {
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -span + (2 * span * i) / (n - 1);
      const y = -span + (2 * span * j) / (n - 1);
      out.push({ x, y, v: fn(x, y) });
    }
  }
  return out;
};

const loud = (o = {}) => Object.assign(idleState(), { amp: 0.8, grow: 1 }, o);

test('psi is finite everywhere, including the origin', () => {
  // atan2(0,0) and the 1/sqrt radial term both live at r = 0.
  const s = loud();
  for (const { v } of grid((x, y) => psi(x, y, s), 60)) {
    assert.ok(Number.isFinite(v), 'non-finite psi');
  }
  assert.ok(Number.isFinite(psi(0, 0, s)));
});

test('water gathers on the NODAL lines, not the antinodes', () => {
  // This is the whole physical premise: liquid is driven off high-amplitude
  // regions and collects where the plate is still. If it ever inverts, the
  // figure becomes the negative of a Chladni pattern.
  const s = loud();
  let onNode = 0, offNode = 0, nodeN = 0, offN = 0;
  for (const { x, y } of grid(() => 0, 70)) {
    if (Math.hypot(x, y) > 0.95) continue;
    const f = Math.abs(psi(x, y, s));
    const T = nodalThickness(x, y, s);
    if (f < 0.05) { onNode += T; nodeN++; } else if (f > 0.5) { offNode += T; offN++; }
  }
  assert.ok(nodeN > 20 && offN > 20, 'sampling did not find both regions');
  assert.ok(onNode / nodeN > 0.7, `water should stand on nodes (${onNode / nodeN})`);
  assert.ok(offNode / offN < 0.1, `antinodes should be dry (${offNode / offN})`);
});

test('the figure is CONNECTED paths, not isolated round pools', () => {
  // The failure being fixed: a handful of separate near-circular blobs. A
  // nodal figure is long connected curves, so its contour rings must be far
  // longer relative to the area they enclose than a circle's would be.
  const s = loud({ m: 5, n: 3, mix: 0.15 });
  const { rings } = fieldOutline(makeWaterField(s), { width: 1200, height: 1200, res: 420 });
  assert.ok(rings.length > 0, 'no contour at all');

  let worst = 0;
  for (const r of rings) {
    if (r.length < 12) continue;
    let per = 0, area = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
      area += a[0] * b[1] - b[0] * a[1];
    }
    area = Math.abs(area) / 2;
    if (area < 400) continue;
    // 1.0 for a perfect circle; higher means longer, more sinuous boundary.
    worst = Math.max(worst, per / (2 * Math.sqrt(Math.PI * area)));
  }
  assert.ok(worst > 1.8, `largest pool is too circular (isoperimetric ratio ${worst.toFixed(2)})`);
});

test('pitch changes the TOPOLOGY, not just a size or a colour', () => {
  // Acceptance criterion: "frequency changes alter the topology". Count the
  // separate contour rings — a different modal order gives a different number
  // of nodal cells, which a mere scale change never would.
  const at = (pitchNorm) => {
    const s = Object.assign(idleState(),
      targetFromFeatures({ pitchNorm, rms: 0.3, centroid: 0.4, spread: 0.15, pitchConf: 0.9 }));
    s.amp = 0.7; s.grow = 1;
    return marchingSquares(makeWaterField(s), { x0: -1.2, y0: -1.2, x1: 1.2, y1: 1.2 }, 300).length;
  };
  const lowN = at(0.12), highN = at(0.85);
  assert.ok(highN > lowN + 2,
    `higher pitch must give finer nodal structure (low ${lowN} vs high ${highN})`);
});

test('amplitude controls how much water is gathered into the figure', () => {
  const area = (amp) => {
    const s = Object.assign(idleState(), { m: 4, n: 3, amp, grow: 1 });
    let a = 0;
    for (const { x, y } of grid(() => 0, 80)) {
      if (Math.hypot(x, y) < 0.95) a += nodalThickness(x, y, s);
    }
    return a;
  };
  const quiet = area(0.05), mid = area(0.4), full = area(0.95);
  assert.ok(mid > quiet * 1.5, `amplitude must widen the figure (${quiet} -> ${mid})`);
  assert.ok(full > mid, `and keep widening (${mid} -> ${full})`);
});



test('a transient adds an outward ripple that decays', () => {
  const s = loud();
  const before = psi(0.5, 0, s);
  kick(s, 1);
  assert.ok(s.ripAmt > 0);
  const during = psi(0.5, 0, s);
  assert.notEqual(before, during, 'a transient must disturb the surface');
  for (let i = 0; i < 100; i++) advance(s, 0.05);
  assert.ok(s.ripAmt < 0.01, `ripple must decay (${s.ripAmt})`);
});

test('glide morphs continuously — no snap between figures', () => {
  const s = idleState();
  const target = targetFromFeatures({ pitchNorm: 0.9, rms: 0.5, centroid: 0.8, spread: 0.2, pitchConf: 0.9 });
  let prev = { ...s }, maxStep = 0;
  // 2.5s at tau=0.5 is ~99% of the way; 1s would only be 86% and the
  // "arrived" assertion would be measuring the tolerance, not the glide.
  for (let i = 0; i < 150; i++) {
    glide(s, target, 1 / 60, 0.5);
    maxStep = Math.max(maxStep, Math.abs(s.m - prev.m), Math.abs(s.kr - prev.kr));
    prev = { ...s };
  }
  assert.ok(maxStep < 0.6, `parameters jumped by ${maxStep} in one frame`);
  assert.ok(Math.abs(s.m - target.m) < 0.5, 'glide never arrived');
});

test('field parameters stay finite under sustained glide from any features', () => {
  const s = idleState();
  for (const pitchNorm of [0, 0.5, 1]) {
    for (const rms of [0, 1]) {
      for (const spread of [0, 1]) {
        const t = targetFromFeatures({ pitchNorm, rms, centroid: 0.5, spread, pitchConf: 0.2 });
        for (let i = 0; i < 40; i++) { glide(s, t, 1 / 60); advance(s, 1 / 60); }
        for (const k of ['m', 'n', 'kr', 'ma', 'mix', 'amp', 'fine', 'chaos']) {
          assert.ok(Number.isFinite(s[k]), `${k} went non-finite`);
        }
        assert.ok(s.mix >= 0 && s.mix <= 1, `mix out of range: ${s.mix}`);
      }
    }
  }
});

// ── emergence ──────────────────────────────────────────────────────────
test('at rest the canvas is EMPTY — no droplets, no partial figure', () => {
  // The resting state used to be a scatter of droplets, which read as an
  // unrelated layer sitting over the figure rather than as part of it.
  const s = idleState();
  assert.equal(s.grow, 0);
  let total = 0;
  for (let y = -1.2; y <= 1.2; y += 0.05) {
    for (let x = -1.2; x <= 1.2; x += 0.05) total += thickness(x, y, s);
  }
  assert.ok(total < 0.5, `resting canvas should be empty, got ${total.toFixed(2)}`);
});

test('a design floods outward from the centre rather than appearing whole', () => {
  const s = Object.assign(idleState(), { amp: 0.8, growTarget: 1 });
  const covered = () => {
    let n = 0;
    for (let y = -1.2; y <= 1.2; y += 0.05) {
      for (let x = -1.2; x <= 1.2; x += 0.05) if (thickness(x, y, s) > 0.5) n++;
    }
    return n;
  };
  const start = covered();
  assert.equal(start, 0, 'nothing should be visible before it grows');

  for (let i = 0; i < 30; i++) stepGrow(s, GROW_SEC / 60);
  assert.ok(s.grow > 0.4 && s.grow < 0.6, `half-way grow was ${s.grow}`);
  assert.ok(reveal(0, 0, s) > 0.9, 'centre should be flooded by half-way');
  assert.ok(reveal(1.15, 0, s) < 0.1, 'the rim should not be flooded yet');
  const mid = covered();

  for (let i = 0; i < 60; i++) stepGrow(s, GROW_SEC / 60);
  assert.equal(s.grow, 1);
  assert.ok(covered() > mid, `coverage must keep increasing (${mid} -> ${covered()})`);
});

test('grow settles exactly at its target, and drains back when it returns to 0', () => {
  const s = Object.assign(idleState(), { amp: 0.8, growTarget: 1 });
  for (let i = 0; i < 200; i++) stepGrow(s, 0.05);
  assert.equal(s.grow, 1, 'grow must settle exactly, not overshoot');
  s.growTarget = 0;
  for (let i = 0; i < 200; i++) stepGrow(s, 0.05);
  assert.equal(s.grow, 0, 'Clear must drain the figure back out');
});

// ── blob distance, split from its threshold ────────────────────────────
import { blobDist, blobThickness } from '../js/cymafield.js';

test('blobDist is negative inside a lobe and positive far outside', () => {
  const s = Object.assign(idleState(), { form: 1, amp: 0.5 });
  // The centre lobe always exists, so the origin is inside.
  assert.ok(blobDist(0, 0, s) < 0, 'origin should be inside');
  assert.ok(blobDist(3, 3, s) > 0, 'far corner should be outside');
});

test('blobThickness still agrees with the sign of blobDist', () => {
  const s = Object.assign(idleState(), { form: 1, amp: 0.5 });
  for (const [x, y] of [[0, 0], [0.5, 0.2], [1.5, 1.5], [-0.3, 0.7]]) {
    const d = blobDist(x, y, s);
    const T = blobThickness(x, y, s);
    if (d < -0.02) assert.equal(T, 1, `deep inside at ${x},${y}`);
    if (d > 0.02) assert.equal(T, 0, `well outside at ${x},${y}`);
  }
});

// ── the Form ramp, hinged at 0.5 ───────────────────────────────────────

// A stand-in organism: a disc of radius 0.5 at the origin, as a signed
// distance. A known analytic shape keeps these tests about the RAMP rather
// than about whatever blobfield happens to draw for a given seed.
const DISC = { sample: (x, y) => Math.hypot(x, y) - 0.5 };

test('Form 1.0 is the pure organism, not the blob', () => {
  // Compared against the disc across a grid rather than at a couple of points:
  // the blob happens to agree with the disc at the origin, so a spot check
  // passes whether or not the organism is actually being used.
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, organism: DISC });
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const x = -1 + (2 * i) / 20, y = -1 + (2 * j) / 20;
      const d = DISC.sample(x, y);
      if (Math.abs(d) < 0.02) continue;          // skip the edge band
      assert.equal(nodalThickness(x, y, s), d < 0 ? 1 : 0, `at ${x},${y}`);
    }
  }
});

test('the ramp is continuous across the 0.5 hinge', () => {
  const at = (form) => {
    const s = Object.assign(idleState(), { form, amp: 0.5, organism: DISC });
    return nodalThickness(0.35, 0.1, s);
  };
  assert.ok(Math.abs(at(0.499) - at(0.501)) < 0.05, 'no jump at the hinge');
});

test('the upper half stays crisp', () => {
  // The regression test for the mid-Form blur. Walk x across the disc edge and
  // count samples that are neither fully in nor fully out. A distance-space
  // blend keeps that band a few samples wide; a mask blend smears it.
  for (const form of [0.6, 0.75, 0.9, 1.0]) {
    const s = Object.assign(idleState(), { form, amp: 0.5, organism: DISC });
    let soft = 0;
    for (let i = 0; i <= 400; i++) {
      const T = nodalThickness(-1 + (2 * i) / 400, 0, s);
      if (T > 0.01 && T < 0.99) soft++;
    }
    assert.ok(soft <= 12, `Form ${form} had ${soft} soft samples, expected <= 12`);
  }
});

test('without an organism the ramp falls back to the blob', () => {
  // Before the first bake lands there is no organism; the design must hold the
  // blob rather than vanish.
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, organism: null });
  assert.ok(nodalThickness(0, 0, s) > 0, 'still draws something');
});
