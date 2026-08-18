// Contouring: turn any scalar field into editable vector outlines.
//
// Marching squares -> stitched rings -> ring-aware simplification -> periodic
// bezier fitting. Nothing here knows what produced the field, which is why it
// can trace a cymatic water thickness field directly rather than tracing a
// rasterisation of one. That is what makes the SVG/PDF export the true shape.

// Marching squares at iso = 0, returning closed loops of [x, y] points.
export function marchingSquares(field, bounds, res = 320, iso = 0, sealBorder = true) {
  const { x0, y0, x1, y1 } = bounds;
  const dx = (x1 - x0) / res, dy = (y1 - y0) / res;
  const n = res + 1;
  const v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) v[j * n + i] = field(x0 + i * dx, y0 + j * dy) - iso;
  }

  // SEAL THE BORDER: force the outermost ring of samples to read as outside.
  //
  // A contour that reaches the edge of the sampled rectangle leaves stitchLoops
  // with an OPEN chain, and ringToPath closes it with a straight chord — which
  // an even-odd fill then inverts into a wedge slicing across the design. That
  // is the single worst export failure this project has: measured at 25.7px of
  // spurious geometry on a portrait frame, because a portrait view is only 1.05
  // world units wide while the figure reaches 1.105.
  //
  // Sealing makes every loop close, and it closes along the frame — which is
  // what clipping a shape to a page actually means. Callers put the seal OUTSIDE
  // the page via a guard band, so the closure lands where it is cropped away.
  if (sealBorder) {
    const OUT = 1e3;
    for (let i = 0; i < n; i++) {
      v[i] = OUT;                        // bottom row
      v[(n - 1) * n + i] = OUT;          // top row
      v[i * n] = OUT;                    // left column
      v[i * n + n - 1] = OUT;            // right column
    }
  }

  const px = (i) => x0 + i * dx, py = (j) => y0 + j * dy;
  // Zero crossing along an edge. Guarded: two equal values would divide by
  // zero and emit NaN vertices, which stitch into garbage loops.
  const cross = (va, vb, a, b) => (va === vb ? a : a + (b - a) * (va / (va - vb)));

  const segs = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const va = v[j * n + i], vb = v[j * n + i + 1];
      const vc = v[(j + 1) * n + i + 1], vd = v[(j + 1) * n + i];
      let code = 0;
      if (va < 0) code |= 1;
      if (vb < 0) code |= 2;
      if (vc < 0) code |= 4;
      if (vd < 0) code |= 8;
      if (code === 0 || code === 15) continue;

      const eB = () => [cross(va, vb, px(i), px(i + 1)), py(j)];
      const eR = () => [px(i + 1), cross(vb, vc, py(j), py(j + 1))];
      const eT = () => [cross(vd, vc, px(i), px(i + 1)), py(j + 1)];
      const eL = () => [px(i), cross(va, vd, py(j), py(j + 1))];

      switch (code) {
        case 1: case 14: segs.push([eL(), eB()]); break;
        case 2: case 13: segs.push([eB(), eR()]); break;
        case 3: case 12: segs.push([eL(), eR()]); break;
        case 4: case 11: segs.push([eR(), eT()]); break;
        case 6: case 9:  segs.push([eB(), eT()]); break;
        case 7: case 8:  segs.push([eT(), eL()]); break;
        // Saddles: two crossings in one cell, and which pair joins is
        // genuinely ambiguous from the corners alone. Resolve with the cell
        // average — the standard heuristic, and correct for smooth fields.
        case 5:
          if ((va + vb + vc + vd) < 0) segs.push([eL(), eT()], [eB(), eR()]);
          else segs.push([eL(), eB()], [eT(), eR()]);
          break;
        case 10:
          if ((va + vb + vc + vd) < 0) segs.push([eL(), eB()], [eT(), eR()]);
          else segs.push([eL(), eT()], [eB(), eR()]);
          break;
      }
    }
  }
  return stitchLoops(segs, Math.min(dx, dy) * 1e-3);
}

// Join unordered segments end-to-end into closed rings.
function stitchLoops(segs, eps) {
  const K = (p) => `${Math.round(p[0] / eps)}|${Math.round(p[1] / eps)}`;
  const at = new Map();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const k = K(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(idx);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const loop = [segs[s0][0], segs[s0][1]];
    let end = segs[s0][1];
    const startK = K(segs[s0][0]);
    for (;;) {
      const cands = at.get(K(end));
      if (!cands) break;
      const next = cands.find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      const other = K(s[0]) === K(end) ? s[1] : s[0];
      loop.push(other);
      end = other;
      if (K(end) === startK) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Ramer-Douglas-Peucker for a CLOSED ring. The open-chain form collapses a
// ring outright: its first and last points coincide, so the chord it measures
// against has ~zero length and every point looks collinear. Splitting the
// ring at its farthest point and simplifying two open halves avoids that —
// the same fix strands.js carries for closed strand loops.
export function simplifyRing(pts, epsilon) {
  if (pts.length < 4) return pts;
  const a = pts[0];
  let far = 1, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > best) { best = d; far = i; }
  }
  const h1 = rdpOpen(pts.slice(0, far + 1), epsilon);
  const h2 = rdpOpen(pts.slice(far), epsilon);
  return h1.slice(0, -1).concat(h2.slice(0, -1));
}

function rdpOpen(pts, epsilon) {
  if (pts.length < 3) return pts;
  const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
  const ex = x1 - x0, ey = y1 - y0;
  const len = Math.hypot(ex, ey);
  let idx = -1, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i][0] - x0, py = pts[i][1] - y0;
    const d = len < 1e-12 ? Math.hypot(px, py) : Math.abs(px * ey - py * ex) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= epsilon || idx < 0) return [pts[0], pts[pts.length - 1]];
  return rdpOpen(pts.slice(0, idx + 1), epsilon).slice(0, -1).concat(rdpOpen(pts.slice(idx), epsilon));
}

// Periodic Catmull-Rom. The open form in strands.js clamps its end tangents,
// which leaves a visible corner exactly where a ring closes.
// The largest a handle may be, as a fraction of its own segment's length.
//
// Catmull-Rom sets each handle from the NEIGHBOURS' separation, so where a ring
// turns sharply — or where one simplified segment is far shorter than the span
// either side of it — the handle can be several times the segment it belongs to
// and the curve shoots past its own control points. That is what produces long
// spikes and self-intersections out of an otherwise sane polygon. 1/3 is the
// classic non-overshoot bound: at exactly 1/3 with collinear points the cubic
// reduces to the straight line.
const HANDLE_MAX = 1 / 3;

function clampHandle(anchor, handle, segLen) {
  const hx = handle[0] - anchor[0], hy = handle[1] - anchor[1];
  const len = Math.hypot(hx, hy);
  const lim = HANDLE_MAX * segLen;
  if (len <= lim || len < 1e-12) return handle;
  const k = lim / len;
  return [anchor[0] + hx * k, anchor[1] + hy * k];
}

export function closedCatmullRom(pts) {
  const n = pts.length;
  const at = (i) => pts[((i % n) + n) % n];
  const segs = [];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    segs.push({
      c1: clampHandle(p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], segLen),
      c2: clampHandle(p2, [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], segLen),
      end: p2,
    });
  }
  return segs;
}

export function ringToPath(pts, decimals = 2) {
  if (pts.length < 3) return '';
  const f = (v) => +v.toFixed(decimals);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (const { c1, c2, end } of closedCatmullRom(pts)) {
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d + 'Z';
}

// World (blob space) -> pixel space, preserving aspect and centring.
export function makeProjector(bounds, width, height, margin = 0.06) {
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const s = Math.min(width * (1 - 2 * margin) / bw, height * (1 - 2 * margin) / bh);
  const ox = width / 2 - ((bounds.x0 + bounds.x1) / 2) * s;
  // Y is flipped: world Y points up, screen Y points down.
  const oy = height / 2 + ((bounds.y0 + bounds.y1) / 2) * s;
  return { scale: s, project: (x, y) => [x * s + ox, -y * s + oy] };
}

// Outline of a scalar field (negative inside), in pixel space.
export function fieldOutline(field, { bounds = { x0: -1.35, y0: -1.35, x1: 1.35, y1: 1.35 },
                                      width = 1600, height = 1200,
                                      res = 1600, simplify = 0.3, margin = 0.02,
                                      sealBorder = true } = {}) {
  const { project, scale } = makeProjector(bounds, width, height, margin);
  const loops = marchingSquares(field, bounds, res, 0, sealBorder);
  return {
    bounds, scale, project,
    rings: loops
      .map((loop) => simplifyRing(loop.map(([x, y]) => project(x, y)), simplify))
      // res 1600 / simplify 0.3, measured. At 1100/0.6 the modal singularity at
      // the centre of a rounded design — where every nodal petal meets — left a
      // 6px speck the contour could not resolve while the canvas painted it.
      // 1600/0.3 brings every case to 2px; 2200/0.3 reaches 1.4px for twice the
      // samples and more points per ring, which is not worth it.
      //
      // A cymatic field throws off tiny specks at the resolution limit; they
      // add hundreds of paths to the SVG and are invisible at any print size.
      //
      // 4, not 6. At 6 the smallest real cells — the starburst petals at the
      // modal centre — were dropped from the SVG while the canvas still painted
      // them, which measured as 6.7px of canvas-only ink. 4 is the geometric
      // minimum for a closed area, and 3 measures identically, so nothing
      // between them exists to lose.
      .filter((r) => r.length >= 4),
  };
}
