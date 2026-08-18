// Canvas / SVG export parity harness.
//
//   node tools/parity.mjs out/parity
//
// Rasterises the SVG the exporter actually emits and compares it, pixel for
// pixel, against the field the canvas draws — in ONE shared pixel space, so any
// difference is contour fidelity rather than framing.
//
// Writes four images per case, which is what makes a parity claim checkable:
//   canvas-*   the field, thresholded (what the shader's flat view paints)
//   svg-*      the exported path, flattened and even-odd filled
//   diff-*     red where only the canvas is inked, blue where only the SVG is
//   overlay-*  the two at partial transparency
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { drawText, GLYPH_H } from './glyphs.mjs';
import { fieldOutline, makeProjector, closedCatmullRom } from '../js/contour.js';
import { contourFrameForTest } from '../js/export.js';
import { makeWaterField, idleState } from '../js/cymafield.js';
import { joinedField } from '../js/cymajoin.js';
import { signedEdt } from '../js/bake.js';

const dir = process.argv[2] ?? 'out/parity';
const LABEL_SCALE = 3, LABEL_PAD = 12;
const LABEL_H = GLYPH_H * LABEL_SCALE + LABEL_PAD * 2;

// The user's screenshot: Detailed Cymatic, Nodal detail 0, Swell 0, Mass max.
const BASE = {
  ...idleState(),
  m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1,
};

// EXACTLY what js/export.js does, so a divergence here is a divergence there.
function exportFieldOf(state) {
  return (state.join ?? 0) > 0 ? joinedField(state).sample : makeWaterField(state);
}

// The world rectangle the app exports, mirroring renderer.viewBounds() at
// zoom 1 and no pan.
function viewBounds(width, height) {
  const aspect = width / height;
  const k = 3.15;
  return { x0: -0.5 * aspect * k, x1: 0.5 * aspect * k, y0: -0.5 * k, y1: 0.5 * k };
}

// ── rasterisers ─────────────────────────────────────────────────────────

// The field itself, thresholded at the surface. This is what the shader's flat
// view paints: joinCoverage crosses WATER_EDGE exactly at distance 0, and the
// analytic path crosses it where thickness == 0.08, so in both cases the
// silhouette is field < 0.
function rasterField(field, bounds, width, height, margin) {
  const { scale, project } = makeProjector(bounds, width, height, margin);
  // Invert the projector rather than re-deriving it: project is [x*s+ox, -y*s+oy].
  const [ox0, oy0] = project(0, 0);
  const mask = new Uint8Array(width * height);
  for (let py = 0; py < height; py++) {
    const wy = -((py + 0.5) - oy0) / scale;
    for (let px = 0; px < width; px++) {
      const wx = ((px + 0.5) - ox0) / scale;
      if (field(wx, wy) < 0) mask[py * width + px] = 1;
    }
  }
  return mask;
}

// Flatten one ring's cubic Beziers — the same curves ringToPath writes — into a
// dense polyline.
function flattenRing(pts, perSeg = 16) {
  const out = [];
  let cur = pts[0];
  for (const { c1, c2, end } of closedCatmullRom(pts)) {
    for (let k = 1; k <= perSeg; k++) {
      const t = k / perSeg, u = 1 - t;
      out.push([
        u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
        u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
      ]);
    }
    cur = end;
  }
  return out;
}

// Even-odd scanline fill over every ring at once — fill-rule="evenodd" on one
// path is exactly this, and it is what punches holes through.
function rasterRings(rings, width, height) {
  const polys = rings.map((r) => flattenRing(r));
  const mask = new Uint8Array(width * height);
  for (let py = 0; py < height; py++) {
    const y = py + 0.5;
    const xs = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil(xs[i] - 0.5));
      const b = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = a; px <= b; px++) mask[py * width + px] = 1;
    }
  }
  return mask;
}

// ── images ──────────────────────────────────────────────────────────────

function label(rgb, width, height, text) {
  const out = new Uint8Array(width * (height + LABEL_H) * 3);
  out.set(rgb, 0);
  for (let i = width * height * 3; i < out.length; i += 3) {
    out[i] = 17; out[i + 1] = 18; out[i + 2] = 22;
  }
  drawText(out, width, height + LABEL_H, text, LABEL_PAD, height + LABEL_PAD,
    LABEL_SCALE, [232, 232, 236]);
  return { rgb: out, width, height: height + LABEL_H };
}

function monoImage(mask, width, height) {
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    rgb[i * 3] = 17; rgb[i * 3 + 1] = 17; rgb[i * 3 + 2] = 24;
  }
  return rgb;
}

function diffImage(a, b, width, height) {
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) { rgb[i * 3] = 224; rgb[i * 3 + 1] = 60; rgb[i * 3 + 2] = 60; }
    else if (!a[i] && b[i]) { rgb[i * 3] = 60; rgb[i * 3 + 1] = 110; rgb[i * 3 + 2] = 226; }
    else if (a[i]) { rgb[i * 3] = 228; rgb[i * 3 + 1] = 228; rgb[i * 3 + 2] = 232; }
  }
  return rgb;
}

function overlayImage(a, b, width, height) {
  const rgb = new Uint8Array(width * height * 3).fill(246);
  for (let i = 0; i < a.length; i++) {
    // Canvas in warm grey at half strength, SVG in cool blue at half strength:
    // agreement reads neutral dark, disagreement keeps its colour cast.
    let r = 246, g = 246, bl = 246;
    if (a[i]) { r -= 110; g -= 96; bl -= 80; }
    if (b[i]) { r -= 80; g -= 100; bl -= 110; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
  }
  return rgb;
}

// How far every disagreeing pixel is from the other silhouette. A one-or-two
// pixel band is normal contour sampling error; a wedge is tens of pixels.
function mismatchDepth(a, b, width, height) {
  const dA = signedEdt(a, width, height);
  const dB = signedEdt(b, width, height);
  let n = 0, worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (!!a[i] === !!b[i]) continue;
    n++;
    worst = Math.max(worst, Math.abs(a[i] ? dB[i] : dA[i]));
  }
  return { n, worst, frac: n / a.length };
}

// ── run ─────────────────────────────────────────────────────────────────

mkdirSync(dir, { recursive: true });
const MARGIN = 0.02;                       // fieldOutline's default
const CASES = [];
for (const [fmt, W, H] of [['portrait', 800, 1200], ['landscape', 1350, 900]]) {
  for (const join of [0, 0.6]) CASES.push({ fmt, W, H, join });
}

let failures = 0;
for (const { fmt, W, H, join } of CASES) {
  const state = { ...BASE, join };
  const field = exportFieldOf(state);
  const bounds = viewBounds(W, H);

  // The canvas is rasterised over the PAGE rectangle; the SVG is contoured over
  // the guard-banded rectangle and shifted back. Both therefore land in the same
  // page pixel space, which is the only way the comparison means anything.
  const canvas = rasterField(field, bounds, W, H, 0);
  const frame = contourFrameForTest(state, W, H, bounds);
  const { rings } = fieldOutline(field, frame.opts);
  const svg = rasterRings(rings.map((r) => r.map(([x, y]) => [x - frame.dx, y - frame.dy])), W, H);

  const { n, worst, frac } = mismatchDepth(canvas, svg, W, H);
  const tag = `${fmt}-join${join.toFixed(1)}`;
  const head = `${tag}  rings ${rings.length}  mismatch ${(frac * 100).toFixed(2)}%  worst ${worst.toFixed(1)}px`;
  console.log(head);
  if (worst > 3) failures++;

  for (const [name, rgb] of [
    ['canvas', monoImage(canvas, W, H)],
    ['svg', monoImage(svg, W, H)],
    ['diff', diffImage(canvas, svg, W, H)],
    ['overlay', overlayImage(canvas, svg, W, H)],
  ]) {
    const t = name === 'diff'
      ? `${tag} DIFF  RED CANVAS ONLY  BLUE SVG ONLY`
      : `${tag} ${name.toUpperCase()}`;
    const img = label(rgb, W, H, t);
    writeFileSync(`${dir}/${name}-${tag}.png`, encodePNG(img.width, img.height, img.rgb));
  }
}
console.log(failures ? `\n${failures}/${CASES.length} cases exceed 3px` : '\nall cases within 3px');
