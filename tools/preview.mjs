// Shared renderers for the review tools: flat silhouette, water material
// approximation, exported-path raster, and a caption band.
//
// The water preview APPROXIMATES the WebGL material in js/shader.js — there is
// no GL context in node. It reads the SAME field the silhouette does, so the
// geometry shown is exact and only the shading is invented. Its job is to show
// whether a junction reads as a pinch or a bulge once the form has volume.
import { drawText, GLYPH_H } from './glyphs.mjs';
import { closedCatmullRom } from '../js/contour.js';

export const LABEL_SCALE = 3;
export const LABEL_PAD = 12;
export const LABEL_H = GLYPH_H * LABEL_SCALE + LABEL_PAD * 2;

// World point for a pixel, given a square half-extent S and the frame aspect.
const world = (i, j, w, h, S, aspect) => [
  (-1 + (2 * (i + 0.5)) / w) * aspect * S,
  (1 - (2 * (j + 0.5)) / h) * S,
];

export function silhouette(sample, { w, h, S, aspect = 1, cx = 0, cy = 0 }) {
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = world(i, j, w, h, S, aspect);
      if (sample(x + cx, y + cy) >= 0) continue;
      const o = (j * w + i) * 3;
      rgb[o] = 17; rgb[o + 1] = 17; rgb[o + 2] = 24;
    }
  }
  return rgb;
}

export function water(sample, { w, h, S, aspect = 1, cx = 0, cy = 0 }) {
  const rgb = new Uint8Array(w * h * 3);
  const T = 0.055 * S;
  const e = (2 * S) / h;
  const BG = [26, 27, 32], DEEP = [78, 132, 164], SHALLOW = [163, 205, 226], RIM = [226, 242, 250];
  const lx = -0.55, ly = 0.83;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [wx, wy] = world(i, j, w, h, S, aspect);
      const x = wx + cx, y = wy + cy;
      const o = (j * w + i) * 3;
      const d = sample(x, y);
      if (d >= 0) { rgb[o] = BG[0]; rgb[o + 1] = BG[1]; rgb[o + 2] = BG[2]; continue; }
      const t = Math.min(1, -d / T);
      const hgt = t * t * (3 - 2 * t);
      const gx = (sample(x + e, y) - sample(x - e, y)) / (2 * e);
      const gy = (sample(x, y + e) - sample(x, y - e)) / (2 * e);
      const gl = Math.hypot(gx, gy) || 1;
      const slope = 1 - hgt;
      const lam = Math.max(0, (-gx / gl) * slope * lx + (-gy / gl) * slope * ly);
      const rim = Math.pow(1 - hgt, 3.2);
      const spec = Math.pow(lam, 3.0) * 0.55;
      for (let c = 0; c < 3; c++) {
        const body = DEEP[c] + (SHALLOW[c] - DEEP[c]) * hgt;
        rgb[o + c] = Math.max(0, Math.min(255,
          Math.round(body * (0.74 + 0.26 * lam) + RIM[c] * (rim * 0.42 + spec))));
      }
    }
  }
  return rgb;
}

// Even-odd scanline fill over the exported rings — fill-rule="evenodd" on one
// path is exactly this, and it is what punches holes through.
export function rasterRings(rings, w, h) {
  const polys = rings.map((pts) => {
    const out = [];
    let cur = pts[0];
    for (const { c1, c2, end } of closedCatmullRom(pts)) {
      for (let s = 1; s <= 12; s++) {
        const t = s / 12, u = 1 - t;
        out.push([
          u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
          u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
        ]);
      }
      cur = end;
    }
    return out;
  });
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let py = 0; py < h; py++) {
    const y = py + 0.5;
    const xs = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil(xs[i] - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = a; px <= b; px++) {
        const o = (py * w + px) * 3;
        rgb[o] = 17; rgb[o + 1] = 17; rgb[o + 2] = 24;
      }
    }
  }
  return rgb;
}

export function labelled(rgb, w, h, text, dark = false) {
  const out = new Uint8Array(w * (h + LABEL_H) * 3);
  out.set(rgb, 0);
  for (let i = w * h * 3; i < out.length; i += 3) {
    out[i] = 17; out[i + 1] = 18; out[i + 2] = 22;
  }
  drawText(out, w, h + LABEL_H, text, LABEL_PAD, h + LABEL_PAD, LABEL_SCALE, [232, 232, 236]);
  return { rgb: out, w, h: h + LABEL_H };
}
