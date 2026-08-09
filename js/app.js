import { AudioEngine } from './audio.js';
import { buildFingerprint } from './features.js';
import { LiquidRenderer } from './renderer.js';
import { LiveConductor } from './live.js';
import { idleState, targetFromFeatures, clamp01 } from './cymafield.js';
import { buildSVG, exportPDF, downloadText, downloadCanvas } from './export.js';
import { LiveRecorder, MAX_RECORD_SEC } from './recorder.js';

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
  gloss: 1, dispersion: 1, flow: 0.35, flat: false,
  // How much a design that is NOT responding to sound still moves. 0 freezes
  // it completely (zero draw calls); the default is a slow drift.
  motion: 0.35,
  ground: '#aeb8bf', ink: '#12181d', deep: '#7d94a6',
  transparent: false, exportRes: 1600,
};

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
  s.grow = 0;
  s.growTarget = 1;
  return s;
}

function applyStyle() {
  renderer.setStyle({
    gloss: params.gloss,
    dispersion: params.dispersion,
    flat: params.flat,
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

  for (const [id, key, scale] of [['sl-gloss', 'gloss', 1], ['sl-dispersion', 'dispersion', 1]]) {
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
  $('chk-flat').addEventListener('change', (e) => { params.flat = e.target.checked; applyStyle(); });
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
                      idleState, targetFromFeatures,
                      setField: (s, a = 'full') => renderer.setField(s, a) };
});
