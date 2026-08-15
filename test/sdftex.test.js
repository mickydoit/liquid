import test from 'node:test';
import assert from 'node:assert/strict';
import { packSDF, unpackDistance, RANGE } from '../js/sdftex.js';

const roundTrip = (d) => {
  const px = packSDF(Float64Array.from([d]), 1, 1);
  return unpackDistance(px[0], px[1]);
};

test('packing round-trips within 1/8000 of a world unit', () => {
  for (const d of [-2, -1.5, -0.5, -0.01, 0, 0.01, 0.5, 1.5, 2]) {
    assert.ok(Math.abs(roundTrip(d) - d) < 1 / 8000, `d=${d} -> ${roundTrip(d)}`);
  }
});

test('the zero crossing survives packing', () => {
  // The threshold sits at exactly 0, so a sign flip here would move every edge
  // in the design.
  assert.ok(roundTrip(-0.001) < 0);
  assert.ok(roundTrip(0.001) > 0);
});

test('distances beyond RANGE clamp instead of wrapping', () => {
  // Wrapping would turn far-outside points into inside ones, punching holes
  // through the middle of the design.
  assert.ok(roundTrip(50) > 0);
  assert.ok(Math.abs(roundTrip(50) - RANGE) < 0.01);
  assert.ok(roundTrip(-50) < 0);
  assert.ok(Math.abs(roundTrip(-50) + RANGE) < 0.01);
});

test('packSDF fills all four channels for every cell', () => {
  const px = packSDF(Float64Array.from([0.1, -0.1, 0.3, -0.3]), 2, 2);
  assert.equal(px.length, 16);
  for (let i = 0; i < 4; i++) assert.equal(px[i * 4 + 3], 255, 'alpha must be opaque');
});
