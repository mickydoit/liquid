// Turns a seed plus controls into a baked signed-distance grid, without
// re-doing work. A bake at preview resolution costs ~22 ms, so re-baking every
// frame would cap the app at ~45 fps for no reason: the organism only changes
// when its inputs do.
//
// Knows nothing about WebGL. The renderer decides what to do with the grid.
import { makeBlobField, defaultControls } from './blobfield.js?v=2ffd3a4f';
import { bake, FORMATS, gridSampler } from './bake.js?v=2ffd3a4f';

// Every control, in a fixed order, so the key is stable across objects that
// happen to enumerate their properties in a different order.
const KEYS = Object.keys(defaultControls()).sort();

const keyFor = (seed, controls, res, aspect) => {
  const d = defaultControls();
  return `${seed}|${res}|${aspect.toFixed(4)}|${KEYS.map((k) => (controls[k] ?? d[k]).toFixed(4)).join(',')}`;
};

// The ONE bake. The cache, the worker and the worker's synchronous fallback
// all call this, so there is no way for those paths to drift apart.
export function bakeOrganism(seed, controls, res, aspect = FORMATS.portrait) {
  const { field } = makeBlobField(seed, controls);
  return bake(field, {
    aspect,
    res,
    simplify: controls.simplify ?? defaultControls().simplify,
  });
}

// `worker`  — bake off the main thread. request() then returns the PREVIOUS
//             grid immediately and calls onReady when the new one lands, so
//             the render loop never blocks on a bake.
// `onReady` — called with the finished bake.
//
// Without a worker, request() bakes inline and returns the result. The export
// path wants exactly that: it needs the grid in hand to contour it, and a
// one-off 270 ms bake is not worth an async hop.
export function makeOrganismCache({ worker = false, onReady = null } = {}) {
  let lastKey = null;
  let lastVal = null;
  let w = null;
  let token = 0;

  if (worker && typeof Worker !== 'undefined') {
    try {
      // A module worker, because organism.js uses ES imports.
      w = new Worker(new URL('./organism.worker.js?v=2ffd3a4f', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        // Stale replies are dropped: dragging a slider queues several bakes
        // and they are not guaranteed to finish in order, so without this an
        // older grid could land last and stick.
        if (e.data.token !== token) return;
        const { grid, w: gw, h: gh, aspect } = e.data;
        lastVal = { grid, w: gw, h: gh, aspect, sample: gridSampler(grid, gw, gh, aspect) };
        api.bakes++;
        if (onReady) onReady(lastVal);
      };
    } catch {
      // Blocked worker (file:// origins, strict CSP). Inline is slower but
      // correct, and identical — both paths call bakeOrganism().
      w = null;
    }
  }

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
      lastKey = key;
      if (w) {
        w.postMessage({ seed, controls, res, aspect, token: ++token });
        // The previous grid, so the caller always has something to draw. null
        // on the very first request, which callers already handle — the ramp
        // falls back to the blob when there is no organism.
        return lastVal;
      }
      lastVal = bakeOrganism(seed, controls, res, aspect);
      api.bakes++;
      return lastVal;
    },
    dispose() {
      if (w) { w.terminate(); w = null; }
      lastKey = null;
      lastVal = null;
    },
  };
  return api;
}
