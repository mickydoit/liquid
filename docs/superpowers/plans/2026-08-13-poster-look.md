# Poster Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Form slider so it reaches the `blobfield.js` organism, letting the app be adjusted into the EXPO-poster look — one large cropped organic form, sweeping tapered necks, strong negative space.

**Architecture:** Form becomes a three-engine ramp hinged at 0.5. Below 0.5 is today's cymatic-to-blob mask blend, remapped. Above 0.5 the blob and organism blend as **signed distances** and are thresholded once, which is what keeps the upper half crisp. The organism reaches the WebGL preview as a baked signed-distance texture rather than a GLSL port, so there is one geometry implementation and the preview matches what SVG emits.

**Tech Stack:** Vanilla ES modules, WebGL1, `node --test`. No dependencies.

## Global Constraints

- **No new runtime dependencies.** The project has none and ships as static files.
- **`js/blobfield.js` is not modified.** It is tuned and carries passing tests.
- **WebGL1 only.** No `OES_texture_float`, no `OES_standard_derivatives`, no extension checks.
- **Every geometry change must land on the state the exporter reads**, or a design will export differently from its preview. Follow the existing comments in `js/app.js:302-326`.
- **Run `npm run bust` before any commit that changes `index.html`, `style.css` or a file under `js/`.** Otherwise GitHub Pages serves a stale build for ten minutes.
- **Preview bake resolution is 256. Export bake resolution is 900.**
- **`RANGE = 2.0`** world units for distance packing.
- Full test suite must pass at every commit: `npm test`.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/blobfield.js` | Organism geometry. **Unchanged.** |
| `js/bake.js` | Field → cleaned signed grid. **Unchanged.** |
| `js/sdftex.js` | **New.** Pack/unpack a signed distance to RGBA8. Pure functions, no WebGL. |
| `js/organism.js` | **New.** Seed + controls → cached baked SDF. Knows nothing about WebGL. |
| `js/organism.worker.js` | **New.** Runs the bake off the main thread. |
| `js/cymafield.js` | Field maths. Gains `blobDist`, the Form remap, the organism branch, the plate-mask fade. |
| `js/shader.js` | GLSL. Gains organism sampling and the analytic edge. |
| `js/renderer.js` | Gains `setOrganismSDF`, three uniforms, `uPxWorld`. |
| `js/app.js` | Poster control group, seed/reroll, audio wiring, slider remap. |
| `js/export.js` | Bakes the organism at export resolution. |

---

### Task 1: Split blob distance from blob thickness

Both the CPU and GLSL blob functions currently threshold internally, so there is no distance to blend with. This task exposes the distance without changing any output.

**Files:**
- Modify: `js/cymafield.js:246-254` (`blobThickness`)
- Modify: `js/shader.js:88-95` (`blobAt`)
- Test: `test/cymafield.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `blobDist(x, y, s) -> number` (signed, negative inside, world units), exported from `js/cymafield.js`. GLSL `float blobDist(vec2 p)` in `js/shader.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/cymafield.test.js — append
import { blobDist, blobThickness, idleState } from '../js/cymafield.js';

test('blobDist is negative inside a lobe and positive far outside', () => {
  const s = Object.assign(idleState(), { form: 1, amp: 0.5 });
  // The centre lobe always exists, so the origin is inside.
  assert.ok(blobDist(0, 0, s) < 0, 'origin should be inside');
  // Far outside the plate.
  assert.ok(blobDist(3, 3, s) > 0, 'far corner should be outside');
});

test('blobThickness still agrees with the sign of blobDist', () => {
  const s = Object.assign(idleState(), { form: 1, amp: 0.5 });
  for (const [x, y] of [[0, 0], [0.5, 0.2], [1.5, 1.5], [-0.3, 0.7]]) {
    const d = blobDist(x, y, s);
    const T = blobThickness(x, y, s);
    if (d < -0.02) assert.equal(T, 1, `deep inside at ${x},${y}`);
    if (d > 0.02) assert.equal(T, 0, `well outside at ${x},${y}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cymafield.test.js`
Expected: FAIL — `blobDist` is not exported.

- [ ] **Step 3: Write minimal implementation**

Replace `blobThickness` in `js/cymafield.js`:

```js
// The signed distance itself, kept separate from the threshold so the Form
// ramp can blend it with the organism's distance BEFORE either is thresholded.
// Blending two already-thresholded masks is what makes today's mid-Form blur:
// a half-and-half mask has no sharp transition left to find.
export function blobDist(x, y, s) {
  const cs = blobCircles(s);
  const k = 0.15 + 0.08 * (1 - (s.simple ?? 0));
  let d = Math.hypot(x - cs[0].x, y - cs[0].y) - cs[0].r;
  for (let i = 1; i < cs.length; i++) {
    d = smin(d, Math.hypot(x - cs[i].x, y - cs[i].y) - cs[i].r, k);
  }
  return d;
}

export function blobThickness(x, y, s) {
  return 1 - smoothstep(-0.012, 0.012, blobDist(x, y, s));
}
```

In `js/shader.js`, split the GLSL the same way:

```glsl
float blobDist(vec2 p) {
  float d = length(p - uBlob[0].xy) - uBlob[0].z;
  for (int i = 1; i < 10; i++) {
    if (i >= uBlobN) break;
    d = sminf(d, length(p - uBlob[i].xy) - uBlob[i].z, uBlobK);
  }
  return d;
}

float blobAt(vec2 p) {
  return 1.0 - smoothstep(-0.012, 0.012, blobDist(p));
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, 127 tests. No existing test changes behaviour — this is a pure refactor.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/cymafield.js js/shader.js test/cymafield.test.js index.html
git commit -m "refactor: expose blob signed distance separately from its threshold"
```

---

### Task 2: Pack a signed distance into RGBA8

WebGL1 float textures need `OES_texture_float`, which is not guaranteed. 16 bits across R and G of an ordinary RGBA8 texture is finer than the edge needs and works everywhere.

**Files:**
- Create: `js/sdftex.js`
- Test: `test/sdftex.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `RANGE` (number, 2.0), `packSDF(grid: Float64Array, w: number, h: number) -> Uint8Array` (length `w*h*4`), `unpackDistance(r: number, g: number) -> number` (r, g are 0-255 ints).

- [ ] **Step 1: Write the failing test**

```js
// test/sdftex.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { packSDF, unpackDistance, RANGE } from '../js/sdftex.js';

const roundTrip = (d) => {
  const px = packSDF(Float64Array.from([d]), 1, 1);
  return unpackDistance(px[0], px[1]);
};

test('packing round-trips within 1/8000 of a world unit', () => {
  for (const d of [-2, -1.5, -0.5, -0.01, 0, 0.01, 0.5, 1.5, 2]) {
    assert.ok(Math.abs(roundTrip(d) - d) < 1 / 8000, `d=${d} -> ${roundTrip(d)}`);
  }
});

test('the zero crossing survives packing', () => {
  // The threshold is at exactly 0, so a sign flip here would move every edge.
  assert.ok(roundTrip(-0.001) < 0);
  assert.ok(roundTrip(0.001) > 0);
});

test('distances beyond RANGE clamp instead of wrapping', () => {
  // Wrapping would turn far-outside points into inside ones, punching holes.
  assert.ok(roundTrip(50) > 0);
  assert.ok(Math.abs(roundTrip(50) - RANGE) < 0.01);
  assert.ok(roundTrip(-50) < 0);
});

test('packSDF fills all four channels for every cell', () => {
  const px = packSDF(Float64Array.from([0.1, -0.1, 0.3, -0.3]), 2, 2);
  assert.equal(px.length, 16);
  for (let i = 0; i < 4; i++) assert.equal(px[i * 4 + 3], 255, 'alpha must be opaque');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sdftex.test.js`
Expected: FAIL — cannot find module `../js/sdftex.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/sdftex.js
//
// A baked signed-distance grid has to reach a WebGL1 fragment shader. Float
// textures there need OES_texture_float, which is not guaranteed, so the
// distance is packed into 16 bits across the R and G channels of an ordinary
// RGBA8 texture: about 1/16000 of a world unit, far finer than a 1px edge
// needs, and no extension check or fallback path anywhere.
export const RANGE = 2.0;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function packSDF(grid, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // Clamped, not wrapped: a wrap would turn far-outside points into inside
    // ones and punch holes through the design.
    const v = clamp01((grid[i] + RANGE) / (2 * RANGE)) * 255;
    const hi = Math.floor(v);
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
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/sdftex.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add js/sdftex.js test/sdftex.test.js
git commit -m "feat: pack signed distances into RGBA8 for WebGL1"
```

---

### Task 3: Cached organism bakes

**Files:**
- Create: `js/organism.js`
- Test: `test/organism.test.js`

**Interfaces:**
- Consumes: `makeBlobField`, `defaultControls` from `js/blobfield.js`; `bake`, `FORMATS` from `js/bake.js`.
- Produces: `makeOrganismCache() -> { request(seed, controls, res) -> {grid, w, h, aspect, sample}, bakes: number, dispose() }`. `bakes` counts actual bakes performed, for tests and diagnostics.

- [ ] **Step 1: Write the failing test**

```js
// test/organism.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOrganismCache } from '../js/organism.js';

const CONTROLS = { formCount: 0.30, stretch: 0.95, merge: 0.10, simplify: 0.55, scaleCrop: 1.30 };

test('the same seed and controls give an identical grid', () => {
  const a = makeOrganismCache().request(47, CONTROLS, 96);
  const b = makeOrganismCache().request(47, CONTROLS, 96);
  assert.deepEqual(Array.from(a.grid), Array.from(b.grid));
});

test('different seeds give different grids', () => {
  const c = makeOrganismCache();
  const a = c.request(47, CONTROLS, 96);
  const b = c.request(48, CONTROLS, 96);
  assert.notDeepEqual(Array.from(a.grid), Array.from(b.grid));
});

test('an unchanged request does not re-bake', () => {
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, CONTROLS, 96);
  assert.equal(c.bakes, 1);
});

test('any control change re-bakes', () => {
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, Object.assign({}, CONTROLS, { merge: 0.9 }), 96);
  assert.equal(c.bakes, 2);
});

test('a resolution change re-bakes', () => {
  // Export asks for 900 after the preview asked for 256; returning the
  // preview grid would silently export a low-resolution design.
  const c = makeOrganismCache();
  c.request(47, CONTROLS, 96);
  c.request(47, CONTROLS, 128);
  assert.equal(c.bakes, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/organism.test.js`
Expected: FAIL — cannot find module `../js/organism.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/organism.js
//
// Turns a seed plus controls into a baked signed-distance grid, without
// re-doing work. A bake at preview resolution costs ~22 ms, so re-baking on
// every frame would cap the app at ~45 fps for no reason: the organism only
// changes when its inputs do.
//
// Knows nothing about WebGL. The renderer decides what to do with the grid.
import { makeBlobField, defaultControls } from './blobfield.js';
import { bake, FORMATS } from './bake.js';

// Every control, in a fixed order, so the key is stable across objects that
// happen to enumerate their properties differently.
const KEYS = Object.keys(defaultControls()).sort();
const keyFor = (seed, controls, res) =>
  `${seed}|${res}|${KEYS.map((k) => (controls[k] ?? defaultControls()[k]).toFixed(4)).join(',')}`;

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
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/organism.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add js/organism.js test/organism.test.js
git commit -m "feat: cache organism bakes by seed, controls and resolution"
```

---

### Task 4: The Form ramp on the CPU field

This is the geometry change, and it must land on the state the exporter reads.

**Files:**
- Modify: `js/cymafield.js:149-187` (`nodalThickness`)
- Test: `test/cymafield.test.js`

**Interfaces:**
- Consumes: `blobDist` (Task 1); a `sample(x, y)` function from Task 3's bake.
- Produces: `nodalThickness(x, y, s)` now honours `s.organism` — an optional `{ sample(x, y) }` — and remaps `s.form`. State gains `organism: null` in `idleState()`.

- [ ] **Step 1: Write the failing test**

```js
// test/cymafield.test.js — append
import { nodalThickness, idleState } from '../js/cymafield.js';

// A stand-in organism: a disc of radius 0.5 at the origin, as a signed
// distance. Using a known analytic shape keeps this test about the RAMP,
// not about whatever blobfield happens to draw.
const DISC = { sample: (x, y) => Math.hypot(x, y) - 0.5 };

test('Form 1.0 is the pure organism', () => {
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, organism: DISC });
  assert.equal(nodalThickness(0, 0, s), 1, 'disc centre is inside');
  assert.equal(nodalThickness(0.9, 0, s), 0, 'well outside the disc');
});

test('the ramp is continuous across the 0.5 hinge', () => {
  const at = (form) => {
    const s = Object.assign(idleState(), { form, amp: 0.5, organism: DISC });
    return nodalThickness(0.35, 0.1, s);
  };
  assert.ok(Math.abs(at(0.499) - at(0.501)) < 0.05, 'no jump at the hinge');
});

test('the upper half stays crisp', () => {
  // The regression test for the mid-Form blur. Walk x across the disc edge
  // and count cells that are neither fully in nor fully out. A distance-space
  // blend keeps that band a few cells wide; a mask blend smears it.
  for (const form of [0.6, 0.75, 0.9, 1.0]) {
    const s = Object.assign(idleState(), { form, amp: 0.5, organism: DISC });
    let soft = 0;
    for (let i = 0; i <= 400; i++) {
      const T = nodalThickness(-1 + (2 * i) / 400, 0, s);
      if (T > 0.01 && T < 0.99) soft++;
    }
    assert.ok(soft <= 12, `Form ${form} had ${soft} soft cells, expected <= 12`);
  }
});

test('without an organism the ramp falls back to the blob', () => {
  // Before the first bake lands there is no organism; the design must not
  // vanish, it must hold the blob.
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, organism: null });
  assert.ok(nodalThickness(0, 0, s) > 0, 'still draws something');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cymafield.test.js`
Expected: FAIL — `nodalThickness` ignores `s.organism`; Form 1.0 returns the blob, not the disc.

- [ ] **Step 3: Write minimal implementation**

In `js/cymafield.js`, add `organism: null` to the object returned by `idleState()`, then replace the `if (s.form)` block inside `nodalThickness`:

```js
  // The Form ramp, hinged at 0.5.
  //
  //   0.0 -> 0.5   cymatic field -> blob   (mask blend, as before)
  //   0.5 -> 1.0   blob -> organism        (DISTANCE blend)
  //
  // The upper half blends signed distances and thresholds ONCE at the end.
  // Blending two already-thresholded masks — which is what the lower half
  // does — is exactly what makes mid-Form look blurred: a half-and-half mask
  // has no sharp transition left to find. Distances have no such problem, so
  // the organism half is crisp at every position.
  const form = s.form ?? 0;
  if (form > 0) {
    const lower = Math.min(1, form * 2);
    const w = smoothstep(0, 1, lower);
    T = T * (1 - w) + blobThickness(x, y, s) * w;

    if (form > 0.5 && s.organism) {
      const upper = smoothstep(0, 1, (form - 0.5) * 2);
      const dBlob = blobDist(x, y, s);
      const dOrg = s.organism.sample(x, y);
      const d = dBlob * (1 - upper) + dOrg * upper;
      // One pixel at bake resolution. The CPU path has no screen to measure
      // against, so it uses a fixed hairline: the exporter contours at the
      // zero crossing anyway, and this only shapes the antialiasing.
      T = 1 - smoothstep(-0.004, 0.004, d);
    }
  }
```

Remove the old `if (s.form) { ... }` block this replaces. Import nothing new — `blobDist` and `blobThickness` are in the same module.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. If an existing Form test fails on the remap, update its Form value to half its old value and note the remap in a comment — that is the intended behaviour change.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/cymafield.js test/cymafield.test.js index.html
git commit -m "feat: hinge the Form ramp at 0.5 and blend to the organism in distance space"
```

---

### Task 5: Release the plate mask above the hinge

**Not in the original spec — found while planning.** `nodalThickness` ends with `T *= 1 - smoothstep(1.02, 1.30, r)`, a soft circular dish edge. The reference posters run edge to edge on all four sides. With the plate mask always on, the organism is trapped inside a disc and the look is unreachable no matter how the sliders are set.

**Files:**
- Modify: `js/cymafield.js` (the plate line at the end of `nodalThickness`)
- Modify: `js/shader.js:135` (the same line in GLSL)
- Test: `test/cymafield.test.js`

**Interfaces:**
- Consumes: Task 4's ramp.
- Produces: no new exports. Behaviour: the plate mask fades out linearly across Form 0.5 → 1.0.

- [ ] **Step 1: Write the failing test**

```js
// test/cymafield.test.js — append
test('the plate edge is gone at Form 1.0 so forms can run off frame', () => {
  const BIG = { sample: (x, y) => Math.hypot(x, y) - 5 };  // covers the frame
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, organism: BIG });
  // Well outside the plate radius but inside a portrait frame's corner.
  assert.equal(nodalThickness(1.2, 0.9, s), 1, 'no dish edge at Form 1');
});

test('the plate edge still holds at Form 0', () => {
  const s = Object.assign(idleState(), { form: 0, amp: 0.9 });
  assert.equal(nodalThickness(1.6, 0, s), 0, 'dish edge intact for the field');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cymafield.test.js`
Expected: FAIL — the first assertion returns 0; the plate mask crops it.

- [ ] **Step 3: Write minimal implementation**

In `js/cymafield.js`, replace the plate line at the end of `nodalThickness`:

```js
  // Soft plate boundary — the dish edge, not a hard crop.
  //
  // Released as Form crosses into the organism: a Chladni figure lives on a
  // physical plate and must end at its rim, but the organism is a poster
  // composition whose whole language is forms running off the frame. Holding
  // the dish edge there would trap it in a disc and make the look unreachable.
  const r = Math.sqrt(x * x + y * y);
  const plate = 1 - smoothstep(1.02, 1.30, r);
  const release = clamp01((form - 0.5) * 2);
  T *= plate * (1 - release) + release;
  return T;
```

In `js/shader.js`, replace line 135 (`return T * (1.0 - smoothstep(1.02, 1.30, length(p)));`):

```glsl
  float plate = 1.0 - smoothstep(1.02, 1.30, length(p));
  float release = clamp((uForm - 0.5) * 2.0, 0.0, 1.0);
  return T * mix(plate, 1.0, release);
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/cymafield.js js/shader.js test/cymafield.test.js index.html
git commit -m "feat: release the plate edge above the Form hinge so forms can run off frame"
```

---

### Task 6: Upload the organism to the GPU

**Files:**
- Modify: `js/renderer.js:10-17` (`UNIFORMS`), `js/renderer.js:116-132` (beside `setBackdrop`), and the uniform-setting block around `js/renderer.js:180`
- Test: manual — WebGL has no coverage in `node --test`. Verified in Task 7.

**Interfaces:**
- Consumes: `packSDF` from `js/sdftex.js`.
- Produces: `renderer.setOrganismSDF(grid, w, h)` and `renderer.setOrganismMix(v)`. Uniforms `uOrganism` (sampler2D, texture unit 1), `uOrgSize` (vec2), `uHasOrganism` (float), `uPxWorld` (float).

- [ ] **Step 1: Add the uniform names**

In `js/renderer.js`, extend the `UNIFORMS` array:

```js
  'uGround', 'uInk', 'uDeep',
  'uOrganism', 'uOrgSize', 'uHasOrganism', 'uPxWorld',
```

- [ ] **Step 2: Add the upload method**

Beside `setBackdrop` in `js/renderer.js`:

```js
  // The organism arrives as a baked signed-distance grid rather than as GLSL.
  // Keeping one CPU implementation is the point: a GLSL port would be a second
  // source of truth, and bake()'s morphology cleanup — which is what produces
  // the clean poster silhouettes — has no fragment-shader equivalent, so a
  // ported preview would systematically differ from the export.
  setOrganismSDF(grid, w, h) {
    const gl = this.gl;
    if (this._orgTex) { gl.deleteTexture(this._orgTex); this._orgTex = null; }
    if (grid) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, packSDF(grid, w, h));
      // LINEAR so the distance interpolates between cells: that is what lets a
      // 256-cell bake hold a clean edge well past 1:1 zoom.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._orgTex = t;
      this._orgSize = [w, h];
    }
    this._dirty = true;
  }
```

Add `import { packSDF } from './sdftex.js';` at the top of `js/renderer.js`, and initialise `this._orgTex = null; this._orgSize = [1, 1];` beside the other field initialisers near line 72.

- [ ] **Step 3: Bind the texture and set the uniforms**

In the render function beside the existing `uBackTex` binding:

```js
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._orgTex);
    gl.uniform1i(u.uOrganism, 1);
    gl.uniform2f(u.uOrgSize, this._orgSize[0], this._orgSize[1]);
    gl.uniform1f(u.uHasOrganism, this._orgTex ? 1 : 0);
    // One pixel in WORLD units, computed rather than taken from fwidth:
    // fwidth needs OES_standard_derivatives on WebGL1, the same
    // extension-availability trap as float textures. Because the blended
    // value is a true signed distance, this is exact.
    const hPx = useInset ? this.canvas.height : height;
    gl.uniform1f(u.uPxWorld, 2.0 / (hPx * this.zoom * (useInset ? this.insetZoom : 1)));
```

Confirm the exact local names for `height` and `useInset` at the call site before writing this; the render path is shared between the canvas and `renderToCanvas`.

- [ ] **Step 4: Verify the app still runs**

Run: `npm start`, open `http://localhost:8788`, confirm no WebGL errors in the console and the design still renders. `uHasOrganism` is 0, so nothing should change visually.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/renderer.js index.html
git commit -m "feat: upload the baked organism as an RGBA8 distance texture"
```

---

### Task 7: Sample the organism in GLSL

**Files:**
- Modify: `js/shader.js` (uniform block near line 30, and `nodalAt` near line 134)
- Test: manual visual check, described below.

**Interfaces:**
- Consumes: Task 6's uniforms; Task 1's `blobDist`.
- Produces: no new exports.

- [ ] **Step 1: Declare the uniforms**

In the `js/shader.js` uniform block:

```glsl
uniform sampler2D uOrganism;  // baked signed distance, 16-bit across R and G
uniform vec2 uOrgSize;
uniform float uHasOrganism;
uniform float uPxWorld;       // one pixel, in world units
```

- [ ] **Step 2: Add the sampler**

```glsl
// Unpack the 16-bit distance. Must mirror unpackDistance() in js/sdftex.js
// exactly — the two are one format, split across two languages.
float organismDist(vec2 p) {
  // The bake covers x in [-aspect, aspect], y in [-1, 1], portrait aspect.
  vec2 uv = vec2((p.x / (uOrgSize.x / uOrgSize.y) + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  vec4 t = texture2D(uOrganism, uv);
  return (t.r + t.g / 255.0) * 4.0 - 2.0;
}
```

Why `* 4.0 - 2.0`: `RANGE` is 2.0, so the decode is `v * 2 * RANGE - RANGE`. `texture2D` already returns 0-1 floats, so `v = t.r + t.g / 255.0` — the JS side's `/255` divisions are already applied by the sampler.

- [ ] **Step 3: Blend it in**

Replace the `uForm` blend inside `nodalAt`:

```glsl
  float lower = min(1.0, uForm * 2.0);
  T = mix(T, blobAt(p), smoothstep(0.0, 1.0, lower));

  if (uForm > 0.5 && uHasOrganism > 0.5) {
    float upper = smoothstep(0.0, 1.0, (uForm - 0.5) * 2.0);
    float d = mix(blobDist(p), organismDist(p), upper);
    // One pixel of transition, no more: this is what makes the upper half
    // crisp where a mask blend smears over tens of pixels.
    T = 1.0 - smoothstep(-uPxWorld, uPxWorld, d);
  }
```

- [ ] **Step 4: Verify visually**

Wire a temporary bake into the console via `window.__liquid`, or wait for Task 8 and check then. The check: at Form 1.0 with View = Flat fill, the edge must be crisp at every zoom, and the shape must match `node tools/render.mjs` output for the same seed and controls.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/shader.js index.html
git commit -m "feat: sample the organism distance texture in the fragment shader"
```

---

### Task 8: Poster controls, seed and reroll

**Files:**
- Modify: `index.html` (the Water `<details>` panel)
- Modify: `js/app.js` (params, slider wiring, the design pipeline)
- Test: manual, plus the headless smoke check below.

**Interfaces:**
- Consumes: `makeOrganismCache` (Task 3); `resolveControls`, `seedFor` from `js/blobfield.js`.
- Produces: `params.poster = { formCount, stretch, merge, simplify, scaleCrop }` and `params.variation` (integer).

- [ ] **Step 1: Add the markup**

In `index.html`, after the Water `<details>` block:

```html
    <details open id="poster-group">
      <summary>Poster</summary>
      <p class="hint tight">Active above Form 0.5.</p>
      <label>Form count<input type="range" id="sl-p-count" min="0" max="1" step="0.02" value="0.30"></label>
      <label>Stretch<input type="range" id="sl-p-stretch" min="0" max="1" step="0.02" value="0.95"></label>
      <label>Merge<input type="range" id="sl-p-merge" min="0" max="1" step="0.02" value="0.10"></label>
      <label>Simplify<input type="range" id="sl-p-simplify" min="0" max="1" step="0.02" value="0.55"></label>
      <label>Scale / crop<input type="range" id="sl-p-crop" min="0.5" max="2" step="0.05" value="1.30"></label>
      <button id="btn-reroll" class="wide">Reroll composition</button>
    </details>
```

- [ ] **Step 2: Wire the sliders**

In `js/app.js`, add to `params`:

```js
  poster: { formCount: 0.30, stretch: 0.95, merge: 0.10, simplify: 0.55, scaleCrop: 1.30 },
  variation: 0,
```

Then, beside the other slider handlers:

```js
  // The Poster controls are GEOMETRY, so like Simplicity and Swell they have
  // to land on the state the vector export reads.
  const POSTER = { 'sl-p-count': 'formCount', 'sl-p-stretch': 'stretch',
                   'sl-p-merge': 'merge', 'sl-p-simplify': 'simplify',
                   'sl-p-crop': 'scaleCrop' };
  for (const [id, key] of Object.entries(POSTER)) {
    $(id).addEventListener('input', (e) => {
      params.poster[key] = parseFloat(e.target.value);
      refreshOrganism();
    });
  }
  $('btn-reroll').addEventListener('click', () => { params.variation++; refreshOrganism(); });
```

- [ ] **Step 3: Add the refresh function**

```js
const organismCache = makeOrganismCache();

// Rebuild the organism and hand it to BOTH the renderer (as a texture) and
// the field state (as a sample function). The renderer draws from the
// texture; the exporter contours the state. They must be the same bake or a
// design will export differently from its preview.
function refreshOrganism() {
  const s = currentState();
  if (!s || (params.form ?? 0) <= 0.5) return;
  const controls = resolveControls(params.poster, s.features ?? null);
  const seed = seedFor(s.features ?? null, params.variation);
  const baked = organismCache.request(seed, controls, 256);
  s.organism = baked;
  renderer.setOrganismSDF(baked.grid, baked.w, baked.h);
  renderer._dirty = true;
}
```

Call `refreshOrganism()` from the `sl-form` handler after setting `params.form`, and wherever a new design is committed. Add the imports:

```js
import { makeOrganismCache } from './organism.js';
import { resolveControls, seedFor } from './blobfield.js';
```

- [ ] **Step 4: Verify end to end**

Run `npm start`, then in the browser: set View to Flat fill, drag Form to 1.0, and confirm a large organic form appears with crisp edges. Drag Scale to 2.0 and confirm forms run off all four frame edges (this is what Task 5 unlocked). Press Reroll and confirm the composition changes. Sweep Form from 0 to 1 and confirm no jump at 0.5.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add index.html js/app.js index.html
git commit -m "feat: add the Poster control group, seed and reroll"
```

---

### Task 9: Export the organism at full resolution

**Files:**
- Modify: `js/export.js:16-27` (`buildSVG`)
- Test: `test/export.test.js`

**Interfaces:**
- Consumes: `makeOrganismCache` (Task 3).
- Produces: `buildSVG` re-bakes at 900 when `state.form > 0.5`.

- [ ] **Step 1: Write the failing test**

```js
// test/export.test.js — append
import { buildSVG } from '../js/export.js';
import { idleState } from '../js/cymafield.js';

test('an organism design exports a non-trivial path', () => {
  const DISC = { sample: (x, y) => Math.hypot(x, y) - 0.5 };
  const s = Object.assign(idleState(), { form: 1, amp: 0.5, grow: 1, organism: DISC });
  const svg = buildSVG({ state: s, width: 400, height: 600, ink: '#fff', variant: 'flat' });
  assert.match(svg, /<path id="water"/);
  // A disc traced at 400x600 is hundreds of points, not a stub.
  assert.ok(svg.length > 1000, `expected a real outline, got ${svg.length} bytes`);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test test/export.test.js`
Expected: PASS if `makeWaterField` already routes through `nodalThickness` (it does). This test pins the behaviour so Step 3's re-bake cannot regress it.

- [ ] **Step 3: Add the export-resolution re-bake**

In `buildSVG`, before building the field:

```js
  // Re-bake at export resolution. The preview bakes at 256 for speed; emitting
  // that grid would ship a visibly coarser silhouette than the design the user
  // approved on screen.
  if ((state.form ?? 0) > 0.5 && state.organism && state.organismSource) {
    const { seed, controls } = state.organismSource;
    state = Object.assign({}, state, {
      organism: exportCache.request(seed, controls, 900),
    });
  }
```

Add `const exportCache = makeOrganismCache();` at module scope and the import. In Task 8's `refreshOrganism`, also set `s.organismSource = { seed, controls }` so the exporter can reproduce the bake.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/export.js js/app.js test/export.test.js index.html
git commit -m "feat: re-bake the organism at export resolution"
```

---

### Task 10: Move the bake off the main thread

Deliberately last. A 256 bake is ~22 ms, which is usable on the main thread; this task removes the jank rather than enabling the feature, so it must not block anything before it.

**Files:**
- Create: `js/organism.worker.js`
- Modify: `js/organism.js`
- Test: `test/organism.test.js`

**Interfaces:**
- Consumes: Task 3's cache.
- Produces: `makeOrganismCache({ worker = true })`; `request()` keeps its synchronous signature and returns the last known grid while a new bake is in flight, so the render loop never waits.

- [ ] **Step 1: Write the failing test**

```js
// test/organism.test.js — append
import { bakeOrganism } from '../js/organism.js';

test('the worker payload and the synchronous bake agree exactly', () => {
  // The worker path must not be a second implementation. bakeOrganism() is
  // the single function both the worker and the fallback call.
  const a = bakeOrganism(47, CONTROLS, 96);
  const b = bakeOrganism(47, CONTROLS, 96);
  assert.deepEqual(Array.from(a.grid), Array.from(b.grid));
  assert.equal(a.w, b.w);
  assert.equal(a.h, b.h);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/organism.test.js`
Expected: FAIL — `bakeOrganism` is not exported.

- [ ] **Step 3: Extract and wire the worker**

In `js/organism.js`, extract the body of the bake into an exported function, and have both the cache and the worker call it:

```js
// The ONE bake. The worker and the synchronous fallback both call this, so
// there is no way for the two paths to drift apart.
export function bakeOrganism(seed, controls, res) {
  const { field } = makeBlobField(seed, controls);
  return bake(field, {
    aspect: FORMATS.portrait,
    res,
    simplify: controls.simplify ?? defaultControls().simplify,
  });
}
```

```js
// js/organism.worker.js
import { bakeOrganism } from './organism.js';

self.onmessage = (e) => {
  const { seed, controls, res, token } = e.data;
  const b = bakeOrganism(seed, controls, res);
  // Transfer rather than copy: a 900-res grid is ~6 MB.
  self.postMessage({ token, grid: b.grid, w: b.w, h: b.h, aspect: b.aspect },
                   [b.grid.buffer]);
};
```

In the cache, when `worker` is enabled: post the request, return the previous value immediately, and on the reply store the new grid and invoke an `onReady` callback so `app.js` can call `renderer.setOrganismSDF` and mark dirty. Fall back to calling `bakeOrganism` synchronously when `typeof Worker === 'undefined'`.

Note: the worker must be constructed as a module worker — `new Worker(url, { type: 'module' })` — because `organism.js` uses ES imports.

- [ ] **Step 4: Run the full suite and check the app**

Run: `npm test`, then `npm start` and drag the Poster sliders. Expected: PASS, and dragging is smooth with no per-frame stutter.

- [ ] **Step 5: Commit**

```bash
npm run bust
git add js/organism.js js/organism.worker.js test/organism.test.js index.html
git commit -m "feat: bake the organism in a worker, with a synchronous fallback"
```

---

## Self-Review

**Spec coverage.** Form axis → Tasks 1, 4. Distance-space blend → Task 4. Components: `sdftex.js` Task 2, `organism.js` Task 3, worker Task 10, renderer Task 6, shader Task 7, cymafield Tasks 1/4/5, app Task 8, export Task 9. Texture format → Task 2. Analytic edge → Tasks 6, 7. Resolution 256/900 → Tasks 8, 9. Controls → Task 8. Seed and reroll → Task 8, using `seedFor(features, variation)`, which already exists in `blobfield.js:342` and needs no new code. Audio → Task 8 via `resolveControls`. Testing items 1-7 → Tasks 1-10 as written.

**Gap found and added:** the plate mask (Task 5). The spec did not mention it; without it the organism is trapped in a disc and the reference look is unreachable. This is the one place the plan exceeds the spec, and it is required, not optional.

**Spec item deliberately not covered:** testing item 7, "preview and export describe the same boundary", is asserted structurally — both paths call `nodalThickness` on the same state — rather than by a pixel comparison, which would need a GL context `node --test` does not have. Task 9's test pins the export side.

**Type consistency.** `blobDist(x, y, s)` / `blobDist(vec2)` used consistently in Tasks 1, 4, 7. `request(seed, controls, res)` consistent in Tasks 3, 8, 9, 10. `bakeOrganism(seed, controls, res)` introduced and used only in Task 10. `packSDF`/`unpackDistance` defined in Task 2, used in Tasks 6 and 7 — and Task 7 notes explicitly that the GLSL decode must mirror the JS.
