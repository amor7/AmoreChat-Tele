// Synthesized ringtones (no audio files to ship or cache).
let ctx = null;
let timer = null;

function tone(freqs, duration, gain = 0.12) {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const t = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.02);
  g.gain.setValueAtTime(gain, t + duration - 0.05);
  g.gain.linearRampToValueAtTime(0, t + duration);
  g.connect(ctx.destination);
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(t);
    o.stop(t + duration);
  }
}

// incoming: a bright double ring every 2s; outgoing: the classic long "ringback" tone.
export function startRing(kind) {
  stopRing();
  const play =
    kind === 'incoming'
      ? () => {
          tone([880, 1320], 0.35);
          setTimeout(() => tone([880, 1320], 0.35), 450);
        }
      : () => tone([440, 480], 1.2, 0.06);
  try {
    play();
    timer = setInterval(play, kind === 'incoming' ? 2000 : 3500);
  } catch {
    /* audio blocked until the user interacts */
  }
  navigator.vibrate?.(kind === 'incoming' ? [400, 200, 400] : 0);
}

export function stopRing() {
  clearInterval(timer);
  timer = null;
  navigator.vibrate?.(0);
}
