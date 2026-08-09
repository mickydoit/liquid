import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveConductor, KickDetector, pitchNormOf,
         ON_RMS, OFF_RMS, STABLE_SEC, RELEASE_SEC } from '../js/live.js';

const mkFrame = (o = {}) => ({
  pitchHz: 220, pitchConf: 0.9, rms: 0.15, flux: 0.002,
  centroid: 0.4, spread: 0.3,
  chroma: new Float32Array(12),
  ...o,
});

function harness() {
  const log = { fields: [], phases: [] };
  const frame = { current: mkFrame({ rms: 0.0005, pitchHz: 0, pitchConf: 0.05, flux: 0 }) };
  const conductor = new LiveConductor({
    audio: { getMusicalFrame: () => frame.current },
    renderer: { setField: (s, anim) => log.fields.push({ ...s, __anim: anim }) },
    onState: (p) => log.phases.push(p),
  });
  return { conductor, log, frame };
}

function drive(conductor, frame, value, seconds, t0) {
  let t = t0;
  frame.current = value;
  for (let i = 0; i < Math.round(seconds / 0.05); i++) { t += 0.05; conductor.tick(t); }
  return t;
}

const SILENT = mkFrame({ rms: 0.0005, pitchHz: 0, pitchConf: 0.05, flux: 0 });
const TONE = (hz, o = {}) => mkFrame({ rms: 0.18, pitchHz: hz, pitchConf: 0.95, flux: 0.001, ...o });

test('pitchNormOf spans the same 6 octaves as the fingerprint', () => {
  assert.ok(Math.abs(pitchNormOf(55) - 0) < 1e-9);
  assert.ok(Math.abs(pitchNormOf(3520) - 1) < 1e-9);
  // An unvoiced frame must not read as "lowest possible note".
  assert.ok(pitchNormOf(0) > 0.2);
});

test('idle: silence at startup shows droplets, never a formed design', () => {
  const { conductor, log, frame } = harness();
  drive(conductor, frame, SILENT, 2, 0);
  assert.equal(conductor.phase, 'idle');
  assert.ok(log.fields[log.fields.length - 1].amp < 0.05, 'idle must not gather water');
});

test('hold: a formed design SURVIVES silence instead of dissolving to droplets', () => {
  const { conductor, log, frame } = harness();
  let t = drive(conductor, frame, SILENT, 1, 0);
  t = drive(conductor, frame, TONE(220), 3, t);
  assert.equal(conductor.phase, 'active');
  const formed = { ...log.fields[log.fields.length - 1] };
  assert.ok(formed.amp > 0.4, `a real sound must gather water (amp ${formed.amp})`);

  t = drive(conductor, frame, SILENT, 6, t);
  assert.equal(conductor.phase, 'hold');
  const held = log.fields[log.fields.length - 1];
  assert.ok(held.amp > 0.4, `held design lost its water (amp ${held.amp})`);
  for (const k of ['m', 'n', 'kr', 'ma']) {
    assert.ok(Math.abs(held[k] - formed[k]) < 1e-9, `${k} drifted while held`);
  }
});

test('hold: geometry frozen, material animation continues', () => {
  // The renderer is told WHICH animation to run: geometry time driving a held
  // figure would let it change shape on its own, and no animation at all
  // would make held water look like a photograph.
  const { conductor, log, frame } = harness();
  let t = drive(conductor, frame, SILENT, 0.5, 0);
  t = drive(conductor, frame, TONE(220), 3, t);
  assert.equal(log.fields[log.fields.length - 1].__anim, 'full');
  t = drive(conductor, frame, SILENT, 6, t);
  assert.equal(log.fields[log.fields.length - 1].__anim, 'material');
});

test('hold: a new sound transitions smoothly out of the held design', () => {
  const { conductor, log, frame } = harness();
  let t = drive(conductor, frame, SILENT, 0.5, 0);
  t = drive(conductor, frame, TONE(160), 3, t);
  t = drive(conductor, frame, SILENT, 5, t);
  const from = log.fields.length - 1;
  const held = log.fields[from].m;

  t = drive(conductor, frame, TONE(1500, { rms: 0.22, centroid: 0.8 }), 6, t);
  const after = log.fields[log.fields.length - 1].m;
  assert.ok(Math.abs(after - held) > 1.5, `a new sound must change the figure (${held} -> ${after})`);

  let biggest = 0;
  for (let i = from + 1; i < log.fields.length; i++) {
    biggest = Math.max(biggest, Math.abs(log.fields[i].m - log.fields[i - 1].m));
  }
  assert.ok(biggest < 0.9, `transition snapped by ${biggest.toFixed(2)} instead of flowing`);
});

test('hysteresis: background noise under the ON threshold never forms a design', () => {
  const { conductor, log, frame } = harness();
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 0.05;
    frame.current = mkFrame({ rms: ON_RMS * (0.5 + 0.45 * Math.sin(i)), pitchHz: 300,
                              pitchConf: 0.6, flux: 0.0004 });
    conductor.tick(t);
  }
  assert.equal(conductor.phase, 'idle', 'room tone formed a design');
  assert.ok(log.fields[log.fields.length - 1].amp < 0.05);
});

test('stability window: a blip shorter than STABLE_SEC is ignored', () => {
  const { conductor, frame } = harness();
  let t = drive(conductor, frame, SILENT, 0.5, 0);
  drive(conductor, frame, TONE(400, { rms: 0.3, flux: 0.02 }), STABLE_SEC * 0.5, t);
  assert.equal(conductor.phase, 'idle', 'a blip must not form a design');
});

test('a low-confidence frame drives loudness but not topology', () => {
  // Pitch detection fails on noise; letting a bad estimate through would jerk
  // the figure between unrelated modal orders.
  const { conductor, log, frame } = harness();
  let t = drive(conductor, frame, SILENT, 0.5, 0);
  t = drive(conductor, frame, TONE(220), 3, t);
  const before = { ...log.fields[log.fields.length - 1] };
  t = drive(conductor, frame, mkFrame({ rms: 0.25, pitchHz: 3000, pitchConf: 0.1, flux: 0.001 }), 2, t);
  const after = log.fields[log.fields.length - 1];
  for (const k of ['m', 'n', 'kr', 'ma']) {
    assert.ok(Math.abs(after[k] - before[k]) < 0.4, `${k} moved on an unreliable pitch`);
  }
});

test('reset returns to idle droplets', () => {
  const { conductor, frame } = harness();
  let t = drive(conductor, frame, SILENT, 0.5, 0);
  t = drive(conductor, frame, TONE(220), 3, t);
  assert.equal(conductor.phase, 'active');
  conductor.reset();
  assert.equal(conductor.phase, 'idle');
  assert.equal(conductor.field.amp, 0);
});

test('KickDetector fires on a flux spike and decays', () => {
  const k = new KickDetector();
  for (let i = 0; i < 30; i++) k.step(0.001, 1 / 60);
  const hit = k.step(0.05, 1 / 60);
  assert.ok(hit > 0.9, `expected an onset (${hit})`);
  for (let i = 0; i < 60; i++) k.step(0.001, 1 / 60);
  assert.ok(k.value < 0.05, 'onset must decay');
});
