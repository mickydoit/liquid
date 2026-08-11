import test from 'node:test';
import assert from 'node:assert/strict';
import { sdTaperedCapsule, unionRound, makeRng, warp, warpParams } from '../js/blobfield.js';
import { fnv1a } from '../js/hash.js';

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
