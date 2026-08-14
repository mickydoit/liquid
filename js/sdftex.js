// A baked signed-distance grid has to reach a WebGL1 fragment shader. Float
// textures there need OES_texture_float, which is not guaranteed, so the
// distance is packed into 16 bits across the R and G channels of an ordinary
// RGBA8 texture: about 1/16000 of a world unit, far finer than a one-pixel
// edge needs, and no extension check or fallback path anywhere.
//
// The GLSL decode in js/shader.js must mirror unpackDistance() exactly. These
// are one format split across two languages.
export const RANGE = 2.0;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function packSDF(grid, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // Clamped, not wrapped. A wrap would turn far-outside points into inside
    // ones and punch holes through the middle of the design.
    const v = clamp01((grid[i] + RANGE) / (2 * RANGE)) * 255;
    const hi = Math.floor(v);
    // The high byte saturates at 255, where v - hi is 0, so `lo` cannot round
    // up into a carry that the decode would misread.
    const lo = Math.round((v - hi) * 255);
    out[i * 4] = hi;
    out[i * 4 + 1] = lo;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function unpackDistance(r, g) {
  return ((r + g / 255) / 255) * 2 * RANGE - RANGE;
}
