import { fieldOutline, ringToPath, closedCatmullRom } from './contour.js?v=6ddb29f8';
import { makeWaterField, makeCentrelineField } from './cymafield.js?v=6ddb29f8';

// Vector export.
//
// This is not a trace of a rasterisation. The water's outline is analytic —
// an isocontour of the same field the shader draws — so these paths ARE the
// shape, contoured on the CPU at whatever resolution is asked for and fitted
// with periodic beziers. Small files, smooth curves, genuinely editable.

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function buildSVG({ state, width, height, ink, background, variant = 'flat', bounds = null }) {
  // `bounds` is the on-screen view rectangle. Passing it is what keeps a
  // zoomed or panned SVG framed the same as the canvas; without it the vector
  // output would silently ignore the user's framing. margin 0 because the
  // view is already the exact frame.
  const opts = bounds ? { width, height, bounds, margin: 0 } : { width, height };
  // The outline traces the CENTRELINE, matching the on-screen outline view —
  // tracing the water's boundary draws both sides of every ribbon and every
  // curve arrives doubled. A blob has no spine, so it keeps its boundary.
  const field = (variant === 'outline' && (state.form ?? 0) < 0.5)
    ? makeCentrelineField(state) : makeWaterField(state);
  const { rings } = fieldOutline(field, opts);
  const paths = rings.map((r, i) =>
    `    <path id="pool-${String(i + 1).padStart(3, '0')}" d="${ringToPath(r)}"/>`);

  const body = variant === 'outline'
    ? [`  <g id="outline" fill="none" stroke="${ink}" stroke-width="2">`, ...paths, '  </g>']
    // ONE path with every ring as a subpath: fill-rule is per-path, so
    // separate <path> elements would fill the enclosed voids solid instead of
    // punching them through.
    : [`  <path id="water" fill="${ink}" fill-rule="evenodd" d="${rings.map((r) => ringToPath(r)).join(' ')}"/>`];

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
  const opts = bounds ? { width, height, bounds, margin: 0 } : { width, height };
  const field = (variant === 'outline' && (state.form ?? 0) < 0.5)
    ? makeCentrelineField(state) : makeWaterField(state);
  const { rings } = fieldOutline(field, opts);
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
