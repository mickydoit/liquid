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

import { psi, idleState } from './cymafield.js?v=e10531ff';
import { fnv1a } from './hash.js?v=e10531ff';

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
    // Frame-scale MULTIPLIER, not a [0,1] control like its neighbours: 1.0
    // means the organism exactly fits the frame, and values above 1 push it
    // outward so it overflows and gets cropped, which is the point of the
    // control. Roughly [0.5, 2.0] in practice.
    scaleCrop: 1.15,
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

  // Composition offset. The spec asks for an off-centre arrangement with no
  // obvious centre point; without this the hub sits at the world origin, which
  // is the exact centre of the frame at every scale, so it can never be
  // cropped out and the organism can never read as several separate forms.
  // Drawn HERE — before anything weight-dependent — so form-count continuity
  // is unaffected.
  const offTh = rng() * Math.PI * 2;
  const offR = 0.25 + rng() * 0.45;
  const offset = [Math.cos(offTh) * offR, Math.sin(offTh) * offR];

  const raw = Array.from({ length: MAX_FORMS }, () => ({
    jitter: rng() * 2 - 1,
    len: rng(),
    tip: rng(),
    root: rng(),
  }));
  const warpP = warpParams(rng);

  const hub = { ax: offset[0], ay: offset[1], ra: hubR,
                bx: offset[0], by: offset[1], rb: hubR, weight: 1 };

  // How many arms are active. formCount 0 -> 3 arms, 1 -> MAX_FORMS.
  const active = 3 + c.formCount * (MAX_FORMS - 3);

  const arms = raw.map((r, i) => {
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

    // Translated by `offset` so the whole organism moves rigidly with the
    // hub — arms keep their positions relative to it rather than the offset
    // deforming the mark.
    return {
      ax: Math.cos(th) * rootD + offset[0],
      ay: Math.sin(th) * rootD + offset[1],
      ra: rootR,
      bx: Math.cos(th) * (rootD + len) + offset[0],
      by: Math.sin(th) * (rootD + len) + offset[1],
      rb: tipR,
      weight,
    };
  });

  return { prims: [hub, ...arms], warpP, offset };
}

// Below this weight an arm is gone entirely. Scaling radii to zero is not
// enough: a zero-radius capsule is still a line of zero-distance points, which
// would leave a hairline scratch exactly where the arm faded out.
const WEIGHT_EPS = 1e-3;

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

// `controls` must be a COMPLETE control object — run it through
// defaultControls() once in the caller. This is evaluated per cell during the
// bake (~500k times), so allocating a merged object here would dominate.
//
// Second precondition: if c.detail > 0, c._psiState must already be populated
// (a cymatic state built by perturbState()). makeBlobField is what establishes
// both preconditions — it merges the controls AND builds _psiState once, up
// front, rather than here, because this function runs once per grid cell
// during the bake and cannot afford to allocate that state on every call.
export function blobField(px, py, prims, warpP, c) {
  const [wx, wy] = warp(px, py, c.warp * 0.35, warpP);

  // Merge maps to a fixed fillet radius in world units, scaled only by the
  // merge control itself — not by hubR, which is layout()-local and never
  // reaches this function.
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

  // Shape Style: psi displaces the contour by a BOUNDED distance. psi is a
  // superposition of cosines ranging to about +-2, so it is clamped before
  // scaling or it would overshoot PERTURB_MAX.
  //
  // The `c._psiState` check is defensive, not decorative: a caller that
  // bypassed makeBlobField (and so never got _psiState built) should get the
  // un-perturbed field, not a TypeError from psi() reading an undefined state.
  if (c.detail > 0 && c._psiState) {
    const w = Math.max(-1, Math.min(1, psi(wx, wy, c._psiState)));
    d -= w * c.detail * PERTURB_MAX;
  }

  return c.invert ? -d : d;
}

export function makeBlobField(seed, controls) {
  const c = Object.assign(defaultControls(), controls);
  // Built once: psi's state is constant across the field, and rebuilding it
  // per cell would allocate an object ~500k times during a bake.
  c._psiState = perturbState(c.detail);
  const { prims, warpP, offset } = layout(seed, c);
  // Scale/Crop enlarges the organism relative to the frame, which is what
  // pushes arms off the edge and takes the centre out of view.
  // Floored, not clamped to a "sensible" range: at 0 this divides by zero
  // (NaN/Infinity through warp and sdTaperedCapsule), and negative values
  // flip the sign of every distance, silently breaking the negative-inside
  // convention. 0.05 is far below any usable value, so it cannot alter a
  // legitimate input.
  const s = Math.max(0.05, c.scaleCrop);
  // The offset is a FRAMING decision, so it belongs in screen units. layout()
  // bakes it into the primitives in blobfield space, where evaluating at x / s
  // would put the hub on screen at offset * s — coupling framing to scale, and
  // by a different amount per seed. This correction cancels that, so the hub
  // lands at `offset` on screen at every scaleCrop.
  const [ox, oy] = offset;
  const k = (s - 1) / s;
  return {
    prims, warpP, offset, controls: c,
    field: (x, y) => blobField(x / s + ox * k, y / s + oy * k, prims, warpP, c) * s,
  };
}

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
