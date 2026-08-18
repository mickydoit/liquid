import { fieldOutline, ringToPath, closedCatmullRom } from './contour.js?v=fe17cf9f';
import { makeWaterField, makeCentrelineField, isMeta } from './cymafield.js?v=fe17cf9f';
import { META_FRAME } from './metafield.js?v=fe17cf9f';
import { joinedField } from './cymajoin.js?v=fe17cf9f';

// The field the export contours.
//
// Detailed Cymatic traces the CENTRELINE — outlining a nodal ribbon's boundary
// draws both sides of every line and every curve arrives doubled. A metaball has
// no spine, so it keeps its boundary.
//
// Above Join 0 the geometry is a bake, and the export reads the SAME baked grid
// the screen does. Contouring the analytic field here instead would put necks on
// screen that the SVG does not have.
//
// The outline variant keeps the centreline even when joined: a joined figure
// still has nodal ribbons, and its spine is still where the outline belongs.
function exportField(state, variant) {
  if (variant === 'outline' && !isMeta(state)) return makeCentrelineField(state);
  const baked = (state.join ?? 0) > 0 || (state.roundness ?? 0) > 0;
  if (!isMeta(state) && baked) return joinedField(state).sample;
  return makeWaterField(state);
}

// How far past the page every design is contoured.
//
// A contour reaching the edge of the sampled rectangle used to leave an OPEN
// chain that ringToPath closed with a straight chord, which an even-odd fill
// inverted into a wedge across the design. marchingSquares now seals its border
// so every loop closes — but a closure ON the page edge is still visible as a
// straight cut. Contouring wider puts that closure OUTSIDE the page, where the
// viewBox crops it away, and the overhang stays in the file, which is what a
// printer wants for bleed.
//
// Applied to EVERY mode now, not just Metaball Cymatic. A portrait view is only
// 1.05 world units wide while a Detailed Cymatic figure reaches 1.105, so
// portrait exports were cut too — measured at 25.7px of spurious geometry.
const GUARD = 1.08;

// The world rectangle a Detailed Cymatic design is laid out against, when the
// caller has no view rectangle to offer.
const PLATE = 1.35;

// The rectangle to contour, and how far to shift the result back.
//
// One function for every mode and both writers. SVG and PDF differ only in how
// they write the rings, so a frame fix applied to one and not the other shows up
// as a PDF that does not match its SVG.
function contourFrame(state, width, height, bounds) {
  const aspect = width / height;
  // Priority: the caller's view rectangle, else the composition's own frame.
  // fieldOutline otherwise defaults to a SQUARE +-1.35 fitted into the page,
  // which letterboxes a portrait export and crops the composition.
  const base = bounds ?? (isMeta(state)
    // The SAME rectangle the composition was laid out against — see META_FRAME.
    // A different constant here silently rescales every exported design.
    ? { x0: -META_FRAME * aspect, x1: META_FRAME * aspect, y0: -META_FRAME, y1: META_FRAME }
    : { x0: -PLATE * aspect, x1: PLATE * aspect, y0: -PLATE, y1: PLATE });

  // Expand about the centre, so the page's framing and scale are unchanged and
  // the guard band lands outside it.
  const cx = (base.x0 + base.x1) / 2, cy = (base.y0 + base.y1) / 2;
  const hw = ((base.x1 - base.x0) / 2) * GUARD, hh = ((base.y1 - base.y0) / 2) * GUARD;
  return {
    // margin 0: the rectangle IS the frame, so fieldOutline must not inset it
    // again — an inset would rescale the design relative to the page.
    opts: {
      bounds: { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh },
      width: width * GUARD, height: height * GUARD, margin: 0,
    },
    dx: ((GUARD - 1) / 2) * width,
    dy: ((GUARD - 1) / 2) * height,
  };
}

// Exposed for tools/parity.mjs, which must frame its raster EXACTLY as the
// exporter does or its comparison measures framing rather than fidelity.
export function contourFrameForTest(state, width, height, bounds) {
  return contourFrame(state, width, height, bounds);
}

export function buildSVG({ state, width, height, ink, background, variant = 'flat', bounds = null }) {
  // `bounds` is the on-screen view rectangle. Passing it is what keeps a zoomed
  // or panned SVG framed the same as the canvas; without it the vector output
  // would silently ignore the user's framing.
  const frame = contourFrame(state, width, height, bounds);
  const field = exportField(state, variant);
  const { rings } = fieldOutline(field, frame.opts);
  const paths = rings.map((r, i) =>
    `    <path id="pool-${String(i + 1).padStart(3, '0')}" d="${ringToPath(r)}"/>`);

  let body = variant === 'outline'
    ? [`  <g id="outline" fill="none" stroke="${ink}" stroke-width="2">`, ...paths, '  </g>']
    // ONE path with every ring as a subpath: fill-rule is per-path, so
    // separate <path> elements would fill the enclosed voids solid instead of
    // punching them through.
    : [`  <path id="water" fill="${ink}" fill-rule="evenodd" d="${rings.map((r) => ringToPath(r)).join(' ')}"/>`];

  // Shift the guard band back off the page. The overhang stays in the file
  // rather than being clipped away, which is what a printer wants for bleed.
  body = [`  <g transform="translate(${-frame.dx} ${-frame.dy})">`, ...body, '  </g>'];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...body,
    '</svg>',
  ].join('\n');
}

export function exportPDF({ state, width, height, ink, background, variant = 'flat', bounds = null }) {
  const { jsPDF } = window.jspdf;
  // The SAME frame treatment as buildSVG — see contourFrame(). Kept in step
  // deliberately: a PDF framed differently from its SVG is the kind of bug that
  // only shows up at the printer.
  const frame = contourFrame(state, width, height, bounds);
  const field = exportField(state, variant);
  let { rings } = fieldOutline(field, frame.opts);
  // Shift the guard band off the page before anything is measured in mm.
  rings = rings.map((r) => r.map(([x, y]) => [x - frame.dx, y - frame.dy]));
  const mmW = width > height ? 297 : 210;
  const mmH = mmW * (height / width);
  const doc = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm', format: [mmW, mmH],
  });
  const px2mm = mmW / width;

  if (background != null) {
    const [r, g, b] = hexToRgb(background);
    doc.setFillColor(r, g, b);
    doc.rect(0, 0, mmW, mmH, 'F');
  }
  const [ir, ig, ib] = hexToRgb(ink);
  doc.setFillColor(ir, ig, ib);
  doc.setDrawColor(ir, ig, ib);

  if (variant !== 'outline') {
    // Raw operators rather than lines(): each lines() call paints its own
    // path, which fills the enclosed voids solid. One path across every ring
    // closed with an EVEN-ODD fill (f*) is what punches them through.
    const ci = (x) => doc.internal.getCoordinateString(x);
    const cv = (y) => doc.internal.getVerticalCoordinateString(y);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const pts = ring.map(([x, y]) => [x * px2mm, y * px2mm]);
      doc.internal.write(`${ci(pts[0][0])} ${cv(pts[0][1])} m`);
      for (const { c1, c2, end } of closedCatmullRom(pts)) {
        doc.internal.write(
          `${ci(c1[0])} ${cv(c1[1])} ${ci(c2[0])} ${cv(c2[1])} ${ci(end[0])} ${cv(end[1])} c`);
      }
      doc.internal.write('h');
    }
    doc.internal.write('f*');
  } else {
    doc.setLineWidth(2 * px2mm);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      // jsPDF's lines() reads all three pairs of a curve entry as offsets
      // from the point BEFORE the curve, not chained one to the next.
      let cx = ring[0][0] * px2mm, cy = ring[0][1] * px2mm;
      const legs = [];
      for (const { c1, c2, end } of closedCatmullRom(ring.map(([x, y]) => [x * px2mm, y * px2mm]))) {
        legs.push([c1[0] - cx, c1[1] - cy, c2[0] - cx, c2[1] - cy, end[0] - cx, end[1] - cy]);
        cx = end[0]; cy = end[1];
      }
      doc.lines(legs, ring[0][0] * px2mm, ring[0][1] * px2mm, [1, 1], 'S', true);
    }
  }
  doc.save(`liquid-${variant}.pdf`);
}

export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function downloadCanvas(canvas, filename, mime = 'image/png') {
  const a = Object.assign(document.createElement('a'), {
    href: canvas.toDataURL(mime, 0.95), download: filename,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
