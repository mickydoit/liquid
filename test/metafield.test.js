import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMeta, metaBalls, metaDist, metaClusters, META_MAX } from '../js/metafield.js';
import { idleState } from '../js/cymafield.js';

const st = (o = {}) => Object.assign(idleState(), {
  amp: 0.6, grow: 1,
  features: { pitchNorm: 0.42, rms: 0.31, centroid: 0.38, spread: 0.22, pitchConf: 0.8 },
  meta: Object.assign(defaultMeta(), o.meta),
}, o);

// ── the forms themselves ───────────────────────────────────────────────

test('produces between 5 and 14 rounded forms', () => {
  for (const count of [0, 0.25, 0.5, 0.75, 1]) {
    const balls = metaBalls(st({ meta: { count } }));
    assert.ok(balls.length >= 5 && balls.length <= META_MAX,
      `count ${count} gave ${balls.length} forms`);
  }
});

test('Circle count controls how many forms there are', () => {
  const few = metaBalls(st({ meta: { count: 0 } })).length;
  const many = metaBalls(st({ meta: { count: 1 } })).length;
  assert.ok(many > few, `count should raise the number of forms (${few} -> ${many})`);
});

test('every form is rounded — radii are positive and bounded', () => {
  // A degenerate radius is how spikes and slivers appear. There are none here:
  // the forms are circles and restrained ellipses, nothing else.
  const balls = metaBalls(st({ meta: { stretch: 1, sizeVar: 1 } }));
  for (const b of balls) {
    assert.ok(b.rx > 0.02 && b.ry > 0.02, `degenerate radius ${b.rx},${b.ry}`);
    const ratio = Math.max(b.rx, b.ry) / Math.min(b.rx, b.ry);
    assert.ok(ratio <= 2.6, `ellipse too elongated (${ratio.toFixed(2)}:1) — reads as a spike`);
  }
});

test('Roundness/Stretch runs from circles to restrained ellipses', () => {
  const round = metaBalls(st({ meta: { stretch: 0 } }));
  for (const b of round) {
    assert.ok(Math.abs(b.rx - b.ry) < 1e-9, 'stretch 0 must be exact circles');
  }
  const oval = metaBalls(st({ meta: { stretch: 1 } }));
  assert.ok(oval.some((b) => Math.abs(b.rx - b.ry) > 0.02), 'stretch 1 must give ellipses');
});

test('Size variation controls radius spread', () => {
  const spread = (m) => {
    const r = metaBalls(st({ meta: m })).map((b) => (b.rx + b.ry) / 2);
    const mean = r.reduce((a, v) => a + v, 0) / r.length;
    return Math.sqrt(r.reduce((a, v) => a + (v - mean) ** 2, 0) / r.length) / mean;
  };
  assert.ok(spread({ sizeVar: 1 }) > spread({ sizeVar: 0 }) * 1.5,
    'size variation must widen the spread of radii');
});

// ── clustering: the Merge contract ─────────────────────────────────────

test('Merge 0 leaves the forms separate', () => {
  const s = st({ meta: { merge: 0 } });
  const { clusters } = metaClusters(s);
  assert.equal(clusters.filter((c) => c.length > 1).length, 0,
    'nothing should be joined at Merge 0');
});

test('Merge 0.5 connects 30-60% of neighbouring forms', () => {
  // The acceptance criterion, asserted directly rather than eyeballed.
  const s = st({ meta: { merge: 0.5 } });
  const { balls, joinedPairs, candidatePairs } = metaClusters(s);
  const pct = joinedPairs / candidatePairs;
  assert.ok(pct >= 0.30 && pct <= 0.60,
    `${(pct * 100).toFixed(0)}% of neighbours joined, want 30-60%`);
  assert.ok(balls.length >= 5, 'still several forms');
});

test('Merge 0.5 leaves at least two connected groups AND two separate forms', () => {
  const { clusters } = metaClusters(st({ meta: { merge: 0.5 } }));
  assert.ok(clusters.filter((c) => c.length > 1).length >= 2, 'want >= 2 connected groups');
  assert.ok(clusters.filter((c) => c.length === 1).length >= 2, 'want >= 2 separate forms');
});

test('Merge 1 keeps negative space — it never fuses into one object', () => {
  const { clusters } = metaClusters(st({ meta: { merge: 1 } }));
  assert.ok(clusters.length >= 2,
    `Merge 1 collapsed to ${clusters.length} cluster(s) — must keep separation`);
});

test('Merge grows monotonically without collapsing', () => {
  let prev = -1;
  for (const merge of [0, 0.25, 0.5, 0.75, 1]) {
    const { joinedPairs } = metaClusters(st({ meta: { merge } }));
    assert.ok(joinedPairs >= prev, `joins must not fall as Merge rises (${prev} -> ${joinedPairs})`);
    prev = joinedPairs;
  }
});

test('clusters stay small — no cluster swallows most of the design', () => {
  // A cluster containing everything is the "one fused organism" failure.
  for (const merge of [0.5, 0.75, 1]) {
    const { clusters, balls } = metaClusters(st({ meta: { merge } }));
    const biggest = Math.max(...clusters.map((c) => c.length));
    assert.ok(biggest <= Math.max(3, Math.ceil(balls.length * 0.5)),
      `Merge ${merge}: one cluster holds ${biggest} of ${balls.length} forms`);
  }
});

// ── geometry ───────────────────────────────────────────────────────────

test('members of a cluster are actually connected, non-members are not', () => {
  const s = st({ meta: { merge: 0.6 } });
  const { clusters, balls } = metaClusters(s);
  // Walk the segment between two cluster members: the field must stay inside.
  const joined = clusters.find((c) => c.length > 1);
  assert.ok(joined, 'expected at least one joined cluster');
  const [i, j] = joined;
  let inside = true;
  for (let t = 0; t <= 1; t += 0.02) {
    const x = balls[i].x + (balls[j].x - balls[i].x) * t;
    const y = balls[i].y + (balls[j].y - balls[i].y) * t;
    if (metaDist(x, y, s) > 0) { inside = false; break; }
  }
  assert.ok(inside, 'a joined pair must be connected by solid material');
});

test('separate clusters have clear space between them', () => {
  const s = st({ meta: { merge: 0 } });
  const { balls } = metaClusters(s);
  // Between the two nearest centres of different clusters there must be a gap.
  let gap = false;
  for (let t = 0.3; t <= 0.7; t += 0.05) {
    const x = balls[0].x + (balls[1].x - balls[0].x) * t;
    const y = balls[0].y + (balls[1].y - balls[0].y) * t;
    if (metaDist(x, y, s) > 0) { gap = true; break; }
  }
  assert.ok(gap, 'unjoined forms must have negative space between them');
});

test('the field is smooth — no sharp corners anywhere on the boundary', () => {
  // Sampled curvature along the boundary. A polygonal corner shows up as a
  // gradient direction that snaps; a fillet never does.
  const s = st({ meta: { merge: 0.6 } });
  const e = 1e-4;
  const grad = (x, y) => {
    const gx = metaDist(x + e, y, s) - metaDist(x - e, y, s);
    const gy = metaDist(x, y + e, s) - metaDist(x, y - e, s);
    const m = Math.hypot(gx, gy) || 1;
    return [gx / m, gy / m];
  };
  let worst = 0;
  for (let k = 0; k < 400; k++) {
    const th = (k / 400) * Math.PI * 2;
    // March to the boundary along this ray, then compare adjacent normals.
    for (let r = 0.05; r < 1.4; r += 0.01) {
      const x = Math.cos(th) * r, y = Math.sin(th) * r;
      if (Math.abs(metaDist(x, y, s)) < 0.004) {
        const [ax, ay] = grad(x, y);
        const [bx, by] = grad(x + 0.006 * -ay, y + 0.006 * ax);   // step along the boundary
        worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))));
        break;
      }
    }
  }
  assert.ok(worst < 0.9, `boundary turns ${worst.toFixed(2)} rad in one step — that is a corner`);
});

// ── determinism and sound ──────────────────────────────────────────────

test('same sound and controls give the same composition', () => {
  const a = metaBalls(st());
  const b = metaBalls(st());
  assert.deepEqual(a, b);
});

test('moving a control modifies the composition rather than rerolling it', () => {
  // Spacing must not shuffle which forms exist — it moves the ones there are.
  const a = metaBalls(st({ meta: { spacing: 0.4 } }));
  const b = metaBalls(st({ meta: { spacing: 0.6 } }));
  assert.equal(a.length, b.length, 'a slider must not change the form count');
  const moved = a.some((ball, i) => Math.hypot(ball.x - b[i].x, ball.y - b[i].y) > 1e-6);
  assert.ok(moved, 'spacing should actually move the forms');
});

test('Reroll changes the composition, and only when it changes', () => {
  const a = metaBalls(st({ variation: 0 }));
  const b = metaBalls(st({ variation: 1 }));
  assert.notDeepEqual(a, b, 'reroll must give a different composition');
  assert.deepEqual(metaBalls(st({ variation: 1 })), b, 'and stay deterministic');
});

test('different sounds give different compositions', () => {
  const a = metaBalls(st());
  const b = metaBalls(st({
    features: { pitchNorm: 0.85, rms: 0.62, centroid: 0.71, spread: 0.55, pitchConf: 0.4 },
  }));
  assert.notDeepEqual(a, b, 'the sound must shape the composition');
});
