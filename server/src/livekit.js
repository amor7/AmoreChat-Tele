import crypto from 'node:crypto';

// Talks to the LiveKit media server: access tokens for clients, the Twirp
// RoomService API for moderation, and webhook verification. No SDK needed.
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
export const LIVEKIT_URL = (process.env.LIVEKIT_URL || 'http://livekit:7880').replace(/\/$/, '');
export const rtcEnabled = !!(API_KEY && API_SECRET);

const b64url = (s) => Buffer.from(s).toString('base64url');

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', API_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function verifyJwt(token) {
  const [head, body, sig] = String(token || '').split('.');
  if (!head || !body || !sig) return null;
  const expected = crypto.createHmac('sha256', API_SECRET).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now - 30) return null;
  if (claims.nbf && claims.nbf > now + 30) return null;
  return claims;
}

export const identityOf = (userId) => `u${userId}`;
export const userIdOf = (identity) => (/^u\d+$/.test(identity || '') ? Number(identity.slice(1)) : null);

// Client access token. `sources` limits what the user may publish (mic only, or camera/screen too).
export function accessToken({ user, room, canPublish, sources, hidden = false, ttlSeconds = 6 * 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: API_KEY,
    sub: identityOf(user.id),
    name: user.display_name,
    metadata: JSON.stringify({ avatar: user.avatar_file_id || null }),
    nbf: now - 10,
    exp: now + ttlSeconds,
    video: {
      room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: !!canPublish,
      canPublishData: false,
      canPublishSources: canPublish ? sources : [],
      canUpdateOwnMetadata: false,
      ...(hidden ? { hidden: true } : {}),
    },
  });
}

async function roomService(method, body) {
  const token = signJwt({
    iss: API_KEY,
    nbf: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 60,
    video: { roomAdmin: true, roomList: true, roomCreate: true, room: body.room || '' },
  });
  const res = await fetch(`${LIVEKIT_URL}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`livekit ${method}: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

export const listRooms = async () => (await roomService('ListRooms', {})).rooms || [];
export const listParticipants = async (room) => (await roomService('ListParticipants', { room })).participants || [];
export const removeParticipant = (room, userId) => roomService('RemoveParticipant', { room, identity: identityOf(userId) });
// Take publishing rights away live (the speaker becomes a listener without reconnecting).
export const revokePublish = (room, userId) =>
  roomService('UpdateParticipant', { room, identity: identityOf(userId), permission: { can_subscribe: true, can_publish: false, can_publish_data: false } });
export const deleteRoom = (room) => roomService('DeleteRoom', { room }).catch(() => {});

// Server-side mute of a participant's tracks of the given sources (e.g. MICROPHONE, SCREEN_SHARE).
export async function muteSources(room, userId, sources) {
  const p = (await listParticipants(room)).find((x) => x.identity === identityOf(userId));
  if (!p) return 0;
  let n = 0;
  for (const t of p.tracks || []) {
    if (sources.includes(String(t.source))) {
      await roomService('MutePublishedTrack', { room, identity: p.identity, track_sid: t.sid, muted: true });
      n++;
    }
  }
  return n;
}

// LiveKit signs webhooks with a JWT whose `sha256` claim is the base64 SHA-256 of the body.
export function verifyWebhook(rawBody, authHeader) {
  if (!rtcEnabled) return false;
  const claims = verifyJwt(String(authHeader || '').replace(/^Bearer\s+/i, ''));
  if (!claims) return false;
  const digest = crypto.createHash('sha256').update(rawBody).digest('base64');
  return claims.sha256 === digest;
}

// For tests: a webhook header signed like LiveKit does it.
export function signWebhook(rawBody) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: API_KEY, nbf: now - 10, exp: now + 300, sha256: crypto.createHash('sha256').update(rawBody).digest('base64') });
}
