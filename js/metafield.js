// Metaball Cymatic — a few large liquid lobes, some joined by broad waists.
//
// THREE THINGS THIS DELIBERATELY IS NOT, each having been built and rejected:
//
// 1. One antinode per circle. A modal lattice is regularly spaced, so turning
//    every peak into a circle gives evenly sized dots however they are joined.
// 2. Nearest-neighbour joining. Threading points by proximity produces bead
//    strings and worms; it cannot produce a composition.
// 3. Merge as a pure softening of existing overlaps. Merge has to change how
//    many COMPONENTS the design has, or its three settings look identical.
//
// The model instead is: the field picks a few ANCHOR REGIONS; each anchor gets
// one to three large lobes; a seeded GROUPING PLAN says which lobes could join;
// and Merge activates those groups one at a time. At Merge 0 nothing is joined
// and every lobe is its own component. At Merge 1 the plan is fully realised.
// Anchors, lobe sizes and the plan never change with Merge — only which groups
// are active — so the layout stays stable while the connectivity moves.
import { psi } from './cymafield.js?v=0ba92281';
import { makeRng } from './blobfield.js?v=0ba92281';
import { fnv1a } from './hash.js?v=0ba92281';

export const META_MAX = 12;
export const META_CLUSTER_MAX = 12;

export function defaultMeta() {
  return {
    count: 0.25,     // lobe count, 6 -> 10; 6-7 reads best at the default
    order: 0.4,      // complexity of the scaffold placing the anchors
    merge: 0.5,      // how many groups are joined, and how broadly
    spacing: 0.5,    // distance between cluster centres; lobe sizes unchanged
    sizeVar: 0.55,   // consistent lobes -> a clear size hierarchy
    stretch: 0.3,    // circles -> restrained ellipses, capped at 1.6:1
    symmetry: 0.45,  // ordered cymatic balance -> controlled asymmetry
    scaleCrop: 1.0,  // a true zoom of the finished artwork
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Longer forms come from two or three joined lobes, not one stretched ellipse:
// past this an ellipse stops reading as a lobe and starts reading as a spike.
const MAX_ECC = 1.6;

// Half-extent of the composition's frame, in world units.
//
// This is the shader's own view rectangle at zoom 1: main() maps
// p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 3.15 / uZoom, so the half-HEIGHT
// is always 3.15/2 and the half-width is that times the aspect. The field must
// be composed against exactly that rectangle or the design renders at the wrong
// scale inside the frame — laying it out against a smaller box is what made the
// approved composition arrive as two small droplets in the real app.
//
// Exported so the vector exporter frames the same rectangle too.
export const META_FRAME = 3.15 / 2;

// Fraction of the frame the composition should span.
const TARGET_COVER = 0.92;

function resolved(s) {
  const m = Object.assign(defaultMeta(), s.meta);
  const f = s.features ?? {};
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const rms = clamp01(f.rms ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);
  return {
    count: clamp01(m.count + (centroid - 0.5) * 0.22),
    order: clamp01(m.order + (centroid - 0.5) * 0.35),
    merge: clamp01(m.merge),
    spacing: clamp01(m.spacing),
    sizeVar: clamp01(m.sizeVar + (spread - 0.5) * 0.3),
    stretch: clamp01(m.stretch),
    symmetry: clamp01(m.symmetry + (conf - 0.5) * 0.3),
    scaleCrop: Math.max(0.3, m.scaleCrop),
    mass: lerp(0.94, 1.10, rms),
    pitch,
    aspect: s.aspect && s.aspect > 0 ? s.aspect : 0.78,
  };
}

// Square-plate dominant. The radial membrane term arranges its antinodes in
// concentric rings, which is the radial flower this composition must not be.
function scaffoldState(c) {
  return {
    m: lerp(1.4, 3.4, c.order) + c.pitch * 1.1,
    n: lerp(1.0, 2.7, c.order) + c.pitch * 0.6,
    kr: lerp(1.6, 3.6, c.order),
    ma: lerp(0.8, 2.4, c.order),
    mix: lerp(0.04, 0.28, c.pitch),
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

// The frame in world units. Sizes are expressed against the SHORTER edge so the
// targets mean the same thing in portrait and landscape.
// The box the SCAFFOLD is sampled in.
//
// psi() has a fixed spatial frequency, so it is not scale-invariant: sampling
// it over a larger rectangle yields a different pattern of peaks. The scaffold
// is a pattern, not a physical size, so it is always evaluated in this
// canonical box and the peaks are then mapped into whatever frame the design is
// composed against. Without this, changing META_FRAME silently reshuffles every
// approved composition.
function canonOf(c) {
  const cx = c.aspect >= 1 ? 1.2 : 1.2 * c.aspect;
  const cy = c.aspect >= 1 ? 1.2 / c.aspect : 1.2;
  return { cx, cy };
}

function frameOf(c) {
  // Height is fixed and width follows the aspect — the shader's convention. The
  // previous form scaled the SHORT edge down instead, which has the same aspect
  // ratio but a different scale, and that is the mismatch.
  const fx = META_FRAME * c.aspect, fy = META_FRAME;
  return { fx, fy, short: 2 * Math.min(fx, fy) };
}

// Anchor regions, spread across the frame by a coarse occupancy grid.
//
// Taking the strongest peaks alone repeatedly produced a single diagonal
// string: peak strength correlates along a modal ridge, so the top few are
// often nearly collinear. At most one anchor per grid cell forces the
// composition to occupy two dimensions.
function anchors(c, want, sep) {
  const sc = scaffoldState(c);
  const { fx, fy } = frameOf(c);
  const { cx, cy } = canonOf(c);
  const N = 44;
  const cand = [];
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      // Sampled in the CANONICAL box, positioned in the real frame. psi has a
      // fixed spatial frequency, so evaluating it over the frame directly makes
      // the whole composition depend on the frame's absolute size.
      const u = -1 + (2 * i) / (N - 1);
      const v = -1 + (2 * j) / (N - 1);
      cand.push({ x: u * fx, y: v * fy, v: Math.abs(psi(u * cx, v * cy, sc)) });
    }
  }
  // Ranked by field STRENGTH, not by strict local maxima.
  //
  // A low-order scaffold is smooth: at the orders this mode uses it has about
  // four local maxima in the whole frame, which silently capped the anchor
  // count and left Circle count doing nothing whatever it was set to. Ranking
  // every sample and enforcing separation gives as many anchors as asked for
  // while still following the field.
  cand.sort((p, q) => q.v - p.v || p.x - q.x || p.y - q.y);

  const G = 4;
  const cellOf = (p) => {
    const gx = Math.min(G - 1, Math.max(0, Math.floor(((p.x + fx) / (2 * fx)) * G)));
    const gy = Math.min(G - 1, Math.max(0, Math.floor(((p.y + fy) / (2 * fy)) * G)));
    return gy * G + gx;
  };
  // One anchor per cell first, so the composition occupies two dimensions
  // rather than stringing along a modal ridge, which is where the diagonal
  // came from.
  // `sep` is passed in, derived from the SOLVED lobe radius.
  //
  // It used to be computed here from its own independent estimate, which meant
  // lobe size and anchor spacing moved separately — and since the frame-fit
  // normalises the whole layout, only their RATIO affects density. Enlarging
  // the lobes therefore did nothing at all: the fit simply scaled it back.
  const used = new Set();
  const out = [];
  for (const p of cand) {
    if (out.length >= want) break;
    const k = cellOf(p);
    if (used.has(k)) continue;
    if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < sep)) continue;
    used.add(k);
    out.push(p);
  }
  for (let relax = 0.8; out.length < want && relax > 0.3; relax -= 0.15) {
    for (const p of cand) {
      if (out.length >= want) break;
      if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < sep * relax)) continue;
      out.push(p);
    }
  }
  return out.slice(0, want);
}

// The grouping plan: cluster sizes summing to the lobe count, always including
// singletons so something stays separate at full Merge.

// ── composition templates ──────────────────────────────────────────────
//
// The cymatic scaffold proposes, but it does not decide the composition.
//
// Modal peaks lie along ridges, so the strongest few are frequently near
// collinear — which is exactly how the landscape kept arriving as a top-left to
// bottom-right diagonal however the anchors were spread. Peaks now influence
// the composition (which template, which mirroring, how far each role is nudged
// from its slot) rather than dictating it.
//
// Positions are fractions of the frame half-extent, so a template means the
// same arrangement in any aspect. Each is designed with the two major masses in
// visual relationship and the accents placed to break the line between them,
// not to sit on it.
const TEMPLATES = {
  portrait: [
    // dominant upper-right, balance lower-left, an accent beside each mass
    [[0.34, 0.42], [-0.34, -0.44], [-0.42, 0.16], [0.30, -0.14]],
    // dominant upper-left, balance lower-centre-right, accents hugging each
    [[-0.32, 0.46], [0.30, -0.42], [0.40, 0.18], [-0.26, -0.16]],
    // dominant lower-right, balance upper-centre-left, accents offset
    [[0.30, -0.40], [-0.30, 0.44], [0.38, 0.20], [-0.34, -0.14]],
  ],
  landscape: [
    // dominant right, balance upper-left, accents above and below centre
    [[0.44, -0.22], [-0.44, 0.26], [-0.04, 0.44], [0.08, -0.46]],
    // dominant lower-right, balance left-centre, accents split vertically
    [[0.40, 0.30], [-0.46, -0.20], [0.00, -0.44], [-0.10, 0.42]],
    // dominant left, balance right, accents stacked off-axis
    [[-0.44, -0.26], [0.42, 0.28], [0.04, 0.44], [-0.06, -0.42]],
  ],
};

// How straight a line the component centroids fall on. 1 is perfectly
// collinear; the diagonal arrangement scores around 0.95.
function linearity(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den < 1e-9 ? 1 : Math.abs(sxy / den);
}

// How far the middle of the canvas is from the nearest component, as a fraction
// of the half-frame. A large value is the empty corridor through the centre.
function centreVoid(pts) {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(p[0], p[1]));
  return best;
}

// Pick a template and a mirroring for this sound. Every candidate is scored and
// the best kept, so a layout that reads as a line or leaves a hole through the
// middle cannot be selected however the seed falls.
function composition(c, rng) {
  const set = TEMPLATES[c.aspect >= 1 ? 'landscape' : 'portrait'];
  const cands = [];
  for (let t = 0; t < set.length; t++) {
    for (let mx = 0; mx < 2; mx++) {
      for (let my = 0; my < 2; my++) {
        const pts = set[t].map(([x, y]) => [mx ? -x : x, my ? -y : y]);
        cands.push({ pts, score: linearity(pts) + Math.max(0, centreVoid(pts) - 0.34) * 1.6 });
      }
    }
  }
  // Seeded order, then the lowest score wins — variation across sounds without
  // ever selecting an invalid arrangement.
  const order = cands.map((v, i) => ({ v, k: rng() + i * 1e-6 }))
                     .sort((a, b) => a.k - b.k).map((o) => o.v);
  let best = order[0];
  for (const o of order) if (o.score < best.score - 1e-6) best = o;
  return best.pts;
}

// The composition plan: explicit ROLES, not a random size partition.
//
// A partition produced four or five similar masses; the reference is a few
// deliberately unequal ones. So the plan names them:
//
//   dominant — a three-lobe mass, the largest thing in the frame
//   balance  — a two-lobe mass, second in weight
//   accent   — single lobes, secondary, NOT circles competing with the masses
//
// At the default that is [3] [2] [1] [1]. Circle count adds or removes accents
// and can promote balance to three lobes; it never adds more equal masses.
function planRoles(nLobes) {
  const roles = [];
  const domK = nLobes >= 7 ? 3 : 2;
  roles.push({ role: 'dominant', k: domK, weight: 1.0 });
  let left = nLobes - domK;
  if (left >= 2) {
    // Two, not three, at seven lobes: the plan is [3] [2] [1] [1], and a
    // three-lobe balance leaves no accents and no room to absorb one later.
    const balK = left >= 6 ? 3 : 2;
    roles.push({ role: 'balance', k: balK, weight: 0.90 });
    left -= balK;
  }
  // Accents shrink as they multiply, so a high Circle count adds secondary
  // notes rather than more competing circles.
  const accentWeights = [0.72, 0.60, 0.50, 0.45];
  let ai = 0;
  while (left > 0) {
    roles.push({ role: 'accent', k: 1, weight: accentWeights[Math.min(ai, 3)] });
    ai++; left--;
  }
  return roles;
}

function layout(s) {
  const c = resolved(s);
  const rng = makeRng(metaSeed(s));
  const { fx, fy, short } = frameOf(c);

  const nLobes = Math.round(lerp(6, 10, c.count));
  const plan = planRoles(nLobes);

  // Lobe radius solved from the area the composition should fill.
  //
  // Sum the weighted lobe areas the plan implies, then scale so the total lands
  // on the ink target once overlap inside the connected masses is discounted.
  // Sizing lobes by a fixed fraction and letting the frame-fit resolve it is
  // what kept the design under-massed at roughly half the target.
  const frameArea = 4 * fx * fy;
  let weighted = 0;
  for (let g = 0; g < plan.length; g++) weighted += plan[g].k * plan[g].weight * plan[g].weight;
  const OVERLAP_LOSS = 0.76;      // joined lobes share area
  // The constant is above the ink target because the frame-fit shrinks the
  // layout after the lobes are sized; this is calibrated against the measured
  // result rather than derived.
  const rUnit = Math.sqrt((0.40 * frameArea) / (weighted * Math.PI * OVERLAP_LOSS)) * c.mass;

  // Anchors are spaced in units of the solved lobe radius, so the ratio that
  // actually decides density is set here in one place.
  // Role slots from a validated template, nudged by the cymatic scaffold.
  //
  // The scaffold is sampled at each slot and its local peaks pull the role a
  // short way, so the sound still shapes the arrangement — but it can no longer
  // drag the composition onto a ridge.
  const slots = composition(c, rng);
  const peakHints = anchors(c, Math.max(4, plan.length), rUnit * lerp(1.32, 2.10, c.spacing));
  const regions = [];
  for (let g = 0; g < plan.length; g++) {
    const [sx, sy] = slots[Math.min(g, slots.length - 1)];
    // Extra roles beyond the template's four fan out around the frame rather
    // than stacking on the last slot.
    const extra = g >= slots.length ? (g - slots.length + 1) * 1.7 : 0;
    let bx = sx * fx * (extra ? 0.55 : 1), by = sy * fy * (extra ? 0.55 : 1);
    if (extra) { bx = Math.cos(extra) * 0.5 * fx; by = Math.sin(extra) * 0.5 * fy; }
    // Nudge toward the nearest scaffold peak, capped so the slot still governs.
    let near = null, nd = Infinity;
    for (const p of peakHints) {
      const d = Math.hypot(p.x - bx, p.y - by);
      if (d < nd) { nd = d; near = p; }
    }
    const pull = 0.22 * (1 - c.symmetry * 0.5);
    if (near) { bx += (near.x - bx) * pull; by += (near.y - by) * pull; }
    regions.push({ x: bx, y: by });
  }
  const nGroups = plan.length;

  // Merge stages. Forming the dominant mass comes first, then balance, then an
  // accent is ABSORBED into the balance mass at the top of the range — which is
  // how Merge 1 reaches three components without deleting anything.
  const groups = [];
  for (let g = 0; g < nGroups; g++) {
    const p = plan[g];
    groups.push({
      k: p.k,
      role: p.role,
      region: regions[g],
      threshold: p.role === 'dominant' ? 0.22 : p.role === 'balance' ? 0.40 : 2,
      scale: rUnit * p.weight * lerp(1, 1 + 0.18 * c.sizeVar, rng()),
      rot: rng() * Math.PI * 2,
      ecc: 1 + c.stretch * (MAX_ECC - 1) * (0.4 + rng() * 0.6),
      jitter: [rng(), rng(), rng(), rng()],
    });
  }
  // The first accent joins the balance mass near the top of Merge.
  const balanceIdx = groups.findIndex((g) => g.role === 'balance');
  const accentIdx = groups.findIndex((g) => g.role === 'accent');
  const absorbAt = 0.78;
  const absorbed = c.merge >= absorbAt && balanceIdx >= 0 && accentIdx >= 0;

  const balls = [];
  const groupIds = [];
  for (const g of groups) {
    const active = c.merge >= g.threshold;
    const depth = active ? clamp01((c.merge - g.threshold) / Math.max(0.08, 1 - g.threshold)) : 0;
    const sepK = active ? lerp(0.94, 0.74, depth) : 2.30;

    const ids = [];
    const push = (x, y, r) => {
      ids.push(balls.length);
      balls.push({
        x, y,
        rx: r * g.ecc,
        ry: r / Math.sqrt(g.ecc),
        rot: g.rot + (g.jitter[ids.length % 4] - 0.5) * 0.6,
        cluster: 0,
      });
    };

    const R = g.scale;
    if (g.k === 1) {
      push(g.region.x, g.region.y, R);
    } else if (g.k === 2) {
      const rA = R, rB = R * lerp(1, 0.82, g.jitter[2]);
      const d = (rA + rB) * g.ecc * sepK;
      const dx = Math.cos(g.rot) * d * 0.5, dy = Math.sin(g.rot) * d * 0.5;
      push(g.region.x - dx, g.region.y - dy, rA);
      push(g.region.x + dx, g.region.y + dy, rB);
    } else {
      // A triangle or short curved fan, never a line.
      const sweep = lerp(2.1, 3.4, g.jitter[3]);
      for (let i = 0; i < 3; i++) {
        const rr = R * lerp(0.82, 1.0, g.jitter[i]);
        const a = g.rot + (i - 1) * (sweep / 2) + (g.jitter[i] - 0.5) * 0.3;
        const dist = R * g.ecc * sepK * 0.95;
        push(g.region.x + Math.cos(a) * dist, g.region.y + Math.sin(a) * dist, rr);
      }
    }
    groupIds.push({ ids, active });
  }

  // The accent does not vanish when absorbed: it MOVES to the balance mass and
  // joins it, so the relationship to the original composition survives.
  if (absorbed) {
    const bal = groupIds[balanceIdx].ids;
    let bx = 0, by = 0, br = 0;
    for (const i of bal) {
      bx += balls[i].x; by += balls[i].y;
      br = Math.max(br, Math.max(balls[i].rx, balls[i].ry));
    }
    bx /= bal.length; by /= bal.length;
    const acc = balls[groupIds[accentIdx].ids[0]];
    const dx = acc.x - bx, dy = acc.y - by;
    const d = Math.hypot(dx, dy) || 1e-6;
    const want = (br + Math.max(acc.rx, acc.ry)) * 0.86;
    acc.x = bx + (dx / d) * want;
    acc.y = by + (dy / d) * want;
  }

  const clusters = [];
  groupIds.forEach((g, gi) => {
    if (absorbed && gi === accentIdx) return;                  // handled below
    if (g.active) {
      const ids = g.ids.slice();
      if (absorbed && gi === balanceIdx) ids.push(...groupIds[accentIdx].ids);
      clusters.push(ids);
    } else {
      for (const i of g.ids) clusters.push([i]);
    }
  });

  clusters.forEach((ids, ci) => {
    for (const i of ids) balls[i].cluster = Math.min(ci, META_CLUSTER_MAX - 1);
  });

  // Separate components must not touch: they combine with a plain min, which
  // cuts a sharp concave notch anywhere two overlap.
  //
  // Measured lobe-to-lobe, NOT by a bounding circle per cluster. A two-lobe
  // capsule inscribed in a circle wastes about half that circle, so the circular
  // test held components a long way apart while looking tangent — which is why
  // the composition kept coming out sparse however the radii were sized.
  // Radius of an ellipse in a given direction.
  const dirR = (b, ux, uy) => {
    const ca = Math.cos(-b.rot), sa = Math.sin(-b.rot);
    const qx = ux * ca - uy * sa, qy = ux * sa + uy * ca;
    return 1 / Math.sqrt((qx / b.rx) ** 2 + (qy / b.ry) ** 2);
  };
  const sepPass = () => {
    for (let ci = 0; ci < clusters.length; ci++) {
      for (let cj = ci + 1; cj < clusters.length; cj++) {
        let worst = Infinity, bi = -1, bj = -1;
        for (const i of clusters[ci]) {
          for (const j of clusters[cj]) {
            const dx = balls[j].x - balls[i].x, dy = balls[j].y - balls[i].y;
            const dd = Math.hypot(dx, dy) || 1e-6;
            // The ellipse's radius ALONG the line between centres, not
            // max(rx, ry). The larger axis is a circular bound again, and it
            // held elongated lobes apart by their worst case in every
            // direction — which capped how dense the composition could get
            // however the lobes were sized.
            const gap = dd - (dirR(balls[i], dx / dd, dy / dd)
                            + dirR(balls[j], -dx / dd, -dy / dd)) * 1.005;
            if (gap < worst) { worst = gap; bi = i; bj = j; }
          }
        }
        if (worst >= 0 || bi < 0) continue;
        const dx = balls[bj].x - balls[bi].x, dy = balls[bj].y - balls[bi].y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const ux = dx / d, uy = dy / d, shove = -worst * 0.5;
        for (const k of clusters[ci]) { balls[k].x -= ux * shove; balls[k].y -= uy * shove; }
        for (const k of clusters[cj]) { balls[k].x += ux * shove; balls[k].y += uy * shove; }
      }
    }
  };
  for (let pass = 0; pass < 12; pass++) sepPass();

  // Draw the components together BEFORE fitting.
  //
  // The clearance pass only guarantees they do not overlap; left there, they
  // drift to the corners and the refit shrinks everything, which is the empty
  // corridor through the middle. Contracting toward the composition centroid
  // and refitting to the same coverage enlarges the components instead of
  // merely zooming the same sparse arrangement. The clearance pass runs again
  // afterwards so nothing is pushed into contact.
  {
    let ccx = 0, ccy = 0, n = 0;
    for (const ids of clusters) {
      for (const i of ids) { ccx += balls[i].x; ccy += balls[i].y; n++; }
    }
    ccx /= Math.max(1, n); ccy /= Math.max(1, n);
    const DRAW_IN = 0.80;
    for (const ids of clusters) {
      let gx = 0, gy = 0;
      for (const i of ids) { gx += balls[i].x; gy += balls[i].y; }
      gx /= ids.length; gy /= ids.length;
      const nx = ccx + (gx - ccx) * DRAW_IN, ny = ccy + (gy - ccy) * DRAW_IN;
      for (const i of ids) { balls[i].x += nx - gx; balls[i].y += ny - gy; }
    }
    for (let pass = 0; pass < 8; pass++) sepPass();
  }

  // Fit to the frame, THEN apply Spacing.
  //
  // Order matters. Spacing applied before the fit is cancelled by it and reads
  // as a zoom, which was the complaint about the previous version. Applied
  // after, it moves cluster centres while every lobe keeps the radius the fit
  // gave it.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of balls) {
    x0 = Math.min(x0, b.x - b.rx); x1 = Math.max(x1, b.x + b.rx);
    y0 = Math.min(y0, b.y - b.ry); y1 = Math.max(y1, b.y + b.ry);
  }
  const fit = Math.min((2 * fx * TARGET_COVER) / Math.max(1e-6, x1 - x0),
                       (2 * fy * TARGET_COVER) / Math.max(1e-6, y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const spanX = (x1 - x0) * fit, spanY = (y1 - y0) * fit;
  const pullX = Math.min(1.35, Math.max(1, (2 * fx * TARGET_COVER) / Math.max(1e-6, spanX)));
  const pullY = Math.min(1.35, Math.max(1, (2 * fy * TARGET_COVER) / Math.max(1e-6, spanY)));
  const offX = (1 - c.symmetry) * (rng() - 0.5) * 0.26 * fx;
  const offY = (1 - c.symmetry) * (rng() - 0.5) * 0.26 * fy;
  const spread = lerp(0.86, 1.22, c.spacing);

  const centres = clusters.map((ids) => {
    let cx = 0, cy = 0;
    for (const i of ids) { cx += balls[i].x; cy += balls[i].y; }
    return [cx / ids.length, cy / ids.length];
  });
  clusters.forEach((ids, ci) => {
    const [ccx, ccy] = centres[ci];
    const nx = ((ccx - mx) * fit * pullX + offX) * spread;
    const ny = ((ccy - my) * fit * pullY + offY) * spread;
    for (const i of ids) {
      const b = balls[i];
      // Offsets within a cluster scale but do not spread, so a joined group
      // never pulls apart when Spacing rises.
      b.x = nx + (b.x - ccx) * fit;
      b.y = ny + (b.y - ccy) * fit;
      b.rx *= fit; b.ry *= fit;
    }
  });

  // Grow the lobes until the components nearly touch.
  //
  // Sizing lobes, clearing them, then scaling the layout to fit leaves them far
  // smaller than the frame allows: the clearance pass inflates the bounding box
  // and the fit then shrinks everything back, so ink came out around a third of
  // target. Growing the RADII afterwards — never the positions — recovers the
  // mass without disturbing the composition, and the cap is the clearance
  // itself, so components still never merge.
  {
    const cen = clusters.map((ids) => {
      let cx = 0, cy = 0;
      for (const i of ids) { cx += balls[i].x; cy += balls[i].y; }
      cx /= ids.length; cy /= ids.length;
      let inner = 0;
      for (const i of ids) {
        inner = Math.max(inner, Math.hypot(balls[i].x - cx, balls[i].y - cy));
      }
      let rad = 0;
      for (const i of ids) {
        rad = Math.max(rad, Math.hypot(balls[i].x - cx, balls[i].y - cy)
                            + Math.max(balls[i].rx, balls[i].ry));
      }
      return { cx, cy, rad, inner };
    });
    let grow = 2.2;
    for (let i = 0; i < cen.length; i++) {
      for (let j = i + 1; j < cen.length; j++) {
        const d = Math.hypot(cen[j].cx - cen[i].cx, cen[j].cy - cen[i].cy);
        // Only the radius part scales; the within-cluster offsets do not.
        const ri = cen[i].rad - cen[i].inner, rj = cen[j].rad - cen[j].inner;
        const room = d - cen[i].inner - cen[j].inner;
        if (ri + rj > 1e-6) grow = Math.min(grow, (room * 0.94) / (ri + rj));
      }
    }
    grow = Math.max(1, Math.min(1.7, grow));
    for (const b of balls) { b.rx *= grow; b.ry *= grow; }
  }
  const meanR = balls.reduce((a, b) => a + (b.rx + b.ry) / 2, 0) / Math.max(1, balls.length);
  // Area-weighted centre of the artwork. Scale/crop zooms about THIS, not the
  // world origin: the composition is deliberately off-centre, so zooming about
  // the origin drove the frame into a gap and the ink FELL as Scale/crop rose.
  let wsum = 0, cxs = 0, cys = 0;
  for (const b of balls) {
    const w = b.rx * b.ry;
    wsum += w; cxs += b.x * w; cys += b.y * w;
  }
  const centre = wsum > 0 ? [cxs / wsum, cys / wsum] : [0, 0];
  return {
    balls, clusters, controls: c, scale: c.scaleCrop, centre,
    // Smooth-union radius. Broad enough that a join reads as a liquid waist
    // rather than two circles overlapping.
    blendR: meanR * lerp(0.34, 0.56, c.merge),
  };
}

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

// Polynomial smooth minimum — the union inside a cluster. It grows a broad
// liquid waist while the two lobes are still clearly two lobes, which a
// fillet-only union cannot do: a fillet just rounds the notch where two
// outlines cross, leaving the pair reading as touching eggs.
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

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
  // Scale/crop is a true zoom about the composition centre: evaluating at p/S
  // and scaling the result by S enlarges positions, radii and necks together.
  const S = sol.scale;
  const [cx, cy] = sol.centre;
  const px = cx + (x - cx) / S, py = cy + (y - cy) / S;

  const per = new Array(META_CLUSTER_MAX).fill(Infinity);
  for (const b of sol.balls) {
    const d = sdEllipse(px - b.x, py - b.y, b.rx, b.ry, b.rot);
    const k = b.cluster;
    per[k] = per[k] === Infinity ? d : smin(per[k], d, sol.blendR);
  }
  let out = Infinity;
  for (const d of per) if (d < out) out = d;
  return out * S;
}

export function metaThickness(x, y, s, edge = 0.004) {
  const d = metaDist(x, y, s);
  return d < -edge ? 1 : d > edge ? 0 : 0.5 - d / (2 * edge);
}

// Composition metrics. Components are counted from the RENDERED field by flood
// fill rather than from the cluster list: two clusters pushed into contact
// would otherwise be reported as two when they read as one.
export function compositionStats(s, aspect = 0.78, N = 240) {
  const st = Object.assign({}, s, { aspect });
  const c = resolved(st);
  const { fx, fy, short } = frameOf(c);
  const mask = new Uint8Array(N * N);
  let ink = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < N; j++) {
    const y = -fy + (2 * fy * (j + 0.5)) / N;
    for (let i = 0; i < N; i++) {
      const x = -fx + (2 * fx * (i + 0.5)) / N;
      if (metaDist(x, y, st) < 0) {
        mask[j * N + i] = 1; ink++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  let comps = 0;
  const seen = new Uint8Array(N * N);
  for (let p = 0; p < N * N; p++) {
    if (!mask[p] || seen[p]) continue;
    comps++;
    const stack = [p];
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const qx = q % N, qy = (q / N) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const r = ny * N + nx;
        if (mask[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
      }
    }
  }
  const sol = metaSolve(st);
  const areas = sol.balls.map((b) => Math.PI * b.rx * b.ry);
  const diam = sol.balls.map((b) => b.rx + b.ry);
  return {
    lobes: sol.balls.length,
    components: comps,
    inkFraction: ink / (N * N),
    bboxCoverW: ink ? (x1 - x0) / (2 * fx) : 0,
    bboxCoverH: ink ? (y1 - y0) / (2 * fy) : 0,
    areaRatio: areas.length ? Math.max(...areas) / Math.min(...areas) : 1,
    minLobeFrac: diam.length ? Math.min(...diam) / short : 0,
    maxLobeFrac: diam.length ? Math.max(...diam) / short : 0,
    clusters: sol.clusters.map((g) => g.slice()),
  };
}
