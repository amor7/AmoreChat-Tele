// Checks run before ffmpeg touches a user's file. Usage: node --test server/test/media-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnsafeHeader, withInputGuards, ffmpegInputs, ffmpegTimeout, INPUT_FORMATS } from '../src/media-guard.js';

const MIN = 60_000;
const b = (s) => Buffer.from(s, 'latin1');

test('isUnsafeHeader: HLS and ffconcat are refused', () => {
  assert.ok(isUnsafeHeader(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')));
  assert.ok(isUnsafeHeader(Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n')));
  assert.ok(isUnsafeHeader(Buffer.from('﻿#EXTM3U\n')), 'UTF-8 BOM');
  assert.ok(isUnsafeHeader(b('\xFF\xFE#EXTM3U')), 'UTF-16 BOM bytes');
  assert.ok(isUnsafeHeader(Buffer.from('  \r\n\t#EXTM3U')), 'leading whitespace');
  assert.ok(isUnsafeHeader(Buffer.from('﻿ \n ffconcat version 1.0')), 'BOM then whitespace');
});

test('isUnsafeHeader: real media and near misses pass', () => {
  assert.ok(!isUnsafeHeader(Buffer.alloc(0)));
  assert.ok(!isUnsafeHeader(null));
  assert.ok(!isUnsafeHeader(b('\x1aE\xdf\xa3\x9fB\x86\x81\x01')), 'webm');
  assert.ok(!isUnsafeHeader(b('OggS\x00\x02')), 'ogg');
  assert.ok(!isUnsafeHeader(b('\x00\x00\x00\x20ftypisom')), 'mp4');
  assert.ok(!isUnsafeHeader(b('ID3\x04')), 'mp3');
  // ffmpeg matches the exact upper-case marker; a lower-case one is not a playlist to it.
  assert.ok(!isUnsafeHeader(Buffer.from('#extm3u\n')));
  assert.ok(!isUnsafeHeader(Buffer.from('x#EXTM3U')), 'marker not at the start');
});

test('isUnsafeHeader: XML (DASH manifests, SMIL) is refused', () => {
  assert.ok(isUnsafeHeader(Buffer.from('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">')));
  assert.ok(isUnsafeHeader(Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">')), 'MPD without a declaration');
  assert.ok(isUnsafeHeader(Buffer.from('<mpd>')), 'any case');
  assert.ok(isUnsafeHeader(Buffer.from('<smil><body><video src="file:///data/app.db"/></body></smil>')));
  assert.ok(isUnsafeHeader(Buffer.from('<SMIL>')));
  assert.ok(isUnsafeHeader(Buffer.from('<?XML version="1.0"?>')));
  assert.ok(isUnsafeHeader(Buffer.from('﻿ \r\n<?xml version="1.0"?>')), 'BOM then whitespace');
  assert.ok(isUnsafeHeader(Buffer.from('﻿<?xml version="1.0"?>', 'utf16le')), 'UTF-16 LE text');
  assert.ok(isUnsafeHeader(b('\xFE\xFF\x00<\x00M\x00P\x00D')), 'UTF-16 BE text');
});

test('isUnsafeHeader: other text starting with < passes', () => {
  assert.ok(!isUnsafeHeader(Buffer.from('<mpdx>')), 'a longer tag name');
  assert.ok(!isUnsafeHeader(Buffer.from('<smiley>')));
  assert.ok(!isUnsafeHeader(Buffer.from('x<?xml')), 'marker not at the start');
});

test('withInputGuards: -nostdin once, file-only protocols and the format whitelist before every -i', () => {
  const g = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS];
  assert.deepEqual(withInputGuards(['-y', '-ss', '1', '-i', 'a.webm', 'b.jpg']), ['-nostdin', '-y', '-ss', '1', ...g, '-i', 'a.webm', 'b.jpg']);
  assert.deepEqual(withInputGuards(['-i', 'a', '-i', 'b', 'o']), ['-nostdin', ...g, '-i', 'a', ...g, '-i', 'b', 'o']);
  // Every -i is directly preceded by both whitelists.
  const out = withInputGuards(['-hide_banner', '-i', 'x', '-i', 'y', '-i', 'z']);
  out.forEach((a, i) => {
    if (a === '-i') assert.deepEqual(out.slice(i - 4, i), g, `guards before -i at ${i}`);
  });
});

test('INPUT_FORMATS: media demuxers only, nothing that opens other files', () => {
  const list = INPUT_FORMATS.split(',');
  for (const f of ['mov', 'matroska', 'ogg', 'mp3', 'wav', 'flac', 'aac']) assert.ok(list.includes(f), f);
  for (const f of ['hls', 'dash', 'concat', 'image2', 'image2pipe', 'smil', 'xml', 'tee', 'lavfi', 'data', 'tty', 'subviewer']) {
    assert.ok(!list.includes(f), `${f} must not be allowed`);
  }
  assert.ok(list.every((f) => /^[a-z0-9_]+$/.test(f)), 'plain demuxer names');
});

test('ffmpegInputs: the argument after each -i, never the output', () => {
  assert.deepEqual(ffmpegInputs(['-hide_banner', '-i', '/u/x.mp4']), ['/u/x.mp4']);
  assert.deepEqual(ffmpegInputs(['-y', '-i', 'a', '-i', 'b', 'out.mp4']), ['a', 'b']);
  assert.deepEqual(ffmpegInputs(['-y', '-i']), []);
});

test('ffmpegTimeout: probe and thumbnails', () => {
  assert.equal(ffmpegTimeout('probe'), MIN);
  assert.equal(ffmpegTimeout('thumb', 99999), MIN);
});

test('ffmpegTimeout: audio has a 2 min floor and grows for long voice', () => {
  assert.equal(ffmpegTimeout('voice', 10), 2 * MIN);
  assert.equal(ffmpegTimeout('music', 240), 2 * MIN);
  assert.equal(ffmpegTimeout('voice', 15 * 60), 7.5 * MIN, 'a 15 minute voice note gets more than 2 min');
  assert.equal(ffmpegTimeout('voice', null), 7.5 * MIN, 'unknown length: enough for the longest voice note');
  assert.equal(ffmpegTimeout('audio', 0), 7.5 * MIN);
  assert.equal(ffmpegTimeout('audio', 10 * 3600), 30 * MIN, 'ceiling');
});

test('ffmpegTimeout: video floor, scale, ceiling, unknown', () => {
  assert.equal(ffmpegTimeout('video', 30), 15 * MIN);
  assert.equal(ffmpegTimeout('video', 600), 60 * MIN);
  assert.equal(ffmpegTimeout('video', 5 * 3600), 120 * MIN);
  assert.equal(ffmpegTimeout('video', null), 60 * MIN);
  assert.equal(ffmpegTimeout('video', 'garbage'), 60 * MIN);
  assert.equal(ffmpegTimeout('video', -5), 60 * MIN);
  assert.equal(ffmpegTimeout(undefined), 60 * MIN, 'no kind: bounded, not unlimited');
});
