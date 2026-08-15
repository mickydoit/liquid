// The approved compositions, and how a silhouette is reduced to a comparable
// signature. Shared by the fixture generator and the regression test so the two
// can never disagree about what is being compared.
import { defaultMeta, metaDist, META_FRAME } from '../js/metafield.js';
import { idleState } from '../js/cymafield.js';

const A = { pitchNorm: 0.42, rms: 0.31, centroid: 0.38, spread: 0.22, pitchConf: 0.8 };
const B = { pitchNorm: 0.80, rms: 0.58, centroid: 0.68, spread: 0.50, pitchConf: 0.40 };

export const CASES = [
  { name: 'portrait-default', features: A, aspect: 1000 / 1400 },
  { name: 'landscape-default', features: A, aspect: 1500 / 1000 },
  { name: 'landscape-sound-b', features: B, aspect: 1500 / 1000 },
];

// A coarse occupancy grid. Fine enough that any real change to a form's size,
// position or connectivity moves at least one cell, coarse enough that
// antialiasing and floating-point noise cannot.
export const GRID = 48;

export function signature({ features, aspect }) {
  const s = Object.assign(idleState(), {
    amp: 0.6, grow: 1, features, aspect, mode: 'meta', meta: defaultMeta(),
  });
  const fx = META_FRAME * aspect, fy = META_FRAME;
  let bits = '';
  for (let j = 0; j < GRID; j++) {
    const y = fy - (2 * fy * (j + 0.5)) / GRID;
    for (let i = 0; i < GRID; i++) {
      const x = -fx + (2 * fx * (i + 0.5)) / GRID;
      bits += metaDist(x, y, s) < 0 ? '1' : '0';
    }
  }
  return bits;
}
