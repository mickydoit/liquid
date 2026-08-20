// Fusion comparison gate.
//
//   node tools/fusion.mjs out/fusion
//
// One field, one Roundness, one set of selected Join pairs. Only Fusion moves.
// For each candidate: flat silhouette, liquid preview, and the flattened SVG
// export — plus three enlarged junctions, because a junction is what Fusion is
// for and it cannot be judged at whole-design scale.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { silhouette, water, rasterRings, labelled } from './preview.mjs';
import { fieldOutline } from '../js/contour.js';
import { buildSVG, contourFrameForTest } from '../js/export.js';
import { idleState } from '../js/cymafield.js';
import { joinedField, clearJoinCache, CANON_EXTENT } from '../js/cymajoin.js';

const dir = process.argv[2] ?? 'out/fusion';
const STEPS = [0, 0.25, 0.5, 0.75];

// The state from the user's screenshot, with Roundness at the reviewed value.
const BASE = {
  ...idleState(),
  m: 7, n: 6, kr: 14, ma: 7,
  mass: 0.95, simple: 0, amp: 0.5, grow: 1,
  join: 0.6, roundness: 0.5,
};

const W = 1100, H = 1100;
const S = CANON_EXTENT * 1.02;
const BOUNDS = { x0: -S, x1: S, y0: -S, y1: S };

// Pick three junctions to enlarge, from the pairs Join actually selected:
// the most equal, the most unequal, and a cell carrying two connections.
function junctions(built) {
  const sel = built.selected;
  if (!sel.length) return [];
  const r = (id) => built.inradii.get(id) ?? 0;
  const scored = sel.map((p) => {
    const a = r(p.a), b = r(p.b);
    const ratio = Math.min(a, b) / Math.max(a, b || 1);
    return { p, ratio, size: Math.min(a, b) };
  }).filter((s) => s.size > 0);
  if (!scored.length) return sel.slice(0, 3).map((p, i) => ({ p, label: `PAIR ${i + 1}` }));

  const big = scored.filter((s) => s.size > 8);
  const equal = [...big].sort((a, b) => b.ratio - a.ratio || b.size - a.size)[0];
  const unequal = [...big].sort((a, b) => a.ratio - b.ratio)[0];
  const deg = new Map();
  for (const p of sel) { deg.set(p.a, (deg.get(p.a) ?? 0) + 1); deg.set(p.b, (deg.get(p.b) ?? 0) + 1); }
  const hub = [...deg.entries()].filter(([, d]) => d >= 2).sort((a, b) => b[1] - a[1])[0];
  const hubPair = hub ? sel.find((p) => p.a === hub[0] || p.b === hub[0]) : null;

  const out = [];
  if (equal) out.push({ p: equal.p, label: 'EQUAL PAIR' });
  if (unequal && unequal.p !== (equal && equal.p)) out.push({ p: unequal.p, label: 'UNEQUAL PAIR' });
  if (hubPair) out.push({ p: hubPair, label: 'THREE-CELL JUNCTION' });
  return out;
}

mkdirSync(dir, { recursive: true });

// Junction locations are chosen ONCE, from the Fusion 0 build, so the same three
// places are enlarged at every Fusion value.
clearJoinCache();
const ref = joinedField({ ...BASE, fusion: 0 });
const refCell = (2 * CANON_EXTENT) / ref.h;
const chosen = junctions(ref);
console.log('junctions:', chosen.map((c) => `${c.label} ${c.p.a}-${c.p.b}`).join('  |  '));

for (const fusion of STEPS) {
  clearJoinCache();
  const state = { ...BASE, fusion };
  const built = joinedField(state);
  const field = built.sample;
  const tag = `f${fusion.toFixed(2)}`;
  const head = `FUSION ${fusion.toFixed(2)}   JOIN ${BASE.join}   ROUND ${BASE.roundness}`
    + `   PAIRS ${built.selected.length}`;
  const how = fusion === 0 ? '  (CURRENT JOIN METHOD)' : '';
  console.log(`${tag}  selected=${built.selected.length}  necks=${built.necks.length}`);

  const flat = labelled(silhouette(field, { w: W, h: H, S }), W, H, `${head}${how}  FLAT`);
  writeFileSync(`${dir}/flat-${tag}.png`, encodePNG(flat.w, flat.h, flat.rgb));

  const wet = labelled(water(field, { w: W, h: H, S }), W, H, `${head}${how}  LIQUID`);
  writeFileSync(`${dir}/liquid-${tag}.png`, encodePNG(wet.w, wet.h, wet.rgb));

  const frame = contourFrameForTest(state, W, H, BOUNDS);
  const { rings } = fieldOutline(field, frame.opts);
  const shifted = rings.map((r) => r.map(([x, y]) => [x - frame.dx, y - frame.dy]));
  const svg = labelled(rasterRings(shifted, W, H), W, H, `${head}${how}  SVG EXPORT`);
  writeFileSync(`${dir}/svg-${tag}.png`, encodePNG(svg.w, svg.h, svg.rgb));

  writeFileSync(`${dir}/liquid-${tag}.svg`,
    buildSVG({ state, width: W, height: H, ink: '#12181d', background: '#aeb8bf', bounds: BOUNDS }));

  // Enlarged junctions: a tight window centred on each chosen channel.
  const ZW = 700, ZS = 0.30;
  chosen.forEach(({ p, label }, n) => {
    const cx = ((p.ax + p.bx) / 2 / built.w) * 2 * CANON_EXTENT - CANON_EXTENT;
    const cy = CANON_EXTENT - ((p.ay + p.by) / 2 / built.h) * 2 * CANON_EXTENT;
    const zoomFlat = labelled(silhouette(field, { w: ZW, h: ZW, S: ZS, cx, cy }),
      ZW, ZW, `${label}  FUSION ${fusion.toFixed(2)}`);
    writeFileSync(`${dir}/zoom${n + 1}-${tag}.png`,
      encodePNG(zoomFlat.w, zoomFlat.h, zoomFlat.rgb));
  });
}
console.log(`\nwritten to ${dir}  (${chosen.length} junctions enlarged)`);
