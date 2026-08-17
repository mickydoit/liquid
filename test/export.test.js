import test from 'node:test';
import assert from 'node:assert/strict';
import { idleState, targetFromFeatures, makeWaterField } from '../js/cymafield.js';
import { fieldOutline, ringToPath, closedCatmullRom, marchingSquares } from '../js/contour.js';
import { buildSVG } from '../js/export.js';

const formed = (o = {}) => {
  const s = Object.assign(idleState(),
    targetFromFeatures({ pitchNorm: 0.3, rms: 0.35, centroid: 0.35, spread: 0.12, pitchConf: 0.95 }));
  s.amp = 0.75;
  s.grow = 1;            // a fully emerged design
  return Object.assign(s, o);
};

test('the outline is CONNECTED paths, not isolated round pools', () => {
  // The failure this whole design replaced: separate near-circular blobs. A
  // nodal figure is long connected curves, so its rings must be far longer
  // relative to the area they enclose than a circle's would be.
  const { rings } = fieldOutline(makeWaterField(formed({ m: 5, n: 3, mix: 0.15 })),
    { width: 1200, height: 1200, res: 420 });
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
    worst = Math.max(worst, per / (2 * Math.sqrt(Math.PI * area)));  // 1.0 = circle
  }
  assert.ok(worst > 1.8, `largest pool is too circular (isoperimetric ratio ${worst.toFixed(2)})`);
});

test('every exported vertex is finite and inside the frame', () => {
  const { rings } = fieldOutline(makeWaterField(formed()), { width: 1600, height: 1200 });
  assert.ok(rings.length > 0);
  for (const ring of rings) {
    for (const [x, y] of ring) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), 'non-finite vertex');
      assert.ok(x >= 0 && x <= 1600 && y >= 0 && y <= 1200, `outside frame: ${x},${y}`);
    }
  }
});

test('flat SVG is ONE even-odd path so enclosed voids punch through', () => {
  // fill-rule is per-path: separate <path> elements would each fill
  // independently and the voids inside the figure would come out solid.
  const svg = buildSVG({ state: formed(), width: 1200, height: 900,
                         ink: '#101418', background: '#aeb8bf', variant: 'flat' });
  assert.equal((svg.match(/<path/g) || []).length, 1, 'flat fill must be a single path');
  assert.ok(/fill-rule="evenodd"/.test(svg));
  assert.ok((svg.match(/M/g) || []).length > 1, 'expected several subpaths');
  assert.ok(!/NaN|Infinity/.test(svg), 'non-finite values in path data');
});

test('outline SVG strokes each ring separately and fills nothing', () => {
  const svg = buildSVG({ state: formed(), width: 1200, height: 900,
                         ink: '#101418', background: null, variant: 'outline' });
  assert.ok(/<g id="outline" fill="none"/.test(svg));
  assert.ok((svg.match(/<path/g) || []).length > 1, 'outline should keep rings separate');
  assert.ok(!/<rect id="background"/.test(svg), 'null background must omit the rect');
});

test('SVG is deterministic for the same state', () => {
  const s = formed();
  assert.equal(buildSVG({ state: s, width: 800, height: 600, ink: '#000', background: '#fff' }),
               buildSVG({ state: s, width: 800, height: 600, ink: '#000', background: '#fff' }));
});

test('ringToPath closes every ring', () => {
  const d = ringToPath([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.ok(d.startsWith('M') && d.endsWith('Z'));
});

test('closedCatmullRom is periodic — a segment closes the ring', () => {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const segs = closedCatmullRom(pts);
  assert.equal(segs.length, pts.length);
  assert.deepEqual(segs[segs.length - 1].end, pts[0]);
});

test('an idle (ungrown) field contours to nothing without throwing', () => {
  // At rest the canvas is empty, so there is genuinely no outline to trace.
  // Exporting in that state must be a no-op, not a crash.
  const rings = marchingSquares(makeWaterField(idleState()),
    { x0: -1.35, y0: -1.35, x1: 1.35, y1: 1.35 }, 200);
  assert.ok(Array.isArray(rings));
  assert.equal(rings.length, 0, 'an empty canvas should trace no rings');
});

// ── the organism ───────────────────────────────────────────────────────
test('an organism design exports a real outline, not a stub', () => {
  const DISC = { sample: (x, y) => Math.hypot(x, y) - 0.5 };
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, grow: 1, organism: DISC });
  const svg = buildSVG({ state: s, width: 400, height: 600, ink: '#fff', variant: 'flat' });
  assert.match(svg, /<path id="water"/);
  // A disc traced at 400x600 is hundreds of points, not a couple of moves.
  assert.ok(svg.length > 1000, `expected a real outline, got ${svg.length} bytes`);
});

// ── Cymatic Join ────────────────────────────────────────────────────────
const islands = (join) => ({
  ...idleState(), m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1, join,
});
const subpaths = (svg) => (svg.match(/M/g) ?? []).length;

test('Join 0 exports exactly what an absent Join does', () => {
  const withZero = buildSVG({ state: islands(0), width: 900, height: 1350, ink: '#111' });
  const noKey = { ...islands(0) };
  delete noKey.join;
  const without = buildSVG({ state: noKey, width: 900, height: 1350, ink: '#111' });
  assert.equal(withZero, without, 'an absent join and join 0 must agree');
});

test('joining merges rings, so the export has fewer subpaths', () => {
  const open = buildSVG({ state: islands(0), width: 900, height: 1350, ink: '#111' });
  const shut = buildSVG({ state: islands(0.8), width: 900, height: 1350, ink: '#111' });
  assert.ok(subpaths(shut) < subpaths(open),
    `joined ${subpaths(shut)} not fewer than unjoined ${subpaths(open)}`);
});

// Format must reframe the same cymatic event, never change which cells connect.
// The bake is keyed to a canonical window for exactly this reason.
test('portrait and landscape exports share one topology', () => {
  const p = buildSVG({ state: islands(0.6), width: 900, height: 1350, ink: '#111' });
  const l = buildSVG({ state: islands(0.6), width: 1350, height: 900, ink: '#111' });
  assert.equal(subpaths(p), subpaths(l),
    `portrait ${subpaths(p)} subpaths vs landscape ${subpaths(l)}`);
});
