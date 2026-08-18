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
} from './bake.js?v=17f9b6fa';
import { unionRound } from './blobfield.js?v=17f9b6fa';
import { makeWaterField } from './cymafield.js?v=17f9b6fa';

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
// `nct` lets a caller that already has the transform hand it in. It is the most
// expensive step here, and the bake needs it for Roundness as well.
export function measureChannels(mask, w, h, nct = null) {
  const { label, sx, sy, dist } = nct ?? nearestCellTransform(mask, w, h);
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

// The smallest cell that may take a neck at all, as a fraction of the design's
// MEDIAN cell inradius.
//
// A neck is a fraction of the smaller cell it joins, so joining a speck forces
// a thread. On the reference design the inradii run 1.0, 1.0, 1.0, 1.0, 1.4,
// 2.0, 2.0, 3.6, 3.6, 4.2, 4.2 and then jump to 8.0 against a median of 28 —
// the specks are the starburst petals at the modal centre, and there is a clean
// break below about a quarter of the median. Cells under the threshold stay as
// isolated forms, which is what they should read as.
export const MIN_CELL_FRAC = 0.25;

export function medianInradius(inradii) {
  const v = [...inradii.values()].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

// Pairs whose smaller cell is big enough to carry a visibly liquid neck.
// Rejected pairs are SKIPPED, never joined with a thinner neck.
export function viablePairs(pairs, inradii) {
  const floor = MIN_CELL_FRAC * medianInradius(inradii);
  return pairs.filter((p) => Math.min(inradii.get(p.a) ?? 0, inradii.get(p.b) ?? 0) >= floor);
}

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
// The narrowest UNSELECTED channel each cell still has, in cells. A neck's
// fillet must not reach across one of these and close it.
export function cellClearance(unselected) {
  const clear = new Map();
  for (const p of unselected) {
    for (const id of [p.a, p.b]) {
      const cur = clear.get(id);
      if (cur === undefined || p.gap < cur) clear.set(id, p.gap);
    }
  }
  return clear;
}

export function makeNecks(selected, toWorld, cellSize, inradii = null, clearance = null) {
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

    // The fillet is capped LOCALLY, by the tightest unselected channel these two
    // cells still have — not by the tightest one anywhere in the design.
    //
    // A global cap is pinned by whichever pair in the whole field happens to sit
    // closest, and in a 46-cell design that collapses every fillet to nearly
    // zero. unionRound then degenerates to min(), the neck meets the lobe at a
    // hard corner, and the form reads as a tube butted onto a blob rather than
    // as one pinched shape — visible immediately in a shaded preview and almost
    // invisible in a flat silhouette.
    const local = clearance
      ? Math.min(clearance.get(p.a) ?? Infinity, clearance.get(p.b) ?? Infinity) * cellSize
      : Infinity;
    const kf = Math.min(FILLET_K * r, Number.isFinite(local) ? local * 0.5 : Infinity);
    return { a: p.a, b: p.b, ax, ay, bx, by, r, kf };
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
// `extent` is the world half-height the raster covers: y spans [-extent, extent]
// and x spans [-aspect*extent, aspect*extent].
//
// It must cover the WHOLE design, not just the on-screen frame. The plate mask
// runs out to r = 1.30 (cymafield.js:201), so a bake at extent 1 clips every
// cell beyond the frame — and clipping before the channels are measured invents
// boundaries that are not in the design, which is worse than cropping a picture.
export function buildJoinedField(
  state, { aspect = FORMATS.portrait, res = 1024, extent = 1 } = {},
) {
  const analytic = makeWaterField(state);
  const join = state.join ?? 0;

  // res is the LONG edge, so a landscape bake costs the same as a portrait one.
  const w = aspect >= 1 ? res : Math.round(res * aspect);
  const h = aspect >= 1 ? Math.round(res / aspect) : res;
  const total = w * h;
  const cellSize = (2 * extent) / h;            // world units per cell
  const toWorld = (i, j) => [
    (-1 + (2 * (i + 0.5)) / w) * aspect * extent,
    (1 - (2 * (j + 0.5)) / h) * extent,
  ];
  // gridSampler's window is x in [-aspect, aspect], y in [-1, 1], so world
  // points are normalised into it. The VALUES it returns are still true world
  // distances, because cellSize already carries `extent`.
  const sampler = (grid) => {
    const g = gridSampler(grid, w, h, aspect);
    return (x, y) => g(x / extent, y / extent);
  };

  // Identity. Returning the analytic field ITSELF rather than a bake of it is
  // what makes the default bit-identical to today rather than merely close.
  if (join <= 0 && (state.roundness ?? 0) <= 0) {
    return {
      sample: analytic, grid: null, w, h, aspect, extent, cellSize,
      necks: [], pairs: [], unselected: [], filletCap: Infinity,
      shapes: null, roundness: 0,
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

  // The base for the fillet must be a true DISTANCE — see makeJoinedField.
  const edtCells = signedEdt(mask, w, h);
  const { labels } = labelComponents(mask, w, h, 8);
  const distRaw = new Float64Array(total);
  for (let i = 0; i < total; i++) distRaw[i] = edtCells[i] * cellSize;

  // ── Roundness, BEFORE Join ────────────────────────────────────────────
  //
  // Measured on the ORIGINAL cells, so the clearance a rounded body is allowed
  // to grow into is the channel the cymatic field actually left there.
  const roundness = state.roundness ?? 0;
  let dist = distRaw;
  let bodyMask = mask;
  let shapes = null;
  if (roundness > 0) {
    // ONE nearest-cell transform, shared by the clearance measurement and the
    // territory partition the blend runs over. It is the most expensive step in
    // the bake and computing it twice doubled the cost.
    const nct0 = nearestCellTransform(mask, w, h);
    shapes = cellShapes(mask, w, h, labels, toWorld, cellSize);
    const clearance0 = cellClearance(measureChannels(mask, w, h, nct0));
    const inradii0 = cellInradii(mask, w, h, edtCells, labels);
    dist = roundCells(distRaw, mask, w, h, labels, shapes, clearance0,
      { roundness, cellSize, toWorld, nct: nct0, inradii: inradii0 });
    // Channels are re-measured against the ROUNDED bodies, so Join necks meet
    // the shapes that are actually drawn rather than the ones they replaced.
    bodyMask = new Uint8Array(total);
    for (let i = 0; i < total; i++) bodyMask[i] = dist[i] < 0 ? 1 : 0;
  }

  const bodyLabels = roundness > 0
    ? labelComponents(bodyMask, w, h, 8).labels : labels;
  const inradii = cellInradii(bodyMask, w, h,
    roundness > 0 ? dist : edtCells, bodyLabels);

  const pairs = measureChannels(bodyMask, w, h);
  const viable = viablePairs(pairs, inradii);
  const selected = selectJoins(viable, join);

  // A channel Join selected is MEANT to close, so it is excluded from the
  // clearances the fillets are capped against.
  const chosen = new Set(selected.map((p) => `${p.a}:${p.b}`));
  const unselected = pairs.filter((p) => !chosen.has(`${p.a}:${p.b}`));

  const necks = makeNecks(selected, toWorld, cellSize, inradii,
    cellClearance(unselected));

  // Each neck carries its own cap, so no global one is applied.
  const filletCap = Infinity;

  // The grid: the base distance, with each neck filleted in over its own
  // bounding box only.
  //
  // makeJoinedField() is the DEFINITION, and js/export.js still uses it for the
  // analytic path — but evaluating it per pixel means every neck is tested
  // against every pixel: 1.05M x 32 = 33M segment evaluations, measured at
  // ~700ms of a ~1s bake. A fillet union is identical to min() beyond kf of both
  // surfaces, so outside a neck's own reach there is nothing to compute.
  const grid = new Float64Array(total);
  const analyticGeometry = roundness <= 0;
  // Where nothing moved the cell, keep the ANALYTIC value: thresholding to a
  // binary mask and rebuilding distance from it quantises the zero level set to
  // a half-cell staircase at EVERY resolution — 0.225 cells RMS versus 0.002
  // (bake.js:236-253). Above Roundness 0 the bodies are a blend toward ellipses,
  // so `raw` describes a different shape and substituting it would tear the
  // contour apart.
  for (let i = 0; i < total; i++) grid[i] = analyticGeometry ? raw[i] : dist[i];

  // Pixel index from world, inverting toWorld.
  const toPixX = (x) => ((x / (aspect * extent) + 1) / 2) * w - 0.5;
  const toPixY = (y) => ((1 - y / extent) / 2) * h - 0.5;

  for (const nk of necks) {
    const kf = Math.min(nk.kf, filletCap);
    const reach = nk.r + kf;
    const i0 = Math.max(0, Math.floor(toPixX(Math.min(nk.ax, nk.bx) - reach)));
    const i1 = Math.min(w - 1, Math.ceil(toPixX(Math.max(nk.ax, nk.bx) + reach)));
    const j0 = Math.max(0, Math.floor(toPixY(Math.max(nk.ay, nk.by) + reach)));
    const j1 = Math.min(h - 1, Math.ceil(toPixY(Math.min(nk.ay, nk.by) - reach)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        const [x, y] = toWorld(i, j);
        const ds = sdSegment(x, y, nk.ax, nk.ay, nk.bx, nk.by) - nk.r;
        // Seeded from `dist`, not from `grid`: successive necks must union
        // against the true base distance, and `grid` may still hold the analytic
        // value at this pixel.
        const base = grid[k] === (analyticGeometry ? raw[k] : dist[k]) ? dist[k] : grid[k];
        grid[k] = unionRound(base, ds, kf);
      }
    }
  }

  return {
    sample: sampler(grid),
    grid, w, h, aspect, extent, cellSize, necks, pairs, unselected, filletCap,
    shapes, roundness,
  };
}

// ── Cell Roundness ─────────────────────────────────────────────────────
//
// Relax each segmented cell toward its OWN area-matched ellipse. Nothing new is
// scattered and no primitive is overlaid: the ellipse is derived from the cell's
// image moments, so it inherits that cell's centroid, area and direction, and at
// roundness 0 the field is returned untouched.
//
// Runs BEFORE Join, so the necks are measured and filleted against the rounded
// bodies rather than the raw ones.

// How far a rounded cell may grow outward, as a fraction of the tightest channel
// it has. Two neighbours each growing by this leaves 1 - 2 * 0.4 = 20% of the
// channel still open, so rounding can never close a nodal channel or push two
// unrelated cells into contact.
export const ROUND_GROW_FRAC = 0.4;

// Approximate ellipse SDF. Exact for circles and close enough for the modest
// ratios this produces; the exact form needs an iterative root solve. MIRRORS
// sdEllipsef() in js/shader.js.
export function sdEllipse(px, py, rx, ry, rot) {
  const ca = Math.cos(-rot), sa = Math.sin(-rot);
  const qx = px * ca - py * sa, qy = px * sa + py * ca;
  const k1 = Math.hypot(qx / rx, qy / ry);
  const k2 = Math.hypot(qx / (rx * rx), qy / (ry * ry));
  if (k2 === 0) return -Math.min(rx, ry);
  return ((k1 - 1) * k1) / k2;
}

// Centroid, area and principal axes of every cell, from image moments.
//
// Moments rather than a bounding box: a box has no orientation, so an elongated
// cell lying diagonally would round toward a circle and lose the direction the
// modal field gave it.
export function cellShapes(mask, w, h, labels, toWorld, cellSize) {
  const acc = new Map();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!mask[k]) continue;
      const id = labels[k];
      if (!id) continue;
      let a = acc.get(id);
      if (!a) { a = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }; acc.set(id, a); }
      const [x, y] = toWorld(i, j);
      a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y;
    }
  }

  const out = new Map();
  for (const [id, a] of acc) {
    const cx = a.sx / a.n, cy = a.sy / a.n;
    const mu20 = a.sxx / a.n - cx * cx;
    const mu02 = a.syy / a.n - cy * cy;
    const mu11 = a.sxy / a.n - cx * cy;
    const half = (mu20 + mu02) / 2;
    const disc = Math.sqrt(Math.max(0, ((mu20 - mu02) / 2) ** 2 + mu11 * mu11));
    const l1 = Math.max(1e-12, half + disc), l2 = Math.max(1e-12, half - disc);
    out.set(id, {
      cx, cy,
      area: a.n * cellSize * cellSize,
      rot: 0.5 * Math.atan2(2 * mu11, mu20 - mu02),
      ratio: Math.min(1, Math.sqrt(l2 / l1)),      // 1 = round, 0 = a line
    });
  }
  return out;
}

// How circular a given cell should become at this Roundness.
//
// Compact cells round the hardest; elongated ones keep part of their direction,
// because a modal field's long cells ARE the pattern and turning them into discs
// erases the cymatic organisation the design is built on.
// A near-degenerate cell has no usable direction, and an area-matched ellipse
// for one is a sliver. Floor the ratio so rounding always produces a body.
export const MIN_ELLIPSE_RATIO = 0.18;

export function roundTarget(ratio, roundness) {
  const r = Math.max(MIN_ELLIPSE_RATIO, ratio);
  const strength = Math.min(1, roundness * (0.35 + 0.65 * r));
  return { blend: strength, ratio: r + (1 - r) * strength };
}

// Blend every cell's signed distance toward its area-matched ellipse.
//
// `signed` and the result are in WORLD units, negative inside.
export function roundCells(signed, mask, w, h, labels, shapes, clearance, {
  roundness = 0, cellSize = 1, toWorld, nct = null, inradii = null,
} = {}) {
  if (roundness <= 0) return signed;
  const out = Float64Array.from(signed);

  // The specks at the modal centre are left exactly as they are — the same
  // cells Join already declines to join, for the same reason: there is no body
  // there to round, only a sliver, and rounding one produces a thread the
  // contour cannot resolve. Measured at 6.1px of canvas/SVG divergence,
  // entirely at the centre, before this skip existed.
  const floor = inradii ? MIN_CELL_FRAC * medianInradius(inradii) : 0;

  // Precompute each cell's target ellipse once rather than per pixel.
  const ell = new Map();
  for (const [id, sh] of shapes) {
    if (floor > 0 && (inradii.get(id) ?? 0) < floor) continue;
    const { blend, ratio } = roundTarget(sh.ratio, roundness);
    // Area is preserved exactly: A = PI * a * b with b = a * ratio.
    const rx = Math.sqrt(sh.area / (Math.PI * Math.max(1e-6, ratio)));
    const grow = ROUND_GROW_FRAC * ((clearance.get(id) ?? Infinity) * cellSize);
    ell.set(id, { ...sh, blend, rx, ry: rx * ratio, grow });
  }

  // The nearest-cell transform partitions the plane, so every pixel is blended
  // against exactly ONE cell's ellipse — which is what keeps a rounded body
  // inside its own territory and out of its neighbours'.
  const { label } = nct ?? nearestCellTransform(mask, w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const id = label[k];
      if (!id) continue;
      const e = ell.get(id);
      if (!e || e.blend <= 0) continue;
      const [x, y] = toWorld(i, j);
      const de = sdEllipse(x - e.cx, y - e.cy, e.rx, e.ry, e.rot);
      const blended = signed[k] * (1 - e.blend) + de * e.blend;
      // Cap outward growth. Where the ellipse reaches past the cell this is what
      // stops it crossing a nodal channel; inward relaxation is unconstrained.
      out[k] = Number.isFinite(e.grow) ? Math.max(blended, signed[k] - e.grow) : blended;
    }
  }
  return out;
}

// The bake window every consumer shares.
//
// FIXED, not derived from the output frame. The bake's cell size is
// (2 * extent) / h, so a window keyed to the canvas or page aspect rasterises
// the same design at different fineness and changes which cells connect —
// measured at 66 cells portrait against 61 landscape. A design must not change
// topology because the window was resized or the export was rotated.
//
// 1.40 always covers a Detailed Cymatic figure: the plate mask reaches zero by
// r = 1.30 (cymafield.js:201), so nothing exists beyond it.
export const CANON_EXTENT = 1.40;

// Everything the baked geometry depends on. Anything absent here can change
// without invalidating the cache, so this list must stay complete.
const FIELD_KEYS = [
  'm', 'n', 'kr', 'ma', 'mix', 'amp', 'fine', 'chaos',
  'simple', 'swell', 'mass', 'phase', 'grow', 'join', 'roundness', 'variation',
];

let cache = null;

// The joined field for a state, baked once and reused.
//
// Single-entry: only one design is on screen at a time, and the screen and the
// export ask for the same one within a few milliseconds of each other. Without
// this, exporting would repeat a bake the renderer just did.
export function joinedField(state, { res = 1024 } = {}) {
  const key = `${FIELD_KEYS.map((k) => state[k] ?? 0).join(',')}|${res}`;
  if (cache && cache.key === key) return cache.value;
  const value = buildJoinedField(state, { aspect: 1, res, extent: CANON_EXTENT });
  cache = { key, value };
  return value;
}

export function clearJoinCache() { cache = null; }
