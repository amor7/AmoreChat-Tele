import net from 'node:net';
import { LIVEKIT_URL, rtcEnabled } from './livekit.js';

// Browsers reach LiveKit's signaling WebSocket through this app at /rtc, so the
// only public entry point stays the HTTPS site (no extra domain, port or proxy rule).
// Media itself goes straight to LiveKit over UDP / TCP 7881.
export function setupRtcProxy(app) {
  const target = new URL(LIVEKIT_URL);
  const port = Number(target.port) || 80;

  app.server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/socket.io')) return; // Socket.IO handles its own upgrades
    if (!rtcEnabled || !req.url.startsWith('/rtc')) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  });

  // livekit-client calls this after a failed connect to show a readable reason.
  app.get('/rtc/validate', { config: { public: true } }, async (req, reply) => {
    if (!rtcEnabled) return reply.code(503).type('text/plain').send('voice/video is not enabled on this server');
    const res = await fetch(LIVEKIT_URL + req.url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res) return reply.code(502).type('text/plain').send('media server unreachable');
    return reply.code(res.status).type('text/plain').send(await res.text());
  });
}
