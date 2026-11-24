// Guard for keyboard / screen-reader basics in the web app's JSX.
// Usage: node --test server/test/a11y-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../../web/src');
const jsxFiles = fs
  .readdirSync(SRC, { recursive: true })
  .filter((f) => f.endsWith('.jsx'))
  .map((f) => path.join(SRC, f));
const rel = (f) => path.relative(SRC, f).replaceAll('\\', '/');

// Opening JSX tags matching `start` (a regex at the tag name), whole, across lines: braces,
// strings and arrow functions inside attributes don't end the tag.
function openingTags(src, start) {
  const out = [];
  for (const m of src.matchAll(start)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    out.push({ tag, line: src.slice(0, m.index).split('\n').length, name: m[1] });
  }
  return out;
}
const firstClass = (tag) => tag.match(/className=(?:"|\{`|\{')([\w-]+)/)?.[1] || '';
const oneLine = (tag) => tag.replace(/\s+/g, ' ').slice(0, 140);

test('the tag scanner reads multi-line tags with arrows and braces', () => {
  const src = `<div\n  className="a"\n  onClick={(e) => { if (x > 1) go(); }}\n>\n<span>`;
  const tags = openingTags(src, /<(div|span)\b/g);
  assert.equal(tags.length, 2);
  assert.match(tags[0].tag, /onClick=\{\(e\) => \{ if \(x > 1\) go\(\); \}\}\n>$/);
  assert.equal(firstClass(tags[0].tag), 'a');
});

test('every icon-only button (.icon-btn) has aria-label or title', () => {
  const problems = [];
  for (const f of jsxFiles) {
    for (const { tag, line } of openingTags(fs.readFileSync(f, 'utf8'), /<(button)\b/g)) {
      if (!/className=(?:"|\{`|\{')[^"`']*\bicon-btn\b/.test(tag)) continue;
      if (!/\saria-label=|\stitle=/.test(tag)) problems.push(`${rel(f)}:${line} ${oneLine(tag)}`);
    }
  }
  assert.deepEqual(problems, []);
});

// Clickable non-buttons that are fine without a role, with the reason. Key: file + first class.
const CLICK_ALLOWED = {
  // Backdrops: a tap outside closes the layer. The dialog/menu itself (useDialog / useMenu)
  // closes on Escape for keyboard users; its panel stops the click from reaching the backdrop.
  'components/Modals.jsx modal-backdrop': 'backdrop of Modal (every dialog, the shared confirm included)',
  'components/Menu.jsx menu-backdrop': 'backdrop of Menu (message, chat list and main menus)',
  'components/ChatView.jsx menu-backdrop': 'backdrop of the emoji picker that replaces the message menu',
  'components/Music.jsx music-sheet-back': 'backdrop of the music sheet',
  // Tap anywhere on the call shows the auto-hidden controls; keyboard focus does the same (onFocus).
  'components/CallView.jsx call-view': 'shows the call controls',
  // A Telegram message bubble: a screen reader's activation (a click with detail 0, not after a
  // touch) opens the message menu; keyboard users have the «کارهای پیام» button inside it.
  'components/TeleMessage.jsx bubble': 'screen-reader activation opens the Telegram message menu',
};

test('clickable div/span/li have a role (or are an explained backdrop)', () => {
  const problems = [];
  const used = new Set();
  for (const f of jsxFiles) {
    for (const { tag, line } of openingTags(fs.readFileSync(f, 'utf8'), /<(div|span|li)\b/g)) {
      if (!/\sonClick=/.test(tag)) continue;
      if (/\srole=|\{\.\.\.asButton\(/.test(tag)) continue;
      // A panel that only keeps its clicks from reaching the backdrop does nothing itself.
      if (/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(tag)) continue;
      const key = `${rel(f)} ${firstClass(tag)}`;
      if (CLICK_ALLOWED[key]) {
        used.add(key);
        continue;
      }
      problems.push(`${rel(f)}:${line} ${oneLine(tag)}`);
    }
  }
  assert.deepEqual(problems, [], 'use a <button>, or {...asButton(fn)} from a11y.js');
  // A stale allowlist hides nothing but misleads: drop entries that no longer match.
  assert.deepEqual(Object.keys(CLICK_ALLOWED).filter((k) => !used.has(k)), []);
});

test('every role="dialog" / "alertdialog" says whether it is modal (aria-modal) and has a name', () => {
  const problems = [];
  for (const f of jsxFiles) {
    for (const { tag, line } of openingTags(fs.readFileSync(f, 'utf8'), /<([\w.]+)\b/g)) {
      if (!/\srole="(alert)?dialog"/.test(tag)) continue;
      // Name: aria-label, or aria-labelledby (directly or from useDialog's props).
      if (!/\saria-modal=/.test(tag) || !/\saria-label=|\saria-labelledby=|\{\.\.\.\w*[dD]ialog\}/.test(tag)) problems.push(`${rel(f)}:${line} ${oneLine(tag)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('modal dialogs use useDialog (focus, Tab trap, Escape for the top one only)', () => {
  const problems = [];
  for (const f of jsxFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const { tag, line } of openingTags(src, /<([\w.]+)\b/g)) {
      if (/\srole="dialog"/.test(tag) && /\saria-modal="true"/.test(tag) && !/\{\.\.\.\w*[dD]ialog\}/.test(tag)) problems.push(`${rel(f)}:${line}`);
    }
  }
  assert.deepEqual(problems, []);
});

// useDialog registers Android / browser Back itself. A second useBackClose for the same layer
// would push two history entries (Back once = nothing visible). back: false is only for a
// dialog whose host already registers Back, so that file must have the useBackClose.
test('useDialog owns Back, or says back: false next to the useBackClose that does', () => {
  const problems = [];
  for (const f of jsxFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (!/\buseDialog\(/.test(l)) return;
      const off = /back: false/.test(l);
      if (off && !/\buseBackClose\(/.test(src)) problems.push(`${rel(f)}:${i + 1} back: false without a useBackClose in the file`);
      const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      if (!off && /\buseBackClose\(/.test(near)) problems.push(`${rel(f)}:${i + 1} useBackClose next to useDialog: Back registered twice`);
    });
  }
  assert.deepEqual(problems, []);
});

// Menus get their keyboard support (arrows, Escape, Tab leaves, Back) from useMenu; a hand-made
// role="menu" would look like a menu to screen readers but not act like one.
test('role="menu" / "menuitem" come from Menu.jsx (Menu uses useMenu)', () => {
  const problems = [];
  for (const f of jsxFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const own = rel(f) === 'components/Menu.jsx';
    for (const { tag, line } of openingTags(src, /<([\w.]+)\b/g)) {
      if (!/\srole="menu(item)?"/.test(tag)) continue;
      if (!own) problems.push(`${rel(f)}:${line} use <Menu> / <MenuItem> from components/Menu.jsx`);
      else if (/\srole="menu"/.test(tag) && !/\{\.\.\.menu\}/.test(tag)) problems.push(`${rel(f)}:${line} role="menu" without {...menu} (useMenu)`);
    }
    if (own && !/\buseMenu\(/.test(src)) problems.push(`${rel(f)}: Menu must use useMenu`);
  }
  assert.deepEqual(problems, []);
});

// The browser's own boxes: unstyled, LTR in an RTL app, show a typed password in clear text and
// may not appear at all in the Android WebView. Use confirmDialog / promptDialog / copyDialog
// from web/src/confirm.js instead.
const NATIVE_BOX = /(?:^|[^\w$.])(confirm|prompt|alert)\s*\(|\b(?:window|globalThis|self)\.(confirm|prompt|alert)\s*\(/;
// Comments may mention them; strings with "//" in them only lose a tail, never add a match.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the native-box rule catches calls and skips look-alikes', () => {
  for (const s of ['confirm("x")', 'if (!confirm(a)) return;', 'x && prompt(y)', 'window.alert(1)', '(alert (2))', 'globalThis.confirm(1)', 'self.prompt(2)']) assert.match(s, NATIVE_BOX, s);
  for (const s of ['confirmDialog({})', 'promptDialog()', 'x.confirm(1)', 'api.prompt(2)', 'reconfirm(3)', 'onConfirm(4)', '$confirm(5)', 'myself.confirm(6)']) assert.doesNotMatch(s, NATIVE_BOX, s);
  assert.doesNotMatch(stripComments('a(); // opens confirm()\n/* prompt( */ b();'), NATIVE_BOX);
});

test('no window.confirm / prompt / alert in the web app', () => {
  const problems = [];
  const files = fs
    .readdirSync(SRC, { recursive: true })
    .filter((f) => /\.jsx?$/.test(f))
    .map((f) => path.join(SRC, f));
  for (const f of files) {
    stripComments(fs.readFileSync(f, 'utf8'))
      .split('\n')
      .forEach((l, i) => NATIVE_BOX.test(l) && problems.push(`${rel(f)}:${i + 1} ${l.trim().slice(0, 100)}`));
  }
  assert.deepEqual(problems, [], 'use confirmDialog / promptDialog / copyDialog from web/src/confirm.js');
});
