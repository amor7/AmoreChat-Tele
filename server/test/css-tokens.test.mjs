// Guard for the design tokens (web/src/tokens.css): colors live there (and in themes.css),
// component CSS and JSX only use var(--...). Usage: node --test server/test/css-tokens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../../web/src');
const PALETTE_FILES = new Set(['tokens.css', 'themes.css']);

// Hex colors deliberately kept outside the palette files: { 'file.css': ['#abc', ...] }.
// Each entry needs a comment saying why. Empty today.
const ALLOWED = {};

function files(dir, ext) {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rel = (f) => path.relative(SRC, f).replaceAll('\\', '/');

// Only look at declaration values, so id selectors like #root never count.
function hexInCss(css) {
  const found = [];
  for (const [, value] of css.matchAll(/[\w-]+\s*:([^;{}]+)/g)) {
    for (const [hex] of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(hex.toLowerCase());
  }
  return found;
}

test('component CSS uses tokens, not hex colors', () => {
  const problems = [];
  for (const f of files(SRC, '.css')) {
    const name = rel(f);
    if (PALETTE_FILES.has(name)) continue;
    const allowed = ALLOWED[name] || [];
    const extra = hexInCss(read(f)).filter((h) => !allowed.includes(h));
    if (extra.length) problems.push(`${name}: ${extra.join(' ')}`);
  }
  assert.deepEqual(problems, [], 'add a token in tokens.css instead (or an explained ALLOWED entry)');
});

test('JSX inline styles use tokens, not hex colors', () => {
  const problems = [];
  for (const f of files(SRC, '.jsx')) {
    // Any hex inside a string or template literal, e.g. '1px solid #fff', not only at its start.
    const hex = [];
    for (const [lit] of read(f).matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) hex.push(...(lit.match(/#[0-9a-fA-F]{3,8}\b/g) || []));
    if (hex.length) problems.push(`${rel(f)}: ${hex.join(' ')}`);
  }
  assert.deepEqual(problems, []);
});

test('every var(--x) used in CSS is defined somewhere', () => {
  const css = files(SRC, '.css').map(read);
  const code = [...files(SRC, '.jsx'), ...files(SRC, '.js')].map(read);
  const defined = new Set();
  for (const s of css) for (const [, n] of s.matchAll(/(--[\w-]+)\s*:/g)) defined.add(n);
  // Set from JS at runtime (style.setProperty or React style objects).
  for (const s of code) for (const [, n] of s.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(n);
  const missing = new Set();
  for (const s of css) {
    // var(--x, fallback) is fine without a definition: the fallback is the point.
    for (const [, n, fallback] of s.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) if (!fallback && !defined.has(n)) missing.add(n);
  }
  assert.deepEqual([...missing], []);
});

test('the palette has light and dark values and the semantic tokens', () => {
  const tokens = read(path.join(SRC, 'tokens.css'));
  const block = (sel) => tokens.slice(tokens.indexOf(`${sel} {`), tokens.indexOf('}', tokens.indexOf(`${sel} {`)));
  const light = block(':root');
  const dark = block(":root[data-mode='dark']");
  for (const n of ['--bg', '--panel', '--panel-2', '--border', '--text', '--muted', '--accent', '--accent-2', '--accent-soft', '--grad', '--danger', '--ok', '--bubble-in', '--bubble-out', '--bubble-out-text', '--chat-bg', '--hover', '--shadow', '--shadow-sm', '--glass', '--radius', '--warn', '--ok-text', '--warn-text', '--danger-soft', '--warn-soft', '--ok-soft', '--on-accent', '--overlay', '--media-bg', '--text-on-media']) {
    assert.match(light, new RegExp(`${n}:`), `${n} missing in :root`);
  }
  for (const n of ['--bg', '--panel', '--text', '--muted', '--accent', '--grad', '--danger', '--bubble-in', '--chat-bg', '--glass']) {
    assert.match(dark, new RegExp(`${n}:`), `${n} missing in dark mode`);
  }
  assert.match(light, /color-scheme: light/);
  assert.match(dark, /color-scheme: dark/);
});

test('only tokens.css has a pre-render dark block, and it stays tiny', () => {
  for (const f of files(SRC, '.css')) {
    if (rel(f) !== 'tokens.css') assert.doesNotMatch(read(f), /:not\(\[data-mode\]\)/, rel(f));
  }
  // The full dark palette lives under [data-mode='dark']; this block only avoids a white first frame.
  const tokens = read(path.join(SRC, 'tokens.css'));
  const first = tokens.slice(tokens.indexOf(':root:not([data-mode])'));
  const vars = first.slice(0, first.indexOf('}')).match(/--[\w-]+:/g) || [];
  assert.ok(vars.length > 0 && vars.length <= 4, `first-paint block: ${vars.join(' ')}`);
});

test('motion.css is imported last, a11y.css right before it, tokens.css first, and lite mode turns blur off', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8');
  const cssImports = [...main.matchAll(/import '\.\/([\w-]+\.css)'/g)].map((m) => m[1]);
  assert.equal(cssImports[0], 'tokens.css');
  assert.equal(cssImports.at(-1), 'motion.css');
  // Focus ring / touch sizes must beat component rules, but lite and reduced motion beat them.
  assert.equal(cssImports.at(-2), 'a11y.css');
  const motion = read(path.join(SRC, 'motion.css'));
  assert.match(motion, /\[data-lite\][^{]*\{[^}]*backdrop-filter: none/);
});
