import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRect } from '../js/renderer.js';

// The shader's own mapping, transcribed from js/shader.js main():
//   p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 3.15 / uZoom
// with uZoom = zoom * insetZoom and uPan = pan + inset, exactly as
// _uploadUniforms builds them.
function shaderPoint(vu, vv, { aspect, zoom, pan, inset, insetZoom }) {
  const uZoom = zoom * insetZoom;
  const uPan = [pan[0] + inset[0], pan[1] + inset[1]];
  return [
    (vu - 0.5 - uPan[0]) * aspect * 3.15 / uZoom,
    (vv - 0.5 - uPan[1]) * 1 * 3.15 / uZoom,
  ];
}

const VIEWS = [
  { aspect: 1.5, zoom: 1, pan: [0, 0], inset: [0, 0], insetZoom: 1 },
  { aspect: 0.667, zoom: 1, pan: [0, 0], inset: [0, 0], insetZoom: 1 },
  // The real on-screen condition: a panel on the right.
  { aspect: 1.97, zoom: 1, pan: [0, 0], inset: [-0.0815, 0], insetZoom: 0.837 },
  // Zoomed and panned as well, so the terms cannot cancel by luck.
  { aspect: 1.3, zoom: 2.4, pan: [0.13, -0.07], inset: [-0.06, 0.04], insetZoom: 0.9 },
];

test('viewBounds maps the same rectangle the shader draws', () => {
  for (const v of VIEWS) {
    const r = visibleRect(v);
    const [x0, y0] = shaderPoint(0, 0, v);
    const [x1, y1] = shaderPoint(1, 1, v);
    for (const [a, b, name] of [[r.x0, x0, 'x0'], [r.x1, x1, 'x1'],
                                [r.y0, y0, 'y0'], [r.y1, y1, 'y1']]) {
      assert.ok(Math.abs(a - b) < 1e-12,
        `${name}: export ${a} vs shader ${b} at aspect ${v.aspect}`);
    }
  }
});

// The regression this exists for: viewBounds used to ignore the chrome inset,
// so the SVG framed a smaller, off-centre rectangle than the canvas drew and no
// amount of contour fixing could make the two agree.
test('the chrome inset reaches the export frame', () => {
  const v = { aspect: 1.97, zoom: 1, pan: [0, 0], inset: [-0.0815, 0], insetZoom: 0.837 };
  const withInset = visibleRect(v);
  const without = visibleRect({ ...v, useInset: false });
  // Compare the whole rectangle, not one corner: a leftward shift and a wider
  // zoom cancel almost exactly at x0 for this view, so an x0-only check passes
  // while the frames differ by 1.2 world units at x1.
  const moved = ['x0', 'x1', 'y0', 'y1']
    .reduce((m, k) => Math.max(m, Math.abs(withInset[k] - without[k])), 0);
  assert.ok(moved > 0.1,
    `the inset must change the exported rectangle, or it is being ignored again (max move ${moved})`);
  assert.ok(withInset.x1 - withInset.x0 > without.x1 - without.x0,
    'the inset shrinks the zoom, so it must show MORE world');
});
