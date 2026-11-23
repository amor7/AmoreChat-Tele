import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { get, all, run, parseJSON, UPLOAD_DIR } from './db.js';
import { isUnsafeHeader, withInputGuards, ffmpegInputs, ffmpegTimeout } from './media-guard.js';
import { logBackground } from './timers.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const VIDEO_QUALITIES = [360, 720];

export let ffmpegAvailable = false;
export const mediaReady = new Promise((resolve) => {
  const p = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
  p.on('error', () => resolve(false));
  p.on('exit', (code) => {
    ffmpegAvailable = code === 0;
    resolve(ffmpegAvailable);
  });
});

// Running ffmpeg processes, so shutdown can stop them instead of leaving them to finish alone.
const activeFfmpeg = new Set();
export function killAllFfmpeg() {
  for (const p of activeFfmpeg) {
    try {
      p.kill('SIGKILL');
    } catch {}
  }
  activeFfmpeg.clear();
}

async function assertNotPlaylist(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return; // missing/unreadable: ffmpeg reports that itself, as before
  }
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
    if (isUnsafeHeader(buffer.subarray(0, bytesRead))) {
      throw Object.assign(new Error('ffmpeg input refused: playlist file'), { stderr: '' });
    }
  } finally {
    await fh.close();
  }
}

/**
 * Runs ffmpeg on local files only. opts.kind ('probe', 'thumb', 'voice', 'music', 'audio',
 * 'video') and opts.duration (seconds) set the time limit; opts.out is the output file, removed
 * if the run fails or times out. It is never guessed from args: for a probe the last argument
 * is the user's own input file.
 */
export async function ffmpeg(args, { kind, out, duration } = {}) {
  for (const input of ffmpegInputs(args)) await assertNotPlaylist(input);
  const full = withInputGuards(args);
  const limit = ffmpegTimeout(kind, duration);
  return new Promise((resolve, reject) => {
    // Lower priority on Linux so transcoding never starves the chat server.
    // nice execs ffmpeg, so the PID (and the signals below) are ffmpeg's own.
    const [cmd, argv] = process.platform === 'linux' ? ['nice', ['-n', '10', FFMPEG, ...full]] : [FFMPEG, full];
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    activeFfmpeg.add(p);
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      logBackground(`ffmpeg timeout: ${kind || 'unknown'} run passed ${Math.round(limit / 1000)} s, stopping it`);
      p.kill('SIGTERM');
      killTimer = setTimeout(() => p.kill('SIGKILL'), 5000);
      killTimer.unref();
    }, limit);
    timer.unref();
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeFfmpeg.delete(p);
      if (err) {
        if (out) fs.rmSync(out, { force: true });
        reject(err);
      } else resolve(value);
    };
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-20000);
    });
    p.on('error', (e) => finish(e));
    p.on('exit', (code) => {
      if (code === 0 && !timedOut) return finish(null, stderr);
      const err = new Error(timedOut ? 'ffmpeg timeout' : `ffmpeg exited ${code}: ${stderr.slice(-500)}`);
      err.stderr = stderr;
      finish(err);
    });
  });
}

// `ffmpeg -i` with no output exits non-zero but prints stream info; parse it instead of needing ffprobe.
async function probe(abs) {
  let info = '';
  try {
    info = await ffmpeg(['-hide_banner', '-i', abs], { kind: 'probe' });
  } catch (e) {
    info = e.stderr || '';
  }
  const dur = info.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const vid = info.match(/Video: [^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const rot = info.match(/rotation of (-?\d+)/) || info.match(/rotate\s*:\s*(-?\d+)/);
  let [width, height] = vid ? [Number(vid[1]), Number(vid[2])] : [null, null];
  if (rot && Math.abs(Number(rot[1])) === 90 && width) [width, height] = [height, width];
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    width,
    height,
  };
}

const abs = (rel) => path.join(UPLOAD_DIR, rel);
const sizeOf = (rel) => fs.statSync(abs(rel)).size;
export const removeRel = (rel) => rel && fs.rmSync(abs(rel), { force: true });

// Voice notes: browsers record webm/ogg Opus (Chrome/Firefox) or mp4 AAC (Safari).
// AAC in mp4 plays everywhere, so convert anything else.
export async function processVoice(fileId) {
  const f = get('SELECT * FROM files WHERE id = ?', fileId);
  if (!ffmpegAvailable || f.mime === 'audio/mp4' || f.mime === 'audio/aac' || f.mime === 'audio/mpeg') return;
  const out = f.path + '.m4a';
  try {
    await ffmpeg(['-y', '-i', abs(f.path), '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', abs(out)], { kind: 'voice', out: abs(out), duration: f.duration });
    removeRel(f.path);
    run("UPDATE files SET path = ?, mime = 'audio/mp4', size = ? WHERE id = ?", out, sizeOf(out), f.id);
  } catch {
    removeRel(out);
  }
}

// One job at a time: video encoding is the heaviest thing this server does.
const queue = [];
let busy = false;
let onUpdate = () => {};
/** A music file: its length, title, artist and cover picture, from the file's own tags. */
export async function processMusic(fileId) {
  const f = get('SELECT * FROM files WHERE id = ?', fileId);
  if (!f) return;
  const src = abs(f.path);
  let info = '';
  try {
    info = await ffmpeg(['-hide_banner', '-i', src], { kind: 'probe' });
  } catch (e) {
    info = e.stderr || '';
  }
  const dur = info.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const tag = (name) => info.match(new RegExp(`^\\s*${name}\\s*: (.+)$`, 'im'))?.[1].trim().slice(0, 200) || null;
  let thumb = null;
  if (/Stream #.*: Video:/.test(info)) {
    const out = f.path + '.thumb.jpg';
    await ffmpeg(['-y', '-i', src, '-an', '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', abs(out)], { kind: 'thumb', out: abs(out) })
      .then(() => (thumb = out))
      .catch(() => {});
  }
  run(
    'UPDATE files SET duration = ?, title = ?, artist = ?, thumb = ? WHERE id = ?',
    dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : f.duration,
    tag('title'),
    tag('artist') || tag('album_artist'),
    thumb,
    f.id,
  );
}

export const onMediaUpdate = (fn) => {
  onUpdate = fn;
};

export function queueVideo(fileId, maxQuality) {
  queue.push({ fileId, maxQuality });
  pump();
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try {
    await processVideo(job.fileId, job.maxQuality);
  } catch (e) {
    console.error('video processing failed', job.fileId, e.message);
    run("UPDATE files SET status = 'ready' WHERE id = ?", job.fileId);
  }
  onUpdate(job.fileId);
  busy = false;
  pump();
}

async function processVideo(fileId, maxQuality) {
  const f = get('SELECT * FROM files WHERE id = ?', fileId);
  if (!f) return;
  const src = abs(f.path);
  const meta = await probe(src);
  run('UPDATE files SET width = ?, height = ?, duration = ? WHERE id = ?', meta.width, meta.height, meta.duration, f.id);

  // Thumbnail (poster frame)
  const thumb = f.path + '.thumb.jpg';
  const at = meta.duration ? Math.min(1, meta.duration / 2) : 0;
  try {
    await ffmpeg(['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', abs(thumb)], { kind: 'thumb', out: abs(thumb) });
    run('UPDATE files SET thumb = ? WHERE id = ?', thumb, f.id);
  } catch {
    /* audio-only or unreadable stream: no poster */
  }

  if (!meta.width) {
    run("UPDATE files SET status = 'ready' WHERE id = ?", f.id);
    return;
  }

  // Quality = the short side, so portrait phone videos are handled correctly.
  const short = Math.min(meta.width, meta.height);
  const limit = maxQuality === 'original' ? Infinity : Number(maxQuality) || 720;
  const targets = VIDEO_QUALITIES.filter((q) => q < short && q <= limit);
  const variants = [];
  for (const q of targets) {
    const out = `${f.path}.${q}p.mp4`;
    const landscape = meta.width >= meta.height;
    const scale = landscape ? `scale=-2:${q}` : `scale=${q}:-2`;
    await ffmpeg([
      '-y', '-i', src,
      '-vf', scale,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', q <= 360 ? '28' : '25', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', q <= 360 ? '64k' : '96k', '-ac', '2',
      '-movflags', '+faststart',
      abs(out),
    ], { kind: 'video', out: abs(out), duration: meta.duration });
    const w = landscape ? Math.round((meta.width * q) / meta.height / 2) * 2 : q;
    const h = landscape ? q : Math.round((meta.height * q) / meta.width / 2) * 2;
    variants.push({ q, path: out, size: sizeOf(out), width: w, height: h });
  }

  // Sender asked for a smaller video than the original: keep only the best allowed variant as the main file.
  if (maxQuality !== 'original' && short > limit && variants.length) {
    const best = variants.pop();
    removeRel(f.path);
    run(
      "UPDATE files SET path = ?, mime = 'video/mp4', size = ?, width = ?, height = ?, variants = ?, status = 'ready' WHERE id = ?",
      best.path,
      best.size,
      best.width,
      best.height,
      JSON.stringify(variants),
      f.id,
    );
    return;
  }
  run("UPDATE files SET variants = ?, status = 'ready' WHERE id = ?", JSON.stringify(variants), f.id);
}

export function fileVariants(f) {
  return parseJSON(f.variants, []);
}

// Delete a file from disk and mark it purged (messages keep pointing at it and show "expired").
export function purgeFile(fileId) {
  const f = get('SELECT * FROM files WHERE id = ? AND purged = 0', fileId);
  if (!f) return false;
  removeRel(f.path);
  removeRel(f.thumb);
  for (const v of fileVariants(f)) removeRel(v.path);
  run("UPDATE files SET purged = 1, size = 0, variants = '[]', thumb = NULL WHERE id = ?", f.id);
  return true;
}

// Re-queue videos that were mid-processing when the server stopped.
export async function resumePendingMedia() {
  if (!(await mediaReady)) {
    run("UPDATE files SET status = 'ready' WHERE status = 'processing'");
    return;
  }
  for (const f of all("SELECT id, max_quality FROM files WHERE status = 'processing'")) queueVideo(f.id, f.max_quality || 'original');
}
