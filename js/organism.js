// Turns a seed plus controls into a baked signed-distance grid, without
// re-doing work. A bake at preview resolution costs ~22 ms, so re-baking every
// frame would cap the app at ~45 fps for no reason: the organism only changes
// when its inputs do.
//
// Knows nothing about WebGL. The renderer decides what to do with the grid.
import { makeBlobField, defaultControls } from './blobfield.js?v=32e6954f';
import { bake, FORMATS } from './bake.js?v=32e6954f';

// Every control, in a fixed order, so the key is stable across objects that
// happen to enumerate their properties in a different order.
const KEYS = Object.keys(defaultControls()).sort();

const keyFor = (seed, controls, res, aspect) => {
  const d = defaultControls();
  return `${seed}|${res}|${aspect.toFixed(4)}|${KEYS.map((k) => (controls[k] ?? d[k]).toFixed(4)).join(',')}`;
};

export function makeOrganismCache() {
  let lastKey = null;
  let lastVal = null;
  const api = {
    bakes: 0,
    // `aspect` must match the surface being drawn. Baking at a fixed portrait
    // ratio and sampling it on a differently-shaped canvas letterboxes the
    // organism, so the frame it was composed against is not the frame it is
    // seen in — and the crop, which is the whole point of this look, lands in
    // the wrong place.
    request(seed, controls, res, aspect = FORMATS.portrait) {
      const key = keyFor(seed, controls, res, aspect);
      if (key === lastKey) return lastVal;
      const { field } = makeBlobField(seed, controls);
      const b = bake(field, {
        aspect,
        res,
        simplify: controls.simplify ?? defaultControls().simplify,
      });
      api.bakes++;
      lastKey = key;
      lastVal = b;
      return b;
    },
    dispose() { lastKey = null; lastVal = null; },
  };
  return api;
}
