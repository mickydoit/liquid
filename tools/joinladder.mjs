// Render a ladder of Join values to PNG for visual review.
//
//   node tools/joinladder.mjs out/join
//
// Green tests never once indicated the look was right in this project — all
// three `large` failures in the Shape Style work passed their tests while
// looking wrong, and were caught only by rendering and looking. This ladder is
// the gate for the Join control.
//
// Every image in a ladder shares one field, one audio state, one scale and one
// frame, so the only thing changing down the ladder is Join.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { drawText, GLYPH_H } from './glyphs.mjs';
import { buildJoinedField } from '../js/cymajoin.js';
import { idleState } from '../js/cymafield.js';
import { FORMATS } from '../js/bake.js';

const dir = process.argv[2] ?? 'out/join';
const STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const MARGIN = 0.10;          // clear space around the design, as a fraction
const PREVIEW_JOIN = 0.6;     // the candidate that also gets a material preview

// The regime the Join control is for, matched to the exports the user selected
// in Figma (frame 10:142): a disc of roughly 40-60 rounded cells.
//
// `simple` is 0, not high. It reads "0 = full nodal detail, 1 = a few broad
// meanders" (cymafield.js:44), so LOW simple is what gives many cells — a
// measured sweep put simple 0 / amp 0.5 / m 7 at 46 cells, and simple 0.55 at
// five. The user's phrase "simplified cymatics" describes the flat, reduced
// rendering, not this control.
const BASE = {
  ...idleState(),
  m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1,
};

const LABEL_SCALE = 3;
const LABEL_PAD = 14;
const LABEL_H = GLYPH_H * LABEL_SCALE + LABEL_PAD * 2;

// ── framing ─────────────────────────────────────────────────────────────
//
// Measured from the design itself rather than assumed. The plate mask fades out
// by r = 1.30 (cymafield.js:201), but the outermost CELL sits wherever the modal
// field put it, so probing is what guarantees nothing is cut off.
function designExtent(state, probeExtent = 2.0, res = 400) {
  const { sample } = buildJoinedField(state, { aspect: 1, res, extent: probeExtent });
  let hx = 0, hy = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = (-1 + (2 * (i + 0.5)) / res) * probeExtent;
      const y = (1 - (2 * (j + 0.5)) / res) * probeExtent;
      if (sample(x, y) >= 0) continue;
      hx = Math.max(hx, Math.abs(x));
      hy = Math.max(hy, Math.abs(y));
    }
  }
  return { hx, hy };
}

// The world half-height a frame of this aspect needs to hold the design with a
// clear margin on its binding dimension.
function frameScale({ hx, hy }, aspect) {
  return Math.max((hx * (1 + MARGIN)) / aspect, hy * (1 + MARGIN));
}

// ── renderers ───────────────────────────────────────────────────────────

// Flat silhouette: black form on white, hard threshold. What you see is the
// geometry itself, with no material dressing it up.
function silhouette(sample, S, width, height, aspect) {
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (let j = 0; j < height; j++) {
    const y = (1 - (2 * (j + 0.5)) / height) * S;
    for (let i = 0; i < width; i++) {
      const x = (-1 + (2 * (i + 0.5)) / width) * aspect * S;
      if (sample(x, y) >= 0) continue;
      const o = (j * width + i) * 3;
      rgb[o] = 17; rgb[o + 1] = 17; rgb[o + 2] = 24;
    }
  }
  return rgb;
}

// Water material preview.
//
// An APPROXIMATION of the WebGL material in js/shader.js, not that shader —
// there is no GL context in node. Depth, normal and rim all come from the SAME
// baked field the silhouette uses, so the GEOMETRY shown is identical and only
// the shading is invented. Its job is to show whether a waist reads as a pinch
// or as a bulge once the form has volume.
function water(sample, S, width, height, aspect) {
  const rgb = new Uint8Array(width * height * 3);
  const T = 0.055 * S;                 // depth over which the water thickens
  const e = (2 * S) / height;          // one pixel in world units
  const BG = [26, 27, 32];
  const DEEP = [78, 132, 164];
  const SHALLOW = [163, 205, 226];
  const RIM = [226, 242, 250];
  const lx = -0.55, ly = 0.83;

  for (let j = 0; j < height; j++) {
    const y = (1 - (2 * (j + 0.5)) / height) * S;
    for (let i = 0; i < width; i++) {
      const x = (-1 + (2 * (i + 0.5)) / width) * aspect * S;
      const o = (j * width + i) * 3;
      const d = sample(x, y);
      if (d >= 0) {
        rgb[o] = BG[0]; rgb[o + 1] = BG[1]; rgb[o + 2] = BG[2];
        continue;
      }
      // Depth: 0 at the boundary, 1 well inside.
      const t = Math.min(1, -d / T);
      const hgt = t * t * (3 - 2 * t);
      // Surface normal from the field's gradient — the meniscus rolls off
      // toward the edge, which is what makes a concave waist read as concave.
      const gx = (sample(x + e, y) - sample(x - e, y)) / (2 * e);
      const gy = (sample(x, y + e) - sample(x, y - e)) / (2 * e);
      const gl = Math.hypot(gx, gy) || 1;
      const slope = 1 - hgt;
      const nx = (-gx / gl) * slope, ny = (-gy / gl) * slope;
      const lam = Math.max(0, nx * lx + ny * ly);
      const rim = Math.pow(1 - hgt, 3.2);
      const spec = Math.pow(lam, 3.0) * 0.55;
      for (let c = 0; c < 3; c++) {
        const body = DEEP[c] + (SHALLOW[c] - DEEP[c]) * hgt;
        const v = body * (0.74 + 0.26 * lam) + RIM[c] * (rim * 0.42 + spec);
        rgb[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return rgb;
}

// A dark caption band under the image.
function withLabel(rgb, width, height, text) {
  const out = new Uint8Array(width * (height + LABEL_H) * 3);
  out.set(rgb, 0);
  const base = width * height * 3;
  for (let i = base; i < out.length; i += 3) {
    out[i] = 17; out[i + 1] = 18; out[i + 2] = 22;
  }
  drawText(out, width, height + LABEL_H, text, LABEL_PAD, height + LABEL_PAD,
    LABEL_SCALE, [232, 232, 236]);
  return { rgb: out, width, height: height + LABEL_H };
}

// ── run ─────────────────────────────────────────────────────────────────

mkdirSync(dir, { recursive: true });

// One probe, shared by BOTH ladders, so portrait and landscape show the same
// design at the same scale and differ only in crop.
const ext = designExtent({ ...BASE, join: 0 });
console.log(`design half-extent  x=${ext.hx.toFixed(3)}  y=${ext.hy.toFixed(3)}`);

for (const [name, aspect, height] of [
  ['portrait', FORMATS.portrait, 1200],
  ['landscape', FORMATS.landscape, 900],
]) {
  const S = frameScale(ext, aspect);
  const width = Math.round(height * aspect);
  console.log(`${name}: frame half-height ${S.toFixed(3)}  ${width}x${height}`);

  for (const join of STEPS) {
    const built = buildJoinedField({ ...BASE, join }, { aspect, res: 1024, extent: S });
    const { sample, necks } = built;
    const label = `JOIN ${join.toFixed(1)}   NECKS ${necks.length}`;

    const flat = withLabel(silhouette(sample, S, width, height, aspect),
      width, height, label);
    const flatFile = `${dir}/flat-${name}-${join.toFixed(1)}.png`;
    writeFileSync(flatFile, encodePNG(flat.width, flat.height, flat.rgb));
    console.log(`  ${flatFile}  necks=${necks.length}`);

    if (Math.abs(join - PREVIEW_JOIN) < 1e-9) {
      const wet = withLabel(water(sample, S, width, height, aspect),
        width, height, `${label}   WATER PREVIEW`);
      const wetFile = `${dir}/water-${name}-${join.toFixed(1)}.png`;
      writeFileSync(wetFile, encodePNG(wet.width, wet.height, wet.rgb));
      console.log(`  ${wetFile}`);
    }
  }
}
