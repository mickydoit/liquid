// Cymatic standing-wave field for Liquid mode.
//
// This replaces the circle-SDF metaball that Liquid used to be. That model
// could only ever produce circles: every isocontour of `length(p-c)-r` is a
// circle, and a smooth union only fillets the joins — so no nodal line,
// lattice or star was expressible, and the result read as soap bubbles.
//
// Here the geometry comes from a MODAL FIELD instead. Psi is a superposition
// of plate/membrane eigenmodes; water is a SEPARATE thickness field that
// pools where |Psi| is near zero — the nodal lines. That is the actual
// physics of a vibrated liquid layer, and it is what produces connected
// watery paths, lattices and floral figures rather than isolated blobs.
//
// ⚠ Mirrored in density.js's CYMA_FRAG. If the two drift apart, the vector
// export stops matching what is on screen. Change them together.

const PI = Math.PI;

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

// The default state: silence. Everything else glides toward audio-derived
// targets, so every field parameter is a float — integers would snap the
// topology between modes instead of flowing through it.
export function idleState() {
  return {
    m: 3, n: 2,        // square-plate mode orders (continuous, not integers)
    kr: 7, ma: 3,      // radial wavenumber and angular order
    mix: 0.5,          // 0 = square Chladni, 1 = circular membrane
    amp: 0,            // drives how much water is gathered into the pattern
    fine: 0,           // fine ripple detail (spectral centroid)
    chaos: 0,          // layering / instability (noisy input)
    simple: 0,         // 0 = full nodal detail, 1 = a few broad meanders
    swell: 0,          // 0 = even line weight, 1 = broad lobes tapering to necks
    mass: 0,           // 0 = water on the NODES (a web), 1 = on the ANTINODES (islands)
    form: 0,           // 0 = cymatic field, 0.5 = metaball blob, 1 = organism
    // The baked organism, as { sample(x, y) -> signed distance }, or null
    // before the first bake lands. See js/organism.js.
    organism: null,
    phase: 0,
    // Emergence: 0 is an empty canvas, 1 is the fully flooded figure. The
    // renderer eases `grow` toward `growTarget`, so a design animates INTO
    // existence rather than appearing whole.
    grow: 0,
    growTarget: 0,
    t: 0,              // seconds
    ripAmt: 0,         // transient impulse strength
    ripT: 9,           // seconds since that impulse
  };
}

// How much of the modal order survives. Complexity in a Chladni figure IS
// its mode numbers — a high-order plate has many small cells — so the way to
// simplify is to lower the orders, not to blur or hide anything. Floors keep
// a recognisable figure at the simple end instead of collapsing to a blob.
export function orders(s) {
  // Reaches much further down than before; the floors are what keep a blobby
  // metaball character at the extreme rather than collapsing to a plain disc.
  const det = 1 - 0.86 * (s.simple ?? 0);
  return {
    m: Math.max(0.55, s.m * det),
    n: Math.max(0.45, s.n * det),
    kr: Math.max(1.3, s.kr * det),
    ma: Math.max(0.7, s.ma * det),
    det,
  };
}

// Modal superposition. Continuous in every parameter so the topology can
// morph rather than switch.
export function psi(x, y, s) {
  const o = orders(s);
  // Square plate (classic Chladni): the antisymmetric combination is what
  // gives the familiar crosses, lattices and stars. A single cos*cos product
  // only ever yields a plain grid.
  const u = x * 0.5 + 0.5, v = y * 0.5 + 0.5;
  const sq = Math.cos(o.m * PI * u) * Math.cos(o.n * PI * v)
           - Math.cos(o.n * PI * u) * Math.cos(o.m * PI * v);

  // Circular membrane. A true Bessel J_m is far too costly per pixel; its
  // ring structure is captured by a decaying cosine, which is all the
  // geometry needs — the radii of the nodal circles and the angular lobes.
  const r = Math.sqrt(x * x + y * y);
  const th = Math.atan2(y, x);
  // The angular term must be PERIODIC in theta, or the atan2 branch cut at
  // theta = +-pi draws a hard seam straight across the figure. cos(ma*th) is
  // only periodic for integer ma — and ma has to stay continuous so the
  // angular order can morph — so blend the two neighbouring integer orders.
  const m0 = Math.floor(o.ma), fm = o.ma - m0;
  const ang = Math.cos(m0 * th + s.phase) * (1 - fm)
            + Math.cos((m0 + 1) * th + s.phase) * fm;
  const rad = Math.cos(o.kr * r - o.ma * PI * 0.5 - PI * 0.25)
            / Math.sqrt(1 + o.kr * r * 0.6) * ang;

  let f = sq * (1 - s.mix) + rad * s.mix * 1.7;

  // Fine structure from brightness — a higher-order mode laid over the
  // fundamental, drifting slowly so the surface never looks frozen.
  // Fine detail and layering are both forms of complexity, so they fade with
  // the same control — otherwise "simple" would still carry busy overlays.
  if (s.fine > 0) {
    f += s.fine * 0.30 * o.det
       * Math.cos(o.m * 2.7 * PI * u + s.t * 0.21)
       * Math.cos(o.n * 2.7 * PI * v - s.t * 0.17);
  }

  // Noisy input layers a second, detuned mode over the first, so broadband
  // sound reads as an unstable / doubled figure instead of a clean one.
  if (s.chaos > 0) {
    f += s.chaos * 0.45 * o.det
       * (Math.cos((o.m + 1.7) * PI * u) * Math.cos((o.n + 0.6) * PI * v)
        - Math.cos((o.n + 0.6) * PI * u) * Math.cos((o.m + 1.7) * PI * v));
  }

  // A transient sends a ring travelling outward, decaying in time and radius.
  if (s.ripAmt > 0) {
    f += s.ripAmt * Math.sin(14 * r - s.ripT * 9)
       * Math.exp(-s.ripT * 1.6) * Math.exp(-r * 0.7);
  }

  // Gentle breathing so a sustained tone still lives.
  return f * (0.88 + 0.12 * Math.sin(s.t * 0.9));
}

// How much water stands at a point.
//
// Water is driven off the antinodes and collects along the nodal lines, so
// thickness is high where |Psi| is small. The band widens with amplitude:
// louder sound sweeps liquid out of a larger area and into the figure, which
// is exactly the "water flows into the pattern" behaviour.
// How much the ribbon swells at a given point.
//
// A low-order standing wave from the SAME modal family as the figure, so the
// thick and thin passages belong to the form rather than looking like an
// effect laid over it. Deliberately not the true field gradient: that is the
// physically exact choice, but it costs two extra psi evaluations inside a
// function already called ~8x per pixel, which triples the per-pixel trig
// budget for a difference the eye does not read.
export function swellAt(x, y, s) {
  const o = orders(s);
  const u = x * 0.5 + 0.5, v = y * 0.5 + 0.5;
  // Low frequencies relative to the figure: a few broad passages that swell
  // and pinch, rather than many small wobbles along every ribbon.
  return 0.5 + 0.5 * Math.cos(o.m * 0.32 * PI * u + s.phase * 0.7)
                   * Math.cos(o.n * 0.27 * PI * v - s.phase * 0.5);
}

export function nodalThickness(x, y, s) {
  const f = Math.abs(psi(x, y, s));
  // The band is a threshold on the FIELD, not a width in space. Lowering the
  // modal orders makes the field's gradients gentler, so the same threshold
  // spreads over far more area — simplifying without this turns the figure
  // into a solid mass with a few holes, the inverse of the intended look.
  // Scaling with the same factor keeps the ribbon's width roughly fixed while
  // the cells grow, which is what gives broad meanders instead of a blob.
  const sw = s.swell ? swellAt(x, y, s) : 0;
  const weight = 1 + (s.swell ?? 0) * (0.15 + 2.6 * sw - 1);
  const band = (0.05 + 0.34 * s.amp) * orders(s).det * weight;

  // WHICH SIDE of the field holds the water.
  //
  // On the NODES (mass = 0) the wet set is a nodal line network — always a
  // web of closed loops, because that is what a nodal set is. No amount of
  // simplifying turns it into a few solid lobes.
  //
  // On the ANTINODES (mass = 1) the wet set is the field's peaks instead:
  // a handful of fat rounded masses joined by necks. That is the metaball
  // topology, and it is the only way to reach it from a modal field.
  const line = 1 - smoothstep(band * 0.30, band, f);
  const thr = (0.62 - 0.42 * s.amp) / Math.max(0.3, weight);
  const soft = 0.10 * (s.simple ? 1 + s.simple : 1);
  const lobe = smoothstep(thr - soft, thr + soft, f);
  let T = (1 - (s.mass ?? 0)) * line + (s.mass ?? 0) * lobe;
  // The Form ramp, hinged at 0.5:
  //
  //   0.0 -> 0.5   cymatic field -> blob   (mask blend, as before)
  //   0.5 -> 1.0   blob -> organism        (DISTANCE blend)
  //
  // The upper half blends signed distances and thresholds ONCE at the end.
  // Blending two already-thresholded masks — which is what the lower half does
  // — is exactly what makes mid-Form look blurred: a half-and-half mask has no
  // sharp transition left to find. Distances have no such problem, so the
  // organism half is crisp at every position.
  const form = s.form ?? 0;
  if (form) {
    // smoothstep, not linear: a linear blend leaves a ghost web behind the
    // blob at Form 0.85-0.95.
    const w = smoothstep(0, 1, Math.min(1, form * 2));
    T = T * (1 - w) + blobThickness(x, y, s) * w;

    if (form > 0.5 && s.organism) {
      const upper = smoothstep(0, 1, (form - 0.5) * 2);
      const d = blobDist(x, y, s) * (1 - upper) + s.organism.sample(x, y) * upper;
      // A fixed hairline: the CPU path has no screen to measure against, and
      // the exporter contours the zero crossing regardless, so this only
      // shapes antialiasing.
      T = 1 - smoothstep(-0.004, 0.004, d);
    }
  }
  // Soft plate boundary — the dish edge, not a hard crop.
  const r = Math.sqrt(x * x + y * y);
  T *= 1 - smoothstep(1.02, 1.30, r);
  return T;
}

// Emergence mask. The figure floods outward from the centre, so a design
// arrives as liquid spreading into the pattern rather than being switched on.
// At grow = 0 nothing is visible at all — that is the resting state now,
// instead of a scatter of unrelated droplets sitting over the figure.
export function reveal(x, y, s) {
  const g = s.grow ?? 1;
  const r = Math.sqrt(x * x + y * y);
  return 1 - smoothstep(g * 1.55 - 0.30, g * 1.55 + 0.04, r);
}

// Water thickness. Nodal structure only — there is no separate droplet layer:
// scattered drops read as an unrelated element sitting over the figure rather
// than as part of it, and the emergence mask is a better resting state.
// Because there is now only one term, the CPU field and the GLSL agree
// exactly and the vector export needs no exceptions.
export function thickness(x, y, s) {
  return clamp01(nodalThickness(x, y, s) * reveal(x, y, s));
}

// ── metaball form ──────────────────────────────────────────────────────
//
// A modal field can only give two topologies: water on the nodes is a web of
// closed loops, water on the antinodes is a field of islands (one peak per
// cell). Neither is a single fat multi-armed blob, however far it is
// simplified — that shape is a metaball, a different construction entirely.
//
// So the blob is built directly, from the SAME modal numbers that drive the
// field, and cross-faded with it. The lobe count, placement and size all
// follow m, n, ma and amplitude, so it still answers to the sound.
export const BLOB_MAX = 10;

export function blobCircles(s) {
  const o = orders(s);
  const k = Math.max(3, Math.min(BLOB_MAX - 1, Math.round(3 + o.ma * 0.6)));
  const out = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2 + s.phase;
    // Spacing vs radius is what decides arms-with-necks against one fused
    // mass: the lobes have to stand clear of each other and be bridged, not
    // overlap outright.
    const dist = 0.46 + 0.13 * Math.sin(o.m * 1.7 + i * 2.3);
    const rad = 0.19 + 0.07 * Math.sin(o.n * 2.1 + i * 1.7) + 0.08 * s.amp;
    out.push({ x: Math.cos(a) * dist, y: Math.sin(a) * dist, r: Math.max(0.08, rad) });
  }
  // A centre lobe ties the arms into one body instead of a ring of islands.
  out.push({ x: 0, y: 0, r: 0.16 + 0.10 * s.amp });
  return out;
}

// Polynomial smooth minimum: blending circle SDFs with this rather than a
// hard min is what produces the tapered necks between lobes.
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

// The signed distance itself, kept separate from the threshold so the Form
// ramp can blend it with the organism's distance BEFORE either is thresholded.
// Blending two already-thresholded masks is what makes mid-Form look blurred:
// a half-and-half mask has no sharp transition left to find.
export function blobDist(x, y, s) {
  const cs = blobCircles(s);
  const k = 0.15 + 0.08 * (1 - (s.simple ?? 0));
  let d = Math.hypot(x - cs[0].x, y - cs[0].y) - cs[0].r;
  for (let i = 1; i < cs.length; i++) {
    d = smin(d, Math.hypot(x - cs[i].x, y - cs[i].y) - cs[i].r, k);
  }
  return d;
}

export function blobThickness(x, y, s) {
  return 1 - smoothstep(-0.012, 0.012, blobDist(x, y, s));
}

// ── audio → field ──────────────────────────────────────────────────────
//
// Every mapping is continuous, and callers glide toward these rather than
// jumping, so the water morphs instead of snapping between figures.
export function targetFromFeatures(f) {
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const rms = clamp01(f.rms ?? 0);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);

  // Pitch sets the modal ORDER — the topology — not a colour or a size.
  // Low notes give few large lobes; high notes give fine, busy nodal work.
  return {
    m: 2 + pitch * 7.5,
    n: 1.5 + pitch * 5.0 + spread * 1.5,
    kr: 4.5 + pitch * 16,
    ma: 2 + pitch * 6,
    // A confident, tonal pitch reads as a circular membrane (floral, radial);
    // noisy or atonal input leans to the square plate (lattice, broken).
    mix: clamp01(0.25 + conf * 0.6 - spread * 0.35),
    amp: Math.min(1, rms * 3.2),
    fine: centroid,
    chaos: clamp01(spread * 0.8 + (1 - conf) * 0.5),
  };
}

// Exponential glide, frame-rate independent.
export function glide(state, target, dt, tau = 0.5) {
  const k = 1 - Math.exp(-dt / Math.max(1e-3, tau));
  for (const key of ['m', 'n', 'kr', 'ma', 'mix', 'amp', 'fine', 'chaos']) {
    if (target[key] !== undefined) state[key] += (target[key] - state[key]) * k;
  }
  return state;
}

// Seconds for a design to flood in from nothing.
export const GROW_SEC = 1.35;

// Ease `grow` toward its target. Runs every frame regardless of whether the
// geometry is otherwise frozen, so a held or submitted design still animates
// in once — and then stops, because grow has arrived.
export function stepGrow(state, dt) {
  const target = state.growTarget ?? 1;
  const step = dt / GROW_SEC;
  if (state.grow < target) state.grow = Math.min(target, state.grow + step);
  else if (state.grow > target) state.grow = Math.max(target, state.grow - step * 2);
  return state.grow;
}

// Advance time and decay the transient impulse.
export function advance(state, dt) {
  state.t += dt;
  state.ripT += dt;
  state.phase += dt * 0.15;
  state.ripAmt *= Math.exp(-dt * 1.2);
  return state;
}

export function kick(state, strength = 1) {
  state.ripAmt = Math.min(1.2, state.ripAmt + strength * 0.5);
  state.ripT = 0;
  return state;
}

// Where the water's edge sits, as a thickness value.
//
// ONE canonical number for three consumers that must agree: the shaded view's
// coverage ramp, the flat view's silhouette, and the contour the vector
// export traces. They had drifted — the export cut at 0.5 while the shaded
// view painted everything above ~0.08 — so exports came out markedly thinner
// than the screen, and any filament peaking below 0.5 vanished outright,
// which is what fragmented the strokes.
export const WATER_EDGE = 0.08;

// Centreline field for the OUTLINE export: zero along the nodal line, which
// is the ribbon's spine. Contouring the water's boundary instead draws both
// sides of every ribbon, so each curve comes out doubled.
export function makeCentrelineField(s) {
  return (x, y) => (thickness(x, y, s) > 0.12 ? psi(x, y, s) : 1);
}

// Signed field for contouring: negative inside the water.
export function makeWaterField(s, iso = WATER_EDGE) {
  return (x, y) => iso - thickness(x, y, s);
}
