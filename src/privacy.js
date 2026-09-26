import { createHash, randomBytes } from 'node:crypto';
import { query, one } from './db.js';

// ---------- IP hashing ----------
// ip_hash = SHA-256(today's salt, site, ip). The salt lives in the database so
// every instance agrees, and it's deleted after two days, after which nobody
// (us included) can link a hash to an IP or to another day's hashes.
let cached = { day: null, salt: null };
const today = () => new Date().toISOString().slice(0, 10);

export async function dailySalt(day = today()) {
  if (cached.day === day) return cached.salt;
  await query('INSERT INTO salts (day, salt) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING', [day, randomBytes(32)]);
  const row = await one('SELECT salt FROM salts WHERE day = $1', [day]);
  cached = { day, salt: row.salt };
  return row.salt;
}

export async function ipHash(ip, site, at = new Date()) {
  if (!ip) return null;
  const salt = await dailySalt(new Date(at).toISOString().slice(0, 10));
  return createHash('sha256').update(salt).update(`|${site}|${String(ip).trim()}`).digest('base64url').slice(0, 22);
}

// ---------- user agents ----------
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|uptime|curl|wget|python|httpx|go-http|node-fetch|axios|java\/|okhttp|headless|lighthouse|scan|probe|fetch|libwww|http-client/i;
export const isBot = ua => !ua || BOT.test(ua);

export function device(ua = '') {
  if (!ua) return 'other';
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) return 'mobile';
  if (/windows|macintosh|linux|cros|x11/i.test(ua)) return 'desktop';
  return 'other';
}

export function browser(ua = '') {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser/i.test(ua)) return 'Samsung';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios|chromium/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Other';
}

// ---------- URLs ----------
// Only keep the parts we report on: host and path, never query strings (they
// can hold tokens or emails), clipped to sane lengths.
export function splitUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { host: url.hostname.toLowerCase().slice(0, 253), path: cleanPath(url.pathname) };
  } catch {
    return null;
  }
}
export const cleanPath = path => (String(path || '/').split(/[?#]/)[0] || '/').slice(0, 300);
export const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
