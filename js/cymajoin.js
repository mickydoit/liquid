// Cymatic Join: bridge neighbouring cells with filleted necks.
//
// The cells in Detailed Cymatic are a threshold on |psi| (cymafield.js:186), so
// the shape of the passage between two of them is whatever the field's saddle
// happens to be, and lowering the threshold joins dozens of cells at once
// rather than two chosen ones. A designed neck therefore cannot be a level set
// of the field; it has to be a geometric operation on identified cells, which
// is a whole-image job and bakes rather than evaluating per pixel per frame.
import {
  labelComponents, signedEdt, gridSampler, FORMATS,
} from './bake.js?v=87f2b33d';
import { unionRound } from './blobfield.js?v=87f2b33d';
import { makeWaterField } from './cymafield.js?v=87f2b33d';

// Nearest foreground cell for every pixel, by two-pass vector propagation
// (Danielsson). Exact on convex arrangements and within a fraction of a cell
// elsewhere — far more accuracy than a channel measurement needs.
//
// Doing this ONCE for the whole raster is what lets channel measurement avoid
// per-pair cropped EDTs. A crop tight to a pair cannot see the background just
// outside it, so it overestimates distances at a cell's extremes; that bug has
// already been found and fixed once in this project's field-scaffold work, and
// this approach cannot reintroduce it.
export function nearestCellTransform(mask, w, h) {
  const n = w * h;
  const label = new Int32Array(n);
  const sx = new Int32Array(n).fill(-1);
  const sy = new Int32Array(n).fill(-1);
  const d2 = new Float64Array(n).fill(Infinity);
  const { labels } = labelComponents(mask, w, h, 8);

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    label[i] = labels[i];
    sx[i] = i % w;
    sy[i] = (i - (i % w)) / w;
    d2[i] = 0;
  }

  // Pull j's site into i if it is closer than i's current one.
  const relax = (i, j) => {
    if (sx[j] < 0) return;
    const x = i % w, y = (i - (i % w)) / w;
    const dx = x - sx[j], dy = y - sy[j];
    const c = dx * dx + dy * dy;
    if (c >= d2[i]) return;
    d2[i] = c; sx[i] = sx[j]; sy[i] = sy[j]; label[i] = label[j];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1);
      if (y > 0) relax(i, i - w);
      if (x > 0 && y > 0) relax(i, i - w - 1);
      if (x + 1 < w && y > 0) relax(i, i - w + 1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x + 1 < w) relax(i, i + 1);
      if (y + 1 < h) relax(i, i + w);
      if (x + 1 < w && y + 1 < h) relax(i, i + w + 1);
      if (x > 0 && y + 1 < h) relax(i, i + w - 1);
    }
  }

  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) dist[i] = Math.sqrt(d2[i]);
  return { label, sx, sy, dist };
}

// The narrowest channel between every pair of adjacent cells.
//
// A background pixel whose neighbour belongs to a DIFFERENT cell sits on the
// watershed between them, and the channel width there is the sum of the two
// pixels' distances to their own cells. Taking the minimum over the whole
// watershed gives the narrowest passage, and the two site points give the
// bridge its endpoints — boundary points, not centres, because a capsule
// between centres produces bone shapes.
export function measureChannels(mask, w, h) {
  const { label, sx, sy, dist } = nearestCellTransform(mask, w, h);
  const best = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] || !label[i]) continue;
      // Right and down only: every unordered neighbour pair is still visited
      // exactly once, at half the work.
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0 || mask[j] || !label[j] || label[j] === label[i]) continue;
        const gap = dist[i] + dist[j];
        const a = Math.min(label[i], label[j]);
        const b = Math.max(label[i], label[j]);
        const k = `${a}:${b}`;
        const cur = best.get(k);
        if (cur && cur.gap <= gap) continue;
        const [lo, hi] = label[i] < label[j] ? [i, j] : [j, i];
        best.set(k, { a, b, gap, ax: sx[lo], ay: sy[lo], bx: sx[hi], by: sy[hi] });
      }
    }
  }
  return [...best.values()].sort((p, q) => p.gap - q.gap);
}

// How many necks any one cell may take.
//
// Sorting by channel width alone chains consecutive cells into one long arc,
// because channels narrow toward the centre and the inner band therefore owns
// the head of the sorted list. The cap bounds that, and is also what leaves
// islands unjoined at the top of the range: with a cap of 2 the joined cells
// form chains and rings, never a solid merged mass.
//
// CONSTANT, not a function of Join. The spec proposed ramping it 1 -> 2 across
// the slider, but measured on a 46-cell design that made the cap bind long
// before the budget did: neck counts came out 21, 21, 43, 43, 43 across
// Join 0.2..1.0 — two steps, not a ramp. The ramp belongs entirely to the
// budget below.
export const DEGREE_CAP = 2;

// Greedy narrowest-first accumulation under the degree cap, stopping at `limit`.
function accumulate(pairs, limit) {
  const deg = new Map();
  const out = [];
  for (const p of pairs) {
    if (out.length >= limit) break;
    const da = deg.get(p.a) ?? 0, db = deg.get(p.b) ?? 0;
    if (da >= DEGREE_CAP || db >= DEGREE_CAP) continue;
    deg.set(p.a, da + 1);
    deg.set(p.b, db + 1);
    out.push(p);
  }
  return out;
}

// Take pairs narrowest-first until the Join budget is spent.
//
// The budget is a fraction of what the cap ACTUALLY allows, not of the raw pair
// count. Most pairs are unreachable — a 46-cell design offers 119 adjacent pairs
// but the cap admits at most 43 — so scaling against the raw count spends the
// whole slider inside the saturated region and the control stops responding
// above about 0.3.
export function selectJoins(pairs, join) {
  if (join <= 0) return [];
  const achievable = accumulate(pairs, Infinity).length;
  return accumulate(pairs, Math.round(join * achievable));
}

// Neck half-width, as a fraction of the SMALLER joined cell's inradius — not of
// the channel between them.
//
// Scaling the neck by the gap makes its width independent of the cells it
// joins, and since channels here are far narrower than cells the result is a
// thin stick between two lobes: dumbbells, not the reference's broad
// parallel-sided passages. In the reference the neck is a substantial fraction
// of the lobe it leaves, which is what makes the waist read as a pinch in one
// continuous form rather than as a rod bolted between two shapes.
export const NECK_WIDTH = 0.42;

// Fillet radius as a fraction of the neck's own half-width. Proportional to the
// neck rather than to the gap, for the same reason.
export const FILLET_K = 0.85;

// A neck must still physically span its channel however small the cells are.
export const NECK_MIN_GAP_FRAC = 0.6;

// The largest inscribed radius within each cell, in cells. Read from the inside
// half of the signed EDT, which already measures exactly this.
export function cellInradii(mask, w, h, signed, labels) {
  const inr = new Map();
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const id = labels[i];
    if (!id) continue;
    const d = -signed[i];
    if (d > (inr.get(id) ?? 0)) inr.set(id, d);
  }
  return inr;
}

export function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 <= 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// Selected pairs, in raster coordinates, become bridge stubs in world units.
// `toWorld(i, j)` converts a pixel to world space; `cellSize` is world units per
// cell, which is what turns a gap measured in cells into a world radius.
export function makeNecks(selected, toWorld, cellSize, inradii = null) {
  return selected.map((p) => {
    const [ax, ay] = toWorld(p.ax, p.ay);
    const [bx, by] = toWorld(p.bx, p.by);
    const gap = p.gap * cellSize;
    // The smaller of the two lobes sets the neck's width, so a neck never
    // arrives wider than the cell it leaves.
    const lobe = inradii
      ? Math.min(inradii.get(p.a) ?? 0, inradii.get(p.b) ?? 0) * cellSize
      : gap;
    const r = Math.max(NECK_WIDTH * lobe, NECK_MIN_GAP_FRAC * gap);
    return { ax, ay, bx, by, r, kf: FILLET_K * r };
  });
}

// The joined field: the base distance, unioned with each neck stub through a
// CIRCULAR FILLET.
//
// Not a polynomial smin. A fillet cuts a concave tangent arc in the corner where
// the two surfaces meet, which is the waist this look is built on; smin bulges
// convexly there and reads as soap bubbles (js/shader.js:89).
//
// `base` must be a true signed DISTANCE. makeWaterField returns
// `iso - thickness`, whose gradient is nowhere near 1, and unionRound computes a
// fillet of radius kf in the metric of its arguments — feeding it a non-distance
// produces a fillet of the wrong size.
//
// `filletCap` bounds every fillet radius. A blend expressed in raster widths is
// an absolute size, so at coarse rasters an uncapped blend closes channels by
// itself and Join stops controlling the topology.
export function makeJoinedField(base, necks, filletCap = Infinity) {
  return (x, y) => {
    let d = base(x, y);
    for (const nk of necks) {
      const kf = Math.min(nk.kf, filletCap);
      const ds = sdSegment(x, y, nk.ax, nk.ay, nk.bx, nk.by) - nk.r;
      // Beyond kf of both surfaces the fillet union is identical to min(), so
      // skipping there is an optimisation and not an approximation.
      if (ds > kf && d > kf) { d = Math.min(d, ds); continue; }
      d = unionRound(d, ds, kf);
    }
    return d;
  };
}

// Build the joined field for a state, baking once rather than evaluating per
// pixel per frame. Both the renderer and the vector export read this one
// artefact, so the joined path adds no new CPU/GLSL mirror.
export function buildJoinedField(state, { aspect = FORMATS.portrait, res = 1024 } = {}) {
  const analytic = makeWaterField(state);
  const join = state.join ?? 0;

  // res is the LONG edge, so a landscape bake costs the same as a portrait one.
  const w = aspect >= 1 ? res : Math.round(res * aspect);
  const h = aspect >= 1 ? Math.round(res / aspect) : res;
  const total = w * h;
  const cellSize = 2 / h;                       // world units per cell
  const toWorld = (i, j) => [
    (-1 + (2 * (i + 0.5)) / w) * aspect,
    1 - (2 * (j + 0.5)) / h,
  ];

  if (join <= 0) {
    // Identity. Returning the analytic field ITSELF rather than a bake of it is
    // what makes Join 0 bit-identical to today rather than merely close.
    return {
      sample: analytic, grid: null, w, h, aspect, cellSize, necks: [], pairs: [],
    };
  }

  // Rasterise. `raw` keeps the analytic value, not just its sign.
  const raw = new Float64Array(total);
  const mask = new Uint8Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = toWorld(i, j);
      const v = analytic(x, y);
      raw[j * w + i] = v;
      mask[j * w + i] = v < 0 ? 1 : 0;
    }
  }

  const pairs = measureChannels(mask, w, h);
  const selected = selectJoins(pairs, join);

  // The base for the fillet must be a true DISTANCE — see makeJoinedField.
  const edtCells = signedEdt(mask, w, h);
  const { labels } = labelComponents(mask, w, h, 8);
  const inradii = cellInradii(mask, w, h, edtCells, labels);
  const necks = makeNecks(selected, toWorld, cellSize, inradii);

  // Half the narrowest channel Join did NOT select.
  //
  // The cap exists to stop the blend closing channels by itself, and a channel
  // that was selected is meant to close — measuring against it instead pins the
  // cap to the tightest gap in the design and shrinks every fillet to nothing
  // as soon as one pair is very close.
  const chosen = new Set(selected.map((p) => `${p.a}:${p.b}`));
  const unselected = pairs.filter((p) => !chosen.has(`${p.a}:${p.b}`));
  const filletCap = unselected.length ? unselected[0].gap * cellSize * 0.5 : Infinity;

  const dist = new Float64Array(total);
  for (let i = 0; i < total; i++) dist[i] = edtCells[i] * cellSize;
  const distSample = gridSampler(dist, w, h, aspect);
  const joined = makeJoinedField(distSample, necks, filletCap);

  // Where the necks changed nothing, keep the ANALYTIC value. Thresholding to a
  // binary mask and rebuilding distance from it quantises the zero level set to
  // a half-cell staircase at EVERY resolution — 0.225 cells RMS versus 0.002 for
  // this hybrid (bake.js:236-253). The two expressions differ in scale away from
  // the boundary but agree in sign, and every zero crossing lies inside
  // whichever region owns it.
  const grid = new Float64Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const [x, y] = toWorld(i, j);
      const dj = joined(x, y);
      // If no neck moved this cell, the joined distance still equals the EDT
      // distance there, and the analytic value is the more precise of the two.
      grid[k] = Math.abs(dj - dist[k]) < 1e-12 ? raw[k] : dj;
    }
  }

  return {
    sample: gridSampler(grid, w, h, aspect),
    grid, w, h, aspect, cellSize, necks, pairs, unselected, filletCap,
  };
}
