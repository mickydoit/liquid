// Bake: rasterise a signed field, clean it with real morphology, and hand back
// a cleaned signed field.
//
// Morphological closing, component culling and hole removal are GLOBAL
// operations over a raster. No per-pixel function can express them, in JS or
// in GLSL — which is why the simplified style bakes on settle rather than
// being evaluated per pixel per frame like cymafield.js.
//
// Everything here is expressed in terms of an exact Euclidean distance
// transform: dilation by r is {d <= r}, erosion by r is {d < -r} — strict,
// not <=. There is no zero level set: edt measures cell-centre to
// cell-centre, so the nearest inside cell to any boundary is at magnitude 1,
// never 0. {d <= -r} would therefore retain every inside cell at r = 1 (an
// identity, not an erosion), while duality with dilate (which grows the
// outside starting from magnitude 1 too) demands the strict form. That
// avoids the blocky artefacts of iterative square-kernel dilate/erode.

const INF = 1e20;

// Felzenszwalb & Huttenlocher 1D squared-distance transform: the lower
// envelope of parabolas rooted at each sample. Exact and linear.
function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Distance in cells from every cell to the nearest cell where mask === 0.
export function edt(mask, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < mask.length; i++) g[i] = mask[i] ? INF : 0;

  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}

// Negative inside the mask, positive outside.
export function signedEdt(mask, w, h) {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const dOut = edt(mask, w, h);   // distance from inside to the outside
  const dIn = edt(inv, w, h);     // distance from outside to the inside
  const out = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? -dOut[i] : dIn[i];
  return out;
}

// Morphology via the distance transform. Dilation by r is every cell within r
// of the mask; erosion by r is every masked cell at least r from the boundary.
// Both use a true circular structuring element, unlike iterative kernels.

export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = signedEdt(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

// STRICT comparison. edt is cell-centre to cell-centre, so no inside cell has
// distance 0 and `<= -r` would be an identity at r = 1 rather than an erosion.
// Duality with dilate demands `< -r`; getting this wrong makes close() grow the
// shape by a ring every time instead of leaving it unchanged.
export function erode(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = signedEdt(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = d[i] < -r ? 1 : 0;
  return out;
}

// Fills gaps and pinholes narrower than r.
export function close(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  return erode(dilate(mask, w, h, r), w, h, r);
}

// Removes filaments and spurs thinner than r. A waist wider than 2r survives,
// which is exactly how an intentional waist is told from a hairline bridge.
export function open(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  return dilate(erode(mask, w, h, r), w, h, r);
}

// Connected components by iterative flood fill. Iterative rather than
// recursive: a full-frame component would blow the call stack.
//
// Foreground uses 8-connectivity and background 4-connectivity. Using the same
// for both produces the classic paradox where a diagonal line simultaneously
// does and does not separate the regions either side of it.
export function labelComponents(mask, w, h, connectivity = 8) {
  const labels = new Int32Array(w * h);
  const sizes = [];
  const stack = [];
  const d8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nbrs = connectivity === 4 ? d8.slice(0, 4) : d8;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = sizes.length + 1;
    let n = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const cur = stack.pop();
      n++;
      const cx = cur % w, cy = (cur - cx) / w;
      for (const [dx, dy] of nbrs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] && !labels[ni]) { labels[ni] = id; stack.push(ni); }
      }
    }
    sizes.push(n);
  }
  return { labels, sizes };
}

// Drop foreground components below minArea cells — the detached specks.
export function cullComponents(mask, w, h, minArea) {
  if (minArea <= 1) return Uint8Array.from(mask);
  const { labels, sizes } = labelComponents(mask, w, h, 8);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = labels[i] && sizes[labels[i] - 1] >= minArea ? 1 : 0;
  }
  return out;
}

// Fill background components below minArea that do NOT touch the border. A
// background region reaching the border is the exterior, not a hole.
export function cullHoles(mask, w, h, minArea) {
  if (minArea <= 1) return Uint8Array.from(mask);
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const { labels, sizes } = labelComponents(inv, w, h, 4);

  const touchesBorder = new Uint8Array(sizes.length + 1);
  for (let x = 0; x < w; x++) {
    if (labels[x]) touchesBorder[labels[x]] = 1;
    const b = (h - 1) * w + x;
    if (labels[b]) touchesBorder[labels[b]] = 1;
  }
  for (let y = 0; y < h; y++) {
    if (labels[y * w]) touchesBorder[labels[y * w]] = 1;
    const r = y * w + w - 1;
    if (labels[r]) touchesBorder[labels[r]] = 1;
  }

  const out = Uint8Array.from(mask);
  for (let i = 0; i < mask.length; i++) {
    const id = labels[i];
    if (id && !touchesBorder[id] && sizes[id - 1] < minArea) out[i] = 1;
  }
  return out;
}

// Frame ratios (width / height). The frame is x in [-a, a], y in [-1, 1].
export const FORMATS = { portrait: 2 / 3, square: 1, landscape: 3 / 2 };

// Rasterise, clean, and recover a signed field.
//
// `simplify` in [0,1] scales all four cleanup radii together, so one control
// takes the result from "every detail kept" to "macro-forms only".
export function bake(field, { aspect = FORMATS.portrait, res = 1024, simplify = 0.5 } = {}) {
  // `res` is the LONG edge, so a landscape bake costs the same as a portrait
  // one. Deriving `h = res` unconditionally would make landscape 2.25x the
  // work of portrait at the same nominal resolution, for no stated reason.
  const w = aspect >= 1 ? res : Math.round(res * aspect);
  const h = aspect >= 1 ? Math.round(res / aspect) : res;
  const total = w * h;

  // World units per cell. y spans [-1, 1] over h cells.
  const scale = 2 / h;
  const toWorld = (i, j) => [(-1 + (2 * (i + 0.5)) / w) * aspect, 1 - (2 * (j + 0.5)) / h];

  let mask = new Uint8Array(total);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = toWorld(i, j);
      mask[j * w + i] = field(x, y) < 0 ? 1 : 0;
    }
  }

  // Radii in CELLS, derived from `simplify` and scaled by resolution so the
  // result is resolution-independent.
  const closeR = (0.004 + simplify * 0.020) * h;
  const openR = (0.003 + simplify * 0.016) * h;
  const minArea = (0.0004 + simplify * 0.008) * total;
  const minHole = (0.0004 + simplify * 0.010) * total;

  mask = close(mask, w, h, closeR);          // bridge gaps
  mask = cullHoles(mask, w, h, minHole);     // pinholes out
  mask = open(mask, w, h, openR);            // hairline filaments out
  mask = cullComponents(mask, w, h, minArea); // detached specks out
  mask = cullHoles(mask, w, h, minHole);     // opening can open new pinholes

  // Recover a clean signed field, converted from cells back to world units.
  const cells = signedEdt(mask, w, h);
  const grid = new Float64Array(total);
  for (let i = 0; i < total; i++) grid[i] = cells[i] * scale;

  const FAR = 10;
  const sample = (x, y) => {
    // World -> continuous grid coordinates.
    const gi = ((x / aspect + 1) / 2) * w - 0.5;
    const gj = ((1 - y) / 2) * h - 0.5;
    // Reject only points genuinely beyond the declared frame — more than one
    // cell past the outermost row/column. The old check (`gi < 0 || gi > w - 1`,
    // and the gj equivalent) rejected anything past the outermost row/column's
    // fictitious cell-CENTRE, which is half a cell inside the declared frame
    // edge (x = +-aspect, y = +-1) on every side, and which float error can
    // push a point below even at an exact cell centre (e.g. the top row lands
    // at gj ~= -4.8e-16 instead of 0 for most w/h). Clamping below, rather than
    // rejecting, keeps every declared-frame point and every outermost-row/
    // column point sampling its real nearest cell, while still calling
    // anything actually outside that margin FAR.
    if (gi < -1 || gj < -1 || gi > w || gj > h) return FAR;
    const ci = gi < 0 ? 0 : gi > w - 1 ? w - 1 : gi;
    const cj = gj < 0 ? 0 : gj > h - 1 ? h - 1 : gj;
    const i0 = Math.floor(ci), j0 = Math.floor(cj);
    const i1 = Math.min(i0 + 1, w - 1), j1 = Math.min(j0 + 1, h - 1);
    const fx = ci - i0, fy = cj - j0;
    const a = grid[j0 * w + i0], b = grid[j0 * w + i1];
    const c = grid[j1 * w + i0], d = grid[j1 * w + i1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  return { grid, mask, w, h, aspect, sample };
}
