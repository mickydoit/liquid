// Turns a seed plus controls into a baked signed-distance grid, without
// re-doing work. A bake at preview resolution costs ~22 ms, so re-baking every
// frame would cap the app at ~45 fps for no reason: the organism only changes
// when its inputs do.
//
// Knows nothing about WebGL. The renderer decides what to do with the grid.
import { makeBlobField, defaultControls } from './blobfield.js?v=2dd45290';
import { bake, FORMATS } from './bake.js?v=2dd45290';

// Every control, in a fixed order, so the key is stable across objects that
// happen to enumerate their properties in a different order.
const KEYS = Object.keys(defaultControls()).sort();

const keyFor = (seed, controls, res) => {
  const d = defaultControls();
  return `${seed}|${res}|${KEYS.map((k) => (controls[k] ?? d[k]).toFixed(4)).join(',')}`;
};

export function makeOrganismCache() {
  let lastKey = null;
  let lastVal = null;
  const api = {
    bakes: 0,
    request(seed, controls, res) {
      const key = keyFor(seed, controls, res);
      if (key === lastKey) return lastVal;
      const { field } = makeBlobField(seed, controls);
      const b = bake(field, {
        aspect: FORMATS.portrait,
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
