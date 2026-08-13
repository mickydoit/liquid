// Cache-buster. GitHub Pages serves every file with `cache-control: max-age=600`
// and no fingerprinting, so a browser can hold a stale build for ten minutes.
// Worse, `js/app.js` is an ES module: its imports are fetched as separate URLs,
// so stamping only the <script> tag would leave the other eleven modules stale
// and mix old code into a new build.
//
// So we stamp every asset URL we control — the <link>/<script> tags in
// index.html and each relative `from './x.js'` inside js/ — with `?v=<hash>`
// derived from the content of those same files. Same content, same version, so
// re-running is a no-op and only real changes invalidate the cache.
//
// Run `npm run bust` before committing a change you want to land immediately.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything the browser loads, in a stable order so the hash is deterministic.
const jsFiles = readdirSync(join(root, 'js')).filter(f => f.endsWith('.js')).sort();
const vendorFiles = readdirSync(join(root, 'js/vendor')).filter(f => f.endsWith('.js')).sort();
const assets = [
  'index.html',
  'style.css',
  ...jsFiles.map(f => `js/${f}`),
  ...vendorFiles.map(f => `js/vendor/${f}`),
];

// Strip any existing stamp before hashing, or the version would chase its own
// tail: stamping changes the content, which changes the hash, forever.
const STAMP = /\?v=[0-9a-f]{8}/g;
const read = rel => readFileSync(join(root, rel), 'utf8');
const unstamped = rel => read(rel).replace(STAMP, '');

const hash = createHash('sha256');
for (const rel of assets) hash.update(unstamped(rel));
const version = hash.digest('hex').slice(0, 8);

const stamp = url => `${url}?v=${version}`;
let changed = [];

const write = (rel, next) => {
  if (next === read(rel)) return;
  writeFileSync(join(root, rel), next);
  changed.push(rel);
};

// index.html: our own <link href> and <script src>. The jsPDF CDN tag is left
// alone — it is already versioned in its path and is not ours to stamp.
write('index.html', unstamped('index.html')
  .replace(/(<link[^>]+href=")((?!https?:)[^"]+\.css)(")/g, (_, a, url, b) => a + stamp(url) + b)
  .replace(/(<script[^>]+src=")((?!https?:)[^"]+\.js)(")/g, (_, a, url, b) => a + stamp(url) + b));

// js/*.js: relative import specifiers, which the browser fetches as their own
// requests and caches independently of the module that imported them.
for (const f of jsFiles) {
  const rel = `js/${f}`;
  write(rel, unstamped(rel)
    .replace(/(from\s+')(\.\.?\/[^']+\.js)(')/g, (_, a, url, b) => a + stamp(url) + b));
}

console.log(changed.length
  ? `v=${version} — stamped ${changed.length} file(s):\n  ${changed.join('\n  ')}`
  : `v=${version} — already current, nothing to do`);
