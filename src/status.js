import { readFile } from 'node:fs/promises';
import { query } from './db.js';

// Public status page for every *.deltavdevs.com hostname, on Railway or not.
// Up means the server answered with anything below 500 (an API that 404s at /
// is still up); down means a 5xx, a timeout or no connection. Redirects count
// as up, which is what the GoDaddy forwards are supposed to do.
export const STATUS_HOST = (process.env.STATUS_HOST || 'status.deltavdevs.com').toLowerCase();

const t = (host, name, group) => ({ id: host, host, name, group, url: `https://${host}/` });
export const TARGETS = [
  t('www.deltavdevs.com', 'Main site', 'DeltaVDevs'),
  t('deltavdevs.com', 'deltavdevs.com (forwards to www)', 'DeltaVDevs'),
  t('blog.deltavdevs.com', 'Blog', 'DeltaVDevs'),
  t('deltatime.deltavdevs.com', 'DeltaTime', 'DeltaVDevs'),
  t('synthcity.deltavdevs.com', 'Synthcity', 'DeltaVDevs'),
  t('ward.deltavdevs.com', 'Ward (accounts)', 'DeltaVDevs'),
  t('telescreen.deltavdevs.com', 'Telescreen', 'DeltaVDevs'),
  t('analytics.deltavdevs.com', 'Analytics', 'DeltaVDevs'),
  t('cdn.deltavdevs.com', 'CDN', 'DeltaVDevs'),
  t('css.deltavdevs.com', 'Shared styles', 'DeltaVDevs'),
  t('forms.deltavdevs.com', 'Forms', 'DeltaVDevs'),
  t('merch.deltavdevs.com', 'Merch', 'DeltaVDevs'),
  t('pay.deltavdevs.com', 'Pay', 'DeltaVDevs'),
  t('relay.deltavdevs.com', 'Relay', 'DeltaVDevs'),
  t('spectralis.deltavdevs.com', 'Spectralis', 'DeltaVDevs'),
  t('turkiye.deltavdevs.com', 'Turkiye', 'DeltaVDevs'),
  t('music.deltavdevs.com', 'music (forwards to DeltaWave)', 'Forwards'),
  t('fnf.deltavdevs.com', 'fnf (forwards to the game)', 'Forwards'),
  t('discord.deltavdevs.com', 'discord (forwards to the server invite)', 'Forwards'),
  t('fc.deltavdevs.com', 'FIRST Command', 'FIRST Command'),
  t('fc-app.deltavdevs.com', 'FIRST Command app', 'FIRST Command'),
  t('fc-cdn.deltavdevs.com', 'FIRST Command CDN', 'FIRST Command'),
  t('robotics.deltavdevs.com', 'robotics', 'FIRST Command'),
  t('clarity.deltavdevs.com', 'Clarity', 'Clarity'),
  t('cdn.clarity.deltavdevs.com', 'Clarity CDN', 'Clarity'),
  t('mixxy.deltavdevs.com', 'Mixxy', 'Mixxy'),
  t('api.mixxy.deltavdevs.com', 'Mixxy API', 'Mixxy'),
  t('class.deltavdevs.com', 'ClassPlayer', 'ClassPlayer'),
  t('classapi.deltavdevs.com', 'ClassPlayer API', 'ClassPlayer'),
  t('play.deltavdevs.com', 'DTgooners site', 'DTgooners'),
  t('crn.deltavdevs.com', 'DTgooners', 'DTgooners'),
  t('lrc.deltavdevs.com', 'LRC Generator', 'Other projects'),
  t('jarvis.deltavdevs.com', 'jarvis (forwards to www.jarvis)', 'Other projects'),
  t('www.jarvis.deltavdevs.com', 'Jarvis', 'Other projects'),
  t('china.deltavdevs.com', 'china', 'Other projects'),
];

// Plain words for the usual failures; anything else keeps its code.
const REASONS = {
  ENOTFOUND: 'domain not found', EAI_AGAIN: 'DNS lookup failed', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset',
  ERR_TLS_CERT_ALTNAME_INVALID: "certificate doesn't cover this name", CERT_HAS_EXPIRED: 'certificate expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificate can't be verified", DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
};
function describe(err) {
  if (err.name === 'TimeoutError') return 'timed out after 10s';
  const code = err.cause?.code || err.code;
  return String(REASONS[code] || code || err.message).slice(0, 200);
}

export async function checkStatus({ fetcher = fetch, targets = TARGETS } = {}) {
  await Promise.all(targets.map(async target => {
    const started = Date.now();
    let ok = false, status = null, error = null;
    try {
      const response = await fetcher(target.url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'DeltaVDevs-Status/1.0 (+https://status.deltavdevs.com)' }, signal: AbortSignal.timeout(10_000) });
      status = response.status;
      ok = status < 500;
      response.body?.cancel?.().catch(() => {});
    } catch (err) {
      error = describe(err);
    }
    await query('INSERT INTO status_checks (target, ok, status, latency_ms, error) VALUES ($1, $2, $3, $4, $5)', [target.id, ok, status, Date.now() - started, error]);
  }));
}

// Daily totals for the 90-day bars, then drop raw checks past 14 days.
export async function rollupStatus() {
  await query(`INSERT INTO status_daily (target, day, checks, up, avg_latency_ms)
    SELECT target, (at AT TIME ZONE 'UTC')::date, count(*), count(*) FILTER (WHERE ok), round(avg(latency_ms) FILTER (WHERE ok))
    FROM status_checks WHERE at >= (current_date - 2)::timestamp AT TIME ZONE 'UTC' GROUP BY 1, 2
    ON CONFLICT (target, day) DO UPDATE SET checks = EXCLUDED.checks, up = EXCLUDED.up, avg_latency_ms = EXCLUDED.avg_latency_ms`);
  await query("DELETE FROM status_checks WHERE at < now() - interval '14 days'");
}

export async function statusData() {
  const [latest, days, outages] = await Promise.all([
    query(`SELECT DISTINCT ON (target) target, ok, status, latency_ms, error, at FROM status_checks ORDER BY target, at DESC`),
    query(`SELECT target, day, checks, up FROM status_daily WHERE day > current_date - 90
      UNION ALL SELECT target, (at AT TIME ZONE 'UTC')::date, count(*)::int, count(*) FILTER (WHERE ok)::int FROM status_checks
        WHERE at >= current_date::timestamp AT TIME ZONE 'UTC' AND NOT EXISTS (SELECT 1 FROM status_daily d WHERE d.day = current_date) GROUP BY 1, 2`),
    // Runs of consecutive failed checks in the last 14 days.
    query(`WITH c AS (SELECT target, at, ok, error, status, sum(CASE WHEN ok THEN 1 ELSE 0 END) OVER (PARTITION BY target ORDER BY at) AS grp
             FROM status_checks WHERE at > now() - interval '14 days')
      SELECT target, min(at) AS started, max(at) AS last_failed, count(*)::int AS minutes,
        (array_agg(COALESCE(error, 'HTTP ' || status) ORDER BY at))[1] AS reason,
        bool_or(at > now() - interval '3 minutes') AS ongoing
      FROM c WHERE NOT ok GROUP BY target, grp ORDER BY started DESC LIMIT 50`),
  ]);
  const now = new Map(latest.rows.map(r => [r.target, r]));
  const byTarget = new Map();
  for (const d of days.rows) {
    const list = byTarget.get(d.target) || [];
    list.push({ day: new Date(d.day).toISOString().slice(0, 10), checks: Number(d.checks), up: Number(d.up) });
    byTarget.set(d.target, list);
  }
  const names = new Map(TARGETS.map(x => [x.id, x.name]));
  const sites = TARGETS.map(target => {
    const last = now.get(target.id);
    const history = (byTarget.get(target.id) || []).sort((a, b) => a.day.localeCompare(b.day));
    const checks = history.reduce((n, d) => n + d.checks, 0), up = history.reduce((n, d) => n + d.up, 0);
    return {
      host: target.host, name: target.name, group: target.group,
      up: last ? last.ok : null, code: last?.status ?? null, error: last?.error ?? null, latency_ms: last?.latency_ms ?? null, checked_at: last?.at ?? null,
      uptime_90d: checks ? up / checks : null, days: history,
    };
  });
  return {
    generated_at: new Date().toISOString(),
    sites,
    outages: outages.rows.map(o => ({ host: o.target, name: names.get(o.target) || o.target, started: o.started, last_failed: o.last_failed, minutes: o.minutes, reason: o.reason, ongoing: o.ongoing })),
  };
}

// status.deltavdevs.com answers with the status page and nothing else.
export async function statusRoutes(app) {
  const files = {
    '/': ['status.html', 'text/html; charset=utf-8'],
    '/status.css': ['status.css', 'text/css; charset=utf-8'],
    '/status-app.js': ['status-app.js', 'application/javascript; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const cache = {};
  for (const [path, [file]] of Object.entries(files)) cache[path] = await readFile(new URL(`../public/${file}`, import.meta.url));
  let cached = { at: 0, body: null };

  app.addHook('onRequest', async (request, reply) => {
    if (String(request.hostname || '').split(':')[0].toLowerCase() !== STATUS_HOST) return;
    const path = request.url.split('?')[0];
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();
    if (path === '/health') return;
    if (path === '/status.json') {
      if (!cached.body || Date.now() - cached.at > 20_000) cached = { at: Date.now(), body: JSON.stringify(await statusData()) };
      return reply.type('application/json; charset=utf-8').header('Cache-Control', 'public, max-age=20').header('Access-Control-Allow-Origin', '*').send(cached.body);
    }
    if (files[path]) return reply.type(files[path][1]).header('Cache-Control', path === '/' ? 'public, max-age=60' : 'public, max-age=3600').send(cache[path]);
    if (path === '/robots.txt') return reply.type('text/plain').send('User-agent: *\nAllow: /\n');
    return reply.code(404).type('text/plain').send('Not found');
  });
}
