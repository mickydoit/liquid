// Cell Roundness candidates, canvas and SVG side by side.
//
//   node tools/roundness.mjs out/roundness
//
// Join and every other setting are held identical across the ladder; only
// Roundness moves. For each value it writes:
//   canvas-*.png   the field, thresholded — what the shader's flat view paints
//   svg-*.png      the EXPORTED path, flattened and even-odd filled
//   liquid-*.svg   that same export, as a file to drop into Figma
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { drawText, GLYPH_H } from './glyphs.mjs';
import { makeProjector, closedCatmullRom, fieldOutline } from '../js/contour.js';
import { buildSVG, contourFrameForTest } from '../js/export.js';
import { idleState } from '../js/cymafield.js';
import { joinedField, CANON_EXTENT } from '../js/cymajoin.js';

const dir = process.argv[2] ?? 'out/roundness';
const STEPS = [0, 0.25, 0.5, 0.75];
const LABEL_SCALE = 3, LABEL_PAD = 12;
const LABEL_H = GLYPH_H * LABEL_SCALE + LABEL_PAD * 2;

// The user's screenshot, with Join held at the reviewed value.
const BASE = {
  ...idleState(),
  m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1,
  join: 0.6,
};

// Framed to hold the whole plate with a margin, so nothing is cropped and every
// candidate is judged on the same rectangle.
const W = 1200, H = 1200;
const K = CANON_EXTENT * 1.02;
const BOUNDS = { x0: -K, x1: K, y0: -K, y1: K };

function labelled(rgb, text) {
  const out = new Uint8Array(W * (H + LABEL_H) * 3);
  out.set(rgb, 0);
  for (let i = W * H * 3; i < out.length; i += 3) {
    out[i] = 17; out[i + 1] = 18; out[i + 2] = 22;
  }
  drawText(out, W, H + LABEL_H, text, LABEL_PAD, H + LABEL_PAD, LABEL_SCALE, [232, 232, 236]);
  return out;
}

function rasterField(field) {
  const { scale, project } = makeProjector(BOUNDS, W, H, 0);
  const [ox, oy] = project(0, 0);
  const rgb = new Uint8Array(W * H * 3).fill(255);
  for (let py = 0; py < H; py++) {
    const wy = -((py + 0.5) - oy) / scale;
    for (let px = 0; px < W; px++) {
      const wx = ((px + 0.5) - ox) / scale;
      if (field(wx, wy) >= 0) continue;
      const o = (py * W + px) * 3;
      rgb[o] = 17; rgb[o + 1] = 17; rgb[o + 2] = 24;
    }
  }
  return rgb;
}

function rasterRings(rings) {
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
  const rgb = new Uint8Array(W * H * 3).fill(255);
  for (let py = 0; py < H; py++) {
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
      const b = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = a; px <= b; px++) {
        const o = (py * W + px) * 3;
        rgb[o] = 17; rgb[o + 1] = 17; rgb[o + 2] = 24;
      }
    }
  }
  return rgb;
}

mkdirSync(dir, { recursive: true });
for (const roundness of STEPS) {
  const state = { ...BASE, roundness };
  const built = joinedField(state);
  const field = built.sample;

  const ratios = built.shapes ? [...built.shapes.values()].map((v) => v.ratio) : [];
  const med = ratios.length
    ? ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : null;
  const tag = `r${roundness.toFixed(2)}`;
  const head = `ROUNDNESS ${roundness.toFixed(2)}   JOIN ${BASE.join}   NECKS ${built.necks.length}`;
  console.log(`${tag}  necks=${built.necks.length}  cells=${
    new Set(built.pairs.flatMap((p) => [p.a, p.b])).size}  medianRatio=${
    med === null ? '-' : med.toFixed(3)}`);

  writeFileSync(`${dir}/canvas-${tag}.png`,
    encodePNG(W, H + LABEL_H, labelled(rasterField(field), `${head}  CANVAS`)));

  const frame = contourFrameForTest(state, W, H, BOUNDS);
  const { rings } = fieldOutline(field, frame.opts);
  const shifted = rings.map((r) => r.map(([x, y]) => [x - frame.dx, y - frame.dy]));
  writeFileSync(`${dir}/svg-${tag}.png`,
    encodePNG(W, H + LABEL_H, labelled(rasterRings(shifted), `${head}  SVG EXPORT`)));

  writeFileSync(`${dir}/liquid-${tag}.svg`,
    buildSVG({ state, width: W, height: H, ink: '#12181d', background: '#aeb8bf', bounds: BOUNDS }));
}
console.log(`\nwritten to ${dir}`);
