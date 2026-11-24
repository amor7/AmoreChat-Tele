// Background loops that must never take the server down or flood the log.
// Kept free of app imports (db, Fastify) so tests and early-loaded modules can use it.

const QUIET_MS = 5 * 60 * 1000;

// index.js points this at Fastify's logger once it exists; until then (modules start their
// loops at import time) errors go to stderr.
let defaultLog = (msg, err) => console.error(msg, err);
export function setTimerLogger(fn) {
  if (typeof fn === 'function') defaultLog = fn;
}

/** Logs through the same logger as the loops (Fastify's once index.js has set it). */
export function logBackground(...a) {
  try {
    defaultLog(...a);
  } catch {}
}

/**
 * setInterval for background work. A sync throw or a rejected promise is caught; the first
 * error of each loop is logged with its stack, then at most one line per 5 minutes with how
 * many were held back, so a loop failing every few seconds can't fill the disk. While an async
 * run is still going the next tick is skipped: on a slow server runs would otherwise pile up.
 * A run that is still going after 10 intervals is reported once, so a hung loop is visible.
 */
export function safeInterval(name, ms, fn, { log } = {}) {
  let running = false;
  let runStartedAt = 0;
  let slowLogged = false;
  let logged = false;
  let lastLogAt = 0;
  let suppressed = 0;
  const report = (e) => {
    // A broken logger must not turn a handled error into an unhandled one.
    const out = (...a) => {
      try {
        (log || defaultLog)(...a);
      } catch {}
    };
    const t = Date.now();
    if (!logged) {
      logged = true;
      lastLogAt = t;
      out(`[${name}] failed`, e);
      return;
    }
    if (t - lastLogAt < QUIET_MS) {
      suppressed++;
      return;
    }
    out(`[${name}] failed again (${suppressed} more since the last report): ${e?.message || e}`);
    lastLogAt = t;
    suppressed = 0;
  };
  const tick = () => {
    if (running) {
      if (!slowLogged && Date.now() - runStartedAt > 10 * ms) {
        slowLogged = true;
        try {
          (log || defaultLog)(`[${name}] still running since ${new Date(runStartedAt).toISOString()}`);
        } catch {}
      }
      return;
    }
    let r;
    try {
      r = fn();
    } catch (e) {
      report(e);
      return;
    }
    if (r && typeof r.then === 'function') {
      running = true;
      runStartedAt = Date.now();
      slowLogged = false;
      Promise.resolve(r)
        .catch(report)
        .finally(() => {
          running = false;
        });
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref();
  return timer;
}

/** `p`, or a rejection after `ms` if it hasn't settled by then (`p` itself is not cancelled). */
export function withTimeout(p, ms, message = 'timed out') {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}
