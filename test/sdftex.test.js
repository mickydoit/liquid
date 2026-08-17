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

// ── the CPU/GLSL mirror ─────────────────────────────────────────────────
//
// The pack format is one thing split across two languages: js/sdftex.js writes
// it and the GLSL in js/shader.js reads it. If they drift, the screen stops
// matching the vector export — the exact failure the project's mirror warnings
// exist to prevent.
import { FRAG } from '../js/shader.js';

test('the GLSL decode mirrors unpackDistance numerically', () => {
  // texture2D hands GLSL each byte already divided by 255.
  const glslDecode = (r, g) => (r / 255 + (g / 255) / 255) * 2 * RANGE - RANGE;
  for (const d of [-2, -0.7, -0.02, 0, 0.02, 0.7, 2]) {
    const px = packSDF(Float64Array.from([d]), 1, 1);
    assert.ok(Math.abs(glslDecode(px[0], px[1]) - unpackDistance(px[0], px[1])) < 1e-12,
      `GLSL and JS disagree at d=${d}`);
  }
});

test('the shader carries the decode and the range it was written against', () => {
  assert.match(FRAG, /\(t\.r \+ t\.g \/ 255\.0\) \* 2\.0 \* JOIN_RANGE - JOIN_RANGE/,
    'the GLSL decode expression changed — re-check it against unpackDistance');
  assert.match(FRAG, new RegExp(`const float JOIN_RANGE = ${RANGE.toFixed(1)}`),
    `JOIN_RANGE in the shader must equal RANGE (${RANGE}) in js/sdftex.js`);
});

test('the joined coverage crosses WATER_EDGE at the surface', () => {
  // The flat view thresholds at 0.08 and the exporter contours there, so the
  // joined path must hand back 0.08 exactly at distance 0 or the screen and the
  // SVG cut at different places.
  assert.match(FRAG, /return 0\.08 \+ 0\.92 \* clamp\(-d \/ 0\.06, 0\.0, 1\.0\)/);
  assert.match(FRAG, /return 0\.08 \* \(1\.0 - clamp\(d \/ edge, 0\.0, 1\.0\)\)/);
});
