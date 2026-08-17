// Cymatic Join: bridge neighbouring cells with filleted necks.
//
// The cells in Detailed Cymatic are a threshold on |psi| (cymafield.js:186), so
// the shape of the passage between two of them is whatever the field's saddle
// happens to be, and lowering the threshold joins dozens of cells at once
// rather than two chosen ones. A designed neck therefore cannot be a level set
// of the field; it has to be a geometric operation on identified cells, which
// is a whole-image job and bakes rather than evaluating per pixel per frame.
import { labelComponents } from './bake.js?v=87f2b33d';

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
