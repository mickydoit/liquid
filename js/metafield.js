// Metaball Cymatic — several rounded forms, some separate, some joined by
// smooth liquid necks.
//
// The geometry is NOT the nodal field. A modal field is used only as a
// SCAFFOLD: its antinodes are a naturally cymatic arrangement of well-spaced
// points, and a handful of those become the centres of circles and restrained
// ellipses. Rendering the field itself gives a dense cellular network, which is
// the opposite of the intended silhouette.
//
// Nor is it one organism with arms. There is no skeleton and no hub: every form
// is an independent rounded primitive, and connection is decided per PAIR by
// the Merge control rather than emerging from a shared centre. That is the
// difference between "several rounded lobes joined by waists" and "spikes
// radiating from a middle".
//
// Joins use a circular FILLET union, not a polynomial smooth-min. A fillet adds
// a concave tangent arc in the corner where two surfaces meet, which is the
// narrow hourglass waist the reference shows. `smin` bulges convexly there and
// reads as soap bubbles — the single most load-bearing detail in this look.
import { psi } from './cymafield.js?v=b7cdba0d';
import { unionRound, makeRng } from './blobfield.js?v=b7cdba0d';
import { fnv1a } from './hash.js?v=b7cdba0d';

export const META_MAX = 14;
export const META_CLUSTER_MAX = 8;

export function defaultMeta() {
  return {
    count: 0.45,     // 5 -> 14 forms
    order: 0.40,     // complexity of the scaffold the centres are drawn from
    merge: 0.50,     // how many neighbouring forms connect
    spacing: 0.50,   // distance between forms
    sizeVar: 0.50,   // consistent radii -> strongly varied
    stretch: 0.25,   // circles -> restrained ellipses
    symmetry: 0.50,  // ordered cymatic balance -> controlled asymmetry
    scaleCrop: 1.0,  // >1 enlarges the composition so forms leave the frame
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// How the sound reaches the composition. Each feature drives one property, and
// each is a CENTRE the slider sets — the audio deviates around it — so a
// control still does what it says while the design stays sound-derived.
function resolved(s) {
  const m = Object.assign(defaultMeta(), s.meta);
  const f = s.features ?? {};
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const rms = clamp01(f.rms ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);
  return {
    // Sound complexity -> how many forms.
    count: clamp01(m.count + (centroid - 0.5) * 0.3),
    // Spectral centroid -> scaffold order (detail).
    order: clamp01(m.order + (centroid - 0.5) * 0.4),
    merge: clamp01(m.merge),
    spacing: clamp01(m.spacing),
    // Noisiness -> size variation.
    sizeVar: clamp01(m.sizeVar + (spread - 0.5) * 0.4),
    stretch: clamp01(m.stretch),
    // Confident, tonal input reads as more ordered.
    symmetry: clamp01(m.symmetry + (conf - 0.5) * 0.4),
    scaleCrop: Math.max(0.4, m.scaleCrop),
    // Amplitude -> liquid mass.
    mass: lerp(0.85, 1.25, rms),
    // Pitch -> the scaffold's spatial topology.
    pitch,
  };
}

// The scaffold state: a LOW-order modal field, deliberately far below the one
// Detailed Cymatic draws. Its antinodes are what the centres are sampled from.
function scaffoldState(c) {
  return {
    m: lerp(1.6, 4.2, c.order) + c.pitch * 1.4,
    n: lerp(1.2, 3.4, c.order) + c.pitch * 0.9,
    kr: lerp(2.0, 5.0, c.order),
    ma: lerp(1.0, 3.4, c.order),
    mix: lerp(0.15, 0.75, c.pitch),
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

// Local maxima of |psi| on a coarse grid. These are the antinodes — the plate's
// loudest points — and they sit in a naturally cymatic, well-spaced lattice, so
// the composition reads as sound-derived without the field being drawn.
function antinodes(c) {
  const sc = scaffoldState(c);
  const N = 46;
  const span = 1.15;
  const at = (i, j) => {
    const x = -span + (2 * span * i) / (N - 1);
    const y = -span + (2 * span * j) / (N - 1);
    return { x, y, v: Math.abs(psi(x, y, sc)) };
  };
  const out = [];
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const p = at(i, j);
      let peak = true;
      for (let dj = -1; dj <= 1 && peak; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          if (at(i + di, j + dj).v > p.v) { peak = false; break; }
        }
      }
      if (peak) out.push(p);
    }
  }
  // Strongest first, so raising Circle count ADDS weaker forms rather than
  // reshuffling the ones already there.
  out.sort((a, b) => b.v - a.v || a.x - b.x || a.y - b.y);
  return out;
}

// The forms. Deterministic in (features, variation, controls).
export function metaBalls(s) {
  const c = resolved(s);
  const rng = makeRng(metaSeed(s));
  const want = Math.round(lerp(5, META_MAX, c.count));

  // Selection separation depends on the form COUNT alone, never on Spacing or
  // Merge. Those controls must move the forms that exist, not silently swap
  // which peaks were chosen — a slider that reshuffles the composition is
  // indistinguishable from a reroll.
  const sep = lerp(0.30, 0.17, c.count);

  const peaks = antinodes(c);
  const picked = [];
  for (const p of peaks) {
    if (picked.length >= want) break;
    if (picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= sep)) picked.push(p);
  }
  // A sparse scaffold can run out of well-separated peaks before `want`. Relax
  // the separation rather than return fewer forms than the control promises.
  for (let relax = 0.85; picked.length < want && relax > 0.3; relax -= 0.15) {
    for (const p of peaks) {
      if (picked.length >= want) break;
      if (picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= sep * relax)) picked.push(p);
    }
  }

  const strongest = peaks.length ? peaks[0].v : 1;
  return picked.map((p, i) => {
    // Asymmetry: a seeded nudge off the scaffold, so the arrangement is
    // cymatic in structure but not mechanically regular. Symmetry 1 keeps the
    // scaffold exactly; 0 lets each centre wander.
    const jit = (1 - c.symmetry) * 0.16;
    // Spacing is applied HERE, as a scale on the arrangement, so it spreads the
    // chosen forms apart instead of changing which forms were chosen.
    const spread = lerp(0.82, 1.30, c.spacing);
    const x = (p.x * spread + (rng() * 2 - 1) * jit) * c.scaleCrop;
    const y = (p.y * spread + (rng() * 2 - 1) * jit) * c.scaleCrop;

    // Radius follows the antinode's strength, so bigger forms land where the
    // plate is loudest — varied scale that still means something.
    const strength = strongest > 0 ? p.v / strongest : 1;
    const base = lerp(0.135, 0.20, strength) * c.mass * lerp(1, 1.12, c.scaleCrop - 1);
    const vary = 1 + (rng() * 2 - 1) * c.sizeVar * 0.55;
    const r = Math.max(0.045, base * vary);

    // Restrained ellipses only. Past ~2.6:1 a form stops reading as a lobe and
    // starts reading as the spike this design exists to avoid, so the ratio is
    // capped rather than left to the slider.
    const e = 1 + c.stretch * 0.8 * (0.4 + rng() * 0.6);
    const rot = rng() * Math.PI;
    return { x, y, rx: r * e, ry: r / Math.sqrt(e), rot, i };
  });
}

// Which forms join. Union-find over nearest-neighbour pairs, shortest first, so
// Merge grows connections in a stable order — raising it adds joins rather than
// rearranging the ones already made.
export function metaClusters(s) {
  const c = resolved(s);
  const balls = metaBalls(s);
  const n = balls.length;

  // "Neighbouring forms" is each form's two NEAREST, not everything inside some
  // radius. A radius threshold makes the candidate set collapse as soon as
  // Spacing or Size variation push the forms apart — at which point Merge 0.5
  // has almost nothing to join and the percentage it reports is meaningless.
  // A k-nearest graph is scale-free, so "30-60% of neighbours joined" means the
  // same thing at every setting.
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const near = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      near.push({ j, d: Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y) });
    }
    near.sort((a, b) => a.d - b.d || a.j - b.j);
    for (const { j, d } of near.slice(0, 2)) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ i: Math.min(i, j), j: Math.max(i, j), d });
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);

  const parent = balls.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const size = balls.map(() => 1);

  // The cap is what keeps this from becoming one fused organism at Merge 1.
  // Clusters of two and three are the reference's language; a cluster holding
  // half the design is the failure this whole rewrite is correcting.
  const maxCluster = c.merge < 0.35 ? 2 : c.merge < 0.75 ? 3 : 4;
  const target = Math.round(pairs.length * c.merge * 0.95);

  // How many forms may end up inside a cluster at all. Without this second cap
  // the greedy join chains every form into something and the design loses its
  // separate circles — Merge 1 is specified to keep negative space, not to
  // connect everything. It also keeps a mixture at the midpoint, which is what
  // "balanced" means: several joined groups AND several forms left alone.
  //
  // The curve is sqrt, not linear, because joins are not proportional to the
  // forms recruited: a cluster of k costs k forms but yields only k-1 joins, so
  // a linear cap undershoots the specified 30-60% badly at the midpoint.
  const maxClustered = Math.round(n * 0.94 * Math.sqrt(c.merge));
  let clustered = 0;

  let joined = 0;
  for (const p of pairs) {
    if (joined >= target) break;
    const a = find(p.i), b = find(p.j);
    if (a === b) continue;
    if (size[a] + size[b] > maxCluster) continue;
    // Forms not already in a cluster that this join would recruit.
    const recruits = (size[a] === 1 ? 1 : 0) + (size[b] === 1 ? 1 : 0);
    if (clustered + recruits > maxClustered) continue;
    parent[a] = b;
    size[b] += size[a];
    clustered += recruits;
    joined++;
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const clusters = [...groups.values()];
  // Stable ids, capped so the GLSL mirror's loop bound is a constant.
  clusters.forEach((g, id) => g.forEach((i) => { balls[i].cluster = Math.min(id, META_CLUSTER_MAX - 1); }));

  // Connection has to be built, not hoped for.
  //
  // A fillet only rounds a corner where two surfaces ALREADY meet; it cannot
  // bridge a gap. So joined members are pulled together until they genuinely
  // overlap, and unjoined neighbours are pushed apart until they genuinely do
  // not. Without this the Merge control depends on whether the scaffold
  // happened to place two peaks close enough, which is exactly the accidental
  // behaviour this design is specified against.
  for (let pass = 0; pass < 3; pass++) {
    for (const p of pairs) {
      const a = balls[p.i], b = balls[p.j];
      const same = find(p.i) === find(p.j);
      const ra = (a.rx + a.ry) / 2, rb = (b.rx + b.ry) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const ux = dx / d, uy = dy / d;
      // Joined: overlap by ~18% of the summed radii, which is enough for the
      // fillet to read as a waist rather than a tangent kiss.
      // Unjoined: hold a gap of ~22%, so the negative space is unmistakable.
      const wantD = same ? (ra + rb) * 0.82 : (ra + rb) * 1.22;
      if ((same && d <= wantD) || (!same && d >= wantD)) continue;
      const shift = (wantD - d) * 0.5;
      a.x -= ux * shift; a.y -= uy * shift;
      b.x += ux * shift; b.y += uy * shift;
    }
  }

  return { balls, clusters, joinedPairs: joined, candidatePairs: Math.max(1, pairs.length), fillet: filletFor(c) };
}

// Neck size. Merge thickens the waist as well as adding joins, so the control
// reads as "more liquid connection" rather than a discrete count ticking up.
function filletFor(c) {
  return lerp(0.05, 0.16, c.merge);
}

// Approximate ellipse SDF: exact for circles, and close enough for the modest
// ratios this generator allows. The exact form needs an iterative root solve,
// which is not worth it inside a per-pixel function that a shader must mirror.
export function sdEllipse(px, py, rx, ry, rot) {
  const ca = Math.cos(-rot), sa = Math.sin(-rot);
  const qx = px * ca - py * sa, qy = px * sa + py * ca;
  const k1 = Math.hypot(qx / rx, qy / ry);
  const k2 = Math.hypot(qx / (rx * rx), qy / (ry * ry));
  if (k2 === 0) return -Math.min(rx, ry);
  return (k1 - 1) * (k1 / k2);
}

// Solving the composition costs O(n^2) and the field is sampled hundreds of
// thousands of times per export, so the solve is memoised on everything that
// can change it. Without this the exporter re-derives the whole arrangement
// per pixel.
let _cacheKey = null;
let _cacheVal = null;

export function metaSolve(s) {
  const m = Object.assign(defaultMeta(), s.meta);
  const f = s.features ?? {};
  const key = JSON.stringify([
    m.count, m.order, m.merge, m.spacing, m.sizeVar, m.stretch, m.symmetry, m.scaleCrop,
    s.variation ?? 0,
    f.pitchNorm, f.rms, f.centroid, f.spread, f.pitchConf,
  ]);
  if (key !== _cacheKey) { _cacheKey = key; _cacheVal = metaClusters(s); }
  return _cacheVal;
}

// The composition's signed distance. Fillet union WITHIN a cluster, plain min
// ACROSS clusters — which is what makes connection a decision rather than an
// accident of overlap.
export function metaDist(x, y, s) {
  const { balls, fillet } = metaSolve(s);
  const perCluster = new Array(META_CLUSTER_MAX).fill(Infinity);
  for (const b of balls) {
    const d = sdEllipse(x - b.x, y - b.y, b.rx, b.ry, b.rot);
    const k = b.cluster;
    perCluster[k] = perCluster[k] === Infinity ? d : unionRound(perCluster[k], d, fillet);
  }
  let out = Infinity;
  for (const d of perCluster) if (d < out) out = d;
  return out;
}

// Thickness, for the field the renderer and exporter share.
export function metaThickness(x, y, s, edge = 0.004) {
  const d = metaDist(x, y, s);
  return d < -edge ? 1 : d > edge ? 0 : 0.5 - d / (2 * edge);
}
