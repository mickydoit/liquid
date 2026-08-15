// Metaball Cymatic — a few large liquid forms, some joined, some separate.
//
// The cymatic field places MACRO-CLUSTER centres, not individual primitives.
// Sampling one antinode per circle is what produced bead chains: a modal
// lattice is regularly spaced, so nearest-neighbour joining over it can only
// ever thread the points into necklaces. Here the field decides where three to
// seven COMPOSITIONAL masses sit, and each mass is then built from one to three
// large primitives arranged compactly around its own centre.
//
// Merge changes NECK GEOMETRY, never membership. Cluster membership is fixed by
// the seed and Circle count, so raising Merge widens the waists that exist
// instead of growing longer chains.
//
// The union is a blend of two operators, chosen by Merge:
//   fillet — a concave tangent arc, the narrow hourglass waist
//   smin   — a convex bulge, a broad flowing union
// Fillet alone exaggerates the pinch and reads as peanuts; smin alone loses the
// lobes to soap bubbles. The blend keeps lobes legible while letting the
// transition broaden.
import { psi } from './cymafield.js?v=e10531ff';
import { unionRound, makeRng } from './blobfield.js?v=e10531ff';
import { fnv1a } from './hash.js?v=e10531ff';

export const META_MAX = 14;
export const META_CLUSTER_MAX = 8;

export function defaultMeta() {
  return {
    count: 0.5,      // primitive count, ~6 -> ~12
    order: 0.4,      // complexity of the scaffold placing the macro clusters
    merge: 0.5,      // neck width: narrow hourglass -> broad flowing union
    spacing: 0.5,    // distance between cluster centres
    sizeVar: 0.55,   // consistent masses -> one dominant, several small
    stretch: 0.3,    // circles -> capsules and teardrops
    symmetry: 0.45,  // ordered cymatic balance -> controlled asymmetry
    scaleCrop: 1.0,  // a true zoom of the finished artwork
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Fraction of the frame the composition's bounding box should span. The old
// generator drifted to whatever the scaffold happened to give, which was a
// small cluster of dots in the middle of a large empty canvas.
const TARGET_COVER = 0.86;

function resolved(s) {
  const m = Object.assign(defaultMeta(), s.meta);
  const f = s.features ?? {};
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const rms = clamp01(f.rms ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);
  return {
    count: clamp01(m.count + (centroid - 0.5) * 0.25),
    order: clamp01(m.order + (centroid - 0.5) * 0.35),
    merge: clamp01(m.merge),
    spacing: clamp01(m.spacing),
    sizeVar: clamp01(m.sizeVar + (spread - 0.5) * 0.35),
    stretch: clamp01(m.stretch),
    symmetry: clamp01(m.symmetry + (conf - 0.5) * 0.35),
    scaleCrop: Math.max(0.3, m.scaleCrop),
    mass: lerp(0.9, 1.15, rms),
    pitch,
    // The canvas is a rectangle and the artwork should use it. Without this the
    // composition is laid out in a square and sits inside an invisible plate.
    aspect: s.aspect && s.aspect > 0 ? s.aspect : 0.78,
  };
}

// The scaffold. Deliberately square-plate dominant: the radial membrane term
// arranges its antinodes in concentric rings, which is exactly the "obvious
// radial wheel" this composition must not read as.
function scaffoldState(c) {
  return {
    m: lerp(1.5, 3.6, c.order) + c.pitch * 1.2,
    n: lerp(1.1, 2.9, c.order) + c.pitch * 0.7,
    kr: lerp(1.8, 4.0, c.order),
    ma: lerp(0.9, 2.6, c.order),
    mix: lerp(0.05, 0.34, c.pitch),
    amp: 0.5, fine: 0, chaos: 0, phase: 0, simple: 0,
    ripAmt: 0, ripT: 9, t: 0,
  };
}

export function metaSeed(s) {
  const f = s.features ?? {};
  const key = [f.pitchNorm, f.rms, f.centroid, f.spread, f.pitchConf]
    .map((v) => (typeof v === 'number' ? v.toFixed(3) : '-'))
    .join(',');
  return (fnv1a(key) ^ Math.imul((s.variation ?? 0) >>> 0, 0x9e3779b1)) >>> 0;
}

// Macro-cluster centres: local maxima of |psi| over a RECTANGULAR domain
// matching the canvas, so the composition spans the frame it will be seen in.
function clusterCentres(c, want) {
  const sc = scaffoldState(c);
  const N = 40;
  const ax = c.aspect >= 1 ? 1.2 : 1.2 * c.aspect;
  const ay = c.aspect >= 1 ? 1.2 / c.aspect : 1.2;
  const at = (i, j) => {
    const x = -ax + (2 * ax * i) / (N - 1);
    const y = -ay + (2 * ay * j) / (N - 1);
    return { x, y, v: Math.abs(psi(x, y, sc)) };
  };
  const peaks = [];
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const p = at(i, j);
      let top = true;
      for (let dj = -1; dj <= 1 && top; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          if (at(i + di, j + dj).v > p.v) { top = false; break; }
        }
      }
      if (top) peaks.push(p);
    }
  }
  peaks.sort((a, b) => b.v - a.v || a.x - b.x || a.y - b.y);

  const sep = lerp(0.30, 0.56, c.spacing);
  const out = [];
  for (const p of peaks) {
    if (out.length >= want) break;
    if (out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= sep)) out.push(p);
  }
  for (let relax = 0.8; out.length < want && relax > 0.25; relax -= 0.12) {
    for (const p of peaks) {
      if (out.length >= want) break;
      if (out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= sep * relax)) out.push(p);
    }
  }
  return out;
}

// One macro-cluster's primitives, arranged COMPACTLY around its centre.
//
// Never collinear for k = 3: three primitives in a line is the bead chain in
// miniature. A triangle or curved fan reads as one broad mass instead.
function buildCluster(cx, cy, k, R, rot, c, rng) {
  const out = [];
  const ecc = 1 + c.stretch * 0.85 * (0.45 + rng() * 0.55);
  const mk = (x, y, r, extra = 1) => ({
    x, y,
    rx: r * ecc * extra,
    ry: (r / Math.sqrt(ecc)) * extra,
    rot: rot + (rng() - 0.5) * 0.7,
  });

  if (k === 1) {
    out.push(mk(cx, cy, R));
    return out;
  }
  if (k === 2) {
    // A pair sits close enough that the union reads as one capsule or hourglass
    // rather than two circles that happen to touch.
    // Lobe separation is what makes the neck legible, and it has to be measured
    // against the ACTUAL semi-axes along the join. Deriving it from the cluster
    // radius R looks equivalent but is not: `ecc` inflates rx above R, so the
    // real overlap came out around a third and the waist all but vanished.
    // Merge deepens the overlap; it never closes the waist.
    const rA = R * lerp(1, 0.82, rng() * 0.6);
    const rB = R * lerp(1, 0.82, rng() * 0.6);
    const d = (rA + rB) * ecc * lerp(0.90, 0.74, c.merge);
    const a = rot;
    const dx = Math.cos(a) * d * 0.5, dy = Math.sin(a) * d * 0.5;
    out.push(mk(cx - dx, cy - dy, rA));
    out.push(mk(cx + dx, cy + dy, rB));
    return out;
  }
  // k === 3: a triangle or curved fan. The base angle is seeded and the three
  // offsets are spread over ~200 degrees, so they cannot collapse to a line.
  const d = R * lerp(1.55, 1.20, c.merge);
  const sweep = lerp(2.1, 3.5, rng());
  for (let i = 0; i < 3; i++) {
    const a = rot + (i - 1) * (sweep / 2) + (rng() - 0.5) * 0.35;
    const rr = d * (0.55 + rng() * 0.5);
    out.push(mk(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr,
                R * lerp(0.72, 1.05, rng())));
  }
  return out;
}

// The composition, before Scale/crop. Deterministic in (features, variation,
// controls, aspect).
function layout(s) {
  const c = resolved(s);
  const rng = makeRng(metaSeed(s));

  // 3-7 macro components built from ~6-12 primitives.
  const nClusters = Math.round(lerp(3, 7, c.count * 0.85 + 0.1));
  const centres = clusterCentres(c, nClusters);

  // One cluster is deliberately dominant. "At least one form large enough to
  // feel dominant" does not happen by chance when every radius is drawn from
  // the same distribution.
  const dominant = Math.floor(rng() * centres.length);

  const balls = [];
  const clusters = [];
  centres.forEach((p, ci) => {
    if (balls.length >= META_MAX - 1) return;
    // Cluster size: singles and pairs are the common case, triples the accent.
    const roll = rng();
    let k = roll < 0.34 ? 1 : roll < 0.78 ? 2 : 3;
    if (balls.length + k > META_MAX) k = 1;

    // Scale varies per CLUSTER, not per primitive, so the size difference reads
    // at the composition level rather than as noise inside one mass.
    const big = ci === dominant;
    const t = rng();
    const scale = big ? lerp(1.30, 1.75, t)
                      : lerp(1 - 0.55 * c.sizeVar, 1 + 0.20 * c.sizeVar, t);
    const R = 0.46 * scale * c.mass;

    const rot = rng() * Math.PI * 2;
    const members = buildCluster(p.x, p.y, k, R, rot, c, rng);
    const ids = [];
    for (const b of members) {
      b.cluster = Math.min(clusters.length, META_CLUSTER_MAX - 1);
      ids.push(balls.length);
      balls.push(b);
    }
    clusters.push(ids);
  });

  // Keep clusters clear of one another.
  //
  // Different clusters are combined with a plain min, which cuts a SHARP
  // concave notch wherever two of them overlap — a corner, in a design that
  // must have none. Fitting the composition to the frame scales everything up
  // and readily pushes clusters into contact, so the gap has to be enforced
  // rather than assumed. Uniform scaling preserves it, so doing this before the
  // fit is enough.
  const info = clusters.map((ids) => {
    let cx = 0, cy = 0;
    for (const i of ids) { cx += balls[i].x; cy += balls[i].y; }
    cx /= ids.length; cy /= ids.length;
    let rad = 0;
    for (const i of ids) {
      const b = balls[i];
      rad = Math.max(rad, Math.hypot(b.x - cx, b.y - cy) + Math.max(b.rx, b.ry));
    }
    return { ids, cx, cy, rad };
  });
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < info.length; i++) {
      for (let j = i + 1; j < info.length; j++) {
        const a = info[i], b = info[j];
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const d = Math.hypot(dx, dy) || 1e-6;
        // A visible gap, not a tangent kiss: the negative space between
        // components is part of the composition.
        const want = (a.rad + b.rad) * 0.94;
        if (d >= want) continue;
        const push = (want - d) * 0.5;
        const ux = dx / d, uy = dy / d;
        a.cx -= ux * push; a.cy -= uy * push;
        b.cx += ux * push; b.cy += uy * push;
        for (const k of a.ids) { balls[k].x -= ux * push; balls[k].y -= uy * push; }
        for (const k of b.ids) { balls[k].x += ux * push; balls[k].y += uy * push; }
      }
    }
  }

  // Fit the finished composition to the frame.
  //
  // Normalising here is what guarantees the artwork uses the canvas instead of
  // sitting wherever the scaffold happened to put it. The offset is applied
  // AFTER fitting and is deliberately not centred, so the result is composed
  // rather than merely centred.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of balls) {
    x0 = Math.min(x0, b.x - b.rx); x1 = Math.max(x1, b.x + b.rx);
    y0 = Math.min(y0, b.y - b.ry); y1 = Math.max(y1, b.y + b.ry);
  }
  const fx = c.aspect >= 1 ? 1.2 : 1.2 * c.aspect;
  const fy = c.aspect >= 1 ? 1.2 / c.aspect : 1.2;
  const fit = Math.min((2 * fx * TARGET_COVER) / Math.max(1e-6, x1 - x0),
                       (2 * fy * TARGET_COVER) / Math.max(1e-6, y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const offX = (1 - c.symmetry) * (rng() - 0.5) * 0.30 * fx;
  const offY = (1 - c.symmetry) * (rng() - 0.5) * 0.30 * fy;
  // A uniform fit can only reach the target on ONE axis: a wide arrangement
  // fits the width and leaves the canvas half empty vertically. Spreading the
  // CENTRES — never the radii — takes up the slack, so the artwork uses the
  // rectangle without the primitives themselves being distorted into ovals.
  // Bounded, because past a point this stops being composition and starts
  // being a stretch.
  const spanX = (x1 - x0) * fit, spanY = (y1 - y0) * fit;
  const pullX = Math.min(1.4, Math.max(1, (2 * fx * TARGET_COVER) / Math.max(1e-6, spanX)));
  const pullY = Math.min(1.4, Math.max(1, (2 * fy * TARGET_COVER) / Math.max(1e-6, spanY)));
  for (const b of balls) {
    b.x = (b.x - mx) * fit * pullX + offX;
    b.y = (b.y - my) * fit * pullY + offY;
    b.rx *= fit; b.ry *= fit;
  }

  return { balls, clusters, controls: c, fillet: lerp(0.045, 0.11, c.merge) * fit,
           // Capped below 1: a pure smin dissolves the lobes into one oval,
           // and "broader flowing union" still has to read as lobes.
           blend: c.merge * 0.62, scale: c.scaleCrop };
}

// Solving costs O(n^2) and the field is sampled hundreds of thousands of times
// per export, so it is memoised on everything that can change it.
let _cacheKey = null;
let _cacheVal = null;

export function metaSolve(s) {
  const m = Object.assign(defaultMeta(), s.meta);
  const f = s.features ?? {};
  const key = JSON.stringify([
    m.count, m.order, m.merge, m.spacing, m.sizeVar, m.stretch, m.symmetry, m.scaleCrop,
    s.variation ?? 0, s.aspect ?? 0,
    f.pitchNorm, f.rms, f.centroid, f.spread, f.pitchConf,
  ]);
  if (key !== _cacheKey) { _cacheKey = key; _cacheVal = layout(s); }
  return _cacheVal;
}

export const metaBalls = (s) => metaSolve(s).balls;
export const metaClusters = (s) => metaSolve(s);

// Polynomial smooth minimum — a convex, flowing union.
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

// The union inside a cluster: fillet at low Merge for a narrow hourglass waist,
// smin at high Merge for a broad flowing join. Neither alone is right — fillet
// everywhere exaggerates the pinch into peanuts, smin everywhere dissolves the
// lobes into soap bubbles.
export function clusterUnion(d1, d2, fillet, blend) {
  const f = unionRound(d1, d2, fillet);
  const sm = smin(d1, d2, fillet * lerp(1.5, 3.2, blend));
  return f * (1 - blend) + sm * blend;
}

// Approximate ellipse SDF: exact for circles, close enough for the modest
// ratios this generator allows, and cheap enough for a shader to mirror.
export function sdEllipse(px, py, rx, ry, rot) {
  const ca = Math.cos(-rot), sa = Math.sin(-rot);
  const qx = px * ca - py * sa, qy = px * sa + py * ca;
  const k1 = Math.hypot(qx / rx, qy / ry);
  const k2 = Math.hypot(qx / (rx * rx), qy / (ry * ry));
  if (k2 === 0) return -Math.min(rx, ry);
  return (k1 - 1) * (k1 / k2);
}

export function metaDist(x, y, s) {
  const sol = metaSolve(s);
  // Scale/crop is a TRUE zoom of the finished artwork: evaluating the field at
  // p/S and scaling the result by S enlarges positions, radii and necks
  // together. Multiplying only the centres — which is what it used to do —
  // spread small forms further apart instead of making the artwork bigger.
  const S = sol.scale;
  const px = x / S, py = y / S;

  const per = new Array(META_CLUSTER_MAX).fill(Infinity);
  for (const b of sol.balls) {
    const d = sdEllipse(px - b.x, py - b.y, b.rx, b.ry, b.rot);
    const k = b.cluster;
    per[k] = per[k] === Infinity ? d : clusterUnion(per[k], d, sol.fillet, sol.blend);
  }
  let out = Infinity;
  for (const d of per) if (d < out) out = d;
  return out * S;
}

export function metaThickness(x, y, s, edge = 0.004) {
  const d = metaDist(x, y, s);
  return d < -edge ? 1 : d > edge ? 0 : 0.5 - d / (2 * edge);
}

// Composition metrics, for tests and for checking a change did what was
// intended. Measured on the same field the renderer draws.
export function compositionStats(s, aspect = 0.78, N = 220) {
  const st = Object.assign({}, s, { aspect });
  const fx = aspect >= 1 ? 1.2 : 1.2 * aspect;
  const fy = aspect >= 1 ? 1.2 / aspect : 1.2;
  let ink = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < N; j++) {
    const y = -fy + (2 * fy * (j + 0.5)) / N;
    for (let i = 0; i < N; i++) {
      const x = -fx + (2 * fx * (i + 0.5)) / N;
      if (metaDist(x, y, st) < 0) {
        ink++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const sol = metaSolve(st);
  const areas = sol.balls.map((b) => Math.PI * b.rx * b.ry);
  return {
    inkFraction: ink / (N * N),
    bboxCoverW: ink ? (x1 - x0) / (2 * fx) : 0,
    bboxCoverH: ink ? (y1 - y0) / (2 * fy) : 0,
    components: sol.clusters.length,
    primitives: sol.balls.length,
    areaRatio: areas.length ? Math.max(...areas) / Math.min(...areas) : 1,
  };
}
