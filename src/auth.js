import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { query, one, transaction } from './db.js';

// Sign-in is Ward only. Any staff level may read; admin and owner may change
// things (short links). The Ward refresh token is kept, sealed, in our own
// sessions table and used every few minutes to re-read the level, so a demotion
// or suspension (Ward revokes admin-tool tokens on level changes) ends access.
export const LEVELS = ['viewer', 'admin', 'owner'];
export const SESSION_COOKIE = config.production ? '__Host-analytics' : 'analytics';
const OAUTH_COOKIE = config.production ? '__Host-analytics-oauth' : 'analytics-oauth';
const cookieOptions = { httpOnly: true, secure: config.production, path: '/', sameSite: 'lax' };
const RECHECK_MS = 5 * 60_000;

const b64 = buf => Buffer.from(buf).toString('base64url');
export const token = () => b64(randomBytes(32));
const sha = value => createHash('sha256').update(value).digest('base64url');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// AES-256-GCM with a key derived from SESSION_SECRET.
const key = () => createHash('sha256').update(`analytics-seal|${config.sessionSecret}`).digest();
export function seal(text) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map(b64).join('.');
}
export function unseal(value) {
  try {
    const [iv, body, tag] = String(value).split('.').map(p => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
// Short-lived signed state for the OAuth round trip (no server storage needed).
const sign = body => createHmac('sha256', config.sessionSecret).update(`oauth.${body}`).digest('base64url');
const pack = obj => { const body = b64(JSON.stringify({ ...obj, exp: Date.now() + 600_000 })); return `${body}.${sign(body)}`; };
function unpack(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac || !equal(mac, sign(body))) return null;
  try { const obj = JSON.parse(Buffer.from(body, 'base64url').toString()); return obj.exp > Date.now() ? obj : null; } catch { return null; }
}
export const csrfFor = sessionId => createHmac('sha256', config.sessionSecret).update(`csrf.${sessionId}`).digest('base64url');

async function ward(path, init) {
  const response = await fetch(new URL(path, config.ward.url), { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}
const tokenRequest = params => ward('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams({ ...params, client_id: config.ward.clientId, client_secret: config.ward.clientSecret }),
});
const userinfo = accessToken => ward('/oauth/userinfo', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });

const bounce = (reply, message) => {
  reply.clearCookie(OAUTH_COOKIE, cookieOptions);
  return reply.redirect(`/?error=${encodeURIComponent(message)}`);
};

export async function authRoutes(app) {
  const callback = `${config.publicUrl}/auth/ward/callback`;

  app.get('/auth/ward/start', async (_request, reply) => {
    const state = token(), verifier = token();
    reply.setCookie(OAUTH_COOKIE, pack({ state, verifier }), { ...cookieOptions, maxAge: 600 });
    const url = new URL('/oauth/authorize', config.ward.url);
    url.search = new URLSearchParams({
      client_id: config.ward.clientId, redirect_uri: callback, response_type: 'code',
      scope: 'openid profile email admin offline_access', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/auth/ward/callback', async (request, reply) => {
    const pending = unpack(request.cookies[OAUTH_COOKIE]);
    const { state, code, error, iss } = request.query || {};
    if (error) return bounce(reply, 'Ward sign-in was cancelled.');
    // RFC 9207: only accept a response naming our Ward as issuer.
    if (!pending || typeof state !== 'string' || typeof code !== 'string' || code.length > 2000 || !equal(state, pending.state) || iss !== config.ward.url) {
      return bounce(reply, 'Sign-in expired or could not be verified. Try again.');
    }
    let tokens, profile;
    try {
      const exchanged = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: callback });
      tokens = exchanged.body;
      if (!exchanged.ok || !tokens.access_token || !tokens.refresh_token || !String(tokens.scope || '').split(' ').includes('admin')) throw new Error('bad token response');
      const info = await userinfo(tokens.access_token);
      if (!info.ok) throw new Error(`userinfo ${info.status}`);
      profile = info.body;
    } catch (err) {
      request.log.warn({ err: err.message }, 'ward sign-in failed');
      return bounce(reply, 'Ward sign-in failed. Try again.');
    }
    if (typeof profile.sub !== 'string' || !LEVELS.includes(profile.admin_level)) {
      request.log.info({ audit: true, action: 'auth.denied', sub: profile.sub || null, admin_level: profile.admin_level ?? null }, 'audit auth.denied');
      return bounce(reply, 'That Ward account is not DeltaVDevs staff.');
    }
    const id = token();
    await query(`INSERT INTO sessions (id_hash, sub, name, email, level, refresh_token, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
      [sha(id), profile.sub, String(profile.name || profile.preferred_username || 'Staff').slice(0, 80), profile.email || null, profile.admin_level, seal(tokens.refresh_token), config.sessionHours]);
    await query('DELETE FROM sessions WHERE expires_at < now()');
    reply.clearCookie(OAUTH_COOKIE, cookieOptions);
    reply.setCookie(SESSION_COOKIE, id, { ...cookieOptions, sameSite: 'strict', maxAge: config.sessionHours * 3600 });
    request.log.info({ audit: true, action: 'auth.login', sub: profile.sub, admin_level: profile.admin_level }, 'audit auth.login');
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (request, reply) => {
    const id = request.cookies[SESSION_COOKIE];
    if (id) await query('DELETE FROM sessions WHERE id_hash = $1', [sha(id)]);
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, sameSite: 'strict' });
    return { ok: true };
  });
}

// Re-read the level from Ward with the stored refresh token. One refresh at a
// time per session (row lock): Ward treats a reused refresh token as theft.
async function recheck(request, idHash) {
  return transaction(async db => {
    const row = (await db.query('SELECT * FROM sessions WHERE id_hash = $1 AND expires_at > now() FOR UPDATE', [idHash])).rows[0];
    if (!row) return null;
    if (Date.now() - new Date(row.checked_at).getTime() < RECHECK_MS) return row;
    let refreshed;
    try {
      refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(row.refresh_token) || '' });
    } catch (err) {
      // Ward unreachable: keep going on what we knew, try again next request.
      request.log.warn({ err: err.message }, 'ward unreachable; keeping session level');
      return row;
    }
    if (!refreshed.ok || !refreshed.body.access_token) {
      if (refreshed.status >= 500) return row;
      await db.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
      return null;
    }
    const info = await userinfo(refreshed.body.access_token).catch(() => ({ ok: false, status: 503 }));
    const level = info.ok ? info.body.admin_level : row.level;
    if (info.ok && !LEVELS.includes(level)) { await db.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]); return null; }
    return (await db.query(`UPDATE sessions SET level = $2, refresh_token = COALESCE($3, refresh_token), checked_at = now() WHERE id_hash = $1 RETURNING *`,
      [idHash, level, refreshed.body.refresh_token ? seal(refreshed.body.refresh_token) : null])).rows[0];
  });
}

export async function currentSession(request) {
  const id = request.cookies[SESSION_COOKIE];
  if (typeof id !== 'string' || id.length > 100) return null;
  const idHash = sha(id);
  const row = await one('SELECT * FROM sessions WHERE id_hash = $1 AND expires_at > now()', [idHash]);
  if (!row) return null;
  const fresh = Date.now() - new Date(row.checked_at).getTime() < RECHECK_MS ? row : await recheck(request, idHash);
  return fresh && LEVELS.includes(fresh.level) ? { ...fresh, id } : null;
}

// Every /api route needs a signed-in staff member; changes also need admin or
// owner, the per-session CSRF header and a same-origin request.
export async function guard(request, reply) {
  const session = await currentSession(request);
  if (!session) {
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, sameSite: 'strict' });
    return reply.code(401).send({ error: 'Sign in to continue.' });
  }
  request.session = session;
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== config.origin) return reply.code(403).send({ error: 'Origin not allowed.' });
    if (!equal(request.headers['x-analytics-csrf'], csrfFor(session.id))) return reply.code(403).send({ error: 'Reload the page and try again.' });
  }
}

export function requireLevel(request, ...levels) {
  if (!levels.includes(request.session?.level)) throw Object.assign(new Error(`Needs ${levels.join(' or ')} access.`), { statusCode: 403 });
}
