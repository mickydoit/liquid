# Shape Style: Cymatic Network → Simplified Metaball

Design spec, 11 August 2026.

## Problem

Liquid produces one silhouette language: water pooled along the nodal lines of a
modal field (`cymafield.js:108`). It is detailed, cellular and — for reasons
established below — always a centred circular specimen. It cannot produce the
large, confident, cropped liquid forms of the Russia Expo 2025 identity.

The existing language is wanted and is not being replaced. This adds a second
one alongside it, reachable by a continuous **Shape Style** control.

## Reference reading

Six reference images (Behance gallery 102913275). What they actually show:

- **Construction diagram** — the mark is **circles of varying radius joined by
  straight tangent lines**: tapered capsules. Guide circles are left visible.
  Seven arms, labelled 2024–2030.
- **Growth sequence** — 2 lobes → 3 → 4 → 6 → 7, as *one connected organism*
  that gains arms. Lobes are tangent discs joined by narrow pinched waists.
- **Environmental posters** — the same language scaled up enormously and
  cropped hard by the panel edge, alternating positive and negative between
  adjacent panels.
- **Poster with liquid material** — the identical silhouette rendered as
  transparent water with dispersion.

Three conclusions follow, and two of them contradict the first reading of the
brief:

1. **Joins are concave.** Every waist pinches *inward* along a circular arc
   tangent to both lobes. A polynomial smooth-minimum bulges *convexly* and is
   what makes blobs read as soap bubbles — the exact failure recorded at
   `cymafield.js:3-6` when Liquid was a circle-SDF metaball. The join must be a
   circular fillet union.
2. **It is one connected organism, not scattered forms.** The brief asks for
   "3–7 dominant forms" with negative space between them. The references get
   that appearance by scaling a *connected* organism until its centre is
   off-frame and only arms remain in view. Composition does the work, not
   scattering.
3. **Radial topology is fine; radial *regularity* is not.** The mark is seven
   arms around a centre. What the references avoid is k-fold symmetry — arm
   angles are unevenly spaced, lengths and terminal radii differ widely.

## Architecture

### Where geometry comes from

New module **`js/blobfield.js`** — pure, no WebGL, tested in node alongside
`cymafield.js`.

**Primitive.** A tapered capsule: two endpoints with independent end radii.
Equal radii give a capsule; unequal give a teardrop; two joined at a pinch give
an hourglass. Orientation and aspect are per-primitive, so size and orientation
variation are intrinsic rather than added later.

**Layout.** `layout(fingerprint, controls, variation)` builds a **connected
graph**: a small central node cluster plus N arms, each arm a tapered capsule
running from the cluster to a terminal disc, with optional second-order
branches. Deterministic PRNG seeded from the audio fingerprint XOR the
Variation value (`js/hash.js` already provides the hashing).

**Union.** Circular fillet union, not `smin`:

```
d = max(kf, min(d1, d2)) − length(max(vec2(kf − d1, kf − d2), 0))
```

At the crossing point of two lobes (`d1 = d2 = 0`) this gives `−0.414·kf` —
material added, on an arc tangent to both surfaces. That is the concave waist
the references have. The fillet radius `kf` is the **Merge** control.

Note this is *not* the polynomial `opSmoothUnion`, which bulges convexly.

**Shape Style perturbation.** The capsule union is a true signed *distance*
field, so ψ can displace its contour by a bounded number of pixels:

```
d = blobField(warp(p)) − detail · ψ(p, s) · k_perturb
```

`k_perturb` is clamped below the form scale, which makes cellular breakup
impossible by construction. This is why the blend is a bounded perturbation
rather than a crossfade of the two fields: crossfading breaks into cells
wherever the oscillating ψ outweighs the smooth capsule field, reproducing the
"too many separate radial cells and thin accidental bridges" failure at half
strength.

Shape Style 0 is bit-identical to today's cymatic field. Shape Style 1 is pure
capsules. Reference silhouettes are pure arcs and lines with no nodal waviness,
so **Detail defaults to 0** at full Simplified; ψ perturbation is
intermediate-territory only.

### The bake

Per-pixel code cannot express morphology — closing, connected-component
culling, hole removal and bridge pruning are global operations over a raster.
So the simplified style is **baked on settle**: when the sound stabilises, Hold
fires, or a recording is submitted.

1. Rasterise `d` on a grid at the chosen format aspect, 1024 on the long edge.
2. Morphological **close** — removes gaps.
3. **Connected-component labelling**; drop components below minimum area.
4. **Hole labelling**; drop holes below minimum area.
5. **Opening** at a radius *between* hairline width and waist width. This is
   what distinguishes an accidental filament from an intentional waist — a
   single threshold, because the two differ in width by construction.
6. Recover a clean signed field from the cleaned mask via **Euclidean distance
   transform** (both sides).

Steps 3–5 are driven by **Simplify**.

### One source of truth

The cleaned field is uploaded as an **SDF texture**. Both the shader and the
vector export read it. For the simplified style there is therefore no
hand-mirrored CPU/GLSL pair — the hazard `cymafield.js:14` and the README warn
about does not apply. `contour.js` takes a field *function*
(`contour.js:171`), so the grid is wrapped in a bilinear sampler and marching
squares contours exactly the data on screen.

**Live mode** draws the capsule union analytically in GLSL (primitives fit
easily in uniforms), un-cleaned, so it stays responsive. That is a mirror, and
it is an approximation — it differs from the baked result only by the specks
morphology would remove. Export never uses it.

## Controls

**Continuity rule.** Moving a slider must refine the design, not re-roll it. The
seed generates a fixed pool of **7** primitives once, and every control is a
continuous parameter over that same pool. Form Count fades primitives in and out
by driving their radius toward zero, so 4→5 *adds* a form and leaves the other
four untouched. Only Variation changes the layout.

**Slider/sound combination.** Each dimension has an audio-derived value in
[0,1]. The slider sets the centre; the sound deviates around it by a fixed
per-dimension depth:

```
v = clamp01(slider + (audio − 0.5) · depth)
```

At any slider position the fingerprint still moves the result; at no position
does the slider discard it.

| Control | Drives | Sound feature biasing it |
|---|---|---|
| Detail | ψ perturbation frequency and amount | spectral centroid |
| Form Count | active primitives, 3–7 | pitch |
| Merge | fillet radius k — separate, waisted, joined | amplitude |
| Simplify | min component area, min hole area, opening radius | — |
| Symmetry | placement regularity vs jitter | spectral spread |
| Stretch | capsule length ÷ radius | pitch confidence |
| Warp | domain-warp amplitude | spectral spread |
| Scale/Crop | field scale vs frame; >1 pushes forms off-frame | amplitude |
| Edge Softness | field-level rounding radius | — |
| Invert | sign flip on the cleaned field | — |

Amplitude also scales overall radii, so louder still means more liquid.

**Variation** steps the layout seed. Determinism holds exactly: same sound, same
settings, same Variation always gives the same composition.

These ten appear only when Shape Style > 0, so the panel does not grow for
anyone using pure cymatics.

There is deliberately no separate asymmetry control — Symmetry and Warp cover
it, and a third overlapping knob would make all three fight.

## Composition and framing

**Format** is a renderer-level concept and applies to both styles: portrait 2:3,
square 1:1, landscape 3:2, or Fill window. The stage letterboxes to the chosen
ratio, and `viewBounds()` (`renderer.js:249`) derives from the format rather
than from `canvas.width / canvas.height`. PNG, SVG and PDF then all export the
chosen ratio regardless of window size, so what is approved on screen is what
exports.

**Both radial crops are dropped for the simplified style.** Two independent
crops currently stack:

- `cymafield.js:114` — plate falloff kills water from r = 1.02 to 1.30
- `cymafield.js:125` — `reveal()` at full grow still crops from r = 1.25 to 1.59

At zoom 1 the visible field is ±1.575 vertically (`renderer.js:253`,
`shader.js:72`), so the design is bounded to a circle sitting *inside* the
frame. It is structurally incapable of touching the top or bottom edge whatever
the sound does. That is the root cause of "consistently centred and circular".
Pure cymatics keeps both, untouched.

**Emergence is rebuilt.** The current flood is a radial wipe from the centre
outward, which would re-impose the centring just removed. Instead `grow` drives
the **iso threshold**, sweeping from deep inside the forms out to their
surfaces, so every form blooms from its own core simultaneously. Same
`GROW_SEC`, no centre.

**Cropping is a postcondition.** Layout works in frame-relative coordinates and
places the organism with jittered low-discrepancy spacing — which is what gives
negative space of *varying* width rather than even gaps — then offsets the
arrangement's centroid off-centre by a seeded amount. At the default Scale/Crop
the organism's centre is off-frame and at least two arms intersect a frame
edge. This is asserted, not hoped for.

## Geometry and material

One silhouette, two renderings. The baked SDF is the geometry; neither renderer
owns it, so switching between them cannot change the shape.

**Solid preview** renders it black-on-white. **Water** renders the same field
with gloss, dispersion and depth as today.

**Crisp edges.** For the simplified style `d` is in true distance units, so the
threshold is `smoothstep(−w, +w, −d)` with `w` one pixel in field units — a
genuine 1px transition at any zoom.

The existing Flat view gets the matching fix. `shader.js:79` uses
`smoothstep(0.45, 0.55, T)`, a band fixed in *field* units, so its screen width
is `0.10 / |∇T|` — tens of pixels wherever the gradient is shallow, which is why
softness varies per shape and per edge in a single image. Normalising by the
local gradient makes it 1px, so "Flat view (what the vector export emits)"
becomes true. Avoid `fwidth`; sample the field at ±1px and difference it.

**Edge Softness is geometry, not opacity.** It applies a rounding radius to the
field *before* thresholding, so it smooths the contour itself and therefore
changes the exported SVG path. The 1px antialias stays 1px regardless. No halo.

**Export.** SVG and PDF contour the baked cleaned grid through the existing
`contour.js` marching squares and periodic beziers. PNG to 7680 as now.

The outline double-line problem — `fieldOutline` contouring the water *band*
(`export.js:22`) and so tracing both sides of every nodal ribbon — cannot occur
in the simplified style, because the baked field is a signed distance to the
silhouette rather than a band. One closed curve per form, and Line weight
becomes meaningful.

## Testing

Because the geometry is computed on the CPU and Solid preview is a threshold on
that grid, acceptance results rasterise to PNG **from node, with no browser and
no WebGL**. The working loop is generate → look → adjust → regenerate.

Postconditions, alongside the existing 28 tests:

- **Determinism** — same fingerprint, controls and Variation give byte-identical
  primitives
- **Continuity** — Form Count 4→5 leaves the first four primitives unchanged
- **Form count** — cleaned mask has 3–7 components across a corpus of seeded
  fingerprints
- **No specks, no pinholes** — every component and every hole is at or above its
  minimum area
- **Cropping** — at least two components intersect the frame boundary at default
  Scale/Crop
- **No radial regularity** — mask compared against itself rotated by 2π/k for
  k = 3…8 must differ beyond a threshold; catches pinwheels and rings of similar
  cells mechanically
- **Solid fill** — largest component is a substantial share of total ink
- **Cymatic path unchanged** — existing tests pass; Shape Style 0 is
  bit-identical to today

**These are guards, not the gate.** A design can satisfy every one and still look
nothing like the references. The gate is visual comparison against the reference
images:

1. Three or four very large cropped forms with strong negative space
2. Five to seven elongated forms with several narrow waists
3. An intermediate that keeps a hint of cymatic edge structure without cellular
   breakup

## Out of scope

- **Cymatic outline zero-crossing fix.** `nodalThickness` (`cymafield.js:108`)
  bands `|ψ|`, so each nodal line is a ribbon and outlining it yields two
  parallel contours. The fix —
  threshold signed ψ at 0 for the outline variant — is independent, small, and
  touches `export.js` / `contour.js` rather than any code here. Shipping
  separately keeps both reviewable.
- **Audio mapping decorrelation for the cymatic style.** `cymafield.js:151-157`
  drives m, n, kr and ma all monotonically from pitch, collapsing four mode
  dimensions onto a 1-D curve; `ma ∈ [2,8]` never reaches 0 so concentric rings
  are unreachable. Real, but a cymatic-style concern.
