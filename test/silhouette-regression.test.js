import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, GRID, signature } from './silhouette-cases.mjs';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/silhouettes.json', import.meta.url), 'utf8'));

// The approved flat geometry, locked 15 Aug 2026.
//
// Shader work, interface changes and control wiring must not move these
// silhouettes. If one of these fails, the geometry changed — either revert it
// or, if the change was deliberately approved, regenerate with
// `node tools/silhouette-fixtures.mjs` and say so in the commit.
for (const c of CASES) {
  test(`silhouette unchanged: ${c.name}`, () => {
    const now = signature(c);
    const want = fixtures[c.name];
    assert.ok(want, `no fixture for ${c.name}`);
    if (now === want) return;
    let moved = 0;
    for (let i = 0; i < want.length; i++) if (now[i] !== want[i]) moved++;
    // Report where it moved, so a failure is diagnosable without a diff tool.
    const rows = [];
    for (let j = 0; j < GRID; j++) {
      const a = want.slice(j * GRID, (j + 1) * GRID);
      const b = now.slice(j * GRID, (j + 1) * GRID);
      if (a !== b) rows.push(j);
    }
    assert.fail(`${c.name}: ${moved} of ${want.length} cells moved, rows ${rows.join(',')}`);
  });
}
