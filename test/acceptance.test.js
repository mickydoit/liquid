import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, bakeScenario, scenarioControls } from '../tools/render.mjs';
import { labelComponents } from '../js/bake.js';
import { makeBlobField } from '../js/blobfield.js';

// Several seeds per scenario: a postcondition that holds for one lucky layout
// is not a postcondition.
const SEEDS = [11, 23, 47, 91, 138];

for (const name of Object.keys(SCENARIOS)) {
  test(`${name}: macro-form count, no specks, no pinholes`, () => {
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      const total = b.w * b.h;
      const { sizes } = labelComponents(b.mask, b.w, b.h, 8);

      // The expected count is PER SCENARIO, because the references contain
      // two different things. The construction diagram and the growth
      // sequence are ONE connected mark — a hub with arms, one component,
      // complete in frame. The environmental posters are that same mark
      // scaled up until the frame cuts it into several separate forms. Asking
      // every scenario for 3-7 components would demand the connected mark be
      // something it is not.
      //
      // These bounds are acceptance criteria, not crash guards. If one fails,
      // tune the scenario's control values. Do NOT loosen the bound.
      //
      // `large` deliberately has no component bound — see the note on its
      // `expect` block. It is checked by the edge-coverage test instead.
      const want = SCENARIOS[name].expect.components;
      if (want) {
        const [lo, hi] = want;
        assert.ok(sizes.length >= lo && sizes.length <= hi,
          `${name}/${seed}: ${sizes.length} components, want ${lo}-${hi}`);
      }
      for (const s of sizes) {
        assert.ok(s / total >= 0.002, `${name}/${seed}: speck at ${s / total}`);
      }

      const inv = new Uint8Array(total);
      for (let i = 0; i < total; i++) inv[i] = b.mask[i] ? 0 : 1;
      const bg = labelComponents(inv, b.w, b.h, 4);
      const border = new Set();
      for (let x = 0; x < b.w; x++) {
        border.add(bg.labels[x]);
        border.add(bg.labels[(b.h - 1) * b.w + x]);
      }
      for (let y = 0; y < b.h; y++) {
        border.add(bg.labels[y * b.w]);
        border.add(bg.labels[y * b.w + b.w - 1]);
      }
      bg.sizes.forEach((s, i) => {
        if (border.has(i + 1)) return;
        assert.ok(s / total >= 0.002, `${name}/${seed}: pinhole at ${s / total}`);
      });
    }
  });

  test(`${name}: ink covers a substantial area`, () => {
    // The shared 0.08-0.85 range is a sanity guard. A scenario may narrow it
    // via `expect.ink`, and one does: without a tight upper bound, "cropped"
    // degenerates into "the frame is mostly solid", which passes every other
    // check while destroying the negative space the whole look depends on.
    const [lo, hi] = SCENARIOS[name].expect.ink ?? [0.08, 0.85];
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      const ink = b.mask.reduce((s, v) => s + v, 0) / (b.w * b.h);
      assert.ok(ink > lo && ink < hi, `${name}/${seed}: ink ${ink.toFixed(3)}, want ${lo}-${hi}`);
    }
  });

  test(`${name}: crops the frame`, () => {
    // The brief's editorial feel depends on forms leaving the frame. Count
    // border cells that are ink.
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      let touching = 0;
      for (let x = 0; x < b.w; x++) {
        if (b.mask[x]) touching++;
        if (b.mask[(b.h - 1) * b.w + x]) touching++;
      }
      for (let y = 0; y < b.h; y++) {
        if (b.mask[y * b.w]) touching++;
        if (b.mask[y * b.w + b.w - 1]) touching++;
      }
      assert.ok(touching > 0, `${name}/${seed}: nothing reaches the frame edge`);
    }
  });

  test(`${name}: reads as a cropped composition`, () => {
    // What the poster reference actually shows. Those panels are largely ONE
    // connected shape running off-frame; what makes them read as several
    // forms is lobes entering from different edges, not topological
    // separation. Component count turned out to be undeliverable here — arm
    // roots all sit within hubR*0.35 of the hub, so whether cropping leaves
    // separate pieces or one continuous wedge is decided by each seed's
    // arm-angle draw rather than by any control. Edge coverage describes the
    // intended composition honestly and is achievable for every seed.
    const need = SCENARIOS[name].expect.edges;
    if (need == null) return;
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      let top = 0, bottom = 0, left = 0, right = 0;
      for (let x = 0; x < b.w; x++) {
        if (b.mask[x]) top++;
        if (b.mask[(b.h - 1) * b.w + x]) bottom++;
      }
      for (let y = 0; y < b.h; y++) {
        if (b.mask[y * b.w]) left++;
        if (b.mask[y * b.w + b.w - 1]) right++;
      }
      const edges = [top, bottom, left, right].filter((n) => n > 0).length;
      assert.ok(edges >= need,
        `${name}/${seed}: ink on ${edges} edges (t${top} b${bottom} l${left} r${right}), want >= ${need}`);
    }
  });

  test(`${name}: is not a single centred potato`, () => {
    // The failure the brief opens by rejecting. A starfish leaves large
    // notches inside its bounding box; a potato fills it. Cheap, robust, and
    // it discriminates exactly the thing we care about.
    const max = SCENARIOS[name].expect.maxBboxFill;
    if (max == null) return;
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      let x0 = b.w, y0 = b.h, x1 = -1, y1 = -1, ink = 0;
      for (let j = 0; j < b.h; j++) {
        for (let i = 0; i < b.w; i++) {
          if (!b.mask[j * b.w + i]) continue;
          ink++;
          if (i < x0) x0 = i;
          if (i > x1) x1 = i;
          if (j < y0) y0 = j;
          if (j > y1) y1 = j;
        }
      }
      const fill = ink / ((x1 - x0 + 1) * (y1 - y0 + 1));
      assert.ok(fill <= max, `${name}/${seed}: bbox fill ${fill.toFixed(3)} > ${max}`);
    }
  });

  test(`${name}: carries the intended number of arms`, () => {
    // Pins the spec's "five to seven elongated forms" at the layout level,
    // which survives cropping in a way a component count does not.
    const want = SCENARIOS[name].expect.arms;
    if (want == null) return;
    for (const seed of SEEDS) {
      const { prims } = makeBlobField(seed, scenarioControls(name));
      const active = prims.slice(1).filter((p) => p.weight > 0.5).length;
      assert.ok(active >= want[0] && active <= want[1],
        `${name}/${seed}: ${active} arms, want ${want[0]}-${want[1]}`);
    }
  });

  test(`${name}: no k-fold rotational symmetry`, () => {
    // Pinwheels and rings of similar cells are exactly what the brief rejects.
    // Radial TOPOLOGY is fine — the reference mark is arms around a centre.
    // Radial REGULARITY is not. Compare the mask against itself rotated.
    for (const seed of SEEDS) {
      const b = bakeScenario(name, seed);
      for (let k = 3; k <= 8; k++) {
        const diff = rotationDiff(b, (2 * Math.PI) / k);
        assert.ok(diff > 0.06,
          `${name}/${seed}: ${k}-fold symmetric, diff only ${diff.toFixed(4)}`);
      }
    }
  });
}

// Fraction of cells that disagree between the mask and the mask rotated about
// the frame centre by `theta`.
function rotationDiff(b, theta) {
  const cx = (b.w - 1) / 2, cy = (b.h - 1) / 2;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  let differ = 0, counted = 0;
  for (let j = 0; j < b.h; j++) {
    for (let i = 0; i < b.w; i++) {
      const dx = i - cx, dy = j - cy;
      const si = Math.round(cx + dx * cos - dy * sin);
      const sj = Math.round(cy + dx * sin + dy * cos);
      if (si < 0 || sj < 0 || si >= b.w || sj >= b.h) continue;
      counted++;
      if (b.mask[j * b.w + i] !== b.mask[sj * b.w + si]) differ++;
    }
  }
  return counted ? differ / counted : 1;
}
