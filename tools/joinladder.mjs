// Render a ladder of Join values to PNG for visual review.
//
//   node tools/joinladder.mjs out/join
//
// Green tests never once indicated the look was right in this project — all
// three `large` failures in the Shape Style work passed their tests while
// looking wrong, and were caught only by rendering and looking. This ladder is
// the gate for the Join control.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { renderField } from './render.mjs';
import { buildJoinedField } from '../js/cymajoin.js';
import { idleState } from '../js/cymafield.js';
import { FORMATS } from '../js/bake.js';

const dir = process.argv[2] ?? 'out/join';
const STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

// The regime the Join control is for, matched to the exports the user selected
// in Figma (frame 10:142): a disc of roughly 40-60 rounded cells.
//
// `simple` is 0, not high. It reads "0 = full nodal detail, 1 = a few broad
// meanders" (cymafield.js:44), so LOW simple is what gives many cells — a
// measured sweep put simple 0 / amp 0.5 / m 7 at 46 cells, and simple 0.55 at
// five. The user's phrase "simplified cymatics" describes the flat, reduced
// rendering, not this control.
const base = {
  ...idleState(),
  m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1,
};

mkdirSync(dir, { recursive: true });
for (const [name, aspect] of [['portrait', FORMATS.portrait], ['landscape', FORMATS.landscape]]) {
  for (const join of STEPS) {
    const { sample, necks, pairs } = buildJoinedField({ ...base, join }, { aspect, res: 1024 });
    const height = aspect >= 1 ? 900 : 1350;
    const width = Math.round(height * aspect);
    const { rgb } = renderField(sample, { width, height, aspect });
    const file = `${dir}/ladder-${name}-${join.toFixed(1)}.png`;
    writeFileSync(file, encodePNG(width, height, rgb));
    console.log(`${file}  pairs=${pairs.length} necks=${necks.length}`);
  }
}
