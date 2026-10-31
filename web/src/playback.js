// Only one voice note / video / song plays at a time.
let current = null;
export function claimPlayback(el) {
  if (current && current !== el) current.pause();
  current = el;
}
