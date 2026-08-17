# Cymatic Join — filleted necks between cells, as an opt-in control

Date: 2026-08-17

## Problem

The designs the app already produces in Detailed Cymatic mode with `mass` high
are the wanted output. Three of them are pasted into Figma file
`VHjftplTmEXfXtRfQnXDRS`, frame `10:142` "Example simplified cymatics", as
`water` vectors — the `id="water"` path that `js/export.js:69` emits. They are a
disc of roughly 40–60 rounded cells, size-graded from small at the rim to broad
mid-field, around a tight starburst nodal junction.

What is missing is the **join**. In the reference the user selected (layer
`10:160`, "this one" — a photographed Russia Expo 2025 poster, the same set cited
by the Shape Style spec) and in the user's own Figma boolean unions (frames
`10:34`, `10:57`), lobes are connected by *deliberate necks*: parallel-sided
passages that meet each lobe on a concave tangent arc of a chosen radius. A few
shapes are left as unjoined islands. The connected shapes chain into one sweeping
path.

The app cannot currently produce that, and cannot be tuned into it.

### Why tuning the existing controls cannot reach it

The cells in Detailed Cymatic are a threshold on the modal field's magnitude —
`js/cymafield.js:186`:

```js
const lobe = smoothstep(thr - soft, thr + soft, f);   // f = |psi|
```

Two consequences follow, and both are structural rather than a matter of
parameter choice:

1. **The neck's shape is not choosable.** Where two cells meet, the boundary is
   whatever the field's saddle happens to look like at that level. It is a
   smeared saddle, not a tangent arc of a set radius.
2. **Joining is not selective.** `psi` is quasi-periodic, so its saddles between
   neighbouring cells sit at similar levels across the whole disc. Lowering `thr`
   does not join two chosen cells; it joins dozens at once. This is the observed
   behaviour in the exports: either separate cells, or long merged snaking
   ribbons, with no state in between.

A fillet join must therefore be a **geometric operation on identified cells**,
not a level set of the field.

### Why it cannot be a per-pixel term

Everything the app renders today is analytic and evaluated per-pixel, twice:
`nodalThickness` in `js/cymafield.js` for the CPU/export side, hand-mirrored by
the GLSL in `js/shader.js` (the mirror obligation is stated at
`js/cymafield.js:14` and `js/shader.js:87`).

A fillet join needs to know which cell is which — label the components, find
adjacent pairs, measure the channel between them. Those are whole-image
operations. They cannot be expressed per-pixel in either language, so above
Join 0 the geometry must be computed **once and shared**, not evaluated twice.

This is the same conclusion the Shape Style spec reached for morphological
cleanup, and for the same reason.

### State of the code this builds on

Verified on disk 2026-08-17, and **contradicting the project memory note**:

- `main`'s head is `10393d1`, the Metaball Cymatic merge — *not* the poster-look
  build.
- The organism/SDF-texture path landed at `c912c07` and was then **deleted from
  `main`** by `fc381d5` ("two explicit pattern styles, replacing the
  three-generator Form ramp"). `js/organism.js`, `js/organism.worker.js` and
  `js/sdftex.js` are absent from `main` and from the working tree.
- Consequently `js/bake.js` is **dead code in the app**. Nothing under `js/`
  imports it except `js/polarcells.js` and `js/nodalcells.js`, both of which are
  branch-only experiments. There is no bake-to-texture path in the running app.

So this work reinstates a bake path. It does not extend one.

## Goals

1. Detailed Cymatic gains a `Join` control that closes gaps between cells with
   circular-fillet necks matching the reference's join character.
2. At `Join = 0` the output is unchanged from today, bit for bit.
3. Turning `Join` up ramps smoothly from the current field of islands toward a
   mostly-connected form, tightest gaps closing first.
4. The exported SVG matches the screen exactly. One geometry, not two.

## Non-goals

- Changing the default look. The existing designs are the wanted output; this is
  a control, not a new default.
- Live per-frame joining. See "Accepted limitation".
- Reconciling the two metaball implementations, or deciding the fate of
  `field-scaffold`. Both are open questions, neither is on this path.
- Adding `Join` to Metaball Cymatic mode. That mode has its own `Merge`
  (`index.html:92`) and its own union operator.

## Design

### The control

One slider in the Cymatic group in `index.html`, beside Nodal detail / Swell /
Mass:

```html
<label>Join — islands to connected<input type="range" id="sl-join"
       min="0" max="1" step="0.02" value="0"></label>
```

Backed by `join: 0` in `idleState()` in `js/cymafield.js`. Default 0, so silence
and every existing preset render exactly as they do now.

### Pipeline above Join 0, on settle

1. **Sample.** Evaluate `nodalThickness` over a grid at bake resolution and
   threshold to a binary lobe mask.
2. **Label.** `labelComponents(mask, w, h, 8)` — `js/bake.js:121` — gives the
   cells.
3. **Measure channels.** For each adjacent pair of cells, measure the narrowest
   gap between them by EDT. The crop around each pair **must be padded**: a tight
   bbox cannot see background just outside it, which overestimates distances at a
   cell's extremes. This bug was found and fixed once already in the
   `field-scaffold` work; it must not be reintroduced.
4. **Rank and select.** Sort candidate pairs narrowest-first and take a prefix
   whose length is proportional to `Join`. Apply a **degree cap** — the maximum
   number of joins any one cell may take — so the ramp does not chain a whole
   radial band into a single long arc. The `field-scaffold` measurements found
   sorting by channel width *alone* did exactly that, because channels narrow
   toward the centre and the inner band therefore owns the head of the sorted
   list. Cap 1 at low Join, rising to 2 in the upper half.
5. **Join.** For each selected pair, grow both cells' own contours locally at the
   neck and apply a **circular fillet union there only**, radius derived from the
   locally measured channel width.

   Not a polynomial `smin`. A fillet cuts a *concave* tangent arc where the two
   surfaces meet, which is the waist the reference is built on; `smin` bulges
   *convexly* and reads as soap bubbles. This is stated at `js/shader.js:89` and
   `js/blobfield.js:48`, and it is the single detail that decides whether the
   result looks like the reference.

   Not capsules between centres either. That produces bone shapes — also already
   found and rejected in the `field-scaffold` work.

   The smoothing blend must be **capped at half the narrowest measured channel**.
   A blend expressed in raster widths is an absolute size, so at coarse rasters it
   closes channels by itself and `Join` stops controlling the topology.
6. **Bake.** Write the joined field to a signed-distance texture. `js/sdftex.js`
   and `js/organism.worker.js` are recoverable from `c912c07` — RGBA8 with the
   distance packed 16-bit across R+G, because WebGL1 has no guaranteed float
   textures. Restore them rather than rewriting.

   Keep the analytic value wherever the join left a cell alone, and use the EDT
   only for changed cells. Thresholding to a binary mask and rebuilding distance
   from it quantises the zero level set to a half-cell staircase at *every*
   resolution — measured at 0.225 cells RMS, versus 0.002 for the hybrid.

### Reading the baked field

- `js/renderer.js` / `js/shader.js`: when `Join > 0`, sample the SDF texture
  instead of evaluating the analytic cymatic field.
- `js/export.js`: contour **the same baked field** via the existing
  `fieldOutline` path, with the 8% guard band already used there — contours cut
  by the frame close with straight chords that even-odd inverts into a wedge.

Because both sides read one baked artefact, `Join > 0` introduces **no new
CPU/GLSL mirror**. The existing mirror at `Join = 0` is untouched.

### New and changed files

| File | Change |
|---|---|
| `js/cymajoin.js` | New. Segmentation, channel measurement, pair ranking, degree cap, fillet neck construction. |
| `js/sdftex.js` | Restored from `c912c07`. |
| `js/organism.worker.js` | Restored from `c912c07`, renamed to suit its new use. |
| `js/cymafield.js` | `join` in `idleState()`; route to the baked field when `join > 0`. |
| `js/renderer.js` | Upload and sample the SDF texture; trigger the bake on settle. |
| `js/shader.js` | Texture-sampling branch for the joined path. |
| `js/export.js` | Contour the baked field when `join > 0`. |
| `js/app.js` | Wire the slider into params and URL state. |
| `index.html` | The slider. |

`js/polarcells.js` on `field-scaffold` already implements much of steps 3–5
against a Bessel field. Its neck construction is reusable if generalised to take
a mask rather than a field; that generalisation is part of building
`js/cymajoin.js`, not a separate refactor.

## Accepted limitation

The join is a bake, so it appears on **held and captured designs, not per-frame
while audio is driving**. Segmenting and EDT-ing a 1024² mask every frame will
not hold 60fps.

This was flagged to the user and accepted on 2026-08-17. It suits the working
pattern the design is for: generate, hold, export SVG, place in Figma. Making it
live is materially larger work and is out of scope here.

## Testing

Unit tests, in `test/cymajoin.test.js`:

- Channel measurement returns the true narrowest gap for a constructed pair, and
  is not fooled by a tight crop (the padding regression).
- Pair ranking is narrowest-first, and the selected count rises monotonically
  with `Join`.
- The degree cap holds: no cell exceeds its cap at any `Join` value.
- Fillet radius tracks the local channel width, and the smoothing blend never
  exceeds half the narrowest measured channel.
- `Join = 0` leaves the field numerically identical to `nodalThickness`.

Plus a **rendered PNG ladder** across `Join` values, in the manner of
`npm run refs`. The standing lesson from the Shape Style work is that green tests
never once indicated the look was right — all three `large` failures passed their
tests while looking wrong, and were caught only by rendering and looking. The
ladder is the acceptance artefact; the user's eye on it is the gate.

## Open question, deliberately deferred

`Join` ranks by channel width, so the joins land wherever the field pinches
tightest. The reference's connected shapes instead chain into one *sweeping path*
with islands either side. If the ladder shows the result reads as evenly
speckled rather than composed, the fix is to bias selection along a path through
the disc rather than purely by width. Not built now — it is a change to step 4
only, and the ladder will show whether it is needed.
