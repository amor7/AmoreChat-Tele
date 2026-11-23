// Pure checks around running ffmpeg on user files. Kept apart from media.js (which opens the
// database) so they can be unit tested on their own.

/**
 * True for a file ffmpeg would treat as a list of other files to open: an HLS playlist, an
 * ffconcat script, or XML (DASH manifests, SMIL). ffmpeg follows the entries in those, so an
 * uploaded "video" that is really a playlist could make it read any local file (session keys,
 * the database) into the converted output that the uploader then downloads.
 * This is the second layer: the format whitelist in withInputGuards already keeps those
 * demuxers out. BOMs and leading whitespace are skipped, since rejecting such a file costs
 * nothing; the XML markers are matched in any case.
 */
export function isUnsafeHeader(buf) {
  if (!buf?.length) return false;
  let s = Buffer.from(buf).toString('latin1');
  for (;;) {
    const before = s;
    s = s.replace(/^(\xEF\xBB\xBF|\xFE\xFF|\xFF\xFE)/, '').replace(/^[\s\0]+/, '');
    if (s === before) break;
  }
  // UTF-16 text: drop the zero bytes so "<\0?\0x\0m\0l\0" is seen as "<?xml".
  const plain = s.replace(/\0/g, '');
  return s.startsWith('#EXTM3U') || s.startsWith('ffconcat') || /^<(\?xml|mpd|smil)\b/i.test(plain);
}

/**
 * The only demuxers ffmpeg may pick for a user's file (names from `ffmpeg -demuxers`; a list
 * entry matches any part of a comma-joined name, so 'mov' covers mov,mp4,m4a,3gp,3g2,mj2 and
 * 'matroska' covers matroska,webm). What really reaches ffmpeg here: uploaded video (probe,
 * poster, transcode), voice notes and music (probe, cover art, convert), Telegram voice (Ogg)
 * and voice recorded in the browser (webm/ogg/mp4). Images never go to ffmpeg, and cover art
 * is read by the audio demuxer itself, so no image demuxer (image2 and its %d patterns) is
 * allowed. Everything that opens further files (hls, dash, concat, image2, ...) stays out.
 */
export const INPUT_FORMATS = ['mov', 'matroska', 'avi', 'mpegts', 'flv', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'amr'].join(',');

/**
 * Inputs may only be plain local files (no http, no pipes, no nested protocols) in one of the
 * formats above, and ffmpeg must never wait on stdin. -protocol_whitelist and
 * -format_whitelist are per-input options, so they go before every -i.
 */
export function withInputGuards(args) {
  const out = ['-nostdin'];
  for (const a of args) {
    if (a === '-i') out.push('-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS);
    out.push(a);
  }
  return out;
}

/** The files ffmpeg is told to read (the argument after each -i). */
export const ffmpegInputs = (args) => args.flatMap((a, i) => (a === '-i' && i + 1 < args.length ? [args[i + 1]] : []));

const MIN = 60_000;
// The web app records voice up to 15 minutes (MAX_VOICE_SECONDS in Composer.jsx). AAC/Opus
// encoding runs many times faster than real time even on a weak, niced CPU, but a slow disk
// or a busy video job can stretch it, so long recordings get time in proportion.
const AUDIO_UNKNOWN_SEC = 15 * 60;

/**
 * How long one ffmpeg run may take before it is killed, in ms. A hung or endless run (a broken
 * file, a crafted stream) would otherwise hold the single video slot or a CPU forever.
 * durationSec is the media length when known (0/null/NaN = unknown).
 */
export function ffmpegTimeout(kind, durationSec) {
  const d = Number(durationSec) > 0 ? Number(durationSec) : null;
  switch (kind) {
    case 'probe':
    case 'thumb':
      return MIN;
    case 'voice':
    case 'music':
    case 'audio':
      return Math.min(30 * MIN, Math.max(2 * MIN, (d ?? AUDIO_UNKNOWN_SEC) * 500));
    case 'video':
      return d == null ? 60 * MIN : Math.min(120 * MIN, Math.max(15 * MIN, d * 6000));
    default:
      // Unknown kind: as lenient as an unknown-length video, never unlimited.
      return 60 * MIN;
  }
}
