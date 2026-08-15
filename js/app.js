import { AudioEngine } from './audio.js?v=ac347946';
import { buildFingerprint } from './features.js?v=ac347946';
import { LiquidRenderer } from './renderer.js?v=ac347946';
import { LiveConductor } from './live.js?v=ac347946';
import { idleState, targetFromFeatures, clamp01 } from './cymafield.js?v=ac347946';
import { buildSVG, exportPDF, downloadText, downloadCanvas } from './export.js?v=ac347946';
import { LiveRecorder, MAX_RECORD_SEC } from './recorder.js?v=ac347946';
import { makeOrganismCache } from './organism.js?v=ac347946';
import { resolveControls, seedFor } from './blobfield.js?v=ac347946';

const audio = new AudioEngine();
let renderer = null;
let conductor = null;
let recorder = null;

// 'blank' | 'recording' | 'live' | 'captured'
let mode = 'blank';
let frames = [];
let recordStart = 0;
let design = null;          // the submitted, static field state

const params = {
  gloss: 1, dispersion: 1, rim: 1, depth: 1, refract: 1,
  flow: 0.35, simple: 0, swell: 0, mass: 0, form: 0, view: 0, lineW: 0.012,
  // How much a design that is NOT responding to sound still moves. 0 freezes
  // it completely (zero draw calls); the default is a slow drift.
  motion: 0.35,
  ground: '#aeb8bf', ink: '#12181d', deep: '#7d94a6',
  transparent: false, exportRes: 1600,
  // The organism's art direction, used above Form 0.5. Defaults are the
  // `large` scenario from tools/render.mjs — the tuned cropped-poster case.
  poster: { formCount: 0.30, stretch: 0.95, merge: 0.10, simplify: 0.55, scaleCrop: 1.30 },
  // Reroll step. Same sound and settings plus a different variation gives an
  // alternative composition; see seedFor() in js/blobfield.js.
  variation: 0,
};

// Baked in a worker: a preview bake is ~22 ms, which reads as a stutter while
// a Poster slider is being dragged. onReady is where the finished grid reaches
// the screen, since request() returns the previous one so the loop never waits.
const organismCache = makeOrganismCache({
  worker: true,
  onReady: (baked) => {
    const s = currentState();
    if (!s) return;
    s.organism = baked;
    renderer.setOrganismSDF(baked.grid, baked.w, baked.h);
    renderer._dirty = true;
  },
});

// Rebuild the organism and hand it to BOTH the renderer (as a texture) and the
// field state (as a sample function). The renderer draws from the texture; the
// exporter contours the state. They must be the same bake, or a design would
// export differently from its preview.
function refreshOrganism() {
  const s = currentState();
  if (!s || (params.form ?? 0) <= 0.5) return;
  const controls = resolveControls(params.poster, s.features ?? null);
  const seed = seedFor(s.features ?? null, params.variation);
  // Baked at the canvas's own aspect, so the composition is cropped by the
  // frame the user is actually looking at.
  const c = renderer.canvas;
  const aspect = (c.width || 2) / (c.height || 3);
  // The exporter re-bakes at full resolution and needs the inputs to do it.
  // Set BEFORE the request: the bake is asynchronous, so an export triggered
  // in between must still know what to rebuild.
  s.organismSource = { seed, controls };
  const baked = organismCache.request(seed, controls, 256, aspect);
  // null until the first worker bake lands; onReady takes it from there.
  if (baked) {
    s.organism = baked;
    renderer.setOrganismSDF(baked.grid, baked.w, baked.h);
    renderer._dirty = true;
  }
}

const $ = (id) => document.getElementById(id);
const hex = (h) => {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
};
const setStatus = (t) => { $('status').textContent = t; };

// A recording is one finished image. The frame timeline builds the aggregate
// fingerprint and nothing else — it never drives an animation. Live Hold is
// the opposite case and keeps its shimmer; they are separate render states.
function stateFromFingerprint(fp) {
  const s = idleState();
  Object.assign(s, targetFromFeatures({
    pitchNorm: fp.pitchMedian,
    rms: (fp.volMean ?? 0.3) * 0.6,
    centroid: fp.centroid,
    spread: fp.spread,
    pitchConf: fp.pitchConfidence,
  }));
  s.amp = Math.min(1, Math.max(s.amp, params.flow * 1.6));
  // Start empty and flood in, so a submitted design arrives rather than
  // appearing whole.
  s.simple = params.simple;
  s.swell = params.swell;
  s.mass = params.mass;
  s.form = params.form;
  s.grow = 0;
  s.growTarget = 1;
  return s;
}

function applyStyle() {
  renderer.setStyle({
    gloss: params.gloss,
    dispersion: params.dispersion,
    rim: params.rim,
    depth: params.depth,
    refract: params.refract,
    view: params.view,
    lineW: params.lineW,
    transparent: params.transparent,
    ground: hex(params.ground),
    ink: hex(params.ink),
    deep: hex(params.deep),
  });
}

function showButtons() {
  const live = mode === 'live';
  // The level meter is only meaningful while something is being listened to;
  // left up it reads as a stray line under the brand pill.
  $('vu-track').hidden = !(live || mode === 'recording');
  $('btn-live').classList.toggle('active', live);
  $('btn-stop').hidden = mode !== 'recording';
  $('btn-submit').hidden = mode !== 'recording';
  $('btn-mic').hidden = mode === 'recording' || live;
  $('lbl-file').hidden = mode === 'recording' || live;
  $('btn-rec').hidden = !live;
  $('btn-rec-stop').hidden = !(live && recorder && recorder.recording);
  $('video-ready').hidden = !(recorder && recorder.hasMaster);
}

// ── capture ───────────────────────────────────────────────────────────
function captureLoop() {
  requestAnimationFrame(captureLoop);
  if (audio.active && mode === 'recording') {
    const f = audio.getMusicalFrame();
    if (f) {
      $('vu').style.width = Math.min(100, f.rms * 300) + '%';
      if (f.rms > 0.005) frames.push({ ...f, t: (performance.now() - recordStart) / 1000 });
    }
  }
}

async function startMic() {
  try { await audio.startMic(); } catch { setStatus('Microphone blocked'); return; }
  frames = []; recordStart = performance.now(); mode = 'recording';
  showButtons();
  setStatus('Recording — press ■ then ✓');
}

async function loadFile(file) {
  try { await audio.loadFile(file); } catch { setStatus('Could not read that file'); return; }
  frames = []; recordStart = performance.now(); mode = 'recording';
  showButtons();
  setStatus(`Reading "${file.name}" — press ■ then ✓`);
}

function stopCapture() {
  audio.stop();
  setStatus(frames.length ? 'Press ✓ to create the design' : 'No audio captured — try again');
}

function submit() {
  if (!frames.length) { setStatus('No audio captured — try again'); return; }
  const fp = buildFingerprint(frames, (performance.now() - recordStart) / 1000);
  design = stateFromFingerprint(fp);
  applyStyle();
  // 'material': the GEOMETRY is frozen — the figure never changes on its own —
  // but the water keeps drifting at the Motion rate so a submitted design
  // reads as liquid rather than as a screenshot. Motion 0 freezes it entirely.
  renderer.materialRate = params.motion;
  renderer.setField(design, 'material');
  // A fresh fingerprint means a fresh seed, so the organism must be rebuilt
  // for the new sound rather than held over from the previous design.
  refreshOrganism();
  mode = 'captured';
  showButtons();
  setStatus('Design created — static. Export PNG or vectors.');
}

// ── live ──────────────────────────────────────────────────────────────
async function toggleLive() {
  if (mode === 'live') { endLive(); return; }
  try { await audio.startMic(); } catch { setStatus('Microphone blocked'); return; }
  design = null;
  applyStyle();
  conductor = new LiveConductor({
    audio, renderer,
    onVu: (rms) => { $('vu').style.width = Math.min(100, rms * 300) + '%'; },
    onState: (phase) => {
      setStatus(phase === 'idle' ? 'Live — waiting for sound'
              : phase === 'active' ? 'Live — forming'
              : 'Live — holding · shimmering');
    },
  });
  conductor.field.simple = params.simple;
  conductor.field.swell = params.swell;
  conductor.field.mass = params.mass;
  conductor.field.form = params.form;
  renderer.materialRate = 1;
  conductor.start();
  mode = 'live';
  showButtons();
}

function endLive() {
  if (conductor) { conductor.stop(); conductor = null; }
  audio.stop();
  mode = renderer.state ? 'captured' : 'blank';
  // Freeze whatever was on screen when live ended.
  if (renderer.state) {
    design = renderer.state;
    renderer.materialRate = params.motion;
    renderer.setField(design, 'material');
    refreshOrganism();
  }
  showButtons();
  setStatus(design ? 'Live ended — design frozen' : 'Ready');
}

function clearAll() {
  if (conductor) { conductor.stop(); conductor = null; }
  audio.stop();
  if (recorder) recorder.discard();
  design = null; frames = []; mode = 'blank';
  renderer.clear();
  showButtons();
  setStatus('Ready — record, upload, or go live');
}

// ── export ────────────────────────────────────────────────────────────
function exportDims() {
  const el = $('stage');
  const aspect = (el.clientWidth || 1600) / (el.clientHeight || 1200);
  const L = params.exportRes;
  return aspect >= 1 ? [L, Math.round(L / aspect)] : [Math.round(L * aspect), L];
}

function currentState() { return renderer.state || design; }

function doExport(fmt) {
  const state = currentState();
  if (!state) { setStatus('Create a design first'); return; }
  const [W, H] = exportDims();
  if (fmt === 'png') {
    downloadCanvas(renderer.renderToCanvas(W, H), 'liquid.png');
    setStatus(`PNG saved (${W}×${H})`);
    return;
  }
  const variant = fmt.startsWith('outline') ? 'outline' : 'flat';
  const opts = {
    state, width: W, height: H, ink: params.ink,
    background: params.transparent ? null : params.ground, variant,
    bounds: renderer.viewBounds(),   // keep the vector framing == the screen
  };
  if (fmt.endsWith('svg')) downloadText(buildSVG(opts), `liquid-${variant}.svg`);
  else exportPDF(opts);
  setStatus(`${variant === 'outline' ? 'Outline' : 'Flat'} vector saved`);
}

// ── video ─────────────────────────────────────────────────────────────
function startVideo() {
  if (!recorder) recorder = new LiveRecorder();
  if (typeof VideoEncoder === 'undefined') { setStatus('Video needs WebCodecs (Chrome/Edge)'); return; }
  recorder.onLimit = () => { stopVideo(); setStatus(`Video limit reached (${MAX_RECORD_SEC}s)`); };
  recorder.start(renderer.canvas).then(() => {
    renderer.setFrameSink((now) => recorder.captureTick(now));
    showButtons();
    setStatus('Recording video…');
  }).catch(() => setStatus('Video encoder unavailable'));
}

function stopVideo() {
  if (!recorder) return;
  recorder.stop();
  renderer.setFrameSink(null);
  showButtons();
  setStatus('Video ready — export below');
}

async function exportVideo() {
  if (!recorder || !recorder.hasMaster) return;
  setStatus('Exporting video…');
  try {
    await recorder.exportAt($('sel-video-q').value, {
      onProgress: (p) => setStatus(`Exporting video… ${Math.round(p * 100)}%`),
    });
    setStatus('Video saved');
  } catch (e) { setStatus('Video export failed: ' + e.message); }
}

// ── wiring ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderer = new LiquidRenderer($('stage'));
  applyStyle();

  // Keep the design centred in the space the chrome leaves. Measured rather
  // than hardcoded, so it follows the panel's real size and the mobile
  // layout where the panel sits along the bottom instead of the right.
  const applyInset = () => {
    const panel = $('panel').getBoundingClientRect();
    const stage = $('stage').getBoundingClientRect();
    const overlapsRight = panel.left > stage.left + stage.width * 0.5;
    if (overlapsRight) renderer.setViewInset(Math.max(0, stage.right - panel.left) + 16, 0);
    else renderer.setViewInset(0, Math.max(0, stage.bottom - panel.top) + 12);
  };
  applyInset();
  window.addEventListener('resize', applyInset);
  // Empty canvas until the first valid sound: idleState has grow 0.
  renderer.setField(idleState(), 'full');

  $('btn-mic').addEventListener('click', startMic);
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  $('btn-stop').addEventListener('click', stopCapture);
  $('btn-submit').addEventListener('click', submit);
  $('btn-live').addEventListener('click', toggleLive);
  $('btn-clear').addEventListener('click', clearAll);
  $('btn-rec').addEventListener('click', startVideo);
  $('btn-rec-stop').addEventListener('click', stopVideo);
  $('btn-video-export').addEventListener('click', exportVideo);
  $('btn-video-discard').addEventListener('click', () => {
    if (recorder) recorder.discard(); showButtons(); setStatus('Video discarded');
  });

  for (const [id, key, scale] of [['sl-gloss', 'gloss', 1], ['sl-dispersion', 'dispersion', 1],
                                  ['sl-rim', 'rim', 1], ['sl-depth', 'depth', 1],
                                  ['sl-refract', 'refract', 1]]) {
    $(id).addEventListener('input', (e) => {
      params[key] = parseFloat(e.target.value) * scale;
      applyStyle();
    });
  }
  $('sl-flow').addEventListener('input', (e) => {
    params.flow = parseFloat(e.target.value);
    // A deliberate control change may update a submitted design — then it is
    // re-frozen. It must not restart any animation.
    const s = currentState();
    if (s && mode === 'captured') {
      s.amp = clamp01(params.flow * 1.6);
      renderer.setField(s, 'material');
    }
  });
  // Simplicity is GEOMETRY, not style: it lowers the modal orders, so it has
  // to land on the state the vector export reads or a simplified design would
  // export at full complexity.
  $('sl-simple').addEventListener('input', (e) => {
    params.simple = parseFloat(e.target.value);
    if (conductor) conductor.field.simple = params.simple;
    const s = currentState();
    if (s) { s.simple = params.simple; renderer._dirty = true; }
  });
  // Swell is GEOMETRY too — it changes the band width per point, so it has to
  // reach the state the exporter reads.
  $('sl-swell').addEventListener('input', (e) => {
    params.swell = parseFloat(e.target.value);
    if (conductor) conductor.field.swell = params.swell;
    const s = currentState();
    if (s) { s.swell = params.swell; renderer._dirty = true; }
  });
  $('sl-mass').addEventListener('input', (e) => {
    params.mass = parseFloat(e.target.value);
    if (conductor) conductor.field.mass = params.mass;
    const s = currentState();
    if (s) { s.mass = params.mass; renderer._dirty = true; }
  });
  $('sl-form').addEventListener('input', (e) => {
    params.form = parseFloat(e.target.value);
    if (conductor) conductor.field.form = params.form;
    const s = currentState();
    if (s) { s.form = params.form; renderer._dirty = true; }
    // Crossing the hinge is what brings the organism into play, so the bake
    // has to be available before the ramp asks for it.
    refreshOrganism();
  });

  // The Poster controls are GEOMETRY, so like Simplicity and Swell they have
  // to land on the state the vector export reads — which refreshOrganism does
  // by writing s.organism and s.organismSource.
  const POSTER = { 'sl-p-count': 'formCount', 'sl-p-stretch': 'stretch',
                   'sl-p-merge': 'merge', 'sl-p-simplify': 'simplify',
                   'sl-p-crop': 'scaleCrop' };
  for (const [id, key] of Object.entries(POSTER)) {
    $(id).addEventListener('input', (e) => {
      params.poster[key] = parseFloat(e.target.value);
      refreshOrganism();
    });
  }
  $('btn-reroll').addEventListener('click', () => {
    params.variation++;
    refreshOrganism();
    setStatus(`Composition ${params.variation + 1}`);
  });
  $('sl-motion').addEventListener('input', (e) => {
    params.motion = parseFloat(e.target.value);
    if (mode !== 'live') renderer.materialRate = params.motion;
    renderer._dirty = true;
  });
  $('sl-scale').addEventListener('input', (e) => renderer.setZoom(parseFloat(e.target.value)));
  $('btn-reset-view').addEventListener('click', () => {
    renderer.resetView();
    $('sl-scale').value = 1;
  });
  $('sel-view').addEventListener('change', (e) => {
    params.view = parseFloat(e.target.value); applyStyle();
  });
  $('sl-linew').addEventListener('input', (e) => {
    params.lineW = parseFloat(e.target.value); applyStyle();
  });
  $('lbl-backdrop').addEventListener('click', () => $('file-backdrop').click());
  $('file-backdrop').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { renderer.setBackdrop(img); setStatus('Backdrop loaded — the water now refracts it'); };
    img.onerror = () => setStatus('Could not read that image');
    img.src = URL.createObjectURL(f);
  });
  $('btn-backdrop-clear').addEventListener('click', () => {
    renderer.setBackdrop(null); $('file-backdrop').value = ''; setStatus('Backdrop removed');
  });
  $('chk-transparent').addEventListener('change', (e) => { params.transparent = e.target.checked; });
  for (const [id, key] of [['col-ground', 'ground'], ['col-ink', 'ink'], ['col-deep', 'deep']]) {
    $(id).addEventListener('input', (e) => { params[key] = e.target.value; applyStyle(); });
  }
  $('sel-res').addEventListener('change', (e) => { params.exportRes = parseInt(e.target.value, 10); });
  document.querySelectorAll('[data-export]').forEach((b) =>
    b.addEventListener('click', () => doExport(b.dataset.export)));

  showButtons();
  captureLoop();
  setStatus('Ready — record, upload, or go live');

  // Diagnostics hook: uniform and field state are otherwise unreachable.
  window.__liquid = { params, renderer: () => renderer, conductor: () => conductor,
                      idleState, targetFromFeatures, refreshOrganism,
                      setField: (s, a = 'full') => renderer.setField(s, a) };
});
