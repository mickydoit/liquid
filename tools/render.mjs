// Render blob fields to PNG for visual review.
//
//   node tools/render.mjs out/ 1 2 3
//
// Writes out/blob-<seed>.png for each seed. Solid preview only: black form on
// white ground, hard threshold, so what you see is the silhouette itself with
// no material dressing it up.
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodePNG } from './png.mjs';
import { makeBlobField, defaultControls } from '../js/blobfield.js';

export function renderField(field, { width = 900, height = 1350, aspect = null } = {}) {
  const a = aspect ?? width / height;
  const rgb = new Uint8Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    // World y-up, image y-down.
    const y = 1 - (2 * (j + 0.5)) / height;
    for (let i = 0; i < width; i++) {
      const x = (-1 + (2 * (i + 0.5)) / width) * a;
      const v = field(x, y) < 0 ? 0 : 255;
      const o = (j * width + i) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
    }
  }
  return { rgb, width, height };
}

const [, , outDir = 'out', ...seeds] = process.argv;
if (seeds.length) {
  mkdirSync(outDir, { recursive: true });
  for (const s of seeds) {
    const { field } = makeBlobField(Number(s), defaultControls());
    const { rgb, width, height } = renderField(field);
    writeFileSync(`${outDir}/blob-${s}.png`, encodePNG(width, height, rgb));
    console.log(`${outDir}/blob-${s}.png`);
  }
}
