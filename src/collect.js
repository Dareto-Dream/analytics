import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config, siteByHost } from './config.js';
import { query, one } from './db.js';
import { ipHash, isBot, device, browser, splitUrl, cleanPath, clip } from './privacy.js';

// Public endpoints the sites talk to. They take no cookies from us and set none:
// the visitor cookie (dv_vid) is first-party on each site, written by t.js, and
// only after the visitor accepted analytics cookies.

// Small in-memory rate limit per IP hash; one instance, and losing it on restart is fine.
const hits = new Map();
function limited(key, max = 120) {
  const now = Date.now(), entry = hits.get(key);
  if (!entry || entry.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); return false; }
  return ++entry.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

// Which configured site is this browser request from? Only https origins of our sites.
function siteFromOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && config.production) return null;
    return siteByHost(url.hostname);
  } catch { return null; }
}

const cors = (reply, origin) => reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
  .header('Access-Control-Allow-Methods', 'POST').header('Access-Control-Allow-Headers', 'Content-Type').header('Access-Control-Max-Age', '86400');

const uuid = z.string().uuid().optional();
const event = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pv'), u: z.string().max(2000), r: z.string().max(2000).optional().default(''), ti: z.string().max(300).optional(), v: uuid, s: uuid }),
  z.object({ t: z.literal('out'), u: z.string().max(2000), to: z.string().max(2000), v: uuid, s: uuid }),
]);
const consent = z.object({ id: z.string().uuid(), analytics: z.boolean(), gpc: z.boolean().optional().default(false), v: z.string().max(40).optional() });

function parse(schema, body) {
  let data = body;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

export async function collectRoutes(app) {
  const script = await readFile(new URL('../public/t.js', import.meta.url), 'utf8');
  app.get('/t.js', async (_request, reply) => reply
    .type('application/javascript; charset=utf-8')
    .header('Cache-Control', 'public, max-age=3600')
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(script));

  for (const url of ['/e', '/consent']) {
    app.options(url, async (request, reply) => {
      const site = siteFromOrigin(request);
      if (!site) return reply.code(403).send();
      return cors(reply, request.headers.origin).code(204).send();
    });
  }

  // Page views and outbound clicks. sendBeacon posts text/plain, so no preflight.
  app.post('/e', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const site = siteFromOrigin(request);
    if (!site) return reply.code(403).send({ error: 'unknown site' });
    cors(reply, request.headers.origin);
    const ua = String(request.headers['user-agent'] || '');
    if (isBot(ua)) return reply.code(204).send();
    const data = parse(event, request.body);
    const page = data && splitUrl(data.u);
    // The reported page has to be on the site the request came from.
    if (!data || !page || !site.hosts.includes(page.host)) return reply.code(400).send({ error: 'bad event' });
    const hash = await ipHash(request.ip, site.id);
    if (limited(hash || request.ip)) return reply.code(429).send();
    // Visitor and session ids only count when the site allows cookies at all.
    const consented = Boolean(site.cookies && data.v);
    const visitor = consented ? data.v : null, session = consented ? data.s || null : null;
    if (data.t === 'pv') {
      const params = new URL(data.u).searchParams;
      const ref = data.r ? splitUrl(data.r) : null;
      await query(`INSERT INTO pageviews (site, path, title, referrer_host, referrer_path, utm_source, utm_medium, utm_campaign, device, browser, consented, visitor_id, session_id, ip_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [site.id, page.path, clip(data.ti, 200), ref?.host || null, ref?.path || null,
          clip(params.get('utm_source'), 100), clip(params.get('utm_medium'), 100), clip(params.get('utm_campaign'), 100),
          device(ua), browser(ua), consented, visitor, session, hash]);
    } else {
      const target = splitUrl(data.to);
      if (!target) return reply.code(400).send({ error: 'bad event' });
      await query('INSERT INTO outbound (site, path, target_host, target_path, visitor_id, ip_hash) VALUES ($1, $2, $3, $4, $5, $6)',
        [site.id, page.path, target.host, target.path, visitor, hash]);
    }
    return reply.code(204).send();
  });

  // Consent banner choices, kept as proof of consent. Called by the banner (step 4).
  app.post('/consent', { bodyLimit: 2 * 1024 }, async (request, reply) => {
    const site = siteFromOrigin(request);
    if (!site) return reply.code(403).send({ error: 'unknown site' });
    cors(reply, request.headers.origin);
    const data = parse(consent, request.body);
    if (!data) return reply.code(400).send({ error: 'bad consent' });
    const hash = await ipHash(request.ip, site.id);
    if (limited(`consent:${hash}`, 30)) return reply.code(429).send();
    // Global Privacy Control means no, whatever else was sent.
    await query('INSERT INTO consents (site, consent_id, analytics, gpc, policy_version) VALUES ($1, $2, $3, $4, $5)',
      [site.id, data.id, data.analytics && !data.gpc, data.gpc, data.v || config.policyVersion]);
    return reply.code(204).send();
  });

  // Tracked short links.
  app.get('/r/:slug', async (request, reply) => {
    const slug = String(request.params.slug || '').toLowerCase();
    const link = /^[a-z0-9-]{1,48}$/.test(slug) ? await one('SELECT destination FROM links WHERE slug = $1 AND disabled_at IS NULL', [slug]) : null;
    if (!link) return reply.code(404).type('text/plain').send('This link does not exist.');
    const ua = String(request.headers['user-agent'] || '');
    const ref = request.headers.referer ? splitUrl(request.headers.referer) : null;
    await query('INSERT INTO link_clicks (slug, referrer_host, device, bot, ip_hash) VALUES ($1, $2, $3, $4, $5)',
      [slug, ref?.host || null, device(ua), isBot(ua), await ipHash(request.ip, `link:${slug}`)]);
    return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').redirect(link.destination, 302);
  });
}

export { cleanPath };
