// The Cymatic Join / Roundness bake, off the main thread.
//
// The bake segments a 1024^2 raster, runs a signed EDT and a nearest-cell
// transform, and fillets every neck — measured at 281ms at Roundness 0 and
// 458ms at 0.5. A slider fires 'input' continuously while dragged, so running
// that inline would queue one bake per event and lock the tab.
//
// The grid is transferred rather than copied: it is a Float64Array of about
// 8MB at 1024^2, and structured-cloning that per bake would cost more than the
// bake saved.
import { buildJoinedField, CANON_EXTENT } from './cymajoin.js?v=5b2f92d8';

self.onmessage = (e) => {
  const { id, state, res } = e.data;
  const t0 = performance.now();
  try {
    const r = buildJoinedField(state, { aspect: 1, res, extent: CANON_EXTENT });
    self.postMessage(
      { id, grid: r.grid, w: r.w, h: r.h, necks: r.necks.length, ms: performance.now() - t0 },
      [r.grid.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
