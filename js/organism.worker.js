// Bakes the organism off the main thread.
//
// The bake is ~22 ms at preview resolution, which is usable inline but shows
// as a stutter while a Poster slider is being dragged. It calls bakeOrganism()
// rather than reimplementing anything, so the worker and the synchronous
// fallback cannot drift apart.
import { bakeOrganism } from './organism.js?v=2ffd3a4f';

self.onmessage = (e) => {
  const { seed, controls, res, aspect, token } = e.data;
  const b = bakeOrganism(seed, controls, res, aspect);
  // Transferred, not copied: a 900-res grid is several megabytes.
  self.postMessage({ token, grid: b.grid, w: b.w, h: b.h, aspect: b.aspect },
                   [b.grid.buffer]);
};
