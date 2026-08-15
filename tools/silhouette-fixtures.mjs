// Regenerate the approved silhouette fixtures.
//
//   node tools/silhouette-fixtures.mjs
//
// These lock the APPROVED flat geometry (15 Aug 2026) so later shader,
// interface or control work cannot alter the silhouettes without a test
// failing. Only run this when a geometry change has been deliberately approved.
import { writeFileSync } from 'node:fs';
import { CASES, signature } from '../test/silhouette-cases.mjs';

const out = {};
for (const c of CASES) out[c.name] = signature(c);
writeFileSync(new URL('../test/fixtures/silhouettes.json', import.meta.url),
              JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${Object.keys(out).length} fixtures`);
