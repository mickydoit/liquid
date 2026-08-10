# Liquid

Cymatic water from sound. A standing-wave field is evaluated per pixel and
rendered as a transparent liquid layer; the same field is contoured on the CPU
to produce editable SVG and PDF.

Extracted from [soundform](https://github.com/mickydoit/soundform), where it
lived as one mode among six. Nothing here depends on that project.

## Run

```
npm start          # serves on http://localhost:8788
npm test           # 28 node tests, no browser needed
```

No build step. Vanilla ES modules, one WebGL shader, two CDN scripts (jsPDF
for PDF export, mp4-muxer for video).

## How it works

**The geometry is a modal field, not a shape.** `js/cymafield.js` sums
square-plate Chladni eigenmodes with circular-membrane radial modes. Water is
a *separate* thickness field that pools where the wave field is near zero —
its nodal lines. That is the physics of a vibrated liquid layer, and it is
what produces connected watery paths, lattices and floral figures rather than
isolated blobs.

**Nothing is regenerated.** Every field parameter is a float re-evaluated per
pixel per frame, so audio glides the state directly and the pattern morphs
continuously. There is no worker and no crossfade.

**Two clocks.** `uTimeC` moves the cymatic geometry; `uMatTime` moves only
light on the water. This is what lets a held design shimmer without its
topology drifting.

| render state | geometry | material | used for |
|---|---|---|---|
| `full` | moves | moves | live, responding to sound |
| `material` | frozen | moves | live Hold, and a submitted design |
| `none` | frozen | frozen | Motion at 0 (zero draw calls) |

A submitted design keeps its geometry frozen — the figure never changes on
its own — while the water drifts at the **Motion** rate, so it reads as liquid
rather than as a screenshot. Motion 0 freezes it completely.

## Behaviour

**Live** — an empty canvas until the first valid sound; the figure then floods
in from the centre over ~1.35s; when
the sound stops the design is **held** and keeps shimmering; a new stable
sound flows into a new figure. Hysteresis (ON 0.020 / OFF 0.009 rms), a 0.22 s
stability window and a 0.6 s release keep room tone and pitch-detector glitches
from re-forming it.

**Submitted recording** — the captured frames build one aggregate fingerprint
and one design is generated, which floods in the same way. Its geometry is fixed; only the light on the
water moves, at the Motion rate.

**View** — scroll or pinch to scale, drag to move, double-click to reset;
there is also a Scale slider. The vector export follows the on-screen framing,
so a zoomed SVG matches what you see.

## Controls

**Water** — Gloss, Dispersion, Rim, Depth, Refraction shape the material.
Near-black interiors with a crisp bright edge (high Depth + high Rim) give the
glassy look; Refraction is how hard the ground bends, separately from how much
that bending splits into colour.

**Flow** sets how much water is gathered into the figure — i.e. ribbon weight.
**Simplicity** lowers the modal orders, trading a dense nodal lattice for a few
broad meanders. Complexity in a Chladni figure *is* its mode numbers, so this
lowers them rather than blurring or hiding anything; the band width scales with
them, or gentler gradients would spread the same threshold into a solid mass.

Simplicity is geometry, so it lands on the exported vectors too.

## Audio mapping

| feature | drives |
|---|---|
| pitch | modal order — the topology, not a size or colour |
| amplitude | how much water is gathered into the figure |
| spectral centroid | fine ripple detail |
| spectral spread / low pitch confidence | a layered, less stable figure |
| onsets | a decaying outward ripple |

## Export

`Flat` gives the filled silhouette, `Outline` gives the unfilled figure. Both
are true vector: the outline is an isocontour of the same field the shader
draws, contoured with marching squares and fitted with periodic beziers — not
a trace of a rasterisation. Tick **Flat view** to see on screen exactly what
the vector export emits.

PNG exports at up to 7680 px. Video needs WebCodecs (Chrome/Edge).

## Layout

```
js/cymafield.js   the field: modes, water thickness, audio mapping   (pure)
js/shader.js      the GLSL mirror of cymafield.js + the water material
js/renderer.js    minimal WebGL: one fullscreen quad, no three.js
js/live.js        idle/active/hold state machine                     (pure-ish)
js/contour.js     marching squares -> rings -> periodic beziers      (pure)
js/export.js      SVG / PDF / PNG
js/app.js         wiring
js/audio.js, js/features.js   analysis, carried over unchanged
```

⚠ `js/cymafield.js` and the GLSL in `js/shader.js` **mirror each other**. The
CPU copy drives the vector export; if they drift, exports stop matching the
screen. Change them together.

## Known limits

- Live behaviour is covered by conductor tests rather than browser tests; a
  headless browser has no usable microphone.
