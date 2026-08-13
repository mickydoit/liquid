import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../tools/png.mjs';

test('encodePNG emits a valid PNG signature and IHDR', () => {
  const buf = encodePNG(2, 2, new Uint8Array(12).fill(128));
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(buf.readUInt32BE(16), 2, 'width');
  assert.equal(buf.readUInt32BE(20), 2, 'height');
});

test('encodePNG ends with IEND', () => {
  const buf = encodePNG(1, 1, new Uint8Array([0, 0, 0]));
  assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString('latin1'), 'IEND');
});

test('encodePNG rejects a wrong-sized buffer', () => {
  assert.throws(() => encodePNG(2, 2, new Uint8Array(5)), /expected 12 bytes/);
});
