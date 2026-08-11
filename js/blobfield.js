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
