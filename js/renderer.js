import { VERT, FRAG } from './shader.js?v=b7cdba0d';
import { stepGrow, isMeta } from './cymafield.js?v=b7cdba0d';
import { metaSolve, META_MAX } from './metafield.js?v=b7cdba0d';

// Minimal WebGL renderer: one fullscreen quad, one shader.
//
// Deliberately no three.js. The whole design is a single analytic fragment
// program — there is no scene, no camera, no geometry to manage — so a scene
// graph would be several hundred KB of dependency doing nothing.

const UNIFORMS = [
  'uM', 'uN', 'uKr', 'uMa', 'uMix', 'uAmp', 'uFine', 'uChaos', 'uPhase',
  'uTimeC', 'uRipAmt', 'uRipT', 'uMatTime', 'uGrow',
  'uSimple', 'uRim', 'uDepth', 'uRefract', 'uSwell',
  'uView', 'uLineW', 'uBackTex', 'uHasBack', 'uMass',
  'uMeta', 'uMetaRC', 'uMetaN', 'uMetaK', 'uMode',
  'uAspect', 'uZoom', 'uPan', 'uGloss', 'uDispersion', 'uTransparent',
  'uGround', 'uInk', 'uDeep',
  'uPxWorld',
];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class LiquidRenderer {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.canvas);

    // preserveDrawingBuffer so a canvas read after the draw task still has
    // pixels — video capture and PNG export both depend on it, and without it
    // any later read silently returns an empty buffer.
    const opts = { alpha: true, antialias: false, preserveDrawingBuffer: true };
    this.gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('WebGL unavailable');
    const gl = this.gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link failed: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of UNIFORMS) this.u[n] = gl.getUniformLocation(prog, n);

    this.state = null;
    this.anim = 'full';
    this.zoom = 1;
    this.pan = [0, 0];
    // Chrome inset, kept SEPARATE from the user's pan: the design is nudged
    // and shrunk to centre in the area the floating panel does not cover.
    // Exports must not inherit it — see renderToCanvas.
    this.inset = [0, 0];
    this.insetZoom = 1;
    // Global scalar on material time: 1 while live, and the Motion control
    // while a design is held still. 0 freezes it completely.
    this.materialRate = 1;
    this._matTime = 0;
    this._tick = 0;
    this._frameSink = null;
    this._dirty = true;

    this.style = {
      gloss: 1, dispersion: 1, rim: 1, depth: 1, refract: 1,
      view: 0, lineW: 0.012, transparent: false,
      ground: [0.68, 0.73, 0.78], ink: [0.07, 0.09, 0.11], deep: [0.49, 0.59, 0.69],
    };

    this._resize();
    this._initInput();
    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this._dirty = true;
  }

  // `anim` is the render state, not a style:
  //   'full'     — live and responding: geometry and material both advance
  //   'material' — live HOLD: geometry frozen, only light on the water moves
  //   'none'     — submitted recording: nothing advances, zero draw calls
  setField(state, anim = 'full') {
    this.state = state;
    this.anim = anim;
    this._dirty = true;
  }

  setStyle(patch) { Object.assign(this.style, patch); this._dirty = true; }

  // A backdrop the water refracts. Without one there is nothing behind the
  // liquid to bend, so refraction is invisible no matter how strong — which
  // is the whole reason the reference reads as glass over type.
  setBackdrop(img) {
    const gl = this.gl;
    if (this._backTex) { gl.deleteTexture(this._backTex); this._backTex = null; }
    if (img) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      // NPOT-safe: clamp + linear, no mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._backTex = t;
    }
    this._dirty = true;
  }
  setFrameSink(fn) { this._frameSink = fn; }

  // `useInset` is false for exports: the chrome offset exists to dodge the
  // on-screen panel, and baking it into an exported image would leave the
  // design sitting off-centre with dead space on one side.
  // `hPx` is the target's pixel height. It is needed for uPxWorld, which has
  // to be measured against the surface actually being drawn — the canvas when
  // previewing, the framebuffer when exporting.
  _uploadUniforms(gl, aspect, useInset = true, hPx = 420) {
    const s = this.state, st = this.style, u = this.u;
    gl.uniform1f(u.uM, s.m); gl.uniform1f(u.uN, s.n);
    gl.uniform1f(u.uKr, s.kr); gl.uniform1f(u.uMa, s.ma);
    gl.uniform1f(u.uMix, s.mix); gl.uniform1f(u.uAmp, s.amp);
    gl.uniform1f(u.uFine, s.fine); gl.uniform1f(u.uChaos, s.chaos);
    gl.uniform1f(u.uPhase, s.phase);
    gl.uniform1f(u.uTimeC, s.t);
    gl.uniform1f(u.uRipAmt, s.ripAmt); gl.uniform1f(u.uRipT, s.ripT);
    gl.uniform1f(u.uMatTime, this._matTime);
    gl.uniform1f(u.uGrow, s.grow ?? 1);
    // Simplicity is GEOMETRY, so it lives on the state the exporter reads.
    gl.uniform1f(u.uSimple, s.simple ?? 0);
    gl.uniform1f(u.uSwell, s.swell ?? 0);
    gl.uniform1f(u.uMass, s.mass ?? 0);
    // Metaball Cymatic. The composition is analytic — a handful of ellipses
    // and their cluster ids — so it goes to the GPU as uniforms rather than as
    // a baked texture, and the CPU and GLSL stay mirrored the way the rest of
    // this file already is. metaSolve() memoises, so this is a lookup per frame
    // rather than a re-solve.
    const meta = isMeta(s);
    gl.uniform1f(u.uMode, meta ? 1 : 0);
    if (meta) {
      const { balls, fillet } = metaSolve(s);
      const xy = this._metaArr || (this._metaArr = new Float32Array(META_MAX * 4));
      const rc = this._metaRC || (this._metaRC = new Float32Array(META_MAX * 2));
      xy.fill(0); rc.fill(0);
      const n = Math.min(balls.length, META_MAX);
      for (let i = 0; i < n; i++) {
        const b = balls[i];
        xy[i * 4] = b.x; xy[i * 4 + 1] = b.y; xy[i * 4 + 2] = b.rx; xy[i * 4 + 3] = b.ry;
        rc[i * 2] = b.rot; rc[i * 2 + 1] = b.cluster;
      }
      gl.uniform4fv(u.uMeta, xy);
      gl.uniform2fv(u.uMetaRC, rc);
      gl.uniform1i(u.uMetaN, n);
      gl.uniform1f(u.uMetaK, fillet);
    } else {
      gl.uniform1i(u.uMetaN, 0);
      gl.uniform1f(u.uMetaK, 0.1);
    }
    gl.uniform1f(u.uHasBack, this._backTex ? 1 : 0);
    if (this._backTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._backTex);
      gl.uniform1i(u.uBackTex, 0);
    }
    gl.uniform1f(u.uRim, st.rim);
    gl.uniform1f(u.uDepth, st.depth);
    gl.uniform1f(u.uRefract, st.refract);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uZoom, this.zoom * (useInset ? this.insetZoom : 1));
    gl.uniform2fv(u.uPan, useInset
      ? [this.pan[0] + this.inset[0], this.pan[1] + this.inset[1]]
      : this.pan);
    gl.uniform1f(u.uGloss, st.gloss);
    gl.uniform1f(u.uDispersion, st.dispersion);
    gl.uniform1f(u.uView, st.view);
    gl.uniform1f(u.uLineW, st.lineW);
    gl.uniform1f(u.uTransparent, st.transparent ? 1 : 0);
    gl.uniform3fv(u.uGround, st.ground);
    gl.uniform3fv(u.uInk, st.ink);
    gl.uniform3fv(u.uDeep, st.deep);

    // One pixel in WORLD units, computed rather than taken from fwidth: fwidth
    // needs OES_standard_derivatives on WebGL1, the same extension-availability
    // trap as float textures. main() maps p = (vUv - 0.5 - uPan) * 3.15 / uZoom
    // and vUv spans 0..1 down the viewport, so this is exact.
    const zoomV = this.zoom * (useInset ? this.insetZoom : 1);
    gl.uniform1f(u.uPxWorld, 3.15 / (zoomV * Math.max(1, hPx)));
  }

  _draw() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.state) return;
    this._uploadUniforms(gl, this.canvas.width / this.canvas.height, true, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    // Emergence runs even when everything else is frozen: a design must still
    // flood in once, and then it stops of its own accord because grow has
    // arrived at its target. Without this, a submitted design at Motion 0
    // would pop into existence fully formed.
    let growing = false;
    if (this.state) {
      const now = performance.now() / 1000;
      const dtG = Math.min(0.1, this._growTick ? now - this._growTick : 0.016);
      this._growTick = now;
      const before = this.state.grow ?? 1;
      stepGrow(this.state, dtG);
      growing = Math.abs((this.state.grow ?? 1) - before) > 1e-6;
      if (growing) this._dirty = true;
    } else {
      this._growTick = 0;
    }

    // An empty, ungrown canvas has nothing to animate — without this the app
    // redraws blank frames at 60fps while simply sitting there waiting.
    const empty = this.state && (this.state.grow ?? 1) === 0 && (this.state.growTarget ?? 1) === 0;
    const frozen = empty || this.anim === 'none'
                || (this.anim === 'material' && this.materialRate === 0);
    if (this.state && !frozen) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, this._tick ? now - this._tick : 0.016);
      this._tick = now;

      // Material time always runs while animating — this is the shimmer, and
      // it is the only thing that moves during Hold.
      this._matTime += dt * (this.anim === 'material' ? this.materialRate : 1);

      if (this.anim === 'full') {
        // Geometry time: breathing and fine-detail drift. Frozen in Hold so a
        // held figure cannot change shape on its own.
        this.state.t += dt;
        this.state.phase += dt * 0.15;
      }
      // A transient keeps settling even in Hold — the pattern relaxes rather
      // than snapping — but it only ever decays.
      this.state.ripT += dt;
      this.state.ripAmt *= Math.exp(-dt * 1.2);
      this._dirty = true;
    } else {
      // 'none' falls through deliberately: no advance, no dirty flag, so a
      // submitted design costs zero draw calls and is genuinely static.
      this._tick = 0;
    }
    if (!this._dirty) return;
    this._dirty = false;
    this._draw();
    // The drawing buffer is only guaranteed valid in the same task as the
    // draw, so video capture must happen here.
    if (this._frameSink) this._frameSink(performance.now());
  }

  // Offscreen render at an arbitrary size, returned as a 2D canvas.
  renderToCanvas(width, height) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.state) {
      this._uploadUniforms(gl, width / height, false, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);

    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(width, height);
    // GL origin is bottom-left; canvas is top-left.
    for (let y = 0; y < height; y++) {
      img.data.set(px.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    }
    ctx.putImageData(img, 0, 0);
    this._dirty = true;
    return out;
  }

  // The world rectangle currently visible. The vector export needs this or a
  // zoomed/panned view would export a different framing from the one on
  // screen — the raster and vector outputs have to agree.
  viewBounds() {
    // Deliberately excludes the chrome inset: the vector export is framed the
    // way the exported raster is, not the way the panel-dodged screen is.
    const aspect = this.canvas.width / this.canvas.height;
    const k = 3.15 / this.zoom;
    return {
      x0: (-0.5 - this.pan[0]) * aspect * k, x1: (0.5 - this.pan[0]) * aspect * k,
      y0: (-0.5 - this.pan[1]) * k,          y1: (0.5 - this.pan[1]) * k,
    };
  }

  setZoom(z) { this.zoom = Math.min(6, Math.max(0.35, z)); this._dirty = true; }

  // Centre the design in the region NOT covered by floating chrome. Offsets
  // the framing and shrinks it just enough to fit, the way soundform's camera
  // view-offset does — a design centred on the raw canvas reads as pushed up
  // against whichever panel overlaps it.
  setViewInset(rightPx = 0, bottomPx = 0) {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.inset = [-rightPx / (2 * w), bottomPx / (2 * h)];
    this.insetZoom = Math.min(1, (w - rightPx) / w, (h - bottomPx) / h);
    this._dirty = true;
  }
  resetView() { this.zoom = 1; this.pan = [0, 0]; this._dirty = true; }

  // Scroll / pinch to scale, drag to pan — the design is 2D, so there is no
  // rotation to offer, but framing works the way it does elsewhere.
  _initInput() {
    const el = this.canvas;
    let down = false, lx = 0, ly = 0, pinch0 = 0, zoom0 = 1;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      down = true; lx = e.clientX; ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      // Pan in UV, so a drag tracks the cursor at any zoom level.
      this.pan[0] += (e.clientX - lx) / el.clientWidth;
      this.pan[1] -= (e.clientY - ly) / el.clientHeight;
      lx = e.clientX; ly = e.clientY;
      this._dirty = true;
    });
    const up = (e) => {
      down = false;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                            e.touches[0].clientY - e.touches[1].clientY);
        zoom0 = this.zoom;
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch0 > 0) {
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
        this.setZoom(zoom0 * (d / pinch0));
      }
    }, { passive: false });
    el.addEventListener('touchend', () => { pinch0 = 0; }, { passive: true });

    el.addEventListener('dblclick', () => this.resetView());
  }

  clear() { this.state = null; this._dirty = true; }
}
