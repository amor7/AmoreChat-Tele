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
  // Backdrops: a tap outside closes the layer. The dialog/menu itself (role="dialog", useDialog)
  // closes on Escape for keyboard users; its panel stops the click from reaching the backdrop.
  'components/Modals.jsx modal-backdrop': 'backdrop of Modal',
  'components/QrCode.jsx modal-backdrop': 'backdrop of the QR overlay',
  'components/Composer.jsx modal-backdrop': 'backdrop of the send-file dialog',
  'components/Voice.jsx modal-backdrop': 'backdrop of the stream dialog',
  'components/ChatView.jsx menu-backdrop': 'backdrop of the message menu',
  'components/Folders.jsx menu-backdrop': 'backdrop of the chat menu',
  'components/Sidebar.jsx menu-backdrop': 'backdrop of the main menu',
  'components/Music.jsx music-sheet-back': 'backdrop of the music sheet',
  // Tap anywhere on the call shows the auto-hidden controls; keyboard focus does the same (onFocus).
  'components/CallView.jsx call-view': 'shows the call controls',
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
