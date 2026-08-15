import { fieldOutline, ringToPath, closedCatmullRom } from './contour.js?v=b7cdba0d';
import { makeWaterField, makeCentrelineField, isMeta } from './cymafield.js?v=b7cdba0d';

// How far past the page a metaball composition is contoured.
//
// Its forms run off the frame, so contours reach the domain edge — and a
// contour cut by the edge is an OPEN curve that ringToPath closes with a
// straight chord, which an even-odd fill then inverts into a wedge across the
// design. Contouring wider lets every loop close outside the page, where it is
// simply cropped. The overhang stays in the file, which is what a printer
// wants for bleed. Detailed Cymatic never hits this: its plate mask closes
// every loop well inside the edge.
const GUARD = 1.08;

// The metaball composition's export frame, or null for Detailed Cymatic.
//
// Shared by SVG and PDF: they contour identically and differ only in how they
// write the result, so a frame fix applied to one and not the other shows up
// as a PDF that does not match its SVG.
function metaFrame(state, width, height) {
  if (!isMeta(state)) return null;
  const aspect = width / height;
  // fieldOutline otherwise defaults to a SQUARE +-1.35 fitted into the page,
  // which letterboxes a portrait export and crops the composition.
  const sx = aspect * 1.35 * GUARD, sy = 1.35 * GUARD;
  return {
    bounds: { x0: -sx, x1: sx, y0: -sy, y1: sy },
    // Bounds and pixel size scale together, so the scale is unchanged and the
    // guard band lands outside the page. This shifts it back.
    dx: ((GUARD - 1) / 2) * width,
    dy: ((GUARD - 1) / 2) * height,
    width: width * GUARD,
    height: height * GUARD,
  };
}

export function buildSVG({ state, width, height, ink, background, variant = 'flat', bounds = null }) {
  // An explicit view rectangle still wins over the composition's own frame —
  // the user's on-screen framing is the later decision.
  const org = bounds ? null : metaFrame(state, width, height);
  // `bounds` is the on-screen view rectangle. Passing it is what keeps a
  // zoomed or panned SVG framed the same as the canvas; without it the vector
  // output would silently ignore the user's framing. margin 0 because the
  // view is already the exact frame.
  const opts = org
    ? { width: org.width, height: org.height, bounds: org.bounds, margin: 0 }
    : bounds ? { width, height, bounds, margin: 0 } : { width, height };
  // The outline traces the CENTRELINE, matching the on-screen outline view —
  // tracing the water's boundary draws both sides of every ribbon and every
  // curve arrives doubled. A blob has no spine, so it keeps its boundary.
  // Detailed Cymatic traces the CENTRELINE — outlining a nodal ribbon's
  // boundary draws both sides of every line and every curve arrives doubled.
  // A metaball has no spine, so it keeps its boundary.
  const field = (variant === 'outline' && !isMeta(state))
    ? makeCentrelineField(state) : makeWaterField(state);
  const { rings } = fieldOutline(field, opts);
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
  if (org) body = [`  <g transform="translate(${-org.dx} ${-org.dy})">`, ...body, '  </g>'];

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
  // Same frame treatment as buildSVG — see metaFrame(). Kept in step
  // deliberately: a PDF framed differently from its SVG is the kind of bug
  // that only shows up at the printer.
  const org = bounds ? null : metaFrame(state, width, height);
  const opts = org
    ? { width: org.width, height: org.height, bounds: org.bounds, margin: 0 }
    : bounds ? { width, height, bounds, margin: 0 } : { width, height };
  // Detailed Cymatic traces the CENTRELINE — outlining a nodal ribbon's
  // boundary draws both sides of every line and every curve arrives doubled.
  // A metaball has no spine, so it keeps its boundary.
  const field = (variant === 'outline' && !isMeta(state))
    ? makeCentrelineField(state) : makeWaterField(state);
  let { rings } = fieldOutline(field, opts);
  // Shift the guard band off the page before anything is measured in mm.
  if (org) rings = rings.map((r) => r.map(([x, y]) => [x - org.dx, y - org.dy]));
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
