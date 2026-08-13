# Poster look — reaching the organism from the Form slider

Date: 2026-08-13

## Problem

The reference look — one large organic form cropped by the frame, sweeping
tapered necks, strong negative space, flat light-on-dark — is already produced
by `js/blobfield.js`. Its `large` scenario was tuned against these exact
posters; the code comments cite "the cropped-poster case" and "forms entering
from TWO edges".

But `blobfield.js` is reachable only from `node tools/render.mjs` and the tests.
Nothing in the browser app imports it. The web app runs the cymatic engine in
`js/cymafield.js`, whose two reachable topologies are a nodal web and a field of
islands, plus a `smin` metaball at `form = 1`. None of them is the organism.

So the app cannot currently be adjusted into the reference look, and the closest
thing the project owns sits one directory away, unwired.

A second, related defect blocks the look even where the shapes are close.
Measured 2026-08-13 across a headless render sweep:

- Flat fill is crisp at `form = 1.0` and blurred at `form = 0.0`, blurred in
  patches in between. The blob path is an SDF with a steep, near-constant
  gradient, so the shader's fixed-width edge band lands sub-pixel. The cymatic
  path is a shallow modal field, so the same band smears over tens of pixels.
- Outline view disintegrates into stray arcs above `form ~= 0.5`.
- The blur is preview-only: exporting the blurred state and rasterising the SVG
  gives hard, correct edges.

The root cause is diagnosed in the project memory note
`project-liquid-shader-findings` as item 1, and is unfixed.

## Goals

1. The Form slider can reach the organism, so the app can be adjusted into the
   reference look.
2. Sound still drives the design across the slider's whole range.
3. The preview tells the truth. The views are labelled "what Flat SVG emits";
   in this mode they must actually match.

## Non-goals

- Fixing the cymatic path's blurred edges. That is a real defect with a known
  fix, but it is item 1 of a separate diagnosis and is not required here — the
  new upper half of the slider does not use that path.
- Any change to `js/blobfield.js`. It works and carries passing tests.
- Exposing all eight blobfield controls. See "Controls".

## Design

### The Form axis

Form becomes a three-engine ramp hinged at the midpoint:

| Range | Blend |
|---|---|
| 0.00 -> 0.50 | cymatic field -> blob (today's behaviour, compressed) |
| 0.50 -> 1.00 | blob -> organism (new) |

Below 0.5, behaviour is today's, with the input remapped `form * 2` so the full
cymatic-to-blob range still fits. At exactly 0.5 both halves evaluate to the
pure blob, so the ramp is continuous.

Above 0.5 the blend happens in **distance space**, not mask space. Both sides
are signed distance fields — the blob's `smin` result taken *before*
`blobThickness` thresholds it, and the organism's baked signed grid. They lerp
as distances and are thresholded once, at the end:

```
d = mix(d_blob, d_organism, w)      // w = smoothstep(0, 1, (form - 0.5) * 2)
T = 1 - smoothstep(-e, +e, d)       // e = one pixel, in world units
```

`e` is **computed analytically, not with `fwidth`**. `fwidth` requires
`OES_standard_derivatives` on WebGL1, which is the same extension-availability
trap as float textures. Because `d` is a true signed distance in world units,
one pixel in world units is just `e = 1.0 / (uZoom * uResolution.y * 0.5)`,
already available as uniforms. No extension, no per-platform branch.

This is what keeps the upper half crisp. Blending two thresholded masks — the
way the lower half works today — is precisely what produces the observed
mid-Form blur, because a half-and-half mask has no sharp transition to find.

**Accepted consequence:** compressing cymatic-to-blob into 0-0.5 changes what
existing Form values mean; 0.40 today becomes 0.20. No code path persists a
design to disk, so the cost is re-finding slider positions by eye.

### Components

```
audio -> features -> audioTargets() -> controls -+
                                                 +-> organism.js -> worker -> bake() -> SDF grid
seed (fingerprint + reroll) ---------------------+                                        |
                                                                                          v
                                            renderer.setOrganismSDF() -> RGBA8 texture
                                                                                          |
                                                                                          v
                                       shader: mix(d_blob, d_organism, w) -> threshold
```

**`js/organism.js`** (new) — owns the bake lifecycle. Public surface:

- `request(seed, controls)` — returns the cached SDF if `(seed, controls)` is
  unchanged, otherwise schedules a bake and resolves when it lands.
- `dispose()`

It depends on `blobfield.js` and `bake.js` and knows nothing about WebGL. One
job: turn a seed plus controls into a signed grid, without re-doing work.

**`js/organism.worker.js`** (new) — runs `makeBlobField` + `bake` off the main
thread. Falls back to a synchronous main-thread bake where Workers are
unavailable; the fallback must produce byte-identical output.

**`js/blobfield.js`** — unchanged.

**`js/renderer.js`** — gains `setOrganismSDF(grid, w, h)` and the uniforms
`uOrganism` (sampler), `uOrganismMix` (float), `uHasOrganism` (float, used as a
bool). Texture upload mirrors the existing `setBackdrop` path.

**`js/shader.js`** — samples the organism SDF, lerps with the blob distance,
thresholds with a screen-space derivative for a ~1px edge.

**`js/cymafield.js`** — `nodalThickness` gains the matching organism branch so
the CPU field, which the exporter reads, agrees with the GPU.

**`js/app.js`** — slider remap, the Poster control group, seed and reroll, and
audio wiring through blobfield's existing `audioTargets` / `resolveControls`.

**`js/export.js`** — above Form 0.5, contour the organism baked at export
resolution.

### Texture format

The renderer is WebGL1 (`js/renderer.js:40`). Float textures there require
`OES_texture_float`, which is not guaranteed. So the signed distance packs into
16 bits across the R and G channels of an ordinary RGBA8 texture:

- Encode: `v = clamp((d + RANGE) / (2 * RANGE), 0, 1)`, then
  `R = floor(v * 255)`, `G = floor(frac(v * 255) * 255)`.
- Decode: `d = ((R + G / 255) / 255) * 2 * RANGE - RANGE`.

`RANGE = 2.0` world units, which covers the field. Resolution is then about
1/16000 of a world unit — far finer than the edge needs — and it works on every
WebGL1 implementation with no extension check and no fallback path.

### Resolution and performance

Measured on this machine, portrait aspect, `simplify = 0.55`:

| res | ms/bake | rate |
|---|---|---|
| 128 | 6.2 | 162 Hz |
| 192 | 12.5 | 80 Hz |
| 256 | 22.3 | 45 Hz |
| 384 | 48.5 | 21 Hz |
| 512 | 86.6 | 12 Hz |
| 900 | 267.8 | 3.7 Hz |

Preview bakes at **256** (45 Hz, comfortably live). Export bakes at **900+**.

A baked SDF stays smooth under interpolation, so 256 gives clean edges well
past 1:1 zoom. Fine detail softens at extreme zoom; this look is large forms,
so that is an acceptable trade rather than a compromise.

### Controls

A **Poster** group, enabled as Form crosses 0.5:

| Control | Range | Default |
|---|---|---|
| Form count | 0-1 | 0.30 |
| Stretch | 0-1 | 0.95 |
| Merge | 0-1 | 0.10 |
| Simplify | 0-1 | 0.55 |
| Scale / crop | 0.5-2.0 | 1.30 |
| Seed | integer + reroll | audio fingerprint |

Defaults are the `large` scenario from `tools/render.mjs`, which is the tuned
cropped-poster case.

`warp`, `symmetry` and `detail` are **not** exposed. They stay at their scenario
defaults. They are the three the reference work leans on least, and five
learnable sliders beats eight. They can be exposed later if they turn out to be
missed.

### Seed and variation

The seed comes from the existing `buildFingerprint()` in `js/features.js`, so
the same recording always yields the same poster. A reroll button steps to the
next variation without changing the sound, as an escape hatch when a draw is
awkward.

### Audio

Sound drives the organism through blobfield's existing `audioTargets()` and
`resolveControls()`, which cap how far audio may move each control from its
slider position. Live mode therefore works across the whole Form range, and the
three art-direction controls stay where the user put them.

## Testing

Written test-first, extending the existing `node --test` suite:

1. **Ramp continuity** — Form 0.499 and 0.501 differ only marginally; 0.5 is the
   pure blob; 1.0 is the pure organism.
2. **Crispness** — across the upper half, the field's transition from inside to
   outside spans a bounded number of cells at fixed resolution. This is the
   regression test for the blur.
3. **Determinism** — same seed and controls give a byte-identical grid.
4. **Packing** — encode/decode round-trips within 1/8000 world unit over the
   full range, including both endpoints.
5. **Cache** — a repeated identical `request()` does not re-bake; any control
   change does.
6. **Worker parity** — worker and synchronous fallback produce identical grids.
7. **Preview/export agreement** — at matched resolution, the preview field and
   the exported rings describe the same boundary.

## Risks

- **The remap changes existing slider meanings.** Accepted above; nothing
  persists designs.
- **Worker plus texture upload is new plumbing in a renderer that currently
  owns one texture.** Mitigated by mirroring `setBackdrop`, which already
  handles NPOT-safe parameters.
- **A 256 bake trails live audio by roughly 20 ms.** Below perception for a
  design that already glides between states.
